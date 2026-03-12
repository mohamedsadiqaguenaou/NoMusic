/**
 * rnnoise-worklet.js — AudioWorkletProcessor for RNNoise noise suppression
 *
 * Receives raw WASM bytes via processorOptions.wasmBytes.
 * Processes 480-sample frames (10 ms at 48 kHz) while buffering 128-sample
 * Web Audio render quanta on input and output.
 */

'use strict';

const FRAME_SIZE = 480;
const QUANTUM = 128;
const NUM_PASSES = 2;
const VAD_GATE_LO = 0.3;
const VAD_GATE_HI = 0.6;
const GATE_ATTACK = 0.05;
const GATE_RELEASE = 0.02;

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.alive = true;
    this.ready = false;

    this.inBuf = new Float32Array(FRAME_SIZE * 4);
    this.outBuf = new Float32Array(FRAME_SIZE * 4);
    this.inWrite = 0;
    this.outRead = 0;
    this.outAvail = FRAME_SIZE;
    this._inCount = 0;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'STOP') this.alive = false;
    };

    const { wasmBytes } = options.processorOptions || {};
    if (!wasmBytes) {
      console.error('[RNNoise worklet] Missing wasmBytes');
      return;
    }

    try {
      this._initWasm(wasmBytes);
    } catch (error) {
      console.error('[RNNoise worklet] init failed:', error);
    }
  }

  _initWasm(wasmBytes) {
    const wasmModule = new WebAssembly.Module(wasmBytes);

    let heapU8;
    let heap32;
    let heapF32;
    let wasmMemory;

    const updateViews = (buffer) => {
      heapU8 = new Uint8Array(buffer);
      heap32 = new Int32Array(buffer);
      heapF32 = new Float32Array(buffer);
    };

    const importObj = {
      a: {
        a: (requestedSize) => {
          requestedSize >>>= 0;
          const oldSize = heapU8.length;
          const maxSize = 2147483648;
          if (requestedSize > maxSize) return false;
          for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
            let overGrown = oldSize * (1 + 0.2 / cutDown);
            overGrown = Math.min(overGrown, requestedSize + 100663296);
            const newSize = Math.min(maxSize,
              (Math.max(requestedSize, overGrown) + 65535) & ~65535);
            try {
              wasmMemory.grow((newSize - heapU8.byteLength + 65535) >>> 16);
              updateViews(wasmMemory.buffer);
              return 1;
            } catch (_) {}
          }
          return 0;
        },
        b: (dest, src, num) => {
          heapU8.copyWithin(dest, src, src + num);
        }
      }
    };

    const instance = new WebAssembly.Instance(wasmModule, importObj);
    const exports = instance.exports;

    wasmMemory = exports.c;
    updateViews(wasmMemory.buffer);

    exports.d();

    const rnnoise_create = exports.f;
    const malloc = exports.g;
    const rnnoise_process_frame = exports.j;

    const states = [];
    for (let pass = 0; pass < NUM_PASSES; pass++) {
      const state = rnnoise_create(0);
      if (!state) throw new Error('rnnoise_create returned null (pass ' + pass + ')');
      states.push(state);
    }

    const inPtr = malloc(FRAME_SIZE * 4);
    const outPtr = malloc(FRAME_SIZE * 4);
    if (!inPtr || !outPtr) throw new Error('malloc failed');

    this._states = states;
    this._inPtr = inPtr;
    this._outPtr = outPtr;
    this._processFrame = rnnoise_process_frame;
    this._gateGain = 0;
    this._getHeapF32 = () => {
      if (heapF32.buffer !== wasmMemory.buffer) {
        updateViews(wasmMemory.buffer);
      }
      return heapF32;
    };

    this.ready = true;
    this.port.postMessage({ type: 'PROCESSOR_READY' });
  }

  process(inputs, outputs) {
    if (!this.alive) return false;

    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!input || !output) return true;

    if (!this.ready) {
      output.set(input);
      return true;
    }

    const inLen = this.inBuf.length;
    for (let i = 0; i < QUANTUM; i++) {
      this.inBuf[this.inWrite] = input[i];
      this.inWrite = (this.inWrite + 1) % inLen;
    }
    this._inCount += QUANTUM;

    while (this._inCount >= FRAME_SIZE) {
      const heap = this._getHeapF32();
      const inOff = this._inPtr >>> 2;
      const outOff = this._outPtr >>> 2;
      const readStart = (this.inWrite - this._inCount + inLen * 4) % inLen;

      for (let i = 0; i < FRAME_SIZE; i++) {
        heap[inOff + i] = this.inBuf[(readStart + i) % inLen] * 32768;
      }

      let vad = 0;
      for (let pass = 0; pass < this._states.length; pass++) {
        vad = this._processFrame(this._states[pass], this._outPtr, this._inPtr);
        if (pass < this._states.length - 1) {
          for (let i = 0; i < FRAME_SIZE; i++) {
            heap[inOff + i] = heap[outOff + i];
          }
        }
      }

      let targetGain;
      if (vad >= VAD_GATE_HI) {
        targetGain = 1;
      } else if (vad <= VAD_GATE_LO) {
        targetGain = 0;
      } else {
        targetGain = (vad - VAD_GATE_LO) / (VAD_GATE_HI - VAD_GATE_LO);
      }

      const alpha = targetGain > this._gateGain ? GATE_ATTACK : GATE_RELEASE;
      this._gateGain += (targetGain - this._gateGain) * alpha;

      const outLen = this.outBuf.length;
      for (let i = 0; i < FRAME_SIZE; i++) {
        const writePos = (this.outRead + this.outAvail + i) % outLen;
        this.outBuf[writePos] = (heap[outOff + i] / 32768) * this._gateGain;
      }
      this.outAvail += FRAME_SIZE;
      this._inCount -= FRAME_SIZE;
    }

    const outLen = this.outBuf.length;
    if (this.outAvail >= QUANTUM) {
      for (let i = 0; i < QUANTUM; i++) {
        output[i] = this.outBuf[this.outRead];
        this.outRead = (this.outRead + 1) % outLen;
      }
      this.outAvail -= QUANTUM;
    } else {
      output.fill(0);
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RnnoiseProcessor);