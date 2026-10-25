/**
 * offscreen.js - NoMusic audio processing engine
 *
 * The offscreen document hosts a streaming FastEnhancer (+ optional RNNoise) pipeline:
 * source -> FastEnhancer worker -> [per-channel RNNoise, if RNNOISE_ENABLED] -> analyser -> speakers
 */

'use strict';

const DEFAULT_MODEL_URL = chrome.runtime.getURL('assets/fastenhancer_s.wasm');
const ALL_MODEL_URLS = [DEFAULT_MODEL_URL, chrome.runtime.getURL('assets/fastenhancer_t.wasm')];
const WORKER_URL = chrome.runtime.getURL('fastenhancer-worker.js');
const PROCESSOR_URL = chrome.runtime.getURL('ring-buffer-audio-processor.js');
const RNNOISE_WASM_URL = chrome.runtime.getURL('assets/rnnoise.wasm');
const RNNOISE_PROCESSOR_URL = chrome.runtime.getURL('rnnoise-worklet.js');
// RNNoise post-filter runs after FastEnhancer for additional noise suppression.
const RNNOISE_ENABLED = true;
const SAMPLE_RATE = 48000;
const CHANNEL_COUNT = 2;
const FE_HOP_SIZE = 512; // samples per FastEnhancer hop (fe_hop_size() of the wasm modules)
const STARTUP_FADE_MS = 1000;
const TARGET_BUFFER_MS = 160;
const SAB_FRAMES = Math.ceil((SAMPLE_RATE * CHANNEL_COUNT * TARGET_BUFFER_MS) / 1000);
const SAB_BYTES = SAB_FRAMES * Float32Array.BYTES_PER_ELEMENT + 8;

let audioCtx = null;
let workletNode = null;
let sourceNode = null;
let analyzerNode = null;
let outputGainNode = null;
let rnnoiseSplitNode = null;
let rnnoiseMergeNode = null;
let rnnoiseNodes = [];
let captureStream = null;
let animInterval = null;
let keepAliveInterval = null;
let vizWantedUntil = 0;           // spectrum frames are sent until this time (ms since epoch)
const VIZ_WANTED_TTL_MS = 2500;   // popup pings every second; stop shortly after it closes
const KEEPALIVE_MS = 20000;       // < 30 s MV3 service-worker idle timeout
let isActive = false;
let startInProgress = false;

// ── Load guard (ported from TV Akhi) ─────────────────────────────────────────
// The worker reports the share of real time spent in FastEnhancer about once a second. On a slow machine,
// sustained high load means stutter is coming, so step down to lighter processing, one step at a time:
//   1. mono: process the mix of both channels once (voices sit in the middle): half the model's work;
//   2. one RNNoise pass instead of two;   3. RNNoise off.
// After the last step the popup suggests the Lite model. Every new session starts at full quality again.
const LIGHTEN_LOAD = 0.75;   // share of real time in the model (the worker thread can't go much past ~1)
const LIGHTEN_AFTER_S = 3;   // consecutive slow reports before stepping down
const LIGHTEN_STEPS = ['mono', 'one RNNoise pass', 'RNNoise off'];
let lightenStep = 0;
let slowReports = 0;

let warmCtx = null;
let warmWorklet = null;
let warmWorker = null;
let warmRawSab = null;
let warmDenoSab = null;
let warmModelUrl = null;  // which model URL the current warm worker was loaded with
let activeModelVariant = null; // wasm file the worker actually loaded
let warmRnnoiseChain = null; // cached RNNoise splitter/merger/nodes for the warm ctx
let activeWorker = null;
let engineReady = false;
let warming = null;
let activeSabs = null;
let workerReady = false;
let rnnoiseBytes = null;
let rnnoiseLoading = null;

function sendStatus(state, extra) {
  chrome.runtime.sendMessage({ type: 'DF_STATUS', state, ...(extra || {}) }).catch(() => {});
}

function setRnnoisePasses(passes) {
  for (const node of rnnoiseNodes) {
    try { node.port.postMessage({ type: 'SET_PASSES', passes }); } catch (_) {}
  }
}

function resetLoadGuard(worker) {
  lightenStep = 0;
  slowReports = 0;
  worker.postMessage({ command: 'set_mono', enabled: false });
  setRnnoisePasses(2);
}

