"""JSON message types for IPC and WebSocket communication."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

import json


# -- Overlay WebSocket events (Python → browser) --


@dataclass
class StatusEvent:
    state: Literal["recording", "processing", "idle"]
    type: str = "status"


@dataclass
class TranscriptEvent:
    text: str
    type: str = "transcript"


@dataclass
class TokenEvent:
    content: str
    type: str = "token"


@dataclass
class DoneEvent:
    full_text: str
    type: str = "done"


@dataclass
class ErrorEvent:
    message: str
    type: str = "error"


@dataclass
class HideEvent:
    type: str = "hide"


@dataclass
class CancelledEvent:
    phrase: str = "scratch that"
    full_text: str = ""
    type: str = "cancelled"


def to_json(event) -> str:
    return json.dumps(asdict(event))


def from_json(data: str) -> dict:
    return json.loads(data)
