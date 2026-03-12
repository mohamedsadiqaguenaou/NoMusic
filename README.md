# NoMusic - Remove Background Music From Videos


NoMusic is a browser extension that removes background music from tab audio in real time with an entirely local processing pipeline.

Chrome Web Store:
https://chromewebstore.google.com/detail/fepfnjijcojaoihcekfhonohejglmdbc?utm_source=github.com

## What It Does

- Captures the active tab audio stream.
- Runs speech enhancement in the browser with ONNX Runtime Web and Web Audio worklets.
- Applies RNNoise denoising after enhancement.
- Auto-follows the active tab when the extension is enabled.
- Keeps processing on-device with no backend service.

The current extension is aimed at people who want to watch online video content without background music.

## How It Works

The extension is built around a Manifest V3 service worker and an offscreen document:

- [background.js](background.js) manages extension state, the offscreen document, active-tab tracking, tab capture orchestration, and popup messaging.
- [offscreen.js](offscreen.js) creates the audio graph and coordinates the real-time processing pipeline.
- [ulunas-worker.js](ulunas-worker.js) runs the FastEnhancer ONNX model in a worker.
- [ring-buffer-audio-processor.js](ring-buffer-audio-processor.js) bridges audio frames between the Web Audio graph and the worker through shared buffers.
- [rnnoise-worklet.js](rnnoise-worklet.js) runs RNNoise as an AudioWorklet stage.
- [popup.js](popup.js) powers the browser action UI.

At a high level, the pipeline is:

1. Capture the current tab audio.
2. Feed stereo audio into the FastEnhancer worker.
3. Pass the enhanced stream through per-channel RNNoise worklets.
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
- [icons](icons): Extension icons.

## Load From Source

1. Clone or download this repository.
2. Open Chrome and go to chrome://extensions.
3. Enable Developer mode.
4. Select Load unpacked.
5. Choose this project folder.

## Development Notes

- There is no build step in the current repository. The extension can be loaded directly from source.
- The audio pipeline uses local model/runtime assets already committed under [assets](assets).
- Manifest permissions currently include tab capture, tabs, storage, active tab access, and offscreen documents.

## Privacy

NoMusic is designed to process audio locally in the browser. This repository does not include a server component, remote inference service, or cloud upload path for captured audio.

## Third-Party Components

This repository includes or depends on third-party runtime/model assets, including ONNX Runtime Web, RNNoise runtime assets, and the FastEnhancer model file committed under [assets](assets).

If you redistribute this project, keep the relevant third-party license terms, attribution requirements, and model usage terms in mind.

## Acknowledgements

This project builds on open-source speech enhancement and inference work from the following repositories:

- FastEnhancer: https://github.com/aask1357/fastenhancer
	- Source for the FastEnhancer speech-enhancement model family.
	- The bundled [assets/fastenhancer_s.onnx](assets/fastenhancer_s.onnx) is based on the FastEnhancer ONNX releases.
- RNNoise: https://github.com/xiph/rnnoise
	- Source for the RNNoise denoising model/runtime used in the browser audio pipeline.
	- The bundled [assets/rnnoise.wasm](assets/rnnoise.wasm) and [rnnoise-worklet.js](rnnoise-worklet.js) are part of this integration layer.
- ONNX Runtime: https://github.com/microsoft/onnxruntime
	- Source for the ONNX Runtime Web engine used to execute the FastEnhancer model in-browser.
	- Bundled runtime files live under [assets/vendor/onnxruntime](assets/vendor/onnxruntime).

Credit goes to the authors and contributors of those projects for the underlying models, runtimes, and research this extension depends on.

## License

This project is open-sourced under the ISC license. See [LICENSE](LICENSE).