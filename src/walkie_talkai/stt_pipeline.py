"""Push-to-talk speech-to-text pipeline using tts-stt-plugin components."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable

import numpy as np

from tts_stt.activation.hotkey import HotkeyActivation
from tts_stt.audio.capture import AudioCapture
from tts_stt.stt.vosk_stt import VoskSTT

from walkie_talkai.config import Config

logger = logging.getLogger(__name__)


class STTPipeline:
    """Push-to-talk speech-to-text pipeline using tts-stt-plugin components."""

    def __init__(
        self,
        config: Config,
        on_recording_start: Callable[[], None] | None = None,
        on_partial_text: Callable[[str], None] | None = None,
        on_final_text: Callable[[str], None] | None = None,
        on_recording_stop: Callable[[], None] | None = None,
        on_cancelled: Callable[[str, str], None] | None = None,
    ):
        """
        Initialize the STT pipeline.

        Args:
            config: App configuration
            on_recording_start: Called when user presses the hotkey (recording begins)
            on_partial_text: Called with partial transcription as user speaks
            on_final_text: Called with final transcription when user releases hotkey
            on_recording_stop: Called when recording ends (before final text)
            on_cancelled: Called with (cancel_phrase, full_transcript_text)
        """
        self.config = config
        self.on_recording_start = on_recording_start or (lambda: None)
        self.on_partial_text = on_partial_text or (lambda _: None)
        self.on_final_text = on_final_text or (lambda _: None)
        self.on_recording_stop = on_recording_stop or (lambda: None)
        self.on_cancelled = on_cancelled or (lambda _p, _t: None)

        self.stt: VoskSTT | None = None
        self.mic: AudioCapture | None = None
        self.hotkey: HotkeyActivation | None = None

        self.recognizer = None
        self.lock = threading.Lock()
        self.is_recording = False
        self._committed: list[str] = []  # accumulates committed Vosk endpoint results
        self._best_partial: str = ""     # longest partial seen in current Vosk segment
        self._last_committed_count: int = 0  # detects when Vosk commits new words
        self._cancel_detected: bool = False  # set when cancel phrase found in real-time

    def start(self) -> None:
        """Initialize STT model, audio capture, and start hotkey listener."""
        try:
            # Resolve model path relative to project root if it's relative
            model_path = self.config.stt.model_path
            if not Path(model_path).is_absolute():
                # Navigate from this file to project root
                current_file = Path(__file__)
                package_dir = current_file.parent
                src_dir = package_dir.parent
                project_root = src_dir.parent
                model_path = str(project_root / model_path)

            logger.info(f"Initializing STT with model at {model_path}")

            # Initialize STT
            self.stt = VoskSTT(
                model_path=model_path,
                sample_rate=self.config.stt.sample_rate,
            )

            # Initialize audio capture
            self.mic = AudioCapture(
                sample_rate=self.config.stt.sample_rate,
                channels=1,
            )

            # Initialize hotkey listener
            self.hotkey = HotkeyActivation(
                hotkey=self.config.activation.hotkey,
                on_start=self._on_hotkey_press,
                on_stop=self._on_hotkey_release,
            )
            self.hotkey.start()

            logger.info("STT pipeline initialized successfully")

        except FileNotFoundError as e:
            logger.error(
                f"STT model not found at {model_path}. "
                "Please download the model using: "
                "python -m tts_stt.download_models"
            )
            raise
        except Exception as e:
            logger.error(f"Failed to initialize STT pipeline: {e}")
            raise

    def stop(self) -> None:
        """Stop all components."""
        with self.lock:
            if self.hotkey:
                self.hotkey.stop()

            if self.mic and self.is_recording:
                self.mic.stop()

            self.recognizer = None
            self.is_recording = False

        logger.info("STT pipeline stopped")

    def _detect_cancel_phrase(self, text: str) -> str | None:
        """Check if any cancel phrase appears in the given text (case-insensitive substring match)."""
        if not text:
            return None
        cancel_phrases = [p.lower().strip() for p in self.config.activation.cancel_phrases]
        lower_text = text.lower()
        return next((p for p in cancel_phrases if p in lower_text), None)

    def _reset_transcript_state(self) -> None:
        """Clear all transcript accumulators and create a fresh recognizer.

        Must be called while holding self.lock.
        """
        self._committed = []
        self._best_partial = ""
        self._last_committed_count = 0
        self._cancel_detected = False
        if self.stt:
            self.recognizer = self.stt.new_recognizer()

    def _build_display_text(self, committed_words: list[str], partial: str) -> str:
        """Assemble the full display text from committed words and current partial."""
        committed_text = " ".join(committed_words)
        if partial:
            return (committed_text + " " + partial).strip() if committed_text else partial
        return committed_text

    def _on_hotkey_press(self) -> None:
        """Called when push-to-talk hotkey is pressed."""
        with self.lock:
            if not self.stt or not self.mic:
                return
            self._reset_transcript_state()
            self.is_recording = True

        try:
            self.mic.start(chunk_callback=self._on_chunk)
            self.on_recording_start()
            logger.debug("Recording started")
        except Exception as e:
            logger.error(f"Error starting recording: {e}")
            with self.lock:
                self.is_recording = False

    def _on_hotkey_release(self) -> None:
        """Called when push-to-talk hotkey is released."""
        with self.lock:
            if not self.is_recording or not self.stt or not self.recognizer:
                return
            self.is_recording = False

        try:
            self.mic.stop()
            self.on_recording_stop()

            # Finalize STT to get complete text — pass committed so pauses don't drop words
            with self.lock:
                final_text = self.stt.finalize(self.recognizer, self._committed).strip()
                self.recognizer = None
                self._committed = []

            # Check for empty text — reset to idle so overlay doesn't stick on "Thinking..."
            if not final_text:
                logger.debug("No speech detected")
                self.on_cancelled("", "")
                return

            # Check against cancel phrases (substring match — user may say other words too)
            cancel_match = self._detect_cancel_phrase(final_text)
            if cancel_match is not None:
                logger.debug(f"Cancelled: matched '{cancel_match}' in '{final_text}'")
                self.on_cancelled(cancel_match, final_text)
            else:
                logger.debug(f"Final transcription: {final_text}")
                self.on_final_text(final_text)

        except Exception as e:
            logger.error(f"Error finalizing recording: {e}")
            with self.lock:
                self.recognizer = None

    def _on_chunk(self, chunk: np.ndarray) -> None:
        """Process an audio chunk: feed to Vosk, track partials, detect cancellation."""
        with self.lock:
            if not self.is_recording or not self.stt or not self.recognizer:
                return

            partial_text = self.stt.feed(self.recognizer, chunk, self._committed)
            committed_snapshot = list(self._committed)
            committed_len = len(committed_snapshot)
            endpoint_fired = committed_len > self._last_committed_count

            if endpoint_fired:
                self._last_committed_count = committed_len
                self._best_partial = ""
                display_partial = ""
            else:
                partial = (partial_text or "").strip()
                if len(partial) > len(self._best_partial):
                    self._best_partial = partial
                display_partial = self._best_partial

        full_text = self._build_display_text(committed_snapshot, display_partial)

        if full_text:
            logger.debug(f"{'Committed' if endpoint_fired else 'Partial'}: {full_text}")

        # Real-time cancel detection
        if full_text:
            cancel_match = self._detect_cancel_phrase(full_text)
            if cancel_match is not None:
                with self.lock:
                    if self._cancel_detected:
                        return  # debounce
                    self._cancel_detected = True
                    self._reset_transcript_state()
                    self._cancel_detected = False
                self.on_cancelled(cancel_match, full_text)
                return

        if full_text:
            self.on_partial_text(full_text)
