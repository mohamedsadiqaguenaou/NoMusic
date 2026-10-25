//! NoMusic desktop.
//!
//!   nomusic
//!       Started without arguments (e.g. double-clicked): an interactive menu that stays open.
//!   nomusic run [--input NAME] [--output NAME] [--level 0-100] [--no-rnnoise] [--dry-run] [--seconds N]
//!       Removes background music from system audio, live (see live.rs for the virtual-cable setup).
//!   nomusic devices
//!       Lists capture and playback devices.
//!   nomusic record <seconds> <prefix> [--input NAME] [--level 0-100] [--no-rnnoise]
//!       Records what the speakers play and saves it as <prefix>-original.wav and <prefix>-nomusic.wav.
//!   nomusic process <in.wav> <out.wav> [--no-rnnoise] [--level 0-100]
//!       Removes background music from a 48 kHz WAV file (mono or stereo).

mod default_device;
mod engine;
mod live;

use std::process::ExitCode;

use engine::{Engine, CHANNELS, LATENCY_FRAMES, SAMPLE_RATE};

fn usage() -> ExitCode {
    eprintln!(
        "usage:
  nomusic run [--input NAME] [--output NAME] [--level 0-100] [--no-rnnoise] [--dry-run] [--seconds N]
           nomusic devices
  nomusic record <seconds> <prefix> [--input NAME] [--level 0-100] [--no-rnnoise]
  nomusic process <in.wav> <out.wav> [--no-rnnoise] [--level 0-100]"
    );
    ExitCode::from(2)
}

struct Options {
    rnnoise: bool,
    wet: f32,
    input: Option<String>,
    output: Option<String>,
    dry_run: bool,
    seconds: Option<u64>,
}

fn parse_options(args: &[String], live: bool) -> Result<Options, String> {
    let mut opts = Options { rnnoise: true, wet: 1.0, input: None, output: None, dry_run: false, seconds: None };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--no-rnnoise" => opts.rnnoise = false,
            "--level" => {
                let v: f32 = it.next().and_then(|v| v.parse().ok()).ok_or("--level needs a number 0-100")?;
                opts.wet = (v / 100.0).clamp(0.0, 1.0);
            }
            "--input" if live => opts.input = Some(it.next().ok_or("--input needs a device name")?.clone()),
            "--output" if live => opts.output = Some(it.next().ok_or("--output needs a device name")?.clone()),
            "--dry-run" if live => opts.dry_run = true,
            "--seconds" if live => {
                opts.seconds = Some(it.next().and_then(|v| v.parse().ok()).ok_or("--seconds needs a number")?)
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

    write_wav(output, &out[start..end])
}

/// Writes interleaved 48 kHz stereo as 16-bit PCM.
pub fn write_wav(path: &str, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: CHANNELS as u16,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|e| format!("{path}: {e}"))?;
    for &s in samples {
        writer
            .write_sample((s.clamp(-1.0, 1.0) * 32767.0).round() as i16)
            .map_err(|e| format!("{path}: {e}"))?;
    }
    writer.finalize().map_err(|e| format!("{path}: {e}"))
}

fn read_line() -> Option<String> {
    let mut line = String::new();
    match std::io::stdin().read_line(&mut line) {
        Ok(0) | Err(_) => None, // stdin closed
        Ok(_) => Some(line.trim().to_lowercase()),
    }
}

fn exe_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| ".".into())
}

/// Menu for people who double-click the exe, so the console window never just flashes and closes.
fn interactive() -> ExitCode {
    println!("NoMusic for Windows - removes background music from what your laptop plays.
");
    loop {
        let cable = live::cable_installed();
        if cable {
            println!("  [1] Start live filtering (every app that plays through \"CABLE Input\")");
        } else {
            println!("  [1] Live filtering needs the free VB-Audio Virtual Cable: open its download page");
        }
        println!("  [2] Try it: record 30 seconds of what your speakers play, with and without NoMusic");
        println!("  [3] List audio devices");
        println!("  [Q] Quit");
        print!("> ");
        let _ = std::io::Write::flush(&mut std::io::stdout());
        let Some(choice) = read_line() else { return ExitCode::SUCCESS };
        println!();
        let result = match choice.as_str() {
            "1" if cable => live::run(live::Options {
                input: None,
                output: None,
                rnnoise: true,
                wet: 1.0,
                dry_run: false,
                seconds: None,
            }),
            "1" => {
                println!("Install it, reboot, and start NoMusic again.");
                std::process::Command::new("explorer.exe").arg("https://vb-audio.com/Cable/").spawn().map(drop).map_err(|e| e.to_string())
            }
            "2" => {
                let dir = exe_dir();
                let prefix = dir.join("nomusic-test").to_string_lossy().into_owned();
                let opts = live::Options { input: None, output: None, rnnoise: true, wet: 1.0, dry_run: true, seconds: None };
                live::record(30, &prefix, &opts).map(|()| {
                    println!("Play both files to compare.");
                    let _ = std::process::Command::new("explorer.exe").arg(&dir).spawn();
                })
            }
            "3" => live::list_devices(),
            "q" | "quit" | "exit" => return ExitCode::SUCCESS,
            _ => Ok(()),
        };
        if let Err(e) = result {
            println!("error: {e}");
        }
        println!();
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("process") if args.len() >= 3 => {
            parse_options(&args[3..], false).and_then(|opts| process_file(&args[1], &args[2], &opts))
        }
        Some("run") => parse_options(&args[1..], true).and_then(|o| {
            live::run(live::Options {
                input: o.input,
                output: o.output,
                rnnoise: o.rnnoise,
                wet: o.wet,
                dry_run: o.dry_run,
                seconds: o.seconds,
            })
        }),
        Some("devices") => live::list_devices(),
        Some("record") if args.len() >= 3 => match args[1].parse::<u64>() {
            Ok(seconds) if seconds > 0 => parse_options(&args[3..], true).and_then(|o| {
                let opts = live::Options {
                    input: o.input,
                    output: None,
                    rnnoise: o.rnnoise,
                    wet: o.wet,
                    dry_run: true,
                    seconds: None,
                };
                live::record(seconds, &args[2], &opts)
            }),
            _ => Err("record needs a number of seconds".into()),
        },
        None => return interactive(),
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
