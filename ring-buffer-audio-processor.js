(function () {
    'use strict';

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
            const to_write = Math.min(this._available_write(rd, wr), len);
            const first_part = Math.min(this._storage_capacity() - wr, to_write);
            const sec_part = to_write - first_part;
            this._copy(elements, actualOffset, this.storage, wr, first_part);
            this._copy(elements, actualOffset + first_part, this.storage, 0, sec_part);
            Atomics.store(this.write_ptr, 0, (wr + to_write) % this._storage_capacity());
            return to_write;
        }
        pop(elements, length, offset) {
            const actualOffset = offset || 0;
            const rd = Atomics.load(this.read_ptr, 0);
            const wr = Atomics.load(this.write_ptr, 0);
            if (wr === rd) return 0;
            const len = length !== undefined ? length : elements.length;
            const to_read = Math.min(this._available_read(rd, wr), len);
            const first_part = Math.min(this._storage_capacity() - rd, to_read);
            const sec_part = to_read - first_part;
            this._copy(this.storage, rd, elements, actualOffset, first_part);
            this._copy(this.storage, 0, elements, actualOffset + first_part, sec_part);
            Atomics.store(this.read_ptr, 0, (rd + to_read) % this._storage_capacity());
            return to_read;
        }
        availableRead() {
            const rd = Atomics.load(this.read_ptr, 0);
            const wr = Atomics.load(this.write_ptr, 0);
            return this._available_read(rd, wr);
        }
        availableWrite() {
            const rd = Atomics.load(this.read_ptr, 0);
            const wr = Atomics.load(this.write_ptr, 0);
            return this._available_write(rd, wr);
        }
        capacity() { return this._capacity - 1; }
        _available_read(rd, wr) { return (wr + this._storage_capacity() - rd) % this._storage_capacity(); }
        _available_write(rd, wr) { return this.capacity() - this._available_read(rd, wr); }
        _storage_capacity() { return this._capacity; }
        _copy(src, si, dst, di, n) {
            for (let i = 0; i < n; i++) dst[di + i] = src[si + i];
        }
    }

    class AudioWriter {
        constructor(ringbuf) {
            if (ringbuf.type() !== 'Float32Array') throw TypeError('Requires Float32Array ring buffer');
            this.ringbuf = ringbuf;
        }
        enqueue(buf, length, offset) { return this.ringbuf.push(buf, length, offset); }
    }

    class AudioReader {
        constructor(ringbuf) {
            if (ringbuf.type() !== 'Float32Array') throw TypeError('Requires Float32Array ring buffer');
            this.ringbuf = ringbuf;
        }
        dequeue(buf, length, offset) { return this.ringbuf.pop(buf, length, offset); }
        availableRead() { return this.ringbuf.availableRead(); }
    }

    class RingBufferAudioProcessor extends AudioWorkletProcessor {
        constructor(options) {
            super();
            const rawSab = options.processorOptions.rawSab;
            const denoisedSab = options.processorOptions.denoisedSab;
            this.outputInterleaved = new Float32Array(256);
            this.inputInterleaved = new Float32Array(256);
            this.stagingBuffer = new Float32Array(1024);
            this.stagingRead = 0;
            this.stagingAvailable = 0;
            this._audio_writer = new AudioWriter(new RingBuffer(rawSab, Float32Array));
            this._audio_reader = new AudioReader(new RingBuffer(denoisedSab, Float32Array));
            this.port.postMessage({ type: 'PROCESSOR_READY' });
        }

        process(inputList, outputList) {
            const sourceLimit = Math.min(inputList.length, outputList.length);
            const inputChannels = inputList[0];
            if (!inputChannels || !inputChannels[0]) return true;

            const leftIn = inputChannels[0];
            const rightIn = inputChannels[1] || leftIn;
            for (let i = 0; i < 128; i++) {
                const base = i * 2;
                this.inputInterleaved[base] = leftIn[i];
                this.inputInterleaved[base + 1] = rightIn[i];
            }

            this._audio_writer.enqueue(this.inputInterleaved);

            let produced = 0;
            while (produced < this.outputInterleaved.length) {
                if (this.stagingRead >= this.stagingAvailable) {
                    const available = this._audio_reader.availableRead();
                    if (available <= 0) break;
                    const chunkSize = Math.min(this.stagingBuffer.length, available);
                    this._audio_reader.dequeue(this.stagingBuffer, chunkSize, 0);
                    this.stagingRead = 0;
                    this.stagingAvailable = chunkSize;
                }

                const chunkAvailable = this.stagingAvailable - this.stagingRead;
                const chunkSize = Math.min(this.outputInterleaved.length - produced, chunkAvailable);
                for (let i = 0; i < chunkSize; i++) {
                    this.outputInterleaved[produced + i] = this.stagingBuffer[this.stagingRead + i];
                }
                this.stagingRead += chunkSize;
                produced += chunkSize;
            }

            if (produced < this.outputInterleaved.length) {
                this.outputInterleaved.fill(0, produced);
            }

            for (let n = 0; n < sourceLimit; n++) {
                const leftOut = outputList[n][0];
                const rightOut = outputList[n][1] || outputList[n][0];
                for (let i = 0; i < 128; i++) {
                    const base = i * 2;
                    leftOut[i] = this.outputInterleaved[base];
                    rightOut[i] = this.outputInterleaved[base + 1];
                }
            }
            return true;
        }
    }

    registerProcessor('ring-buffer-audio-processor', RingBufferAudioProcessor);
})();
