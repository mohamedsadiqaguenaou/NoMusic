//! Live system-wide filtering: capture device -> Engine -> playback device.
//!
//! Windows has no way to take audio away from other apps without a driver, so NoMusic relies on a virtual
//! audio cable (VB-Audio Virtual Cable): Windows plays everything into "CABLE Input", we capture it from
//! "CABLE Output", remove the music, and play the result on the real speakers.
//!
//! Threads: the capture callback pushes raw stereo into a ring, a worker thread runs the engine, and the
//! playback callback pulls from a second ring. The two devices run on separate clocks, so the playback
//! side keeps its queue between PREBUFFER and MAX_QUEUE by dropping or waiting for audio.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use rtrb::{Consumer, Producer, RingBuffer};

use crate::default_device::{self, CableAsDefault};
use crate::engine::{Engine, CHANNELS, SAMPLE_RATE};

const CABLE_CAPTURE: &str = "CABLE Output"; // VB-Audio Virtual Cable's recording side
const CABLE_PLAYBACK: &str = "CABLE Input"; // ... and its playback side
const RING_SAMPLES: usize = SAMPLE_RATE as usize * CHANNELS; // 1 s of stereo per ring
const PREBUFFER_FRAMES: usize = 1440; // 30 ms
const MAX_QUEUE_FRAMES: usize = 7200; // 150 ms

pub struct Options {
    pub input: Option<String>,
    pub output: Option<String>,
    pub rnnoise: bool,
    pub wet: f32,
    /// Process without playing anything (for testing on machines without a cable).
    pub dry_run: bool,
    pub seconds: Option<u64>,
}

/// Shared between the audio threads and whoever controls the session (CLI or tray).
pub struct Controls {
    pub running: AtomicBool,
    pub bypass: AtomicBool,
    /// Engine strength (0-100), the extension's suppression level.
    pub level: AtomicU32,
    pub frames_processed: AtomicU64,
    pub process_nanos: AtomicU64,
    pub underruns: AtomicU64,
}

impl Controls {
    pub fn new(level: u32) -> Arc<Self> {
        Arc::new(Controls {
            running: AtomicBool::new(true),
            bypass: AtomicBool::new(false),
            level: AtomicU32::new(level.min(100)),
            frames_processed: AtomicU64::new(0),
            process_nanos: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
        })
    }
}

fn device_name(device: &Device) -> String {
    device.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "?".into())
}

/// True when VB-Audio Virtual Cable's capture side is present.
pub fn cable_installed() -> bool {
    cpal::default_host()
        .input_devices()
        .map(|mut d| d.any(|d| device_name(&d).contains(CABLE_CAPTURE)))
        .unwrap_or(false)
}

pub fn list_devices() -> Result<(), String> {
    let host = cpal::default_host();
    println!("Capture devices:");
    for d in host.input_devices().map_err(|e| e.to_string())? {
        println!("  {}", device_name(&d));
    }
    println!("Playback devices:");
    for d in host.output_devices().map_err(|e| e.to_string())? {
        println!("  {}", device_name(&d));
    }
    Ok(())
}

fn find(devices: impl Iterator<Item = Device>, needle: &str) -> Option<Device> {
    let needle = needle.to_lowercase();
    devices.into_iter().find(|d| device_name(d).to_lowercase().contains(&needle))
}

pub struct Devices {
    pub input: Device,
    pub output: Device,
}

/// Picks the capture device (the cable unless told otherwise) and a real playback device: never the cable
/// itself, or we would feed our own output back in.
pub fn pick_devices(opts: &Options) -> Result<Devices, String> {
    let host = cpal::default_host();
    let inputs = || host.input_devices().map_err(|e| e.to_string());
    let outputs = || host.output_devices().map_err(|e| e.to_string());

    let input = match &opts.input {
        // A playback device can be captured too: WASAPI then records what it plays (loopback).
        Some(name) => find(inputs()?, name)
            .or(find(outputs()?, name))
            .ok_or(format!("no capture or playback device matching \"{name}\""))?,
        None => find(inputs()?, CABLE_CAPTURE).ok_or_else(|| {
            format!(
                "\"{CABLE_CAPTURE}\" not found. Install VB-Audio Virtual Cable (https://vb-audio.com/Cable/), \
                 or pick a capture device with --input (see `nomusic devices`)."
            )
        })?,
    };

    let output = match &opts.output {
        Some(name) => find(outputs()?, name).ok_or(format!("no playback device matching \"{name}\""))?,
        None => {
            let is_cable = |d: &Device| device_name(d).contains(CABLE_PLAYBACK);
            match host.default_output_device().filter(|d| !is_cable(d)) {
                Some(d) => d,
                None => outputs()?
                    .find(|d| !is_cable(d))
                    .ok_or("no playback device besides the virtual cable")?,
            }
        }
    };
    Ok(Devices { input, output })
}

