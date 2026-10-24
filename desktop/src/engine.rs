//! Streaming NoMusic pipeline for 48 kHz interleaved stereo:
//! FastEnhancer (512-sample hops) -> per-channel RNNoise (480-sample frames, two passes + VAD gate).
//!
//! This mirrors the browser pipeline (fastenhancer-worker.js + rnnoise-worklet.js), including the
//! mono dedup: dual-mono hops only run the left FastEnhancer stream.

use std::collections::VecDeque;

use fastenhancer_wasm::Stream;
use nnnoiseless::DenoiseState;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
pub const HOP: usize = 512;
const RN_FRAME: usize = DenoiseState::FRAME_SIZE; // 480
const RN_PASSES: usize = 2;
const VAD_GATE_LO: f32 = 0.3;
const VAD_GATE_HI: f32 = 0.6;
const GATE_ATTACK: f32 = 0.05;
const GATE_RELEASE: f32 = 0.02;
const MONO_RESYNC_HOPS: u32 = 100;

/// Samples of delay the pipeline adds (FastEnhancer hop + RNNoise frame), per channel.
pub const LATENCY_FRAMES: usize = HOP + RN_FRAME;

struct RnChannel {
    states: Vec<Box<DenoiseState<'static>>>,
    input: Vec<f32>,
    scratch_in: [f32; RN_FRAME],
    scratch_out: [f32; RN_FRAME],
    gate: f32,
}

impl RnChannel {
    fn new() -> Self {
        RnChannel {
            states: (0..RN_PASSES).map(|_| DenoiseState::new()).collect(),
            input: Vec::with_capacity(RN_FRAME * 2),
            scratch_in: [0.0; RN_FRAME],
            scratch_out: [0.0; RN_FRAME],
            gate: 0.0,
        }
    }

    /// Feeds samples in; every completed frame is appended to `out`.
    fn push(&mut self, samples: &[f32], out: &mut VecDeque<f32>) {
        self.input.extend_from_slice(samples);
        let mut start = 0;
        while self.input.len() - start >= RN_FRAME {
            // nnnoiseless works on 16-bit-scaled floats.
            for (d, s) in self.scratch_in.iter_mut().zip(&self.input[start..start + RN_FRAME]) {
                *d = s * 32768.0;
            }
            let mut vad = 0.0;
            for (pass, state) in self.states.iter_mut().enumerate() {
                vad = state.process_frame(&mut self.scratch_out, &self.scratch_in);
                if pass + 1 < RN_PASSES {
                    self.scratch_in.copy_from_slice(&self.scratch_out);
                }
            }
            let target = if vad >= VAD_GATE_HI {
                1.0
            } else if vad <= VAD_GATE_LO {
                0.0
            } else {
                (vad - VAD_GATE_LO) / (VAD_GATE_HI - VAD_GATE_LO)
            };
            let alpha = if target > self.gate { GATE_ATTACK } else { GATE_RELEASE };
            self.gate += (target - self.gate) * alpha;
            out.extend(self.scratch_out.iter().map(|v| v / 32768.0 * self.gate));
            start += RN_FRAME;
        }
        self.input.drain(..start);
    }
}

pub struct Engine {
    fe: [Stream; CHANNELS],
    hop: Vec<f32>, // interleaved input staging, up to HOP frames
    wet: f32,
    rnnoise: Option<[RnChannel; CHANNELS]>,
    fe_out: [Vec<f32>; CHANNELS],
    rn_out: [VecDeque<f32>; CHANNELS],
    states_equal: bool,
    right_stale: bool,
    mono_run: u32,
}

impl Engine {
    pub fn new(rnnoise: bool) -> Self {
        let mut engine = Engine {
            fe: [Stream::new(), Stream::new()],
            hop: Vec::with_capacity(HOP * CHANNELS),
            wet: 1.0,
            rnnoise: rnnoise.then(|| [RnChannel::new(), RnChannel::new()]),
            fe_out: [Vec::with_capacity(HOP), Vec::with_capacity(HOP)],
            rn_out: [VecDeque::new(), VecDeque::new()],
            states_equal: true,
            right_stale: false,
            mono_run: 0,
        };
        engine.reset();
        engine
    }

    /// 0.0 = untouched audio, 1.0 = fully enhanced (the extension's suppression level / 100).
    pub fn set_wet(&mut self, wet: f32) {
        self.wet = wet.clamp(0.0, 1.0);
    }

