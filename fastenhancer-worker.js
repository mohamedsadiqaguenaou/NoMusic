(function () {
    'use strict';

    const EXTENSION_BASE_URL = self.location.origin + '/';
    const ORT_BASE_URL = EXTENSION_BASE_URL + 'assets/vendor/onnxruntime/';
    const MODEL_PATH = EXTENSION_BASE_URL + 'assets/fastenhancer_s.onnx';
    const HOP_SIZE = 512;
    const CHANNEL_COUNT = 2;
    const MAX_FRAMES_PER_TICK = 2;

    importScripts(ORT_BASE_URL + 'ort.wasm.min.js');

    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = {
        mjs: ORT_BASE_URL + 'ort-wasm-simd-threaded.mjs',
        wasm: ORT_BASE_URL + 'ort-wasm-simd-threaded.wasm'
    };

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
            for (let i = 0; i < count; i++) dst[di + i] = src[si + i];
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

    let session = null;
    let sessionInputNames = [];
    let cacheInputNames = [];
    let cacheOutputNames = [];
    let inputMetadataByName = Object.create(null);
    let _audio_reader = null;
    let _audio_writer = null;
    let interval = null;
    let currentWet = 1;
    let processing = false;
    let pendingOutputFrame = null;
    let pendingOutputOffset = 0;

    const stereoInput = new Float32Array(HOP_SIZE * CHANNEL_COUNT);
    const stereoOutput = new Float32Array(HOP_SIZE * CHANNEL_COUNT);

    function getTensorShape(metadata) {
        const dims = metadata && Array.isArray(metadata.shape)
            ? metadata.shape
            : (metadata && Array.isArray(metadata.dimensions)
                ? metadata.dimensions
                : (metadata && Array.isArray(metadata.dims) ? metadata.dims : []));

        if (dims.length === 0) {
            throw new Error('Unable to determine tensor shape from ONNX metadata');
        }

        return dims.map((dim) => (typeof dim === 'number' && dim > 0 ? dim : 1));
    }

    function zerosForShape(shape) {
        const size = shape.reduce((product, dim) => product * dim, 1);
        return new Float32Array(size);
    }

    function createCacheTensor(name) {
        const metadata = inputMetadataByName[name] || {};
        const dims = getTensorShape(metadata);
        return new ort.Tensor('float32', zerosForShape(dims), dims);
    }

    function cloneTensor(tensor) {
        return new ort.Tensor(tensor.type, new Float32Array(tensor.data), tensor.dims.slice());
    }

    function createChannelState() {
        return {
            input: new Float32Array(HOP_SIZE),
            output: new Float32Array(HOP_SIZE),
            caches: cacheInputNames.map((name) => createCacheTensor(name))
        };
    }

    const channelStates = [];

    function resetRingBufferPointers(ringBuffer) {
        Atomics.store(ringBuffer.write_ptr, 0, 0);
        Atomics.store(ringBuffer.read_ptr, 0, 0);
    }

    function resetState() {
        stereoInput.fill(0);
        stereoOutput.fill(0);
        pendingOutputFrame = null;
        pendingOutputOffset = 0;

        for (let channel = 0; channel < channelStates.length; channel++) {
            channelStates[channel].input.fill(0);
            channelStates[channel].output.fill(0);
            channelStates[channel].caches = cacheInputNames.map((name) => createCacheTensor(name));
        }

        if (_audio_reader) resetRingBufferPointers(_audio_reader.ringbuf);
        if (_audio_writer) resetRingBufferPointers(_audio_writer.ringbuf);
    }

    async function ensureSession(modelPath) {
        if (session) return session;

        session = await ort.InferenceSession.create(modelPath || MODEL_PATH, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all'
        });

        sessionInputNames = session.inputNames.slice();
        inputMetadataByName = Object.create(null);
        for (let index = 0; index < sessionInputNames.length; index++) {
            inputMetadataByName[sessionInputNames[index]] = session.inputMetadata[index];
        }
        cacheInputNames = sessionInputNames.filter((name) => name.startsWith('cache_in_'));
        cacheOutputNames = session.outputNames.filter((name) => name.startsWith('cache_out_'));

        channelStates.length = 0;
        for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
            channelStates.push(createChannelState());
        }

        return session;
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

    async function processChannel(state) {
        const feeds = {
            wav_in: new ort.Tensor('float32', state.input, [1, HOP_SIZE])
        };

        for (let index = 0; index < cacheInputNames.length; index++) {
            const cacheName = cacheInputNames[index];
            const cache = state.caches[index];
            feeds[cacheName] = cache;
        }

        const results = await session.run(feeds);
        const enhanced = results.wav_out;
        const enhancedData = enhanced && enhanced.data ? enhanced.data : zerosForShape([1, HOP_SIZE]);

        for (let i = 0; i < HOP_SIZE; i++) {
            state.output[i] = state.input[i] * (1 - currentWet) + enhancedData[i] * currentWet;
        }

        state.caches = cacheOutputNames.map((name) => cloneTensor(results[name]));
        return state.output;
    }

    async function processStereoFrame() {
        for (let i = 0; i < HOP_SIZE; i++) {
            const base = i * CHANNEL_COUNT;
            channelStates[0].input[i] = stereoInput[base];
            channelStates[1].input[i] = stereoInput[base + 1];
        }

        const left = await processChannel(channelStates[0]);
        const right = await processChannel(channelStates[1]);

        for (let i = 0; i < HOP_SIZE; i++) {
            const base = i * CHANNEL_COUNT;
            stereoOutput[base] = left[i];
            stereoOutput[base + 1] = right[i];
        }

        return stereoOutput;
    }

    async function tick() {
        if (!_audio_reader || !_audio_writer || !session || processing) return;

        processing = true;
        try {
            let framesProcessed = 0;
            while (framesProcessed < MAX_FRAMES_PER_TICK) {
                if (!flushPendingOutput()) break;
                if (_audio_reader.availableRead() < HOP_SIZE * CHANNEL_COUNT) break;

                _audio_reader.dequeue(stereoInput, HOP_SIZE * CHANNEL_COUNT, 0);
                const processed = await processStereoFrame();
                const written = _audio_writer.enqueue(processed, processed.length, 0);
                if (written < processed.length) {
                    pendingOutputFrame = new Float32Array(processed);
                    pendingOutputOffset = written;
                    break;
                }
                framesProcessed++;
            }
        } catch (err) {
            self.postMessage({ type: 'ERROR', error: err.message || String(err) });
        } finally {
            processing = false;
        }
    }

    self.onmessage = async function (event) {
        const data = event.data || {};

        switch (data.command) {
            case 'init': {
                try {
                    _audio_reader = new AudioReader(new RingBuffer(data.rawSab, Float32Array));
                    _audio_writer = new AudioWriter(new RingBuffer(data.denoisedSab, Float32Array));
                    currentWet = Math.max(0, Math.min(1, (data.suppressionLevel || 100) / 100));
                    await ensureSession(data.modelUrl || MODEL_PATH);
                    resetState();

                    if (channelStates.length > 0) {
                        await processChannel(channelStates[0]);
                        resetState();
                    }

                    clearInterval(interval);
                    interval = setInterval(() => { tick().catch(() => {}); }, 4);
                    self.postMessage({ type: 'SETUP_AWP' });
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
                break;
            }
            case 'stop': {
                clearInterval(interval);
                interval = null;
                processing = false;
                resetState();
                break;
            }
        }
    };

    self.postMessage({ type: 'FETCH_WASM' });
})();