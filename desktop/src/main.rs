//! NoMusic desktop.
//!
//!   nomusic process <in.wav> <out.wav> [--no-rnnoise] [--level 0-100]
//!       Removes background music from a 48 kHz WAV file (mono or stereo).

mod engine;

use std::process::ExitCode;

use engine::{Engine, CHANNELS, LATENCY_FRAMES, SAMPLE_RATE};

fn usage() -> ExitCode {
    eprintln!("usage: nomusic process <in.wav> <out.wav> [--no-rnnoise] [--level 0-100]");
    ExitCode::from(2)
}

struct Options {
    rnnoise: bool,
    wet: f32,
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut opts = Options { rnnoise: true, wet: 1.0 };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--no-rnnoise" => opts.rnnoise = false,
            "--level" => {
                let v: f32 = it.next().and_then(|v| v.parse().ok()).ok_or("--level needs a number 0-100")?;
                opts.wet = (v / 100.0).clamp(0.0, 1.0);
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(opts)
}

fn process_file(input: &str, output: &str, opts: &Options) -> Result<(), String> {
    let mut reader = hound::WavReader::open(input).map_err(|e| format!("{input}: {e}"))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE {
        return Err(format!("{input}: {} Hz, NoMusic needs {SAMPLE_RATE} Hz audio", spec.sample_rate));
    }
    let channels = spec.channels as usize;
    if channels != 1 && channels != 2 {
        return Err(format!("{input}: {channels} channels, only mono and stereo are supported"));
    }

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>(),
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect()
        }
    }
    .map_err(|e| format!("{input}: {e}"))?;

    let mut stereo: Vec<f32> = if channels == 2 {
        samples
    } else {
        samples.iter().flat_map(|&s| [s, s]).collect()
    };
    let frames = stereo.len() / CHANNELS;
    // Pad so the tail comes out of the pipeline too, then drop the leading latency.
    stereo.resize((frames + LATENCY_FRAMES * 2) * CHANNELS, 0.0);

    let mut engine = Engine::new(opts.rnnoise);
    engine.set_wet(opts.wet);
    let mut out = Vec::with_capacity(stereo.len());
    engine.process(&stereo, &mut out);
    let start = (LATENCY_FRAMES * CHANNELS).min(out.len());
    let end = (start + frames * CHANNELS).min(out.len());

    let out_spec = hound::WavSpec {
        channels: CHANNELS as u16,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(output, out_spec).map_err(|e| format!("{output}: {e}"))?;
    for &s in &out[start..end] {
        writer
            .write_sample((s.clamp(-1.0, 1.0) * 32767.0).round() as i16)
            .map_err(|e| format!("{output}: {e}"))?;
    }
    writer.finalize().map_err(|e| format!("{output}: {e}"))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("process") if args.len() >= 3 => {
            let result = parse_options(&args[3..]).and_then(|opts| process_file(&args[1], &args[2], &opts));
            match result {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => usage(),
    }
}