/// Linear resampler for capture devices that don't run at 48 kHz (interleaved stereo).
struct Resampler {
    step: f64, // input frames per output frame
    pos: f64,
    prev: [f32; 2],
}

impl Resampler {
    fn new(from_rate: u32) -> Option<Self> {
        (from_rate != SAMPLE_RATE).then(|| Resampler {
            step: from_rate as f64 / SAMPLE_RATE as f64,
            pos: 0.0,
            prev: [0.0; 2],
        })
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let frames = input.len() / 2;
        let at = |i: isize| -> [f32; 2] {
            if i < 0 {
                self.prev
            } else {
                [input[i as usize * 2], input[i as usize * 2 + 1]]
            }
        };
        // `pos` is relative to the first frame of `input`; frame -1 is the previous chunk's last frame.
        while self.pos < frames as f64 - 1.0 {
            let i = self.pos.floor() as isize;
            let t = (self.pos - i as f64) as f32;
            let (a, b) = (at(i), at(i + 1));
            out.push(a[0] + (b[0] - a[0]) * t);
            out.push(a[1] + (b[1] - a[1]) * t);
            self.pos += self.step;
        }
        if frames > 0 {
            self.prev = at(frames as isize - 1);
            self.pos -= frames as f64;
        }
    }
}

/// Converts device frames with any channel count to stereo f32.
fn push_stereo<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32, out: &mut Vec<f32>) {
    for frame in data.chunks_exact(channels) {
        let l = to_f32(frame[0]);
        let r = if channels > 1 { to_f32(frame[1]) } else { l };
        out.push(l);
        out.push(r);
    }
}

fn build_capture(device: &Device, mut raw: Producer<f32>) -> Result<(Stream, u32), String> {
    let supported = device
        .default_input_config()
        .or_else(|_| device.default_output_config()) // playback device: loopback capture
        .map_err(|e| format!("capture device: {e}"))?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.config();
    let channels = config.channels as usize;
    let rate = config.sample_rate;
    let mut stereo = Vec::with_capacity(8192);
    let mut resampled = Vec::with_capacity(8192);
    let mut resampler = Resampler::new(rate);

    let mut deliver = move |stereo: &mut Vec<f32>| {
        let data: &[f32] = match &mut resampler {
            Some(r) => {
                resampled.clear();
                r.process(stereo, &mut resampled);
                &resampled
            }
            None => stereo,
        };
        if let Ok(mut chunk) = raw.write_chunk_uninit(data.len().min(raw.slots())) {
            let n = chunk.len();
            let (a, b) = chunk.as_mut_slices();
            for (d, s) in a.iter_mut().chain(b.iter_mut()).zip(data) {
                d.write(*s);
            }
            unsafe { chunk.commit(n) };
        }
        stereo.clear();
    };

    let err = |e: cpal::Error| {
        // A glitch report (WASAPI flags one when capture starts); not worth alarming the user.
        if e.kind() != cpal::ErrorKind::Xrun {
            eprintln!("capture error: {e}");
        }
    };
    let stream = match format {
        SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
            config,
            move |data, _| {
                push_stereo(data, channels, |v| v, &mut stereo);
                deliver(&mut stereo);
            },
            err,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
            config,
            move |data, _| {
                push_stereo(data, channels, |v| v as f32 / 32768.0, &mut stereo);
                deliver(&mut stereo);
            },
            err,
            None,
        ),
        other => return Err(format!("capture device uses unsupported sample format {other:?}")),
    }
    .map_err(|e| format!("capture device: {e}"))?;
    Ok((stream, rate))
}

