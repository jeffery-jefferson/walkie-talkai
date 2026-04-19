/**
 * Microphone audio capture using decibri.
 *
 * Wraps decibri as a simple start/stop interface with a chunk callback,
 * matching the interface of the original Python AudioCapture class.
 * Outputs Float32Array samples in [-1, 1] for sherpa-onnx consumption.
 */

import Decibri from 'decibri';

export class AudioCapture {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=16000]
   * @param {number} [opts.channels=1]
   * @param {number} [opts.framesPerBuffer=1600]  100ms at 16kHz
   */
  constructor({ sampleRate = 16000, channels = 1, framesPerBuffer = 1600 } = {}) {
    this._sampleRate = sampleRate;
    this._channels = channels;
    this._framesPerBuffer = framesPerBuffer;
    this._mic = null;
    this._recording = false;
    this._onChunk = null;
  }

  /**
   * Begin recording from the microphone.
   *
   * @param {(samples: Float32Array) => void} onChunk
   *   Called for each captured audio block with Float32Array samples in [-1, 1].
   */
  start(onChunk) {
    if (this._recording) return;

    this._onChunk = onChunk;
    this._mic = new Decibri({
      sampleRate: this._sampleRate,
      channels: this._channels,
      framesPerBuffer: this._framesPerBuffer,
      format: 'float32',
    });

    this._mic.on('data', (chunk) => {
      if (!this._recording || !this._onChunk) return;
      const float32 = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.length / 4);
      this._onChunk(float32);
    });

    this._mic.on('error', (err) => {
      console.error('AudioCapture error:', err);
    });

    this._recording = true;
  }

  /** Stop recording. */
  stop() {
    if (!this._recording) return;
    this._recording = false;
    if (this._mic) {
      this._mic.stop();
      this._mic = null;
    }
    this._onChunk = null;
  }

  /** Return whether capture is currently active. */
  isRecording() {
    return this._recording;
  }
}
