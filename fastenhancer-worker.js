(function () {
    'use strict';

    // FastEnhancer runs as a standalone, ahead-of-time compiled WebAssembly module
    // (see wasm/README.md) - no ONNX Runtime involved.
    const EXTENSION_BASE_URL = self.location.origin + '/';
    const MODEL_PATH = EXTENSION_BASE_URL + 'assets/fastenhancer_s.wasm';
    const HOP_SIZE = 512;
    const CHANNEL_COUNT = 2;
    const MAX_FRAMES_PER_TICK = 2;

    class RingBuffer {
        constructor(sab, type) {
            if (type.BYTES_PER_ELEMENT === undefined) {
                throw TypeError('Pass a concrete typed array class as second argument');
            }
            this._type = type;
            this._capacity = (sab.byteLength - 8) / type.BYTES_PER_ELEMENT;
            this.buf = sab;
            this.write_ptr = new Uint32Array(this.buf, 0, 1);
            this.read_ptr = new Uint32Array(this.buf, 4, 1);
            this.storage = new type(this.buf, 8, this._capacity);
        }
        type() { return this._type.name; }
        push(elements, length, offset) {
            const actualOffset = offset || 0;
            const rd = Atomics.load(this.read_ptr, 0);
            const wr = Atomics.load(this.write_ptr, 0);
            if ((wr + 1) % this._storage_capacity() === rd) return 0;
            const len = length !== undefined ? length : elements.length;
            const toWrite = Math.min(this._available_write(rd, wr), len);
            const firstPart = Math.min(this._storage_capacity() - wr, toWrite);
            const secondPart = toWrite - firstPart;
            this._copy(elements, actualOffset, this.storage, wr, firstPart);
            this._copy(elements, actualOffset + firstPart, this.storage, 0, secondPart);
            Atomics.store(this.write_ptr, 0, (wr + toWrite) % this._storage_capacity());
            return toWrite;
        }
        pop(elements, length, offset) {
            const actualOffset = offset || 0;
            const rd = Atomics.load(this.read_ptr, 0);
            const wr = Atomics.load(this.write_ptr, 0);
            if (wr === rd) return 0;
            const len = length !== undefined ? length : elements.length;
            const toRead = Math.min(this._available_read(rd, wr), len);
            const firstPart = Math.min(this._storage_capacity() - rd, toRead);
            const secondPart = toRead - firstPart;
            this._copy(this.storage, rd, elements, actualOffset, firstPart);
            this._copy(this.storage, 0, elements, actualOffset + firstPart, secondPart);
            Atomics.store(this.read_ptr, 0, (rd + toRead) % this._storage_capacity());
            return toRead;
        }
        availableRead() {
            const rd = Atomics.load(this.read_ptr, 0);
            const wr = Atomics.load(this.write_ptr, 0);
            return this._available_read(rd, wr);
        }
        capacity() { return this._capacity - 1; }
        _available_read(rd, wr) { return (wr + this._storage_capacity() - rd) % this._storage_capacity(); }
        _available_write(rd, wr) { return this.capacity() - this._available_read(rd, wr); }
        _storage_capacity() { return this._capacity; }
        _copy(src, si, dst, di, count) {
            if (count > 0) dst.set(src.subarray(si, si + count), di); // one native copy, not a JS loop
        }
    }

    class AudioReader {
        constructor(ringbuf) {
            if (ringbuf.type() !== 'Float32Array') throw TypeError('Requires Float32Array ring buffer');
            this.ringbuf = ringbuf;
        }
        dequeue(buf, length, offset) { return this.ringbuf.pop(buf, length, offset); }
        availableRead() { return this.ringbuf.availableRead(); }
    }

    class AudioWriter {
        constructor(ringbuf) {
            if (ringbuf.type() !== 'Float32Array') throw TypeError('Requires Float32Array ring buffer');
            this.ringbuf = ringbuf;
        }
        enqueue(buf, length, offset) { return this.ringbuf.push(buf, length, offset); }
    }

    let fe = null;              // wasm exports
    let feModelUrl = null;      // URL the caller asked for (baseline build)
    let feVariant = null;       // file actually loaded
    let _audio_reader = null;
    let _audio_writer = null;
    let rawWritePtr = null;     // Int32 view of the input ring's write pointer (wait target)
    let interval = null;
    let loopToken = 0;
    let currentWet = 1;
    let processing = false;
    let pendingOutputFrame = null;
    let pendingOutputOffset = 0;
    const pendingOutputBuffer = new Float32Array(HOP_SIZE * CHANNEL_COUNT); // reused: no garbage while running

    // Load guard (from TV Akhi): the share of real time spent in the model, reported about once a second so the
    // offscreen document can step down to lighter processing on slow machines instead of stuttering.
    const HOP_MS = (HOP_SIZE / 48000) * 1000;
    const LOAD_REPORT_HOPS = 94; // ~1 s of audio
    let busyMs = 0;
    let busyHops = 0;
    // Step-down: process the mix of both channels as mono (voices sit in the middle), half the model's work.
    let forceMono = false;

    const stereoInput = new Float32Array(HOP_SIZE * CHANNEL_COUNT);
    const stereoOutput = new Float32Array(HOP_SIZE * CHANNEL_COUNT);

    // Per channel: { handle, input: Float32Array view, output: Float32Array view }
    const channelStates = [];
    let viewsBuffer = null;

    // Mono dedup: when L and R are identical (mono sources are upmixed to dual-mono) only the left stream
    // is run and its output is copied. `statesEqual` means the right stream is (logically) in the same
    // state as the left one; `rightStale` means its memory lags and must be copied before it runs again.
    const MONO_RESYNC_HOPS = 100; // ~1 s of identical L/R lets the right stream re-join a diverged left one
    let statesEqual = true;
    let rightStale = false;
    let monoRun = 0;

    function refreshViews() {
        const buffer = fe.memory.buffer;
        if (buffer === viewsBuffer) return;
        viewsBuffer = buffer;
        for (const state of channelStates) {
            state.input = new Float32Array(buffer, fe.fe_stream_input(state.handle), HOP_SIZE);
            state.output = new Float32Array(buffer, fe.fe_stream_output(state.handle), HOP_SIZE);
        }
    }

    function resetRingBufferPointers(ringBuffer) {
        Atomics.store(ringBuffer.write_ptr, 0, 0);
        Atomics.store(ringBuffer.read_ptr, 0, 0);
    }

    function resetState() {
        stereoInput.fill(0);
        stereoOutput.fill(0);
        pendingOutputFrame = null;
        pendingOutputOffset = 0;
        statesEqual = true;
        rightStale = false;
        monoRun = 0;

        if (fe) {
            for (const state of channelStates) fe.fe_stream_reset(state.handle);
        }

        if (_audio_reader) resetRingBufferPointers(_audio_reader.ringbuf);
        if (_audio_writer) resetRingBufferPointers(_audio_writer.ringbuf);
    }

    async function fetchBytes(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching ' + url);
        return response.arrayBuffer();
    }

    async function ensureModel(modelUrl) {
        const url = modelUrl || MODEL_PATH;
        if (fe && feModelUrl === url) return fe;

        if (fe) {
            for (const state of channelStates) fe.fe_stream_free(state.handle);
            channelStates.length = 0;
            fe = null;
            viewsBuffer = null;
        }

        const bytes = await fetchBytes(url);
        const { instance } = await WebAssembly.instantiate(bytes, {});
        const exports = instance.exports;
        if (exports.fe_hop_size() !== HOP_SIZE) {
            throw new Error('FastEnhancer wasm hop size ' + exports.fe_hop_size() + ' != ' + HOP_SIZE);
        }

        fe = exports;
        feModelUrl = url;
        feVariant = url;
        for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
            channelStates.push({ handle: fe.fe_stream_new(), input: null, output: null });
        }
        refreshViews();
        return fe;
    }

    function flushPendingOutput() {
        if (!pendingOutputFrame) return true;

        const remaining = pendingOutputFrame.length - pendingOutputOffset;
        const written = _audio_writer.enqueue(pendingOutputFrame, remaining, pendingOutputOffset);
        if (written <= 0) return false;

        pendingOutputOffset += written;
        if (pendingOutputOffset >= pendingOutputFrame.length) {
            pendingOutputFrame = null;
            pendingOutputOffset = 0;
            return true;
        }

        return false;
    }

    function processStereoFrame() {
        refreshViews();
        const left = channelStates[0];
        const right = channelStates[1];
        let mono = true;
        if (forceMono) {
            for (let i = 0; i < HOP_SIZE; i++) {
                const base = i * CHANNEL_COUNT;
                const m = (stereoInput[base] + stereoInput[base + 1]) * 0.5;
                left.input[i] = m;
                right.input[i] = m;
            }
        } else {
            for (let i = 0; i < HOP_SIZE; i++) {
                const base = i * CHANNEL_COUNT;
                const l = stereoInput[base];
                const r = stereoInput[base + 1];
                left.input[i] = l;
                right.input[i] = r;
                if (l !== r) mono = false;
            }
        }

        if (mono) {
            monoRun++;
            if (!statesEqual && monoRun >= MONO_RESYNC_HOPS) {
                statesEqual = true; // both streams have seen the same audio long enough to have converged
                rightStale = true;
            }
        } else {
            monoRun = 0;
        }

        if (mono && statesEqual) {
            fe.fe_stream_process(left.handle, currentWet);
            rightStale = true;
            for (let i = 0; i < HOP_SIZE; i++) {
                const v = left.output[i];
                stereoOutput[i * CHANNEL_COUNT] = v;
                stereoOutput[i * CHANNEL_COUNT + 1] = v;
            }
            return stereoOutput;
        }

        if (rightStale) {
            fe.fe_stream_copy_state(right.handle, left.handle);
            rightStale = false;
        }
        statesEqual = false;
        fe.fe_stream_process(left.handle, currentWet);
        fe.fe_stream_process(right.handle, currentWet);

        for (let i = 0; i < HOP_SIZE; i++) {
            const base = i * CHANNEL_COUNT;
            stereoOutput[base] = left.output[i];
            stereoOutput[base + 1] = right.output[i];
        }

        return stereoOutput;
    }

    // Processes every complete hop that is available. Returns false when blocked on output space.
    function drain() {
        if (!_audio_reader || !_audio_writer || !fe || processing) return true;

        processing = true;
        try {
            while (true) {
                if (!flushPendingOutput()) return false;
                if (_audio_reader.availableRead() < HOP_SIZE * CHANNEL_COUNT) return true;

                _audio_reader.dequeue(stereoInput, HOP_SIZE * CHANNEL_COUNT, 0);
                const started = performance.now();
                const processed = processStereoFrame();
                busyMs += performance.now() - started;
                if (++busyHops >= LOAD_REPORT_HOPS) {
                    self.postMessage({ type: 'LOAD', load: busyMs / (busyHops * HOP_MS) });
                    busyMs = 0;
                    busyHops = 0;
                }
                const written = _audio_writer.enqueue(processed, processed.length, 0);
                if (written < processed.length) {
                    pendingOutputBuffer.set(processed);
                    pendingOutputFrame = pendingOutputBuffer;
                    pendingOutputOffset = written;
                    return false;
                }
            }
        } catch (err) {
            self.postMessage({ type: 'ERROR', error: err.message || String(err) });
            return true;
        } finally {
            processing = false;
        }
    }

    // Event-driven scheduling: sleep on the input ring's write pointer (the audio worklet notifies it
    // once a full hop is buffered) instead of polling. Atomics.waitAsync keeps the message loop free.
    const MAX_WAIT_MS = 20;
    async function runLoop(token) {
        while (token === loopToken) {
            drain();
            if (token !== loopToken) return;
            const seen = Atomics.load(rawWritePtr, 0);
            if (_audio_reader.availableRead() >= HOP_SIZE * CHANNEL_COUNT && !pendingOutputFrame) continue;
            const result = Atomics.waitAsync(rawWritePtr, 0, seen, MAX_WAIT_MS);
            if (result.async) await result.value;
        }
    }

    function startProcessing() {
        stopProcessing();
        const token = ++loopToken;
        if (typeof Atomics.waitAsync === 'function') {
            runLoop(token).catch((err) => self.postMessage({ type: 'ERROR', error: err.message || String(err) }));
        } else {
            interval = setInterval(drain, 4);
        }
    }

    function stopProcessing() {
        loopToken++;
        clearInterval(interval);
        interval = null;
        if (rawWritePtr) Atomics.notify(rawWritePtr, 0); // wake a pending wait so the old loop exits
    }

    self.onmessage = async function (event) {
        const data = event.data || {};

        switch (data.command) {
            case 'init': {
                try {
                    _audio_reader = new AudioReader(new RingBuffer(data.rawSab, Float32Array));
                    _audio_writer = new AudioWriter(new RingBuffer(data.denoisedSab, Float32Array));
                    rawWritePtr = new Int32Array(data.rawSab, 0, 1);
                    currentWet = Math.max(0, Math.min(1, (data.suppressionLevel || 100) / 100));
                    await ensureModel(data.modelUrl || MODEL_PATH);
                    resetState();

                    // Warm-up hops so the first real frames don't pay for wasm tier-up.
                    for (let i = 0; i < 3; i++) fe.fe_stream_process(channelStates[0].handle, currentWet);
                    resetState();

                    startProcessing();
                    self.postMessage({ type: 'SETUP_AWP', variant: feVariant });
                } catch (err) {
                    self.postMessage({ type: 'ERROR', error: err.message || String(err) });
                }
                break;
            }
            case 'set_suppression_level': {
                const level = typeof data.level === 'number' ? data.level : 100;
                currentWet = Math.max(0, Math.min(1, level / 100));
                break;
            }
            case 'RESET_BUFFERS': {
                resetState();
                busyMs = 0;
                busyHops = 0;
                break;
            }
            case 'set_mono': {
                forceMono = !!data.enabled;
                break;
            }
            // Idle (warm, not filtering): stop waking up to poll the empty ring buffer.
            case 'pause': {
                stopProcessing();
                processing = false;
                break;
            }
            case 'resume': {
                if (fe && _audio_reader) startProcessing();
                break;
            }
            case 'stop': {
                stopProcessing();
                processing = false;
                resetState();
                break;
            }
        }
    };

    self.postMessage({ type: 'FETCH_WASM' });
})();