fn build_playback(device: &Device, mut processed: Consumer<f32>, controls: Arc<Controls>) -> Result<Stream, String> {
    // Output streams accept any rate (WASAPI converts), so ask for 48 kHz in the device's channel layout.
    let supported = device.default_output_config().map_err(|e| format!("playback device: {e}"))?;
    let channels = supported.channels() as usize;
    let config = StreamConfig { channels: supported.channels(), sample_rate: SAMPLE_RATE, buffer_size: Default::default() };
    let mut playing = false;

    let stream = device
        .build_output_stream::<f32, _, _>(
            config,
            move |out, _| {
                let frames = out.len() / channels;
                let queued = processed.slots() / CHANNELS;
                if queued > MAX_QUEUE_FRAMES {
                    // The capture clock runs ahead of ours: drop the oldest audio to bound latency.
                    let drop = (queued - PREBUFFER_FRAMES) * CHANNELS;
                    if let Ok(chunk) = processed.read_chunk(drop) {
                        chunk.commit_all();
                    }
                }
                let queued = processed.slots() / CHANNELS;
                if !playing && queued >= PREBUFFER_FRAMES {
                    playing = true;
                }
                if !playing || queued < frames {
                    if playing {
                        controls.underruns.fetch_add(1, Ordering::Relaxed);
                        playing = false;
                    }
                    out.fill(0.0);
                    return;
                }
                let chunk = processed.read_chunk(frames * CHANNELS).expect("checked above");
                let (a, b) = chunk.as_slices();
                let mut samples = a.iter().chain(b.iter());
                for frame in out.chunks_exact_mut(channels) {
                    let l = *samples.next().unwrap();
                    let r = *samples.next().unwrap();
                    frame[0] = l;
                    if channels > 1 {
                        frame[1] = r;
                        frame[2..].fill(0.0);
                    }
                }
                chunk.commit_all();
            },
            |e| eprintln!("playback error: {e}"),
            None,
        )
        .map_err(|e| format!("playback device: {e}"))?;
    Ok(stream)
}

pub struct Session {
    // First field, so it is dropped first: the speakers become the default again before streams stop.
    cable_default: Option<CableAsDefault>,
    _capture: Stream,
    _playback: Option<Stream>,
    worker: Option<std::thread::JoinHandle<()>>,
    pub controls: Arc<Controls>,
    pub input_name: String,
    pub output_name: String,
    pub input_rate: u32,
}

