/**
 * media-hook.js — NoMusic content script and audio engine (Firefox build)
 *
 * Firefox has no tabCapture, so instead of capturing the whole tab we reroute the page's own <video> and
 * <audio> elements through Web Audio and filter them right here, in the page's AudioContext:
 *   media elements -> FastEnhancer worklet -> per-channel RNNoise worklets -> analyser -> speakers
 * The worklets run on the real-time audio thread of the playing tab. (Processing in the background page
 * stuttered: Windows runs that process in efficiency mode.)
 *
 * The background decides which tab is filtered and tells us with MODE messages. In "bypass" mode hooked
 * elements play straight to the speakers (createMediaElementSource can't be undone, so we only hook once
 * filtering is wanted).
 */

(function () {
  'use strict';

  if (globalThis.__noMusicMediaHook) return;
  globalThis.__noMusicMediaHook = true;

  const SAMPLE_RATE = 48000;
  const CHANNEL_COUNT = 2;
  const FE_PROCESSOR_URL = browser.runtime.getURL('fe-worklet.js');
  const LITE_MODEL_URL = browser.runtime.getURL('assets/fastenhancer_t.wasm');
  const RNNOISE_PROCESSOR_URL = browser.runtime.getURL('rnnoise-worklet.js');
  const RNNOISE_WASM_URL = browser.runtime.getURL('assets/rnnoise.wasm');
  const RNNOISE_ENABLED = true;
  const STARTUP_FADE_S = 0.3;
  const VIZ_TTL_MS = 2500;

  let mode = 'bypass';            // 'filter' | 'bypass'
  let modelUrl = null;
  let wet = 1;
  let ctx = null;
  let inputNode = null;           // every hooked element connects here while filtering
  let feNode = null;
  let feNodeModel = null;
  let rnInput = null;             // RNNoise splitter (or analyser when RNNoise is off)
  let analyser = null;
  let outputGain = null;
  let graphReady = null;          // Promise for the worklet graph
  let graphFailed = false;        // e.g. the page's CSP blocks WebAssembly: play unfiltered
  const hooked = new Map();       // element -> MediaElementAudioSourceNode
  let vizUntil = 0;
  let vizTimer = null;

  // ── WebAssembly ───────────────────────────────────────────────────────────
  // The worklets compile the bytes themselves: a compiled WebAssembly.Module can't be handed from the
  // content script to the page's worklet. Pages whose CSP forbids WebAssembly therefore play unfiltered.
  const wasmBytes = new Map();
  function loadBytes(url) {
    if (!wasmBytes.has(url)) {
      const p = fetch(url).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + url);
        return r.arrayBuffer();
      });
      p.catch(() => wasmBytes.delete(url));
      wasmBytes.set(url, p);
    }
    return wasmBytes.get(url);
  }

  // Options for page-realm constructors must live in the page's compartment (Firefox Xrays).
  function pageOptions(options) {
    return typeof cloneInto === 'function' ? cloneInto(options, window) : options;
  }

  function waitReady(node, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' ready timeout')), 10000);
      node.port.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'PROCESSOR_READY') { clearTimeout(timer); resolve(); }
        if (data.type === 'ERROR') { clearTimeout(timer); reject(new Error(label + ': ' + data.error)); }
      };
      node.onprocessorerror = () => { clearTimeout(timer); reject(new Error(label + ' failed')); };
    });
  }

  // ── Audio graph ───────────────────────────────────────────────────────────

  function ensureContext() {
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
      inputNode = ctx.createGain();
    }
    return ctx;
  }

  async function createFeNode(url) {
    const bytes = await loadBytes(url);
    // Any heavier model starts on Lite while Firefox optimizes it (see fe-worklet.js).
    const liteBytes = url === LITE_MODEL_URL ? null : await loadBytes(LITE_MODEL_URL);
    const node = new AudioWorkletNode(ctx, 'fastenhancer-processor', pageOptions({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: CHANNEL_COUNT,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [CHANNEL_COUNT],
      processorOptions: { bytes: bytes.slice(0), liteBytes: liteBytes && liteBytes.slice(0), wet }
    }));
    await waitReady(node, 'FastEnhancer processor');
    return node;
  }

  async function createRnnoiseChain() {
    const bytes = await loadBytes(RNNOISE_WASM_URL);
    const splitter = ctx.createChannelSplitter(CHANNEL_COUNT);
    const merger = ctx.createChannelMerger(CHANNEL_COUNT);
    const ready = [];
    for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
      const node = new AudioWorkletNode(ctx, 'rnnoise-processor', pageOptions({
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        outputChannelCount: [1],
        processorOptions: { wasmBytes: bytes.slice(0) }
      }));
      ready.push(waitReady(node, 'RNNoise processor'));
      splitter.connect(node, channel, 0);
      node.connect(merger, 0, channel);
    }
    await Promise.all(ready);
    return { input: splitter, output: merger };
  }

  function ensureGraph() {
    if (graphReady) return graphReady;
    ensureContext();
    graphReady = (async () => {
      await Promise.all([
        ctx.audioWorklet.addModule(FE_PROCESSOR_URL),
        RNNOISE_ENABLED ? ctx.audioWorklet.addModule(RNNOISE_PROCESSOR_URL) : null
      ]);
      // FastEnhancer first: if the page's CSP forbids WebAssembly it reports that at once, while the
      // RNNoise worklet would only time out.
      const url = modelUrl;
      const fe = await createFeNode(url);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      outputGain = ctx.createGain();
      if (RNNOISE_ENABLED) {
        const chain = await createRnnoiseChain();
        chain.output.connect(analyser);
        rnInput = chain.input;
      } else {
        rnInput = analyser;
      }
      analyser.connect(outputGain);
      outputGain.connect(ctx.destination);
      feNode = fe;
      feNodeModel = url;
      feNode.connect(rnInput);
      if (mode === 'filter') inputNode.connect(feNode);
      await syncModel(); // the model may have changed meanwhile
    })();
    graphReady.catch((err) => {
      graphFailed = true;
      applyMode();
      reportError(err);
    });
    return graphReady;
  }

  // (Re)build the FastEnhancer node when the selected model changes.
  async function syncModel() {
    if (!modelUrl || feNodeModel === modelUrl) return;
    const url = modelUrl;
    const node = await createFeNode(url);
    if (feNode) {
      try { inputNode.disconnect(feNode); } catch (_) {}
      try { feNode.disconnect(); } catch (_) {}
    }
    feNode = node;
    feNodeModel = url;
    feNode.connect(rnInput);
    if (mode === 'filter') inputNode.connect(feNode);
  }

  function fadeIn() {
    if (!outputGain) return;
    const now = ctx.currentTime;
    outputGain.gain.cancelScheduledValues(now);
    outputGain.gain.setValueAtTime(0, now);
    outputGain.gain.linearRampToValueAtTime(1, now + STARTUP_FADE_S);
  }

  function route(source) {
    try { source.disconnect(); } catch (_) {}
    source.connect(mode === 'filter' && !graphFailed ? inputNode : ctx.destination);
  }

  // Connect or disconnect the processing chain so the worklets only work while filtering.
  function applyMode() {
    if (!ctx) return;
    for (const source of hooked.values()) route(source);
    if (!feNode) return;
    try { inputNode.disconnect(); } catch (_) {}
    if (mode === 'filter') {
      feNode.port.postMessage({ type: 'RESET' });
      inputNode.connect(feNode);
      fadeIn();
    }
  }

  // ── Media elements ────────────────────────────────────────────────────────

  // createMediaElementSource outputs silence for cross-origin media loaded without CORS, which would mute
  // the video entirely — leave those elements alone (they play unfiltered).
  function canHook(el) {
    if (el.srcObject) return false;
    const src = el.currentSrc || el.src;
    if (!src) return true; // no source yet (e.g. MSE attaches later)
    if (src.startsWith('blob:') || src.startsWith('data:')) return true;
    if (el.crossOrigin != null) return true;
    try { return new URL(src, location.href).origin === location.origin; } catch (_) { return false; }
  }

  function hook(el) {
    if (mode !== 'filter' || graphFailed || hooked.has(el) || !canHook(el)) return;
    try {
      ensureContext();
      const source = ctx.createMediaElementSource(el);
      hooked.set(el, source);
      route(source);
    } catch (err) {
      // Already captured by the page's own AudioContext, or similar — it plays unfiltered.
      console.debug('[NoMusic] could not hook media element:', err && err.message);
      return;
    }
    ensureGraph().then(() => { if (mode === 'filter') fadeIn(); }).catch(() => {});
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // `play` doesn't bubble, but capture-phase listeners on the document see it for every element in the
  // document (including ones created later). Elements never inserted into the DOM aren't covered.
  document.addEventListener('play', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLMediaElement)) return;
    hook(el);
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }, true);

  // ── Background messages ───────────────────────────────────────────────────

  function setMode(next) {
    if (next.modelUrl) modelUrl = next.modelUrl;
    if (typeof next.wet === 'number') setWet(next.wet);
    const changed = next.mode !== mode;
    mode = next.mode;
    if (mode === 'filter') {
      for (const el of document.querySelectorAll('video, audio')) hook(el);
      if (graphReady) graphReady.then(syncModel).catch(() => {}); // ensureGraph reports failures
    }
    if (changed) applyMode();
  }

  function setWet(value) {
    wet = Math.max(0, Math.min(1, value));
    if (feNode) feNode.port.postMessage({ type: 'SET_WET', wet });
  }

  function reportError(err) {
    console.error('[NoMusic]', err);
    browser.runtime.sendMessage({ type: 'NM_ERROR', error: err.message || String(err) }).catch(() => {});
  }

  // Spectrum frames for the popup, only while it asks for them.
  function startViz() {
    vizUntil = Date.now() + VIZ_TTL_MS;
    if (vizTimer || !analyser) return;
    const freq = new Uint8Array(analyser.frequencyBinCount);
    vizTimer = setInterval(() => {
      if (Date.now() > vizUntil || mode !== 'filter') {
        clearInterval(vizTimer);
        vizTimer = null;
        return;
      }
      analyser.getByteFrequencyData(freq);
      browser.runtime.sendMessage({ type: 'DF_FREQ_DATA', data: Array.from(freq) }).catch(() => {});
    }, 50);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'NM_MODE') setMode(msg);
    else if (msg.type === 'NM_SET_WET') setWet(msg.wet);
    else if (msg.type === 'NM_VIZ' && hooked.size) startViz(); // only frames that are playing media
  });

  // Ask whether this tab is the filtered one (also wakes the background after it was unloaded).
  browser.runtime.sendMessage({ type: 'NM_HELLO' }).then((resp) => {
    if (resp && resp.mode) setMode(resp);
  }).catch(() => {});
})();
