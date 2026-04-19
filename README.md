# WalkieTalkAI

Voice-driven GitHub Copilot assistant with push-to-talk. Hold a hotkey, speak your question, and get a streamed response in a floating overlay.

## How It Works

1. **Hold** `Ctrl+Shift+Space` (configurable)
2. **Speak** your question — live transcript appears in the overlay
3. **Release** the hotkey — your speech is sent to GitHub Copilot
4. **Watch** the response stream in real-time in the floating overlay
5. The overlay auto-hides after 15 seconds

Say **"scrap that"** or **"nevermind"** while recording to cancel.

## Architecture

Single-process Electron app. No Python dependency.

- **STT**: Offline speech recognition via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (streaming Zipformer model)
- **Audio**: Microphone capture via [decibri](https://www.npmjs.com/package/decibri)
- **Hotkey**: Global push-to-talk via [uiohook-napi](https://github.com/SnosMe/uiohook-napi)
- **AI**: GitHub Copilot via [@github/copilot-sdk](https://www.npmjs.com/package/@github/copilot-sdk)
- **UI**: Electron overlay window + system tray

## Prerequisites

- **Node.js** 20+ and npm
- **GitHub Copilot** subscription and authentication (`gh auth login`)
- **Microphone** connected

## Installation

```bash
# Clone the repo
git clone https://github.com/Mark-T-Ureta/walkie-talkai.git
cd walkie-talkai

# Install dependencies
npm install

# Download an STT model (already included if you cloned with models/)
# Three English models are supported — pick one and put it under models/sherpa-onnx/
# Then set `stt.model_path` in config.yaml to its directory.
#
# Kroko 128L  — best accuracy (~4% WER, 147 MB)      → models/sherpa-onnx/kroko-128l-en/
# Kroko 64L   — faster, smaller (~147 MB, lower WER) → models/sherpa-onnx/kroko-64l-en/
# NeMo CTC 80ms — lowest latency (126 MB)            → models/sherpa-onnx/nemo-ctc-80ms-en/
#
# Example download (Kroko 128L):
mkdir -p models/sherpa-onnx/kroko-128l-en
cd models/sherpa-onnx/kroko-128l-en
for f in encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt; do
  curl -L -o "$f" "https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/main/en/kroko_128l/$f"
done
cd ../../..
```

## Usage

```bash
npm start
```

The app launches with:
- A **floating overlay** in the top-left corner (small pill when idle, expands on recording)
- A **system tray icon** (green microphone) with a right-click context menu

### System Tray Menu

Right-click the tray icon to access:

| Menu Item | Action |
|---|---|
| **Enabled/Disabled** | Toggle the push-to-talk listener on/off |
| **Settings...** | Open the settings window to configure all options |
| **Reset Conversation** | Clear Copilot conversation history and start fresh |
| **Switch Model** | Change the AI model (Claude Sonnet/Opus/Haiku, GPT-4.1/5.x) |
| **Restart** | Restart the application |
| **Quit** | Exit the application |

### Settings Window

Open via tray menu or by editing `config.yaml` directly. Five tabs:

- **Copilot** — AI model selection, system prompt
- **Context** — Working directory, custom instructions file, clipboard inclusion
- **Activation** — Hotkey combo, cancel phrases
- **Speech** — STT model path, sample rate
- **Overlay** — Position, opacity, auto-hide timer, dimensions

## Configuration

Settings are stored in YAML files:

- `config.default.yaml` — Built-in defaults (do not edit)
- `config.yaml` — Your overrides (created when you save settings, gitignored)

### Default Configuration

```yaml
copilot:
  model: gpt-4.1
  system_prompt: |
    You are a helpful voice assistant. Be concise and direct.
    Respond in plain text unless code is specifically requested.

activation:
  hotkey: ctrl+shift+space
  cancel_phrases:
    - scrap that
    - nevermind
    - never mind
    - scratch that

stt:
  model_path: models/sherpa-onnx/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17
  sample_rate: 16000

overlay:
  position: top-left     # top-left, top-right, top-center, bottom-left, bottom-right, bottom-center
  opacity: 0.92
  auto_hide_seconds: 15
  max_width: 340
  max_height: 260
```

### Available Models

Claude: `claude-sonnet-4`, `claude-sonnet-4.5`, `claude-sonnet-4.6`, `claude-haiku-4.5`, `claude-opus-4.5`, `claude-opus-4.6`

GPT: `gpt-4.1`, `gpt-5-mini`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4`, `gpt-5.4-mini`

## Project Structure

```
walkie-talkai/
├── package.json                    # Dependencies and scripts
├── config.default.yaml             # Default configuration
├── electron-builder.json           # Packaging config
├── models/sherpa-onnx/             # Offline STT model
├── assets/                         # App icons (icon.png, icon.ico)
├── src/
│   ├── main/                       # Electron main process
│   │   ├── main.js                 # App lifecycle, wiring
│   │   ├── copilot.js              # GitHub Copilot SDK integration
│   │   ├── stt-pipeline.js         # Push-to-talk orchestration
│   │   ├── stt-engine.js           # sherpa-onnx streaming wrapper
│   │   ├── audio-capture.js        # Microphone capture (decibri)
│   │   ├── hotkey.js               # Global hotkey (uiohook-napi)
│   │   ├── tray.js                 # System tray icon + menu
│   │   ├── config.js               # YAML config management
│   │   ├── config-watcher.js       # Live config reload (chokidar)
│   │   ├── protocol.js             # IPC event builders
│   │   └── ipc-handlers.js         # Settings window IPC
│   ├── preload/                    # Secure IPC bridges
│   │   ├── overlay-preload.js
│   │   └── settings-preload.js
│   └── renderer/                   # UI windows
│       ├── overlay/                # Floating overlay (HTML/JS/CSS)
│       └── settings/               # Settings window (HTML/JS/CSS)
└── tests/
```

## Building

```bash
# Package for Windows
npm run build
```

Output goes to `dist/`.

## Troubleshooting

**"STT model not found"** — Download the sherpa-onnx model (see Installation).

**"Copilot init failed"** — Run `gh auth login` and ensure you have an active Copilot subscription.

**Hotkey not working** — Check that no other application is capturing `Ctrl+Shift+Space`. Change it in Settings or `config.yaml`.

**No audio input** — Check your microphone is connected and set as the default input device.