impl Session {
    pub fn start(opts: &Options, controls: Arc<Controls>) -> Result<Session, String> {
        if let Some(name) = default_device::recover(CABLE_PLAYBACK) {
            println!("Restored \"{name}\" as the default playback device (NoMusic did not exit cleanly last time).");
        }
        let devices = pick_devices(opts)?;
        let (raw_tx, mut raw_rx) = RingBuffer::<f32>::new(RING_SAMPLES);
        let (mut out_tx, out_rx) = RingBuffer::<f32>::new(RING_SAMPLES);

        let (capture, input_rate) = build_capture(&devices.input, raw_tx)?;
        let playback = if opts.dry_run {
            None
        } else {
            Some(build_playback(&devices.output, out_rx, controls.clone())?)
        };

        let rnnoise = opts.rnnoise;
        let worker_controls = controls.clone();
        let worker = std::thread::Builder::new()
            .name("nomusic-engine".into())
            .spawn(move || {
                let c = worker_controls;
                let mut engine = Engine::new(rnnoise);
                let mut input = Vec::with_capacity(8192);
                let mut output = Vec::with_capacity(8192);
                while c.running.load(Ordering::Relaxed) {
                    let n = raw_rx.slots();
                    if n < 256 {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    input.clear();
                    let chunk = raw_rx.read_chunk(n).expect("slots checked");
                    let (a, b) = chunk.as_slices();
                    input.extend_from_slice(a);
                    input.extend_from_slice(b);
                    chunk.commit_all();

                    output.clear();
                    if c.bypass.load(Ordering::Relaxed) {
                        output.extend_from_slice(&input);
                    } else {
                        engine.set_wet(c.level.load(Ordering::Relaxed) as f32 / 100.0);
                        let t0 = Instant::now();
                        engine.process(&input, &mut output);
                        c.process_nanos.fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
                    }
                    c.frames_processed.fetch_add((input.len() / CHANNELS) as u64, Ordering::Relaxed);

                    if let Ok(mut chunk) = out_tx.write_chunk_uninit(output.len().min(out_tx.slots())) {
                        let n = chunk.len();
                        let (a, b) = chunk.as_mut_slices();
                        for (d, s) in a.iter_mut().chain(b.iter_mut()).zip(&output) {
                            d.write(*s);
                        }
                        unsafe { chunk.commit(n) };
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        capture.play().map_err(|e| format!("capture device: {e}"))?;
        if let Some(p) = &playback {
            p.play().map_err(|e| format!("playback device: {e}"))?;
        }

        // Live filtering of the cable: route every app into it, and back to the speakers when we stop.
        let output_name = device_name(&devices.output);
        let cable_default = if !opts.dry_run && device_name(&devices.input).contains(CABLE_CAPTURE) {
            let speakers = default_device::playback_endpoints().into_iter().find(|e| e.name == output_name);
            match speakers.map(|s| CableAsDefault::activate(CABLE_PLAYBACK, s)) {
                Some(Ok(switch)) => Some(switch),
                Some(Err(e)) => {
                    eprintln!("could not make \"{CABLE_PLAYBACK}\" the default playback device ({e}); set it in Sound settings");
                    None
                }
                None => None,
            }
        } else {
            None
        };

        Ok(Session {
            cable_default,
            _capture: capture,
            _playback: playback,
            worker: Some(worker),
            controls,
            input_name: device_name(&devices.input),
            output_name: device_name(&devices.output),
            input_rate,
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.controls.running.store(false, Ordering::Relaxed);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

/// `nomusic run`: filter until Ctrl+C (or --seconds), printing a status line every few seconds.
pub fn run(opts: Options) -> Result<(), String> {
    let controls = Controls::new((opts.wet * 100.0).round() as u32);
    let session = Session::start(&opts, controls.clone())?;
    println!("NoMusic is filtering: {} -> {}", session.input_name, if opts.dry_run { "(dry run, nothing played)" } else { &session.output_name });
    if session.input_rate != SAMPLE_RATE {
        println!("note: the capture device runs at {} Hz; set it to 48000 Hz in Sound settings for the best quality", session.input_rate);
    }
    match &session.cable_default {
        Some(switch) => println!(
            "All apps now play through NoMusic. \"{}\" becomes the default playback device again when NoMusic stops.",
            switch.restore_name()
        ),
        None if !opts.dry_run && session.input_name.contains(CABLE_CAPTURE) => {
            println!("Set \"{CABLE_PLAYBACK}\" as the default playback device so every app plays through NoMusic.")
        }
        None => {}
    }
    println!("Press Ctrl+C to stop.");

    // The Ctrl+C handler can only be installed once per process, and the menu may start several runs.
    static CTRL_C: AtomicBool = AtomicBool::new(false);
    static HANDLER: std::sync::Once = std::sync::Once::new();
    HANDLER.call_once(|| {
        let _ = ctrlc::set_handler(|| CTRL_C.store(true, Ordering::Relaxed));
    });
    CTRL_C.store(false, Ordering::Relaxed);

    let started = Instant::now();
    let mut last = (0u64, 0u64);
    while controls.running.load(Ordering::Relaxed) && !CTRL_C.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(250));
        if opts.seconds.is_some_and(|s| started.elapsed() >= Duration::from_secs(s)) {
            break;
        }
        if started.elapsed().as_millis() % 5000 < 250 {
            let frames = controls.frames_processed.load(Ordering::Relaxed);
            let nanos = controls.process_nanos.load(Ordering::Relaxed);
            let (df, dn) = (frames - last.0, nanos - last.1);
            last = (frames, nanos);
            if df > 0 {
                let load = dn as f64 / 1e9 / (df as f64 / SAMPLE_RATE as f64) * 100.0;
                println!(
                    "  {:.1} s of audio, engine load {:.0}% of real time, {} underruns",
                    frames as f64 / SAMPLE_RATE as f64,
                    load,
                    controls.underruns.load(Ordering::Relaxed)
                );
            }
        }
    }
    let frames = controls.frames_processed.load(Ordering::Relaxed);
    let nanos = controls.process_nanos.load(Ordering::Relaxed);
    let audio_s = frames as f64 / SAMPLE_RATE as f64;
    println!(
        "Stopped after {:.1} s of audio (engine load {:.0}% of real time, {} underruns).",
        audio_s,
        if audio_s > 0.0 { nanos as f64 / 1e9 / audio_s * 100.0 } else { 0.0 },
        controls.underruns.load(Ordering::Relaxed)
    );
    drop(session);
    Ok(())
}

/// `nomusic record`: captures what the speakers are playing for `seconds` and writes it twice, as
/// `<prefix>-original.wav` and `<prefix>-nomusic.wav`, so the filter can be tried without a virtual cable.
pub fn record(seconds: u64, prefix: &str, opts: &Options) -> Result<(), String> {
    let host = cpal::default_host();
    let device = match &opts.input {
        Some(name) => find(host.output_devices().map_err(|e| e.to_string())?, name)
            .or(find(host.input_devices().map_err(|e| e.to_string())?, name))
            .ok_or(format!("no device matching \"{name}\""))?,
        None => host.default_output_device().ok_or("no playback device to record from")?,
    };
    let (tx, mut rx) = RingBuffer::<f32>::new(RING_SAMPLES * 2);
    let (stream, _) = build_capture(&device, tx)?;
    stream.play().map_err(|e| format!("capture device: {e}"))?;
    println!("Recording {} for {seconds} s: play something with music and speech now...", device_name(&device));

    let total = seconds as usize * SAMPLE_RATE as usize * CHANNELS;
    let mut original = Vec::with_capacity(total);
    let started = Instant::now();
    // Loopback delivers nothing while the device is silent, so stop on wall-clock time as well.
    while original.len() < total && started.elapsed() < Duration::from_secs(seconds + 2) {
        std::thread::sleep(Duration::from_millis(20));
        if let Ok(chunk) = rx.read_chunk(rx.slots()) {
            let (a, b) = chunk.as_slices();
            original.extend_from_slice(a);
            original.extend_from_slice(b);
            chunk.commit_all();
        }
    }
    drop(stream);
    original.truncate(total);
    if original.is_empty() {
        return Err("nothing was captured: was anything playing?".into());
    }

    let mut engine = Engine::new(opts.rnnoise);
    engine.set_wet(opts.wet);
    let frames = original.len() / CHANNELS;
    let mut padded = original.clone();
    padded.resize((frames + crate::engine::LATENCY_FRAMES * 2) * CHANNELS, 0.0);
    let mut filtered = Vec::with_capacity(padded.len());
    let t0 = Instant::now();
    engine.process(&padded, &mut filtered);
    let start = crate::engine::LATENCY_FRAMES * CHANNELS;
    let filtered = &filtered[start.min(filtered.len())..(start + frames * CHANNELS).min(filtered.len())];
    let audio_s = frames as f64 / SAMPLE_RATE as f64;
    println!(
        "Captured {audio_s:.1} s; filtering took {:.2} s ({:.0}% of real time).",
        t0.elapsed().as_secs_f64(),
        t0.elapsed().as_secs_f64() / audio_s * 100.0
    );

    for (path, samples) in [(format!("{prefix}-original.wav"), &original[..]), (format!("{prefix}-nomusic.wav"), filtered)] {
        crate::write_wav(&path, samples)?;
        println!("Wrote {path}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_converts_rate_and_keeps_a_ramp_linear() {
        let mut r = Resampler::new(44_100).unwrap();
        let mut out = Vec::new();
        // A 0..1 s ramp (in seconds), small enough that f32 keeps the per-frame steps exact.
        let input: Vec<f32> = (0..44_100).flat_map(|i| [i as f32 / 44_100.0, -(i as f32) / 44_100.0]).collect();
        for chunk in input.chunks(882) {
            r.process(chunk, &mut out);
        }
        let frames = out.len() / 2;
        assert!((frames as i64 - 48_000).abs() <= 2, "{frames}");
        for i in 1..frames {
            let d = out[i * 2] - out[(i - 1) * 2];
            assert!((d - 1.0 / 48_000.0).abs() < 1e-6, "frame {i}: step {d}");
            assert_eq!(out[i * 2 + 1], -out[i * 2]);
        }
    }

    #[test]
    fn push_stereo_handles_mono_and_surround() {
        let mut out = Vec::new();
        push_stereo(&[0.5f32, -0.5], 1, |v| v, &mut out);
        assert_eq!(out, [0.5, 0.5, -0.5, -0.5]);
        out.clear();
        push_stereo(&[1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0], 6, |v| v, &mut out);
        assert_eq!(out, [1.0, 2.0]);
    }
}
