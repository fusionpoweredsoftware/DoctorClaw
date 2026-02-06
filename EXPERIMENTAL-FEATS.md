# Experimental Features

Experimental features live under the **Experimental** tab in Settings (gear icon). They are disabled by default and require additional third-party credentials.

---

## Audio Conversing

Talk to DoctorClaw with your voice instead of typing, and hear AI responses spoken aloud. Powered by [ElevenLabs](https://elevenlabs.io) for both speech-to-text (STT) and text-to-speech (TTS).

### Prerequisites

- An **ElevenLabs account** with an API key ([sign up](https://elevenlabs.io))
- A **Voice ID** from your ElevenLabs voice library (the default voice `21m00Tcm4TlvDq8ikWAM` — "Rachel" — is used if none is specified)
- A browser that supports the **MediaRecorder API** (Chrome, Firefox, Safari 14.5+, Edge)
- Microphone access granted in your browser

### Setup

1. Open **Settings** (gear icon in the top-right corner)
2. Switch to the **Experimental** tab
3. Enter your **ElevenLabs API Key**
4. Optionally enter a **ElevenLabs Voice ID** (defaults to Rachel if left blank)
5. Toggle **Enable Audio Conversing** on
6. Click **Save** — a microphone button will appear next to the send button

### Speech-to-Text (STT)

When audio conversing is enabled, a **microphone button** appears between the message input and the send button.

**How it works:**

1. Click the microphone button to start recording — the button turns red with a pulsing animation
2. As you speak, **words appear in real time** in the input field via ElevenLabs Realtime STT (Scribe v2 Realtime, ~150ms latency)
3. Review the transcription while speaking — you can see exactly what's being captured
4. Click the stop button when done; the final committed transcript is placed in the input field
5. Press Enter to send (auto-send is disabled so you can review first)

**Technical details:**

- **Realtime live preview:** Uses a WebSocket connection to ElevenLabs Scribe v2 Realtime (`wss://api.elevenlabs.io/v1/speech-to-text/realtime`). Audio is captured as raw PCM 16-bit 16kHz via `AudioContext` + `ScriptProcessorNode` and streamed to ElevenLabs through a server-side WebSocket proxy (`/ws/stt`). Partial and committed transcripts are displayed as they arrive (~150ms latency).
- **Batch fallback:** If the realtime WebSocket fails to connect, the full recording is sent via the batch STT endpoint (`/api/stt` → ElevenLabs Scribe v2 `POST /v1/speech-to-text`)
- Uses the browser's **MediaRecorder API** to capture audio locally (as backup for batch STT)
- Supported audio formats: WebM, OGG, MP4 (browser-dependent)
- Any existing text in the input field is preserved and the transcription is appended

### Text-to-Speech (TTS)

When audio conversing is enabled, AI responses are automatically spoken aloud as they stream in.

**How it works:**

1. As the AI response streams in, text is collected and grouped into chunks (roughly every 2 sentences or at paragraph breaks)
2. Each chunk is sent to ElevenLabs for audio generation in parallel — while the first chunk plays, subsequent chunks are already being generated
3. Audio chunks play back sequentially for a seamless listening experience
4. A **speaking indicator** with animated bars appears below the input area while audio is playing, along with a **Stop** button to cancel playback at any time

**Code block handling:**

- Code blocks (fenced with triple backticks) are **not** spoken aloud
- A single code block is replaced with the spoken phrase *"See code block"*
- Multiple consecutive code blocks are replaced with *"See code blocks"* (plural)

**Technical details:**

- TTS requests are sent to the server's `/api/tts` endpoint
- The server proxies to ElevenLabs TTS API (`POST /v1/text-to-speech/{voice_id}`)
- Uses the `eleven_monolingual_v1` model with balanced voice settings (stability: 0.5, similarity_boost: 0.5)
- Chunks are fetched in parallel to minimize gaps between audio playback
- Streaming TTS fires during response generation — it does **not** wait for the full response to complete

### Configuration Fields

| Setting | Description | Default |
|---|---|---|
| `audio_enabled` | Master toggle for audio features | `false` |
| `elevenlabs_api_key` | Your ElevenLabs API key | (none) |
| `elevenlabs_voice_id` | ElevenLabs voice to use for TTS | `21m00Tcm4TlvDq8ikWAM` (Rachel) |

These fields are stored in `doctorclaw.config.json` alongside the other settings.

### Troubleshooting

**Microphone button doesn't appear** — Make sure "Enable Audio Conversing" is toggled on in Settings > Experimental, and that you've clicked Save.

**"Transcribing..." stays forever** — Check that your ElevenLabs API key is valid and has available credits. Open the browser console for error details.

**No audio playback** — Verify your ElevenLabs API key and Voice ID are correct. The browser console will show errors if the TTS API returns a non-200 response.

**Audio cuts out between sentences** — This can happen on slow connections. The parallel fetching strategy minimizes gaps, but latency to the ElevenLabs API is the main factor.

**Live transcription not showing words** — The realtime STT requires a valid ElevenLabs API key with Scribe access. Check the browser console for WebSocket errors. If the realtime connection fails, the system falls back to batch transcription after you stop recording.

**Browser asks for microphone permission repeatedly** — Grant persistent microphone access for the DoctorClaw origin in your browser's site settings.
