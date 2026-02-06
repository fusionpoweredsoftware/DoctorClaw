# DoctorClaw

A lightweight system troubleshooting agent powered by [Ollama](https://ollama.com). DoctorClaw diagnoses system issues interactively — reading config files, running diagnostic commands, executing scripts, and applying fixes — but **only with your explicit approval**.

![Node](https://img.shields.io/badge/Node.js-18%2B-green) ![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-blue) ![License](https://img.shields.io/badge/License-ISC-lightgrey)

---

## Quick Start

### Option A: One-Command Install

Don't have Node.js? The installer handles everything — detecting your OS, installing Node if needed, pulling dependencies, and starting the server.

**macOS / Linux:**
```bash
chmod +x install.sh
./install.sh
```

**Windows:**
```
Double-click install.bat
```

The installer will:
1. Check for Node.js v18+ and offer to install it if missing
2. Run `npm install` to pull dependencies
3. Create a default `doctorclaw.config.json` with OS-appropriate settings
4. Check for Ollama and warn if it's not installed
5. Start the server

### Option B: Manual Setup

If you already have Node.js 18+ and Ollama:

```bash
# Pull a model (if you haven't already)
ollama pull glm-4.7:cloud

# Install dependencies
npm install

# Start DoctorClaw
npm start
```

Then open **http://localhost:3333** in your browser.

### First-Run Setup

The first time you start DoctorClaw (with no `doctorclaw.config.json` present), it runs an interactive setup in your terminal, asking you to configure the model, Ollama URL, OpenClaw directory, OS, and paths. It also auto-detects available Ollama models so you can pick from a list.

You can control this behavior with flags:

| Flag | Effect |
|---|---|
| `-i` / `--interactive` | Always run the setup prompts, even if a config already exists |
| `-y` / `--yes` | Skip all prompts and use defaults (or existing config) |

```bash
# Re-run setup to change settings
node server.mjs -i

# Skip setup entirely (CI, scripts, etc.)
node server.mjs -y

# Or via npm
npm run setup      # same as -i
npm run start:quick  # same as -y
```

---

## Features

- **Interactive diagnostics** — describe an issue in plain English, and DoctorClaw walks through it step by step
- **Approval-gated actions** — every file read, command, script execution, and file write requires your explicit approval before it runs
- **Script execution** — run `.sh`, `.bash`, `.bat`, `.cmd`, and `.ps1` scripts directly from readable directories
- **Automatic backups** — any file modified by DoctorClaw is backed up first to `.doctorclaw-backups/`
- **Session tabs** — run multiple troubleshooting sessions side by side, with full history persisted in your browser
- **Settings UI** — configure everything from the gear icon in the header, no config file editing required
- **Dark mode** — toggle between light and dark themes
- **OS-aware** — commands and shell syntax adapt to your configured operating system
- **Experimental: Audio Conversing** — talk to DoctorClaw using your microphone (speech-to-text) and hear responses spoken aloud (text-to-speech) via [ElevenLabs](https://elevenlabs.io). See [EXPERIMENTAL-FEATS.md](EXPERIMENTAL-FEATS.md) for setup and details.

---

## Configuration

All settings can be managed from the **Settings panel** (gear icon ⚙ in the top-right corner of the UI). Changes to paths take effect immediately; changes to port, model, or Ollama URL require a restart.

Settings are stored in `doctorclaw.config.json`:

```json
{
  "port": 3333,
  "ollama_url": "http://localhost:11434",
  "model": "glm-4.7:cloud",
  "openclaw_dir": "/opt/openclaw",
  "os": "linux",
  "read_paths": [
    "/etc/",
    "/var/log/",
    "/tmp/",
    "/home/",
    "/opt/"
  ],
  "write_paths": [
    "/tmp/",
    "/opt/openclaw"
  ]
}
```

| Setting | Description | Default |
|---|---|---|
| `port` | Server port | `3333` |
| `ollama_url` | Ollama API endpoint | `http://localhost:11434` |
| `model` | Ollama model to use | `glm-4.7:cloud` |
| `openclaw_dir` | OpenClaw installation directory | `/opt/openclaw` |
| `os` | Operating system (`linux`, `macos`, `windows`) | `linux` |
| `read_paths` | Directories DoctorClaw can read from | See above |
| `write_paths` | Directories DoctorClaw can write to | See above |

Environment variables `PORT`, `OLLAMA_URL`, and `DOCTORCLAW_MODEL` override config file values.

---

## How It Works

DoctorClaw uses a local LLM through Ollama to diagnose system issues. When it needs to interact with your system, it requests one of four action types:

| Action | What It Does | Access Rule |
|---|---|---|
| **Read File** | Reads a file's contents | Must be in a readable path |
| **Run Command** | Executes a shell command | Checked against a blocklist of dangerous patterns |
| **Run Script** | Executes a `.sh`, `.bat`, `.cmd`, or `.ps1` script | Script must be in a readable path |
| **Write File** | Creates or modifies a file | Must be in a writable path; original is backed up first |

Each action appears as a card in the chat with **Approve** and **Deny** buttons. Nothing runs until you approve it. If an action is denied or fails, DoctorClaw explains what happened and suggests an alternative.

---

## Safety

DoctorClaw enforces multiple layers of protection:

**Approval required** — every action goes through an approve/deny flow before execution. There are no automatic or silent operations.

**Path restrictions** — file reads and writes are limited to the directories you configure. Attempts to access anything outside those paths are blocked.

**Command blocklist** — dangerous command patterns are rejected before they reach the approval step, including `rm -rf`, `mkfs`, `dd`, `shutdown`, `reboot`, fork bombs, piping untrusted scripts to shell, and more.

**Automatic backups** — before any file is modified, the original is copied to `.doctorclaw-backups/` with a timestamp. You can always roll back.

**Script sandboxing** — scripts run with the script's directory as the working directory and have a 60-second timeout.

**Command timeout** — individual commands are limited to 30 seconds to prevent hangs.

---

## Project Structure

```
doctorclaw/
├── server.mjs                 # Express server, Ollama proxy, action executor
├── public/
│   └── index.html             # Single-file frontend (chat UI, settings, tabs)
├── doctorclaw.config.json     # User configuration (created on first run)
├── package.json               # Node.js project config
├── install.sh                 # macOS/Linux installer
├── install.bat                # Windows installer
├── .doctorclaw-backups/       # Auto-created backup directory
├── README.md
└── EXPERIMENTAL-FEATS.md      # Documentation for experimental features
```

---

## Troubleshooting

**"Cannot reach Ollama"** — Make sure Ollama is running (`ollama serve`) and the URL in settings matches. Default is `http://localhost:11434`.

**"Model not found"** — Pull the model first: `ollama pull glm-4.7:cloud`. Or change the model in Settings to one you've already pulled.

**Port already in use** — Change the port in Settings or start with `PORT=4000 npm start`.

**Path access denied** — Open Settings (gear icon) and add the directory to the readable or writable paths list.

---

## Requirements

- **Node.js** 18+ (the installer can set this up for you)
- **Ollama** running locally with a pulled model
- A modern browser (Chrome, Firefox, Safari, Edge)
