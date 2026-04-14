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
        on_cancelled: Callable[[], None] | None = None,
    ):
        """
        Initialize the STT pipeline.

        Args:
            config: App configuration
            on_recording_start: Called when user presses the hotkey (recording begins)
            on_partial_text: Called with partial transcription as user speaks
            on_final_text: Called with final transcription when user releases hotkey
            on_recording_stop: Called when recording ends (before final text)
            on_cancelled: Called when user says a cancel phrase
        """
        self.config = config
        self.on_recording_start = on_recording_start or (lambda: None)
        self.on_partial_text = on_partial_text or (lambda _: None)
        self.on_final_text = on_final_text or (lambda _: None)
        self.on_recording_stop = on_recording_stop or (lambda: None)
        self.on_cancelled = on_cancelled or (lambda: None)

        self.stt: VoskSTT | None = None
        self.mic: AudioCapture | None = None
        self.hotkey: HotkeyActivation | None = None

        self.recognizer = None
        self.lock = threading.Lock()
        self.is_recording = False

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

    def _on_hotkey_press(self) -> None:
        """Called when push-to-talk hotkey is pressed."""
        with self.lock:
            if not self.stt or not self.mic:
                return

            self.recognizer = self.stt.new_recognizer()
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
            # Stop audio capture
            self.mic.stop()
            self.on_recording_stop()

            # Finalize STT to get complete text
            with self.lock:
                final_text = self.stt.finalize(self.recognizer).strip()
                self.recognizer = None

            # Check for empty text
            if not final_text:
                logger.debug("No speech detected")
                return

            # Check against cancel phrases
            lower_text = final_text.lower().strip()
            cancel_phrases = [p.lower().strip() for p in self.config.activation.cancel_phrases]

            if lower_text in cancel_phrases:
                logger.debug(f"Cancelled: matched cancel phrase '{final_text}'")
                self.on_cancelled()
            else:
                logger.debug(f"Final transcription: {final_text}")
                self.on_final_text(final_text)

        except Exception as e:
            logger.error(f"Error finalizing recording: {e}")
            with self.lock:
                self.recognizer = None

    def _on_chunk(self, chunk: np.ndarray) -> None:
        """Called for each audio chunk during recording."""
        with self.lock:
            if not self.is_recording or not self.stt or not self.recognizer:
                return

            # Feed chunk to STT and get partial text
            partial_text = self.stt.feed(self.recognizer, chunk)

        if partial_text:
            partial_text = partial_text.strip()
            if partial_text:
                logger.debug(f"Partial: {partial_text}")
                self.on_partial_text(partial_text)