function onWorkerLoad(load) {
  slowReports = load > LIGHTEN_LOAD ? slowReports + 1 : 0;
  if (slowReports < LIGHTEN_AFTER_S || lightenStep >= LIGHTEN_STEPS.length || !activeWorker) return;
  slowReports = 0;
  const step = LIGHTEN_STEPS[lightenStep++];
  if (step === 'mono') activeWorker.postMessage({ command: 'set_mono', enabled: true });
  else setRnnoisePasses(step === 'one RNNoise pass' ? 1 : 0);
  console.info('[NoMusic] slow machine: model at ' + Math.round(load * 100) + '% of real time, now ' + step);
  chrome.runtime.sendMessage({
    type: 'DF_PERF', step, lightest: lightenStep >= LIGHTEN_STEPS.length
  }).catch(() => {});
}

// ── FastEnhancer module cache ────────────────────────────────────────────────
// Each model is downloaded and compiled once (streaming compile) and the compiled WebAssembly.Module is
// handed to the worker, so worker restarts and model switches skip both the fetch and the compile.
const moduleCache = new Map(); // model URL -> Promise<{ module, file }>
let prefetchTimer = null;

async function compileWasm(url) {
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(fetch(url));
    } catch (err) {
      if (err instanceof WebAssembly.CompileError) throw err;
      // otherwise (e.g. MIME type not application/wasm) retry via ArrayBuffer below
    }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching ' + url);
  return WebAssembly.compile(await response.arrayBuffer());
}

function loadModelModule(url) {
  let entry = moduleCache.get(url);
  if (!entry) {
    entry = compileWasm(url).then((module) => ({ module, file: url }));
    entry.catch(() => moduleCache.delete(url));
    moduleCache.set(url, entry);
  }
  return entry;
}

// After the engine is warm, compile the other model tier in the background so switching is instant.
function scheduleModulePrefetch() {
  if (prefetchTimer) return;
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    for (const url of ALL_MODEL_URLS) loadModelModule(url).catch(() => {});
  }, 5000);
}

async function loadRnnoiseAssets() {
  if (rnnoiseBytes) return rnnoiseBytes;
  if (rnnoiseLoading) return rnnoiseLoading;

  rnnoiseLoading = (async () => {
    const response = await fetch(RNNOISE_WASM_URL);
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' fetching rnnoise.wasm');
    }
    rnnoiseBytes = await response.arrayBuffer();
    rnnoiseLoading = null;
    return rnnoiseBytes;
  })().catch((error) => {
    rnnoiseLoading = null;
    throw error;
  });

  return rnnoiseLoading;
}

async function createRnnoiseChain(ctx) {
  const wasmBytes = await loadRnnoiseAssets();
  const splitter = ctx.createChannelSplitter(CHANNEL_COUNT);
  const merger = ctx.createChannelMerger(CHANNEL_COUNT);
  const nodes = [];
  const readyPromises = [];

  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    // Slice a copy for each channel — Transfer on first channel would invalidate the buffer
    // for subsequent channels, so we always pass a copy (slice).
    const channelBytes = wasmBytes.slice(0);
    const node = new AudioWorkletNode(ctx, 'rnnoise-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [1],
      processorOptions: { wasmBytes: channelBytes }
    });

    readyPromises.push(new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RNNoise processor ready timeout')), 10000);
      node.port.onmessage = (event) => {
        if (event.data && event.data.type === 'PROCESSOR_READY') { clearTimeout(timer); resolve(); }
      };
      node.onprocessorerror = () => { clearTimeout(timer); reject(new Error('RNNoise processor warm-up failed')); };
    }));

    splitter.connect(node, channel, 0);
    node.connect(merger, 0, channel);
    nodes.push(node);
  }

  await Promise.all(readyPromises);
  for (const node of nodes) {
    node.port.onmessage = null;
    node.onprocessorerror = null;
  }

  return { splitter, merger, nodes };
}

