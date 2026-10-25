<div align="center">
  <img src="https://github.com/mohamedsadiqaguenaou/NoMusic/blob/main/icons/NoMusic(transparent).png?raw=true" alt="NoMusic" width="200"/>
</div>

# NoMusic - Remove Background Music From Videos


NoMusic is a browser extension that removes background music from tab audio in real time with an entirely local processing pipeline.

## Install

* **Chrome Web Store:**  
  <a href="https://chromewebstore.google.com/detail/fepfnjijcojaoihcekfhonohejglmdbc?utm_source=github.com"><img src="imgs/chrome.png" alt="Chrome Web Store" height="50"></a>
* **Microsoft Edge Add-ons:**  
  <a href="https://microsoftedge.microsoft.com/addons/detail/gbdhjflcmaleljgbmmmikodompohnoop"><img src="imgs/edge.png" alt="Edge Add-ons" height="50"></a>

## What It Does

- Captures the active tab audio stream.
- Runs speech enhancement in the browser with FastEnhancer compiled ahead of time into a standalone WebAssembly module (no ONNX Runtime), plus Web Audio worklets.
- Offers multiple audio models (Standard and Lite) to balance between processing power and audio quality.
- Runs an RNNoise denoising stage after FastEnhancer enhancement for additional noise suppression.
- Auto-follows the active tab when the extension is enabled. Turn off **Turn on automatically** in Settings to start filtering only from the power button.
- Adapts to slow machines: when the model can't keep up, it steps down (mono, then fewer RNNoise passes) instead of stuttering, and suggests the Lite model if that isn't enough. The engine sleeps while nothing is being filtered.
- Keeps processing on-device with no backend service.
- Includes English and Arabic localizations for the popup interface.

The current extension is aimed at people who want to watch online video content without background music.

## How It Works

The extension is built around a Manifest V3 service worker and an offscreen document:

- [background.js](background.js) manages extension state, the offscreen document, active-tab tracking, tab capture orchestration, and popup messaging.
- [offscreen.js](offscreen.js) creates the audio graph and coordinates the real-time processing pipeline.
- [fastenhancer-worker.js](fastenhancer-worker.js) runs the natively compiled FastEnhancer WASM module in a worker. It processes dual-mono audio only once, and is woken by the audio worklet instead of polling.
- [ring-buffer-audio-processor.js](ring-buffer-audio-processor.js) bridges audio frames between the Web Audio graph and the worker through shared buffers.
- [rnnoise-worklet.js](rnnoise-worklet.js) runs RNNoise as a per-channel AudioWorklet stage after FastEnhancer, for additional noise suppression.
- [popup.js](popup.js) powers the browser action UI.

At a high level, the pipeline is:

1. Capture the current tab audio.
2. Feed stereo audio into the FastEnhancer worker.
3. Pass the enhanced stream through per-channel RNNoise worklets for additional noise suppression.
4. Play the processed result back to the user.

## Project Structure

- [manifest.json](manifest.json): Chrome extension manifest.
- [background.js](background.js): Manifest V3 service worker.
- [offscreen.html](offscreen.html): Offscreen host page.
- [offscreen.js](offscreen.js): Audio processing engine.
- [popup.html](popup.html): Popup UI.
- [popup.js](popup.js): Popup behavior.
- [styles.css](styles.css): Popup styling.
- [assets](assets): Bundled model and runtime assets.
- [wasm](wasm): ONNX → WASM compiler, Rust runtime kernels, and verification tests for the FastEnhancer modules (see [wasm/README.md](wasm/README.md)).
- [icons](icons): Extension icons.

## Load From Source

1. Clone or download this repository.
2. Open Chrome and go to chrome://extensions.
3. Enable Developer mode.
4. Select Load unpacked.
5. Choose this project folder.

## Development Notes

- The extension can be loaded directly from source; the prebuilt `assets/fastenhancer_{s,t}.wasm` modules are committed.
- To rebuild the FastEnhancer modules after changing the models or kernels, run `npm run build:wasm` (needs Python with `onnx`/`numpy` and Rust with the `wasm32-unknown-unknown` target), then `npm test` to check them against onnxruntime. See [wasm/README.md](wasm/README.md).
- When packaging for a store, the [wasm](wasm) folder (and especially `wasm/runtime/target`) can be excluded; it is only build tooling.
- The audio pipeline uses local model/runtime assets already committed under [assets](assets).
- Manifest permissions currently include tab capture, tabs, storage, active tab access, and offscreen documents.

## Privacy

NoMusic is designed to process audio locally in the browser. This repository does not include a server component, remote inference service, or cloud upload path for captured audio.

## Third-Party Components

This repository includes third-party runtime/model assets, including RNNoise runtime assets and FastEnhancer model weights (the original ONNX exports under [wasm/models](wasm/models), compiled into [assets](assets)).

If you redistribute this project, keep the relevant third-party license terms, attribution requirements, and model usage terms in mind.

## Acknowledgements

This project builds on open-source speech enhancement and inference work from the following repositories:

- FastEnhancer: https://github.com/aask1357/fastenhancer
	- Source for the FastEnhancer speech-enhancement model family.
	- `assets/fastenhancer_s.wasm` (Standard) and `assets/fastenhancer_t.wasm` (Lite) are compiled from the FastEnhancer ONNX releases (kept in [wasm/models](wasm/models)) by [wasm/compiler/fe_compile.py](wasm/compiler/fe_compile.py).
- RNNoise: https://github.com/xiph/rnnoise
	- Source for the RNNoise denoising model/runtime used in the browser audio pipeline.
	- The bundled [assets/rnnoise.wasm](assets/rnnoise.wasm) and [rnnoise-worklet.js](rnnoise-worklet.js) are part of this integration layer.
- ONNX (https://github.com/onnx/onnx) and onnxruntime (https://github.com/microsoft/onnxruntime)
	- Used only at build/test time: the ONNX graph is the compiler input, and onnxruntime provides the reference outputs the WASM modules are verified against.

Credit goes to the authors and contributors of those projects for the underlying models, runtimes, and research this extension depends on.

## License

This project is open-sourced under the ISC license. See [LICENSE](LICENSE).