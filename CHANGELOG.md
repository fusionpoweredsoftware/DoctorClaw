# Changelog

All notable changes to DoctorClaw will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-02-06

### Added
- Initial release of DoctorClaw system diagnostics agent
- Express server with Ollama integration for AI-powered troubleshooting
- Interactive setup wizard with `-i` flag and auto-setup with `-y` flag
- Action execution engine with READ_FILE, RUN_CMD, RUN_SCRIPT, and WRITE_FILE support
- Safety controls: blocked commands list, path-based read/write restrictions, automatic file backups
- Multi-tab chat interface with session persistence
- Settings panel for configuring Ollama, paths, and OpenClaw integration
- Dark/light theme toggle
- OpenClaw auto-detection and directory validation
- Ollama version checking and update recommendations
- ElevenLabs TTS/STT integration (experimental audio conversing)
- WebSocket-based realtime speech-to-text proxy
- macOS/Linux/Windows installer scripts
- Versioning system with `npm run version:patch/minor/major` scripts
