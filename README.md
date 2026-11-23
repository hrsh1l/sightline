# Sightline

**Ask about what's in front of you.** Sightline is a conversational visual assistant prototype for blind and
low-vision people. Point a phone's rear camera at something, ask out loud ("What am I holding?", "Read the
label", "Just the microwave instructions", "Repeat that", "Look again") and hear a short spoken answer.
The first demonstration is in a kitchen — ingredients, packaging, cooking instructions and dates — but nothing
in the product is cooking-specific: it works for everyday objects and printed text.

This is a **phone prototype** (Samsung Galaxy S25, Chrome) with a Node backend on a development computer.
Smart glasses are future work only (see [submission.md](submission.md)); there is no glasses integration.

> **Verification status (2026-11-23).** Automated, integration and desktop-browser tests pass with clearly
> labelled fixture providers — see [docs/test-results.md](docs/test-results.md). **Not yet verified:** real
> Gemini Live / Gemini vision calls (no API key was configured in the build environment) and a physical S25.
> Run `npm run check:models` and the [manual checklist](docs/mobile-checklist.md) before relying on it.

## How it works

```
S25 Chrome (React UI, camera ≤1 FPS + hi-res snapshots, 16 kHz mic, 24 kHz playback)
   │  one origin, port 3000:  HTTP  /   /api/health    WebSocket  /ws (JSON, zod-validated)
   ▼
Node server (express + ws) ── Gemini Live (gemini-3.8-live): voice in/out, frames, tool calls
                           ├─ Gemini vision (gemini-3.6-flash): structured label evidence, snapshot answers
                           └─ optional local YOLO26n detector (127.0.0.1 only)
```

- The Gemini API key stays on the server; the browser only talks to its own origin. The client bundle is
  scanned for secrets after every build.
- "Read label" (button or voice tool call) takes a fresh 1600 px photo, extracts **exact printed text**
  separately from interpretation, and interprets dates deterministically (no invented years, no guessed
  day/month order, batch codes kept separate), comparing against an injected current date in Europe/London.
- Interruptions flush playback immediately; output from a cancelled turn is discarded on server and client.
- If Gemini Live is unavailable, **Snapshot mode** sends a fresh still photo with each typed question to the
  vision model and reads the answer with browser text-to-speech.