async function preWarmEngine(modelUrl) {
  const targetModel = modelUrl || DEFAULT_MODEL_URL;
  if (engineReady && warmModelUrl === targetModel) return;
  // If engine is ready but for a different model, tear it down first
  if (engineReady && warmModelUrl !== targetModel) {
    engineReady = false;
    warming = null;
    if (warmWorker) { try { warmWorker.postMessage({ command: 'stop' }); warmWorker.terminate(); } catch (_) {} }
    if (warmRnnoiseChain) {
      try { warmRnnoiseChain.splitter.disconnect(); } catch (_) {}
      try { warmRnnoiseChain.merger.disconnect(); } catch (_) {}
      for (const n of warmRnnoiseChain.nodes) { try { n.port.postMessage({ type: 'STOP' }); n.disconnect(); } catch (_) {} }
      warmRnnoiseChain = null;
    }
    if (warmCtx) { try { warmCtx.close(); } catch (_) {} }
    warmWorker = null; warmCtx = null; warmWorklet = null;
    warmRawSab = null; warmDenoSab = null; warmModelUrl = null;
  }
  if (warming) return warming;

  warming = (async () => {
    let worker = warmWorker;
    let rawSab = warmRawSab;
    let denoSab = warmDenoSab;
    let workerIsNew = false;

    let compiledModule = null;
    if (!worker) {
      // Compile (or reuse) the model in parallel with the worker's start-up.
      compiledModule = loadModelModule(targetModel).catch((err) => {
        console.warn('[NoMusic] FastEnhancer precompile failed, worker will load it itself:', err);
        return null;
      });
      rawSab = new SharedArrayBuffer(SAB_BYTES);
      denoSab = new SharedArrayBuffer(SAB_BYTES);
      worker = new Worker(WORKER_URL);
      workerIsNew = true;
    }

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('FastEnhancer worker init timeout')), 45000);

      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'FETCH_WASM') {
          Promise.resolve(compiledModule).then((compiled) => {
            worker.postMessage({
              command: 'init',
              rawSab,
              denoisedSab: denoSab,
              modelUrl: targetModel,
              suppressionLevel: 100,
              // compiled WebAssembly.Module (structured-cloned, no recompile in the worker)
              module: compiled ? compiled.module : undefined,
              moduleFile: compiled ? compiled.file : undefined
            });
          });
          return;
        }
        if (data.type === 'SETUP_AWP') {
          clearTimeout(timeout);
          activeModelVariant = data.variant || targetModel;
          console.info('[NoMusic] FastEnhancer native WASM loaded:', activeModelVariant.split('/').pop());
          workerReady = true;
          resolve();
          return;
        }
        if (data.type === 'ERROR') {
          clearTimeout(timeout);
          reject(new Error(data.error || 'FastEnhancer worker error'));
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error('FastEnhancer worker script error: ' + (event.message || event)));
      };

      if (!workerIsNew) {
        clearTimeout(timeout);
        workerReady = true;
        resolve();
      }
    });

    if (RNNOISE_ENABLED) await loadRnnoiseAssets();

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await Promise.all([
      ctx.audioWorklet.addModule(PROCESSOR_URL),
      RNNOISE_ENABLED ? ctx.audioWorklet.addModule(RNNOISE_PROCESSOR_URL) : null
    ]);

    const node = new AudioWorkletNode(ctx, 'ring-buffer-audio-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [2],
      // notifyThreshold: wake the worker once one full FastEnhancer hop (interleaved stereo) is queued
      processorOptions: { rawSab, denoisedSab: denoSab, notifyThreshold: FE_HOP_SIZE * CHANNEL_COUNT }
    });

    await new Promise((resolve, reject) => {
      node.port.onmessage = (event) => {
        if (event.data && event.data.type === 'PROCESSOR_READY') resolve();
      };
      node.onprocessorerror = () => reject(new Error('Audio processor warm-up failed'));
    });
    node.port.onmessage = null;

    // Pre-build the RNNoise chain once for this AudioContext — reused on every start()
    const rnChain = RNNOISE_ENABLED ? await createRnnoiseChain(ctx) : null;

    warmCtx = ctx;
    warmWorklet = node;
    warmWorker = worker;
    warmRawSab = rawSab;
    warmDenoSab = denoSab;
    warmModelUrl = targetModel;
    warmRnnoiseChain = rnChain;
    engineReady = true;
    warming = null;

    // Idle until the first start: no worker or audio thread wake-ups while nothing is filtered.
    worker.postMessage({ command: 'pause' });
    await ctx.suspend().catch(() => {});

    chrome.runtime.sendMessage({ type: 'ENGINE_READY' }).catch(() => {});
    scheduleModulePrefetch();
  })().catch((err) => {
    engineReady = false;
    warming = null;
    warmCtx = null;
    warmWorklet = null;
    warmRnnoiseChain = null;
    warmModelUrl = null;
    throw err;
  });

  return warming;
}

