/**
 * offscreen.js - NoMusic audio processing engine
 *
 * The offscreen document hosts a streaming FastEnhancer + RNNoise pipeline:
 * source -> FastEnhancer worker -> per-channel RNNoise -> analyser -> speakers
 */

'use strict';

const MODEL_URL = chrome.runtime.getURL('assets/fastenhancer_s.onnx');
const WORKER_URL = chrome.runtime.getURL('fastenhancer-worker.js');
const PROCESSOR_URL = chrome.runtime.getURL('ring-buffer-audio-processor.js');
const RNNOISE_WASM_URL = chrome.runtime.getURL('assets/rnnoise.wasm');
const RNNOISE_PROCESSOR_URL = chrome.runtime.getURL('rnnoise-worklet.js');
const SAMPLE_RATE = 48000;
const CHANNEL_COUNT = 2;
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
let isActive = false;
let startInProgress = false;

let warmCtx = null;
let warmWorklet = null;
let warmWorker = null;
let warmRawSab = null;
let warmDenoSab = null;
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
    const node = new AudioWorkletNode(ctx, 'rnnoise-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [1],
      processorOptions: { wasmBytes }
    });

    readyPromises.push(new Promise((resolve, reject) => {
      node.port.onmessage = (event) => {
        if (event.data && event.data.type === 'PROCESSOR_READY') resolve();
      };
      node.onprocessorerror = () => reject(new Error('RNNoise processor warm-up failed'));
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

async function preWarmEngine() {
  if (engineReady) return;
  if (warming) return warming;

  warming = (async () => {
    let worker = warmWorker;
    let rawSab = warmRawSab;
    let denoSab = warmDenoSab;
    let workerIsNew = false;

    if (!worker) {
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
          worker.postMessage({
            command: 'init',
            rawSab,
            denoisedSab: denoSab,
            modelUrl: MODEL_URL,
            suppressionLevel: 100
          });
          return;
        }
        if (data.type === 'SETUP_AWP') {
          clearTimeout(timeout);
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

    await loadRnnoiseAssets();

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await Promise.all([
      ctx.audioWorklet.addModule(PROCESSOR_URL),
      ctx.audioWorklet.addModule(RNNOISE_PROCESSOR_URL)
    ]);

    const node = new AudioWorkletNode(ctx, 'ring-buffer-audio-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [2],
      processorOptions: { rawSab, denoisedSab: denoSab }
    });

    await new Promise((resolve, reject) => {
      node.port.onmessage = (event) => {
        if (event.data && event.data.type === 'PROCESSOR_READY') resolve();
      };
      node.onprocessorerror = () => reject(new Error('Audio processor warm-up failed'));
    });
    node.port.onmessage = null;

    warmCtx = ctx;
    warmWorklet = node;
    warmWorker = worker;
    warmRawSab = rawSab;
    warmDenoSab = denoSab;
    engineReady = true;
    warming = null;

    chrome.runtime.sendMessage({ type: 'ENGINE_READY' }).catch(() => {});
  })().catch((err) => {
    engineReady = false;
    warming = null;
    warmCtx = null;
    warmWorklet = null;
    throw err;
  });

  return warming;
}

async function start({ streamId, suppressionLevel = 100 }) {
  if (startInProgress) return;
  startInProgress = true;

  if (isActive) await stop();

  try {
    sendStatus('loading', { step: 'model', progress: 0.2 });
    await preWarmEngine();
    sendStatus('loading', { step: 'compiling', progress: 0.8 });
    sendStatus('loading', { step: 'capture', progress: 1 });

    audioCtx = warmCtx;
    workletNode = warmWorklet;
    const worker = warmWorker;
    activeSabs = { rawSab: warmRawSab, denoSab: warmDenoSab };
    activeWorker = worker;

    warmCtx = null;
    warmWorklet = null;
    warmWorker = null;
    warmRawSab = null;
    warmDenoSab = null;
    engineReady = false;

    worker.postMessage({ command: 'RESET_BUFFERS' });
    worker.postMessage({ command: 'set_suppression_level', level: suppressionLevel });

    worker.onmessage = (event) => {
      const data = event.data || {};
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

  const rnnoiseChain = await createRnnoiseChain(audioCtx);
  rnnoiseSplitNode = rnnoiseChain.splitter;
  rnnoiseMergeNode = rnnoiseChain.merger;
  rnnoiseNodes = rnnoiseChain.nodes;
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
    workletNode.connect(rnnoiseSplitNode);
    rnnoiseMergeNode.connect(analyzerNode);
    analyzerNode.connect(outputGainNode);
    outputGainNode.connect(audioCtx.destination);

    isActive = true;
    sendStatus('active', { latency: 11 });

    const freqData = new Uint8Array(analyzerNode.frequencyBinCount);
    animInterval = setInterval(() => {
      if (!analyzerNode) return;
      analyzerNode.getByteFrequencyData(freqData);
      chrome.runtime.sendMessage({ type: 'DF_FREQ_DATA', data: Array.from(freqData) }).catch(() => {});
    }, 50);

    preWarmEngine().catch(() => {});
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

  const disconnect = (node) => {
    try { node && node.disconnect(); } catch (_) {}
  };

  disconnect(sourceNode);
  disconnect(analyzerNode);
  disconnect(outputGainNode);
  disconnect(rnnoiseSplitNode);
  disconnect(rnnoiseMergeNode);
  for (const node of rnnoiseNodes) disconnect(node);
  sourceNode = null;
  analyzerNode = null;
  outputGainNode = null;
  rnnoiseSplitNode = null;
  rnnoiseMergeNode = null;
  rnnoiseNodes = [];

  if (workletNode && audioCtx) {
    try { workletNode.disconnect(); } catch (_) {}
    if (!engineReady && !warmWorklet) {
      warmWorklet = workletNode;
      warmCtx = audioCtx;
      warmWorker = activeWorker;
      warmRawSab = activeSabs ? activeSabs.rawSab : null;
      warmDenoSab = activeSabs ? activeSabs.denoSab : null;
      engineReady = !!warmCtx;
    } else {
      try { audioCtx.close(); } catch (_) {}
      if (activeWorker && warmWorker && activeWorker !== warmWorker) {
        activeWorker.postMessage({ command: 'stop' });
        activeWorker.terminate();
      }
    }
  }

  workletNode = null;
  audioCtx = null;
  activeWorker = null;
  activeSabs = null;

  if (captureStream) {
    captureStream.getTracks().forEach((track) => track.stop());
    captureStream = null;
  }

  isActive = false;
  if (!keepStatus) sendStatus('stopped');
}

preWarmEngine().catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
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