    pub fn reset(&mut self) {
        for s in &mut self.fe {
            s.reset();
        }
        self.hop.clear();
        self.rn_out.iter_mut().for_each(VecDeque::clear);
        if let Some(rn) = &mut self.rnnoise {
            *rn = [RnChannel::new(), RnChannel::new()];
        }
        self.states_equal = true;
        self.right_stale = false;
        self.mono_run = 0;
    }

    /// Processes interleaved stereo `input` and appends whatever output is ready (interleaved stereo)
    /// to `output`. Output lags input by `LATENCY_FRAMES`.
    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        let mut pos = 0;
        while pos < input.len() {
            let n = (HOP * CHANNELS - self.hop.len()).min(input.len() - pos);
            self.hop.extend_from_slice(&input[pos..pos + n]);
            pos += n;
            if self.hop.len() == HOP * CHANNELS {
                self.run_hop();
                self.hop.clear();
            }
        }

        let ready = self.rn_out[0].len().min(self.rn_out[1].len());
        output.reserve(ready * CHANNELS);
        for _ in 0..ready {
            output.push(self.rn_out[0].pop_front().unwrap());
            output.push(self.rn_out[1].pop_front().unwrap());
        }
    }

    fn run_hop(&mut self) {
        let mut mono = true;
        {
            let [left, right] = &mut self.fe;
            let (li, ri) = (left.input_mut(), right.input_mut());
            for i in 0..HOP {
                let (l, r) = (self.hop[i * 2], self.hop[i * 2 + 1]);
                li[i] = l;
                ri[i] = r;
                mono &= l == r;
            }
        }

        if mono {
            self.mono_run += 1;
            if !self.states_equal && self.mono_run >= MONO_RESYNC_HOPS {
                self.states_equal = true;
                self.right_stale = true;
            }
        } else {
            self.mono_run = 0;
        }

        let [left, right] = &mut self.fe;
        if mono && self.states_equal {
            left.process(self.wet);
            self.right_stale = true;
            self.fe_out[0].clear();
            self.fe_out[0].extend_from_slice(left.output());
            self.fe_out[1].clear();
            self.fe_out[1].extend_from_slice(left.output());
        } else {
            if self.right_stale {
                right.copy_state_from(left);
                self.right_stale = false;
            }
            self.states_equal = false;
            left.process(self.wet);
            right.process(self.wet);
            self.fe_out[0].clear();
            self.fe_out[0].extend_from_slice(left.output());
            self.fe_out[1].clear();
            self.fe_out[1].extend_from_slice(right.output());
        }

        for c in 0..CHANNELS {
            match &mut self.rnnoise {
                Some(rn) => rn[c].push(&self.fe_out[c], &mut self.rn_out[c]),
                None => self.rn_out[c].extend(self.fe_out[c].iter().copied()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(frames: usize, seed: &mut u32) -> Vec<f32> {
        (0..frames * CHANNELS)
            .map(|_| {
                *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (*seed >> 8) as f32 / (1u32 << 24) as f32 * 0.4 - 0.2
            })
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    #[test]
    fn output_length_tracks_input_minus_latency() {
        let mut engine = Engine::new(true);
        let mut out = Vec::new();
        let mut seed = 1;
        // Odd chunk sizes, like a sound card would deliver.
        for chunk in [441, 1000, 37, 4800, 2222] {
            engine.process(&noise(chunk, &mut seed), &mut out);
        }
        let total = 441 + 1000 + 37 + 4800 + 2222;
        let frames = out.len() / CHANNELS;
        assert_eq!(out.len() % CHANNELS, 0);
        assert!(frames <= total && frames + LATENCY_FRAMES + RN_FRAME >= total, "{frames} of {total}");
    }

    #[test]
    fn suppresses_white_noise() {
        let mut seed = 7;
        let input = noise(SAMPLE_RATE as usize * 2, &mut seed);
        for rnnoise in [false, true] {
            let mut engine = Engine::new(rnnoise);
            let mut out = Vec::new();
            engine.process(&input, &mut out);
            let tail = &out[out.len() / 2..]; // skip the warm-up
            assert!(rms(tail) < rms(&input) * 0.1, "rnnoise={rnnoise}: {} vs {}", rms(tail), rms(&input));
        }
    }

    #[test]
    fn wet_zero_passes_audio_through_fastenhancer() {
        let mut seed = 3;
        let input = noise(HOP * 8, &mut seed);
        let mut engine = Engine::new(false);
        engine.set_wet(0.0);
        let mut out = Vec::new();
        engine.process(&input, &mut out);
        assert_eq!(out, input);
    }
}
