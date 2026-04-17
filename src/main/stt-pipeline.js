/**
 * Push-to-talk speech-to-text pipeline.
 *
 * Coordinates: hotkey press/release → audio capture → sherpa-onnx STT
 * → cancel phrase detection → final text callback.
 *
 * Port of the Python STTPipeline class with the same state machine.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioCapture } from './audio-capture.js';
import { SttEngine } from './stt-engine.js';
import { HotkeyActivation } from './hotkey.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export class SttPipeline {
  /**
   * @param {object} opts
   * @param {object}  opts.config                  App config object
   * @param {() => void}          [opts.onRecordingStart]
   * @param {(text: string) => void} [opts.onPartialText]
   * @param {(text: string) => void} [opts.onFinalText]
   * @param {() => void}          [opts.onRecordingStop]
   * @param {(phrase: string, fullText: string) => void} [opts.onCancelled]
   */
  constructor({
    config,
    onRecordingStart,
    onPartialText,
    onFinalText,
    onRecordingStop,
    onCancelled,
  }) {
    this.config = config;
    this.onRecordingStart = onRecordingStart || (() => {});
    this.onPartialText = onPartialText || (() => {});
    this.onFinalText = onFinalText || (() => {});
    this.onRecordingStop = onRecordingStop || (() => {});
    this.onCancelled = onCancelled || (() => {});

    this._stt = null;
    this._mic = null;
    this._hotkey = null;

    this._stream = null;
    this._isRecording = false;
    this._committed = [];
    this._bestPartial = '';
    this._lastCommittedCount = 0;
    this._cancelDetected = false;
  }

  /** Initialize STT model, audio capture, and start hotkey listener. */
  async start() {
    // Resolve model path relative to project root if relative
    let modelPath = this.config.stt.model_path;
    if (!path.isAbsolute(modelPath)) {
      modelPath = path.join(PROJECT_ROOT, modelPath);
    }

    console.log(`Initializing STT with model at ${modelPath}`);

    // Load the model in a microtask break so Electron's main thread can
    // process window events during the ~2s synchronous model load.
    await new Promise((resolve) => {
      setTimeout(() => {
        this._stt = new SttEngine({
          modelPath,
          sampleRate: this.config.stt.sample_rate,
          hotwords: this.config.stt.hotwords || [],
        });
        resolve();
      }, 0);
    });
    console.log('STT engine loaded');

    this._mic = new AudioCapture({
      sampleRate: this.config.stt.sample_rate,
    });

    this._hotkey = new HotkeyActivation({
      hotkey: this.config.activation.hotkey,
      onStart: () => this._onHotkeyPress(),
      onStop: () => this._onHotkeyRelease(),
    });
    this._hotkey.start();

    console.log('STT pipeline initialized');
  }

  /** Stop all components. */
  stop() {
    if (this._hotkey) this._hotkey.stop();
    if (this._mic && this._isRecording) this._mic.stop();
    if (this._stt && this._stt.destroy) this._stt.destroy();
    this._stream = null;
    this._isRecording = false;
    console.log('STT pipeline stopped');
  }

  /**
   * Change the push-to-talk hotkey without reloading the STT engine.
   * Restarts just the hotkey listener.
   */
  setHotkey(hotkey) {
    if (this._hotkey) this._hotkey.stop();
    this._hotkey = new HotkeyActivation({
      hotkey,
      onStart: () => this._onHotkeyPress(),
      onStop: () => this._onHotkeyRelease(),
    });
    this._hotkey.start();
    console.log(`Hotkey updated to: ${hotkey}`);
  }

  /**
   * Reload the STT engine (used when model_path or sample_rate changes).
   * Abandons any in-flight recording.
   */
  async reloadEngine() {
    if (this._mic && this._isRecording) this._mic.stop();
    this._stream = null;
    this._isRecording = false;

    let modelPath = this.config.stt.model_path;
    if (!path.isAbsolute(modelPath)) {
      modelPath = path.join(PROJECT_ROOT, modelPath);
    }
    console.log(`Reloading STT engine with model at ${modelPath}`);

    // Clean up old engine's temp files
    if (this._stt && this._stt.destroy) this._stt.destroy();

    // Load off the sync path so Electron's main thread stays responsive
    await new Promise((resolve) => {
      setTimeout(() => {
        this._stt = new SttEngine({
          modelPath,
          sampleRate: this.config.stt.sample_rate,
          hotwords: this.config.stt.hotwords || [],
        });
        resolve();
      }, 0);
    });

    this._mic = new AudioCapture({
      sampleRate: this.config.stt.sample_rate,
    });

    console.log('STT engine reloaded');
  }

  // -----------------------------------------------------------------------
  // Internal — hotkey callbacks
  // -----------------------------------------------------------------------

  _onHotkeyPress() {
    if (!this._stt || !this._mic) return;
    this._resetTranscriptState();
    this._isRecording = true;

    try {
      this._mic.start((samples) => this._onChunk(samples));
      this.onRecordingStart();
    } catch (err) {
      console.error('Error starting recording:', err);
      this._isRecording = false;
    }
  }

  _onHotkeyRelease() {
    if (!this._isRecording || !this._stt || !this._stream) return;
    this._isRecording = false;

    try {
      this._mic.stop();
      this.onRecordingStop();

      const finalText = this._stt.finalize(this._stream, this._committed).trim();
      this._stream = null;

      if (!finalText) {
        this.onCancelled('', '');
        return;
      }

      const cancelMatch = this._detectCancelPhrase(finalText);
      if (cancelMatch) {
        this.onCancelled(cancelMatch, finalText);
      } else {
        this.onFinalText(finalText);
      }
    } catch (err) {
      console.error('Error finalizing recording:', err);
      this._stream = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — audio chunk processing
  // -----------------------------------------------------------------------

  _onChunk(samples) {
    if (!this._isRecording || !this._stt || !this._stream) return;

    const partialText = this._stt.feed(this._stream, samples, this._committed);

    const committedLen = this._committed.length;
    const endpointFired = committedLen > this._lastCommittedCount;

    let displayPartial;
    if (endpointFired) {
      this._lastCommittedCount = committedLen;
      this._bestPartial = '';
      displayPartial = '';
    } else {
      const partial = (partialText || '').trim();
      if (partial.length > this._bestPartial.length) {
        this._bestPartial = partial;
      }
      displayPartial = this._bestPartial;
    }

    const fullText = this._buildDisplayText(this._committed, displayPartial);

    // Real-time cancel detection — strikes out the cancelled text but keeps
    // recording so the user can continue speaking after the cancel phrase.
    if (fullText) {
      const cancelMatch = this._detectCancelPhrase(fullText);
      if (cancelMatch) {
        if (this._cancelDetected) return; // debounce
        this._cancelDetected = true;
        // Notify UI to strikethrough the cancelled text
        this.onCancelled(cancelMatch, fullText);
        // Reset STT state so new speech starts fresh, but keep recording
        this._committed = [];
        this._bestPartial = '';
        this._lastCommittedCount = 0;
        if (this._stt) {
          this._stream = this._stt.newStream();
        }
        this._cancelDetected = false;
        return;
      }
    }

    if (fullText) {
      this.onPartialText(fullText);
    }
  }

  // -----------------------------------------------------------------------
  // Internal — helpers
  // -----------------------------------------------------------------------

  _resetTranscriptState() {
    this._committed = [];
    this._bestPartial = '';
    this._lastCommittedCount = 0;
    this._cancelDetected = false;
    if (this._stt) {
      this._stream = this._stt.newStream();
    }
  }

  _buildDisplayText(committed, partial) {
    const committedText = committed.join(' ');
    if (partial) {
      return committedText ? `${committedText} ${partial}` : partial;
    }
    return committedText;
  }

  _detectCancelPhrase(text) {
    if (!text) return null;
    const phrases = (this.config.activation.cancel_phrases || []).map((p) => p.toLowerCase().trim());
    const lower = text.toLowerCase();
    return phrases.find((p) => lower.includes(p)) || null;
  }
}