Details and tradeoffs: [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js ≥ 22.12 (built and tested with Node 26.5.1, npm 11.17.0) on macOS/Linux/Windows.
- A Gemini API key from Google AI Studio with access to a Live model and a Flash vision model.
- Samsung Galaxy S25 (or another Android phone) with Chrome, a data-capable USB cable, and Android platform
  tools (`adb`) on the computer — macOS: `brew install --cask android-platform-tools`.
- Optional: [`uv`](https://docs.astral.sh/uv/) for the YOLO detector.

## Setup

```sh
git checkout feat/sightline
npm ci                     # npm may print "allow-scripts" warnings for esbuild/protobufjs; they are harmless
cp .env.example .env       # then edit .env locally and set GEMINI_API_KEY=...  (never commit it or paste it in chat)
npm run check:models       # verifies YOUR account can use LIVE_MODEL and VISION_MODEL (sends only "Say OK")
npm run dev                # http://localhost:3000 on the computer
```

`npm run check:models` exits 0 only if a real generateContent call and a real Live session (with audio back)
both succeed. If the Live model fails, set `LIVE_MODEL` to another Live model your key can use (current docs list
`gemini-3.8-live`, `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025`); if the vision
model fails, try `gemini-3.5-flash-lite` or `gemini-3.8-flash`.

## Open it on the Samsung Galaxy S25

Camera and microphone need a **secure context**: `http://localhost` or `https://`. Plain
`http://<laptop-LAN-IP>:3000` will not get camera/mic access, so don't use it.

**A. USB (recommended for the demo)** — full guide with troubleshooting: [docs/s25-connection.md](docs/s25-connection.md)

1. On the phone: Settings › About phone › Software information › tap **Build number** 7 times; then
   Settings › Developer options › enable **USB debugging**.
2. Connect USB; accept **Allow USB debugging?** on the phone.
3. On the computer:
   ```sh
   adb devices                     # must show the phone as "device" (not "unauthorized")
   adb reverse tcp:3000 tcp:3000   # phone's localhost:3000 -> computer's localhost:3000
   npm run dev                     # or: npm run build && npm start
   ```
4. In Chrome on the phone open **http://localhost:3000**, tap **Start assistant**, allow camera and microphone.

Without the adb CLI: desktop Chrome › `chrome://inspect/#devices` › Port forwarding › `3000` → `localhost:3000`.

**B. Wireless HTTPS (tunnel)** — the server refuses any non-localhost host unless `ACCESS_TOKEN` is set.

```sh
openssl rand -hex 32                      # put it in .env as ACCESS_TOKEN=...
npm run build && npm start
cloudflared tunnel --url http://localhost:3000   # prints https://<random>.trycloudflare.com
```

On the phone open `https://<host>/?access=<token>` once (sets an HttpOnly cookie and redirects). WebSockets use
`wss://<host>/ws` automatically. Stop the tunnel after the demo: anyone with the token can spend your API quota.

## Using it

1. Read the privacy note: while a session is active, selected camera frames and microphone audio go to Google
   Gemini. Nothing is saved by Sightline after the session ends.
2. **Start assistant** (this tap also unlocks audio playback).
3. Hold an item up to the rear camera and ask. Buttons give dependable alternatives to voice:
   **Read label**, **Look again**, **Repeat**, **Stop speaking**, **Mute microphone**, **Switch camera**, a typed
   question field, and **End session** (stops camera, microphone, transmission and playback immediately).
4. Settings: Live/Snapshot mode, push-to-talk (for noisy rooms or speaker echo), "pause microphone while Sightline
   speaks", camera preview, detector overlay, diagnostics (models, frame age, latency).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server (Vite middleware + API + WebSocket) on `HOST:PORT` (default 127.0.0.1:3000) |
| `npm run build` | Production client build (`dist/client`) and server build (`dist/server`) |
| `npm start` | Run the production build |
| `npm run typecheck` / `npm run lint` | TypeScript (client, server, tests) / ESLint |
| `npm test` | Unit + integration tests (vitest) |
| `npm run test:e2e` | Desktop Chromium e2e with fake camera/mic and FIXTURE providers (`npx playwright install chromium` once) |
| `npm run check:secrets` | Scan the client build for keys or direct provider endpoints (run after build) |
| `npm run check:models` | Verify the configured account can actually use the configured models |
| `npm run verify` | typecheck + lint + test + build + secret scan |

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | — | Server-side only. Missing → honest "not configured" state; the UI still loads. |
| `LIVE_MODEL` | `gemini-3.8-live` | Live (native audio) model |
| `VISION_MODEL` | `gemini-3.6-flash` | Label reading and snapshot answers |
| `LIVE_VOICE` | `Kore` | Prebuilt voice |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | 127.0.0.1 is enough for adb reverse and tunnels |
| `ACCESS_TOKEN` | — | Required for any non-localhost host (tunnel/deployment) |
| `ALLOWED_ORIGINS` | — | Extra WebSocket origins if a proxy rewrites Host |
| `MAX_SESSION_MINUTES` / `MAX_CONCURRENT_SESSIONS` | `20` / `2` | Resource limits |
| `APP_TIMEZONE` | `Europe/London` | Date comparisons on packaging |
| `DETECTOR_URL` | — | e.g. `http://127.0.0.1:8765` to enable the optional YOLO overlay |

## Optional YOLO overlay

```sh
cd services/detector && uv sync && uv run python server.py --port 8765   # ~1 GB first install; weights ~5.5 MB
# then in .env: DETECTOR_URL=http://127.0.0.1:8765 and restart the Node server
```

YOLO26n (COCO, 80 generic classes) draws image-relative boxes only. It cannot identify products, read text or
dates, and never answers questions — Gemini does. Licence: AGPL-3.0 (see [ATTRIBUTION.md](ATTRIBUTION.md)).
Sightline works identically with it disabled (the default).

## Troubleshooting (short)

| Symptom | Fix |
|---|---|
| No camera/mic prompt, or "insecure context" | You're on a LAN IP over http. Use `http://localhost:3000` via `adb reverse`, or the HTTPS tunnel. |
| Permission denied earlier | Chrome › ⋮ › Settings › Site settings › Camera/Microphone › allow `localhost:3000`; reload. |
| "Camera in use" | Close other camera apps (Camera, video calls); tap Start again. |
| WebSocket fails / stuck "Connecting" | `adb reverse --list` should show 3000; check the server terminal; 403 = origin/token, 401 = open `/?access=<token>`, 503 = too many sessions. |
| No sound | Tap the screen (audio may be suspended), raise media volume, check Bluetooth output. |
| "Gemini rejected the server's API key" / "model not available" | Fix `.env`, run `npm run check:models`, restart. |
| Live fails but you need to demo | Settings › Snapshot mode (typed question + photo + spoken answer). |

More: [docs/s25-connection.md](docs/s25-connection.md).

## Privacy, safety and limits

- Session memory only: no audio, image or transcript is written to disk or logs; logs are metadata only.
- Sightline reads what is printed and describes what is visible. It does **not** certify freshness, doneness,
  allergen absence or safety, does not guide knife movements, and gives no navigation instructions.
- Text in images is treated as content to read, never as instructions to the assistant.

## Known limitations

- Not yet run against the real Gemini APIs or on a physical S25 (see status above); latency has not been measured.
- Gemini Live is a preview API; model names, limits and behaviour may change.
- Echo cancellation quality on the phone speaker is unverified; use headphones or push-to-talk if the assistant
  hears itself.
- "Stop speaking" silences playback and discards the rest of the turn; the provider may still finish generating it.
- Date parsing covers common UK/EU packaging formats; anything else is reported as printed, not interpreted.
- No blind or low-vision participants have tested this prototype yet.

## Repository map

`src/shared/protocol.ts` (message contract) · `src/client/{camera,audio,session,ui}` · `src/server/{session,live,vision,http}` ·
`services/detector` (optional YOLO) · `tests/` · `docs/` · [ai.md](ai.md) · [submission.md](submission.md) ·
[demo-script.md](demo-script.md) · [ATTRIBUTION.md](ATTRIBUTION.md)