async function start({ streamId, suppressionLevel = 100, modelUrl }) {
  if (startInProgress) return;
  startInProgress = true;

  if (isActive) await stop();

  const targetModel = modelUrl || DEFAULT_MODEL_URL;

  try {
    sendStatus('loading', { step: 'model', progress: 0.2 });
    await preWarmEngine(targetModel);
    // A warm-up for another model may have been in flight; rebuild for the requested one if so.
    if (warmModelUrl !== targetModel) await preWarmEngine(targetModel);
    sendStatus('loading', { step: 'compiling', progress: 0.8 });
    sendStatus('loading', { step: 'capture', progress: 1 });

    audioCtx = warmCtx;
    workletNode = warmWorklet;
    const worker = warmWorker;
    activeSabs = { rawSab: warmRawSab, denoSab: warmDenoSab };
    activeWorker = worker;

    // Take the pre-built RNNoise chain — do NOT create a new one (avoids WASM OOM)
    const rnnoiseChain = warmRnnoiseChain;

    warmCtx = null;
    warmWorklet = null;
    warmWorker = null;
    warmRawSab = null;
    warmDenoSab = null;
    warmRnnoiseChain = null;
    engineReady = false;

    worker.postMessage({ command: 'RESET_BUFFERS' });
    worker.postMessage({ command: 'set_suppression_level', level: suppressionLevel });
    worker.postMessage({ command: 'resume' });

    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'LOAD') {
        onWorkerLoad(data.load);
        return;
      }
      if (data.type === 'ERROR') {
        console.error('[NoMusic FastEnhancer worker error]', data.error);
        sendStatus('error', { error: 'FastEnhancer worker error: ' + data.error });
        stop();
      }
    };

    workletNode.onprocessorerror = (err) => {
      console.error('[NoMusic audio processor error]', err);
      sendStatus('error', { error: 'Audio processor error: ' + err.message });
      stop();
    };

    captureStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });

    try {
      await captureStream.getAudioTracks()[0].applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      });
    } catch (_) {}

    if (audioCtx.state === 'suspended') await audioCtx.resume();

    rnnoiseSplitNode = rnnoiseChain ? rnnoiseChain.splitter : null;
    rnnoiseMergeNode = rnnoiseChain ? rnnoiseChain.merger : null;
    rnnoiseNodes = rnnoiseChain ? rnnoiseChain.nodes : [];
    resetLoadGuard(worker);
    for (const node of rnnoiseNodes) {
      node.onprocessorerror = (err) => {
        console.error('[NoMusic RNNoise processor error]', err);
        sendStatus('error', { error: 'RNNoise processor error: ' + err.message });
        stop();
      };
    }

    analyzerNode = audioCtx.createAnalyser();
    analyzerNode.fftSize = 256;
    analyzerNode.smoothingTimeConstant = 0.8;
    outputGainNode = audioCtx.createGain();
    outputGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    outputGainNode.gain.linearRampToValueAtTime(1, audioCtx.currentTime + (STARTUP_FADE_MS / 1000));

    sourceNode = audioCtx.createMediaStreamSource(captureStream);
    sourceNode.connect(workletNode);
    if (rnnoiseChain) {
      workletNode.connect(rnnoiseSplitNode);
      rnnoiseMergeNode.connect(analyzerNode);
    } else {
      workletNode.connect(analyzerNode);
    }
    analyzerNode.connect(outputGainNode);
    outputGainNode.connect(audioCtx.destination);

    isActive = true;
    sendStatus('active', { latency: 11, engine: activeModelVariant ? activeModelVariant.split('/').pop() : null });

    // Spectrum frames are only produced while a popup is showing the visualizer (it pings VIZ_WANTED).
    const freqData = new Uint8Array(analyzerNode.frequencyBinCount);
    animInterval = setInterval(() => {
      if (!analyzerNode || Date.now() > vizWantedUntil) return;
      analyzerNode.getByteFrequencyData(freqData);
      chrome.runtime.sendMessage({ type: 'DF_FREQ_DATA', data: Array.from(freqData) }).catch(() => {});
    }, 50);
    // The spectrum stream used to keep the service worker awake as a side effect; keep it alive explicitly.
    keepAliveInterval = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'NOMUSIC_KEEPALIVE' }).catch(() => {});
    }, KEEPALIVE_MS);

    // Do NOT call preWarmEngine here — creating new WASM while the session is active
    // would OOM. The warm pool is replenished automatically when stop() recycles this
    // AudioContext and RNNoise chain back, so next start() is instant at no extra cost.
  } catch (err) {
    console.error('[NoMusic] FastEnhancer start error:', err);
    await stop(true);
    sendStatus('error', { error: err.message || String(err) });
  } finally {
    startInProgress = false;
  }
}

