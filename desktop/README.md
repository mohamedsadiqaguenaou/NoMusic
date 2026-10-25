# NoMusic desktop (Windows)

A native build of the NoMusic pipeline: the same FastEnhancer models as the extension, compiled natively
from [`wasm/runtime`](../wasm/runtime) (no WebAssembly), followed by RNNoise
([nnnoiseless](https://crates.io/crates/nnnoiseless), a Rust port of RNNoise) with the same two passes and
VAD gate as [`rnnoise-worklet.js`](../rnnoise-worklet.js).

[`src/engine.rs`](src/engine.rs) is a streaming engine for 48 kHz interleaved stereo. It takes chunks of any
size and adds `HOP + 480` samples (~21 ms) of latency. It keeps the extension's mono dedup: dual-mono hops
only run the left FastEnhancer stream.

## Usage

### Live: remove music from everything the laptop plays

Windows can't take audio away from other apps without a driver, so NoMusic uses the free
[VB-Audio Virtual Cable](https://vb-audio.com/Cable/):

1. Install VB-Audio Virtual Cable and reboot.
2. Run `nomusic run`. It captures from **CABLE Output** and plays the filtered audio on your normal
   speakers or headphones (the default playback device, or `--output NAME`).
3. In Windows Sound settings, set **CABLE Input** as the default playback device. Games, browsers and
   everything else now play through NoMusic.
4. Optional: set CABLE Input/Output to 48000 Hz (Sound settings → device properties). Other rates work but
   are resampled.

To turn NoMusic off, set your speakers back as the default playback device.

```powershell
nomusic run [--input NAME] [--output NAME] [--level 0-100] [--no-rnnoise]
nomusic devices          # list capture and playback devices
```

The model keeps speech and removes everything else, so game sound effects are reduced along with the
music. Lower `--level` to blend some of the original back in.

### Try it without the cable

```powershell
nomusic record 30 test   # records what the speakers play -> test-original.wav, test-nomusic.wav
```

### Files

```powershell
nomusic process input.wav output.wav [--no-rnnoise] [--level 0-100]
```

Removes background music from a 48 kHz mono or stereo WAV file. `--level` matches the extension's
suppression level (100 = fully enhanced, 0 = original audio).

`--dry-run` (for `run`) captures and filters without playing anything, and `--seconds N` stops after N
seconds. Both are for testing.

## Building

```powershell
cd desktop
cargo build --release            # Standard model -> target/release/nomusic.exe
cargo build --release --no-default-features --features lite   # Lite model
cargo test --release
```

Only one model is compiled into each binary, because the runtime crate selects its model with mutually
exclusive features.

Toolchain: Rust with either the MSVC target (needs the Visual Studio C++ build tools) or the GNU target
(`rustup default stable-x86_64-pc-windows-gnu`, plus a MinGW-w64 toolchain such as WinLibs on `PATH` for
`dlltool`/`as`). The release binary only depends on system DLLs.

Native speed of FastEnhancer Standard on a laptop CPU: ~1.9 ms per 512-sample hop per channel (10.7 ms of
audio), or ~1.3 ms with `RUSTFLAGS="-C target-cpu=x86-64-v3"`.
