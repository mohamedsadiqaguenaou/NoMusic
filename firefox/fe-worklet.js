/**
 * fe-worklet.js — FastEnhancer as an AudioWorkletProcessor (Firefox build).
 *
 * Runs inside the page's own AudioContext, on the real-time audio thread of the tab that is playing.
 * (The background page's process is throttled by Windows efficiency mode, which made processing there
 * stutter.) The models' wasm bytes arrive via processorOptions and are compiled here.
 *
 * Firefox runs worklet wasm in its baseline tier until a function has been called a few hundred times,
 * and only modules compiled asynchronously are tiered up at all. Baseline Standard costs ~15-25 ms per
 * 10.7 ms hop (slow motion), optimized ~3 ms; Lite is cheap in either tier. So when Standard is selected:
 *   1. Lite filters from the start;
 *   2. Standard is compiled asynchronously and warmed up off the output path: every WARM_EVERY_SLOW-th
 *      hop while a warm-up call is still slow (each one then costs ~10 ms of the audio thread), every
 *      WARM_EVERY_FAST-th once it speeds up;
 *   3. after FAST_WINDOWS consecutive checks average under FAST_MS with no call over SLOW_PROBE_MS
 *      (typically 30-90 s), Lite crossfades into Standard.
 *
 * 128-frame render quanta are collected into 512-sample hops. A hop's work is spread over the four quanta
 * of the following hop, one model call per quantum (left, right, then warm-up or the crossfade partner),
 * so no single render quantum pays for a whole stereo hop. Output therefore lags input by two hops.
 */

'use strict';

const HOP = 512;
const QUANTUM = 128;
const MONO_RESYNC_HOPS = 100;
const WARM_EVERY_SLOW = 4;   // warm-up hop rate while warm-up calls are still slow
const WARM_EVERY_FAST = 2;   // ... and once they are fast
const SLOW_PROBE_MS = 8;     // a warm-up call slower than this backs off to WARM_EVERY_SLOW
const PROBE_HOPS = 32;       // Standard hops averaged per speed check (the worklet clock is coarse)
const FAST_MS = 5;           // per channel, under half the hop budget
const FAST_WINDOWS = 3;      // consecutive fast checks before switching
const CROSSFADE_HOPS = 48;   // ~0.5 s

// One FastEnhancer module with a stream per channel, plus the mono dedup from fastenhancer-worker.js:
// dual-mono hops only run the left stream. A hop is processed in two calls, left() then right(), so they
// can run in different render quanta.
class Enhancer {
  constructor(instance) {
    const fe = instance.exports;
    if (fe.fe_hop_size() !== HOP) throw new Error('FastEnhancer hop size ' + fe.fe_hop_size());
    this.fe = fe;
    this.left = fe.fe_stream_new();
    this.right = fe.fe_stream_new();
    this.viewsBuffer = null;
    this.outL = new Float32Array(HOP);
    this.outR = new Float32Array(HOP);
    this.reset();
  }

  reset() {
    this.fe.fe_stream_reset(this.left);
    this.fe.fe_stream_reset(this.right);
    this.statesEqual = true;
    this.rightStale = false;
    this.monoRun = 0;
    this.skipRight = false;
  }

  _views() {
    const buffer = this.fe.memory.buffer;
    if (buffer !== this.viewsBuffer) {
      this.viewsBuffer = buffer;
      this.lIn = new Float32Array(buffer, this.fe.fe_stream_input(this.left), HOP);
      this.lOut = new Float32Array(buffer, this.fe.fe_stream_output(this.left), HOP);
      this.rIn = new Float32Array(buffer, this.fe.fe_stream_input(this.right), HOP);
      this.rOut = new Float32Array(buffer, this.fe.fe_stream_output(this.right), HOP);
    }
  }

  // Loads the hop and runs the left stream into this.outL.
  runLeft(inL, inR, wet) {
    const fe = this.fe;
    this._views();
    let mono = true;
    for (let i = 0; i < HOP; i++) {
      if (inL[i] !== inR[i]) { mono = false; break; }
    }
    this.lIn.set(inL);
    this.rIn.set(inR);

    if (mono) {
      this.monoRun++;
      if (!this.statesEqual && this.monoRun >= MONO_RESYNC_HOPS) {
        this.statesEqual = true;
        this.rightStale = true;
      }
    } else {
      this.monoRun = 0;
    }

    this.skipRight = mono && this.statesEqual;
    if (this.skipRight) {
      this.rightStale = true;
    } else {
      if (this.rightStale) {
        fe.fe_stream_copy_state(this.right, this.left); // before left advances
        this.rightStale = false;
      }
      this.statesEqual = false;
    }
    fe.fe_stream_process(this.left, wet);
    this.outL.set(this.lOut);
  }

  // Runs the right stream into this.outR (or copies the left output for dual-mono hops).
  runRight(wet) {
    if (this.skipRight) {
      this.outR.set(this.outL);
      return;
    }
    this._views();
    this.fe.fe_stream_process(this.right, wet);
    this.outR.set(this.rOut);
  }

  // One throwaway hop on the left stream (warm-up only); returns its duration in ms.
  probe(inL) {
    this._views();
    this.lIn.set(inL);
    const t0 = Date.now();
    this.fe.fe_stream_process(this.left, 1);
    return Date.now() - t0;
  }
}

class FastEnhancerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { bytes, liteBytes, wet } = options.processorOptions || {};
    this.wet = typeof wet === 'number' ? wet : 1;
    this.inL = new Float32Array(HOP);     // hop being collected
    this.inR = new Float32Array(HOP);
    this.workL = new Float32Array(HOP);   // previous hop, processed during this one
    this.workR = new Float32Array(HOP);
    this.resL = new Float32Array(HOP);    // results being produced for workL/workR
    this.resR = new Float32Array(HOP);
    this.outL = new Float32Array(HOP);    // results being played
    this.outR = new Float32Array(HOP);
    this.fill = 0;
    this.active = null;      // Enhancer whose output is played
    this.pending = null;     // Standard, while warming up
    this.hopCount = 0;
    this.probeMs = 0;
    this.probeMax = 0;
    this.probeCount = 0;
    this.fastWindows = 0;
    this.warmEvery = WARM_EVERY_SLOW;
    this.fadeHop = -1;       // >= 0 while crossfading active -> pending, -2 = fade starts next hop

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'SET_WET') this.wet = Math.max(0, Math.min(1, data.wet));
      else if (data.type === 'RESET') this._reset();
    };

    const fail = (err) => this.port.postMessage({ type: 'ERROR', error: err.message || String(err) });
    try {
      if (liteBytes) {
        // Lite is cheap even unoptimized, so it plays as soon as it is compiled (off the audio thread).
        WebAssembly.instantiate(liteBytes, {}).then(({ instance }) => {
          this.active = new Enhancer(instance);
          this.port.postMessage({ type: 'PROCESSOR_READY', model: 'lite' });
          return WebAssembly.instantiate(bytes, {});
        }).then(({ instance }) => {
          this.pending = new Enhancer(instance);
        }).catch(fail);
      } else {
        WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
          this.active = new Enhancer(instance);
          this.port.postMessage({ type: 'PROCESSOR_READY' });
        }).catch(fail);
      }
    } catch (err) {
      fail(err);
    }
  }

  _reset() {
    this.fill = 0;
    for (const b of [this.workL, this.workR, this.resL, this.resR, this.outL, this.outR]) b.fill(0);
    if (this.active) this.active.reset();
  }

  // Task `q` (0-3) of the hop in workL/workR; one model call at most.
  _task(q) {
    if (q === 0 && this.fadeHop === -2) this.fadeHop = 0;
    const active = this.active;
    const pending = this.pending;
    const fading = this.fadeHop >= 0;

    if (q === 0) {
      active.runLeft(this.workL, this.workR, this.wet);
    } else if (q === 1) {
      active.runRight(this.wet);
      if (!fading) {
        this.resL.set(active.outL);
        this.resR.set(active.outR);
      }
    } else if (q === 2) {
      if (fading) {
        pending.runLeft(this.workL, this.workR, this.wet);
      } else if (pending && this.fadeHop === -1 && ++this.hopCount % this.warmEvery === 0) {
        const ms = pending.probe(this.workL);
        this.warmEvery = ms > SLOW_PROBE_MS ? WARM_EVERY_SLOW : WARM_EVERY_FAST;
        this.probeMs += ms;
        this.probeMax = Math.max(this.probeMax, ms);
        if (++this.probeCount === PROBE_HOPS) {
          const fast = this.probeMs / PROBE_HOPS < FAST_MS && this.probeMax <= SLOW_PROBE_MS;
          this.fastWindows = fast ? this.fastWindows + 1 : 0;
          if (this.fastWindows >= FAST_WINDOWS) {
            pending.reset();
            this.fadeHop = -2; // the fade starts with the next hop's task 0
          }
          this.probeMs = 0;
          this.probeMax = 0;
          this.probeCount = 0;
        }
      }
    } else if (fading) {
      // Crossfade Lite -> Standard; Standard's recurrent state settles during the fade.
      pending.runRight(this.wet);
      for (let i = 0; i < HOP; i++) {
        const g = Math.min(1, (this.fadeHop * HOP + i) / (CROSSFADE_HOPS * HOP));
        this.resL[i] = active.outL[i] * (1 - g) + pending.outL[i] * g;
        this.resR[i] = active.outR[i] * (1 - g) + pending.outR[i] * g;
      }
      if (++this.fadeHop >= CROSSFADE_HOPS) {
        this.active = pending;
        this.pending = null;
        this.fadeHop = -1;
        this.port.postMessage({ type: 'MODEL_SWITCHED', model: 'standard' });
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outL;
    // No input connected (bypass mode) or not loaded yet: nothing to do, stay alive.
    if (!this.active || !input || !input[0]) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }

    const inL = input[0];
    const inR = input[1] || inL;
    outL.set(this.outL.subarray(this.fill, this.fill + QUANTUM));
    if (outR !== outL) outR.set(this.outR.subarray(this.fill, this.fill + QUANTUM));
    this.inL.set(inL, this.fill);
    this.inR.set(inR, this.fill);
    this._task(this.fill / QUANTUM);
    this.fill += QUANTUM;

    if (this.fill === HOP) {
      // Rotate: finished results start playing, the collected hop becomes the next work item.
      this.fill = 0;
      let t = this.outL; this.outL = this.resL; this.resL = t;
      t = this.outR; this.outR = this.resR; this.resR = t;
      t = this.workL; this.workL = this.inL; this.inL = t;
      t = this.workR; this.workR = this.inR; this.inR = t;
    }
    return true;
  }
}

registerProcessor('fastenhancer-processor', FastEnhancerProcessor);
