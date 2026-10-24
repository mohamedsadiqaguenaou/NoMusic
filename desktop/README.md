# NoMusic desktop (Windows)

A native build of the NoMusic pipeline: the same FastEnhancer models as the extension, compiled natively
from [`wasm/runtime`](../wasm/runtime) (no WebAssembly), followed by RNNoise
([nnnoiseless](https://crates.io/crates/nnnoiseless), a Rust port of RNNoise) with the same two passes and
VAD gate as [`rnnoise-worklet.js`](../rnnoise-worklet.js).

[`src/engine.rs`](src/engine.rs) is a streaming engine for 48 kHz interleaved stereo. It takes chunks of any
size and adds `HOP + 480` samples (~21 ms) of latency. It keeps the extension's mono dedup: dual-mono hops
only run the left FastEnhancer stream.

## Usage

```powershell
nomusic process input.wav output.wav [--no-rnnoise] [--level 0-100]
```

Removes background music from a 48 kHz mono or stereo WAV file. `--level` matches the extension's
suppression level (100 = fully enhanced, 0 = original audio).

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