async function stop(keepStatus) {
  clearInterval(animInterval);
  animInterval = null;
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;

  const disconnectAll = (node) => {
    try { node && node.disconnect(); } catch (_) {}
  };

  // Fully disconnect source and output chain — these are never recycled.
  disconnectAll(sourceNode);
  disconnectAll(analyzerNode);
  disconnectAll(outputGainNode);
  sourceNode = null;
  analyzerNode = null;
  outputGainNode = null;

  if (workletNode && audioCtx) {
    if (!engineReady && !warmWorklet) {
      // ── RECYCLE PATH ───────────────────────────────────────────────────────
      // Keep the AudioContext alive and re-adopt everything back into the warm
      // pool so the next start() is instant with zero new WASM allocations.
      //
      // Only sever the two EXTERNAL connections we added in start():
      //   sourceNode → workletNode   (already gone — sourceNode disconnected above)
      //   workletNode → rnnoiseSplitNode
      //   rnnoiseMergeNode → analyzerNode  (already gone — analyzerNode disconnected above)
      // The INTERNAL chain wiring (splitter→nodes→merger) is intentionally
      // preserved so the recycled chain is ready to use immediately.
      // Without RNNoise the worklet feeds the (discarded) analyser directly, so drop all its outputs.
      if (rnnoiseSplitNode) {
        try { workletNode.disconnect(rnnoiseSplitNode); } catch (_) {
          try { workletNode.disconnect(); } catch (_) {}
        }
      } else {
        try { workletNode.disconnect(); } catch (_) {}
      }

      warmWorklet   = workletNode;
      warmCtx       = audioCtx;
      warmWorker    = activeWorker;
      warmRawSab    = activeSabs ? activeSabs.rawSab  : null;
      warmDenoSab   = activeSabs ? activeSabs.denoSab : null;
      warmModelUrl  = warmModelUrl; // unchanged — same model was active
      warmRnnoiseChain = rnnoiseSplitNode ? {
        splitter: rnnoiseSplitNode,
        merger:   rnnoiseMergeNode,
        nodes:    [...rnnoiseNodes]
      } : null;
      engineReady = true;
      // Idle until the next start: no worker or audio thread wake-ups while nothing is filtered.
      try { if (warmWorker) warmWorker.postMessage({ command: 'pause' }); } catch (_) {}
      warmCtx.suspend().catch(() => {});
    } else {
      // ── DISCARD PATH ───────────────────────────────────────────────────────
      // A newer warm context already exists (e.g. model was switched while
      // this session ran). Close this context and fully discard its nodes.
      disconnectAll(workletNode);
      disconnectAll(rnnoiseSplitNode);
      disconnectAll(rnnoiseMergeNode);
      for (const node of rnnoiseNodes) {
        disconnectAll(node);
        try { node.port.postMessage({ type: 'STOP' }); } catch (_) {}
      }
      try { audioCtx.close(); } catch (_) {}
      if (activeWorker && warmWorker && activeWorker !== warmWorker) {
        activeWorker.postMessage({ command: 'stop' });
        activeWorker.terminate();
      }
    }
  }

  // Clear active refs — warm pool refs were already set above if recycled.
  workletNode      = null;
  audioCtx         = null;
  activeWorker     = null;
  activeSabs       = null;
  rnnoiseSplitNode = null;
  rnnoiseMergeNode = null;
  rnnoiseNodes     = [];

  if (captureStream) {
    captureStream.getTracks().forEach((track) => track.stop());
    captureStream = null;
  }

  isActive = false;
  if (!keepStatus) sendStatus('stopped');
}

// Warm up the model tier the user actually selected (falls back to Standard if the background can't answer).
chrome.runtime.sendMessage({ type: 'GET_MODEL_URL' })
  .then((resp) => (resp && resp.modelUrl) || DEFAULT_MODEL_URL, () => DEFAULT_MODEL_URL)
  .then((url) => preWarmEngine(url))
  .catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'VIZ_WANTED':
      vizWantedUntil = Date.now() + VIZ_WANTED_TTL_MS;
      return false;
    case 'DF_START':
      start(msg).then(() => sendResponse({ ok: true }))
                .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    case 'DF_STOP':
      stop(false).then(() => sendResponse({ ok: true }));
      return true;
    case 'DF_SET_LEVEL': {
      const level = Math.max(0, Math.min(100, msg.value | 0));
      const target = activeWorker || warmWorker;
      if (target) target.postMessage({ command: 'set_suppression_level', level });
      sendResponse({ ok: true });
      return false;
    }
    case 'DF_GET_STATUS':
      sendResponse({ ok: true, isActive, assetsReady: workerReady, engineReady });
      return false;
    default:
      return false;
  }
});

window.addEventListener('beforeunload', () => {
  if (captureStream) captureStream.getTracks().forEach((track) => track.stop());
});
