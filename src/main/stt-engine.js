/**
 * Streaming speech-to-text engine wrapping sherpa-onnx-node.
 *
 * Exposes the same conceptual interface as the original VoskSTT:
 *   - newStream()  → create a stream per PTT session
 *   - feed()       → push audio, get partial text, detect endpoints
 *   - finalize()   → flush and return complete transcript
 */

import sherpaOnnx from 'sherpa-onnx-node';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class SttEngine {
  /**
   * @param {object} opts
   * @param {string} opts.modelPath  Path to the sherpa-onnx model directory
   * @param {number} [opts.sampleRate=16000]
   * @param {string[]} [opts.hotwords=[]]  Words to bias the recognizer toward
   */
  constructor({ modelPath, sampleRate = 16000, hotwords = [] }) {
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `STT model not found: ${modelPath}\n` +
        'Download a model from https://github.com/k2-fsa/sherpa-onnx/releases'
      );
    }

    // Auto-detect model files in the directory.
    // Prefer int8 quantized models (faster load, lower memory) over full-precision.
    const files = fs.readdirSync(modelPath);
    const findPreferInt8 = (base) => {
      const int8 = files.find((f) => new RegExp(`^${base}.*\\.int8\\.onnx$`, 'i').test(f));
      if (int8) return int8;
      return files.find((f) => new RegExp(`^${base}.*\\.onnx$`, 'i').test(f));
    };

    const tokens = files.find((f) => /tokens\.txt$/i.test(f));
    if (!tokens) {
      throw new Error(`Missing tokens.txt in ${modelPath}`);
    }

    // Detect model architecture:
    //   Transducer (Kroko/Zipformer): encoder + decoder + joiner
    //   NeMo CTC: single model.onnx
    const encoder = findPreferInt8('encoder');
    const decoder = findPreferInt8('decoder');
    const joiner = findPreferInt8('joiner');
    const singleModel = findPreferInt8('model');

    this._sampleRate = sampleRate;
    this._hotwordsFile = null;

    // Write hotwords to a temp file for sherpa-onnx
    let hotwordsFilePath = '';
    if (hotwords.length > 0) {
      hotwordsFilePath = path.join(os.tmpdir(), `walkie-talkai-hotwords-${process.pid}.txt`);
      fs.writeFileSync(hotwordsFilePath, hotwords.join('\n'), 'utf8');
      this._hotwordsFile = hotwordsFilePath;
    }

    // Hotwords require modified_beam_search decoding
    const useHotwords = hotwordsFilePath.length > 0;
    const baseConfig = {
      featConfig: { sampleRate, featureDim: 80 },
      decodingMethod: useHotwords ? 'modified_beam_search' : 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    };

    if (encoder && decoder && joiner) {
      // Transducer model (Kroko, Zipformer)
      this._recognizer = new sherpaOnnx.OnlineRecognizer({
        ...baseConfig,
        modelConfig: {
          transducer: {
            encoder: path.join(modelPath, encoder),
            decoder: path.join(modelPath, decoder),
            joiner: path.join(modelPath, joiner),
          },
          tokens: path.join(modelPath, tokens),
          numThreads: 2,
          provider: 'cpu',
        },
        ...(hotwordsFilePath ? { hotwordsFile: hotwordsFilePath, hotwordsScore: 1.5 } : {}),
      });
    } else if (singleModel) {
      // NeMo CTC model (single model file)
      this._recognizer = new sherpaOnnx.OnlineRecognizer({
        ...baseConfig,
        modelConfig: {
          nemoCtc: {
            model: path.join(modelPath, singleModel),
          },
          tokens: path.join(modelPath, tokens),
          numThreads: 2,
          provider: 'cpu',
        },
        ...(hotwordsFilePath ? { hotwordsFile: hotwordsFilePath, hotwordsScore: 1.5 } : {}),
      });
    } else {
      throw new Error(
        `Incomplete model at ${modelPath}. Need either:\n` +
        `  - Transducer: encoder*.onnx + decoder*.onnx + joiner*.onnx + tokens.txt\n` +
        `  - NeMo CTC: model*.onnx + tokens.txt\n` +
        `Found: ${files.join(', ')}`
      );
    }
  }

  /**
   * Create a fresh stream for one PTT session.
   */
  newStream() {
    return this._recognizer.createStream();
  }

  /**
   * Feed a Float32Array audio chunk and return the latest partial text.
   *
   * @param {object} stream       Stream from newStream()
   * @param {Float32Array} samples Audio samples in [-1, 1]
   * @param {string[]} [committed] If provided, completed utterances are appended
   * @returns {string} Current partial text
   */
  feed(stream, samples, committed) {
    stream.acceptWaveform({ sampleRate: this._sampleRate, samples });

    while (this._recognizer.isReady(stream)) {
      this._recognizer.decode(stream);
    }

    const isEndpoint = this._recognizer.isEndpoint(stream);
    const text = this._recognizer.getResult(stream).text.trim();

    if (isEndpoint) {
      if (committed && text) {
        committed.push(text);
      }
      this._recognizer.reset(stream);
      return text;
    }

    return text;
  }

  /**
   * Signal end of audio and return the complete final transcription.
   *
   * @param {object} stream
   * @param {string[]} [committed]
   * @returns {string}
   */
  finalize(stream, committed) {
    stream.inputFinished();

    while (this._recognizer.isReady(stream)) {
      this._recognizer.decode(stream);
    }

    const final = this._recognizer.getResult(stream).text.trim();

    if (committed && committed.length > 0) {
      const parts = [...committed];
      if (final) parts.push(final);
      return parts.join(' ');
    }

    return final;
  }

  /**
   * Check if the last feed() detected an endpoint.
   */
  isEndpoint(stream) {
    return this._recognizer.isEndpoint(stream);
  }

  /** Clean up the temporary hotwords file if one was created. */
  destroy() {
    if (this._hotwordsFile) {
      try { fs.unlinkSync(this._hotwordsFile); } catch { /* ignore */ }
      this._hotwordsFile = null;
    }
  }
}
