# Sightline architecture

## Overview

```
 Samsung Galaxy S25 · Chrome                       Development computer (Node 22+)                       Google
┌──────────────────────────────────┐   same origin ┌──────────────────────────────────────────────┐
│ React UI (src/client/ui)         │   :3000       │ express + ws (src/server/index.ts)           │
│  start/stop/mute/read/look/typed │               │  • access gate (loopback or ACCESS_TOKEN)    │
│                                  │  HTTP  /      │  • WS origin check, maxPayload, ≤N sessions   │
│ AssistantController ─────────────┼─────────────► │  • GET /api/health (no secrets)               │
│  (src/client/session)            │               │                                               │
│   ├ CameraController + Sampler   │  WS  /ws      │ ClientSession (src/server/session)            │
│   │   rear camera, ≤1 FPS JPEG,  │◄────────────► │  • zod-validated messages, rate limits        │
│   │   latest-frame slot, hi-res  │  JSON msgs    │  • turn ids, cancelled-turn filtering         │
│   │   snapshots on demand        │  (protocol.ts)│  • tool loop: read_label / look_again ───────┼──► Gemini Live
│   ├ MicCapture (AudioWorklet →   │               │    LiveBridge (src/server/live)               │    (gemini-3.8-live)
│   │   16 kHz PCM16, AEC on)      │               │     audio in/out, transcripts, interruption,  │    audio + JPEG in,
│   ├ AudioPlayer (24 kHz PCM16,   │               │     goAway / session resumption               │    audio out
│   │   gap-free, instant flush)   │               │                                               │
│   └ SpeechOutput (snapshot TTS)  │               │ VisionService (src/server/vision) ────────────┼──► generateContent
└──────────────────────────────────┘               │  • structured label evidence (JSON schema)    │    (gemini-3.6-flash)
                                                   │  • dates.ts: deterministic date interpretation│
                                                   │  • snapshot-mode answers                      │
                                                   │ DetectorService (optional) ──► local YOLO     │
                                                   │   one in flight, private 127.0.0.1 only       │
                                                   └──────────────────────────────────────────────┘
```

Browser access paths: USB `adb reverse tcp:3000 tcp:3000` → `http://localhost:3000` (a secure context), or an
HTTPS tunnel with `ACCESS_TOKEN`. See [s25-connection.md](s25-connection.md).

## Key flows

**Live conversation.** The mic worklet produces 16 kHz PCM16 chunks; the controller sends them over `/ws`;
the server forwards them with `sendRealtimeInput({audio})`. Ambient frames (≤1 FPS, ≤768 px) are forwarded with
`sendRealtimeInput({video})`. Gemini's audio (24 kHz PCM16) returns tagged with a server-assigned `turnId`.

**Read label (button or voice).** The button captures a fresh 1600 px frame and sends `action: read_label`.
By voice, the Live model calls the `read_label` tool; the server sends `snapshot.request`, the phone replies
with a fresh frame. Either way the server calls the vision model with a JSON schema, computes date
interpretations deterministically (`src/shared/dates.ts`, injected clock, Europe/London), sends `evidence`
to the UI (exact text vs interpretation), and gives the evidence to the Live model (tool response, or ordered
client content for the button) to summarise aloud.

**Interruption.** Barge-in: Gemini sends `serverContent.interrupted` → server emits `turn: interrupted` →
client flushes all scheduled audio sources. "Stop speaking": the client flushes locally first (instant, works
even offline), then sends `playback.stop`; the server drops any further output of that turn. The player
also rejects late chunks for flushed turn ids.

**Snapshot fallback.** If the Live connection fails (no access, quota, network), the server reports a typed
error with `fallback: snapshot`. The UI is clearly labelled "Snapshot mode": each typed question carries a
fresh still photo to `generateContent`, the answer is shown and spoken with browser TTS.

## Design decisions and tradeoffs

| Decision | Why | Cost |
|---|---|---|
| Server-mediated Live session (not browser-direct) | Permanent key never leaves the server; server can validate, rate-limit, filter cancelled turns and run the vision tool loop | One extra hop (phone → laptop → Google) adds some latency |
| One origin/port (Vite middleware inside the Node server) | Same-origin `/ws` works identically over adb reverse and HTTPS tunnels; no CORS, no proxy config | Dev server and API restart together |
| JSON + base64 over WebSocket | Every message validated by one zod schema shared by both ends | ~33% size overhead vs binary frames; acceptable at 16 kHz audio + 1 FPS |
| Separate high-res vision call for labels | Small print needs more pixels than the ≤768 px live stream; structured output separates exact text from interpretation and makes dates checkable | Extra request and ~1–3 s latency for label reading (measure on device) |
| Deterministic date logic outside the model | Avoids invented years, guessed day/month order and batch-code confusion; testable with an injected clock | Only formats we parse are interpreted; others are reported as printed |
| Explicit buttons as well as voice tools | Dependable when the model doesn't choose a tool or speech recognition mishears | More UI |
| Context window compression + session resumption | Audio+video Live sessions are otherwise limited to ~2 minutes; connections last ~10 minutes | Older context may be summarised away in long sessions |
| Optional detector behind an interface | YOLO can be removed without touching conversation; it never answers packaging questions | COCO labels are generic; AGPL-3.0 licence for Ultralytics |
| Access gate keyed on loopback | USB dev needs no setup; any tunnel/LAN host is refused unless ACCESS_TOKEN is set | Token must be shared out-of-band with the tester |

## Privacy and security

- Media and transcripts live in memory for the session only; nothing is written to disk; logs are metadata-only.
- The client bundle is scanned after build (`npm run check:secrets`) for keys and direct provider endpoints.
- WebSocket: Origin must match the page's host (or `ALLOWED_ORIGINS`); payload cap 2.5 MB; zod validation;
  audio rate limit; max session duration; max concurrent sessions.
- Tools are a fixed allow-list (`read_label`, `look_again`); there is no URL fetching or command execution.
- Text read from images is passed to the model as untrusted content, never as instructions.
