# Sightline: ask about what's in front of you

A voice-first visual assistant for blind and low-vision people. Point a phone camera at something and *talk* about
it: "What am I holding?", "Read the label", "Just the microwave part", "Guide me through these instructions",
"Find the mug". Short spoken answers that you can interrupt.

**Hiya Voice AI Challenge · Track: Accessibility** (with Real-Time Assistance)

- 📄 **One-page write-up:** [WRITEUP.md](WRITEUP.md)
- 🖼️ **Walkthrough with screenshots (real Gemini output):** [docs/how-it-works.md](docs/how-it-works.md)
- 🤖 **AI tools used and how:** [ai.md](ai.md)
- 🧱 **Architecture and tradeoffs:** [docs/architecture.md](docs/architecture.md)
- ✅ **What was tested, and how:** [docs/test-results.md](docs/test-results.md)

## Quick start (about 5 minutes, laptop only)

You need **Node.js 22.12 or later** and a **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey).
The free tier works but has low daily limits.

```sh
git clone https://github.com/hrsh1l/sightline.git && cd sightline
npm ci                     # "allow-scripts" warnings are harmless
cp .env.example .env       # then set GEMINI_API_KEY=... in .env (stays on the server; never sent to the browser)
npm run dev                # http://localhost:3000
```

Open **http://localhost:3000** in desktop Chrome and tap **Start assistant**. Allow camera and microphone (a
laptop webcam is fine), then try these:

| Say (or tap) | What happens |
|---|---|
| "What am I holding?" | It describes the object in one or two sentences |
| "Read the label" / **Read label** | It takes a fresh photo, reads the exact printed text and checks the dates |
| "Guide me through these instructions" | It checks the framing, then walks through the printed steps: say "next", "repeat", "what does that mean?", "done", "where were we?" |
| "Stop" / **Stop speaking** | It goes silent at once; you can interrupt any time |
| **Pause camera** | The camera turns off and you can keep talking |

Without a key the page still loads and says it isn't configured. With a key, `npm run check:models` confirms your
account can use the models.
Find mode's directional audio needs a rear phone camera and the optional local detector (see below).

### On a phone (as built and demoed: Samsung Galaxy S25, Chrome)

Camera and microphone need a secure page, so the phone opens `http://localhost:3000` forwarded over adb.
Details are in [Open it on the Samsung Galaxy S25](#open-it-on-the-samsung-galaxy-s25).

```sh
adb devices && adb reverse tcp:3000 tcp:3000   # USB, or Wireless debugging (below)
```

### Run the tests (no API key or quota needed)

```sh
npm run verify             # typecheck, lint, build, 1,028 unit + integration tests, client secret scan
npx playwright install chromium && npm run test:e2e   # 11 browser end-to-end tests (fake camera/mic, FIXTURE Gemini)
```

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
- **Small print:** "Read label" takes a full-resolution still (ImageCapture photo, or the sharpest of three frames),
  finds the text regions with a fast model, crops them at native resolution and reads the crops at Gemini's
  highest image resolution. A **Torch** button lights the label. If the main vision model is slow, overloaded or
  out of quota, the read falls back to the fast model once.
- **Object boxes:** green boxes over the preview from the optional local YOLO26n detector (up to 4 FPS on small
  frames that never go to Gemini Live).
- **Find an object** ("Find a bottle", or the *Find an object* buttons): cups/mugs, bottles, bowls, apples and
  bananas, detected by the local YOLO26n model. A gentle **stereo beacon** follows the chosen object: left of the
  camera view → left ear, right → right ear, faster pulses = better aligned; one chime + "Bottle centred in the
  camera." when stably centred; spoken tilt hints; asks "the left one or the right one?" when several match; then
  "Read its label" reads that object. Stereo check for earbuds, spoken-direction fallback, and a release-microphone
  option for Bluetooth. Camera-view aiming only — see [docs/find-mode.md](docs/find-mode.md).
- **Instruction companion** ("Guide me through these instructions"): checks a fresh photo, gives one evidence-based
  camera adjustment if the instructions aren't readable ("How about now?" checks a new photo), extracts the visible
  steps verbatim (methods such as microwave/oven kept separate), and walks through them: Next, Repeat, Explain,
  Done, Undo, Pause/Resume, "Where were we?". The app owns progress: reading a step never marks it done; only your
  "Done" does. Works for packaging and simple printed assembly sheets. See
  [docs/instruction-companion.md](docs/instruction-companion.md).
- **Event sounds and haptics:** short cues for session start/end, hold-still/shutter, working, found, lost, error.
- If Gemini Live is unavailable, **Snapshot mode** sends a fresh still photo with each typed question to the
  vision model and reads the answer with browser text-to-speech.

Details and tradeoffs: [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js ≥ 22.12 (built and tested with Node 26.5.1, npm 11.17.0) on macOS/Linux/Windows.
- A Gemini API key from Google AI Studio with access to a Live model and a Flash vision model.
- For the phone route: Samsung Galaxy S25 (or another Android phone) with Chrome, a data-capable USB cable, and Android platform
  tools (`adb`) on the computer — macOS: `brew install --cask android-platform-tools`.
- Optional: [`uv`](https://docs.astral.sh/uv/) for the YOLO detector.

## Setup (detailed)

```sh
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

**A2. Wireless debugging (same Wi-Fi, no cable)** — still `http://localhost:3000` on the phone, no token needed:

```sh
# Phone: Developer options › Wireless debugging › On › "Pair device with pairing code"
adb pair <ip>:<pairing-port>       # enter the 6-digit code (one time)
adb connect <ip>:<connect-port>    # the port shown on the main Wireless debugging screen
adb reverse tcp:3000 tcp:3000
```

Re-run `adb connect` and `adb reverse` if the phone sleeps, changes network or Wireless debugging is toggled.
Networks with client isolation (guest/corporate Wi-Fi) block this; use the HTTPS tunnel instead.

**B. HTTPS tunnel (any network)** — the server refuses any non-localhost host unless `ACCESS_TOKEN` is set.

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
   **Read label**, **Look again**, **Repeat**, **Stop speaking**, **Mute microphone**, **Switch camera**,
   **Pause camera** (turns the camera off and releases it; the conversation continues by voice, Gemini is told it
   cannot see, and Read label / Find / Guide ask you to resume first), a typed question field, and **End session** (stops camera, microphone, transmission and playback immediately).
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
| `npm run detector` | Run the optional local YOLO detector on 127.0.0.1:8765 |
| `npm run test:e2e:find` | Real-detector Find test in Chromium (needs `npm run detector`) |
| `npx tsx scripts/eval-guide.ts` | Live guide-extraction probe on synthetic instruction images (uses quota) |
| `npx tsx scripts/live-guide-dialogue.ts` | Live typed conversation through a running server: guide tools end to end (uses quota) |
| `npx tsx scripts/eval-label.ts` | Live label-reading probe on a synthetic packet image (uses API quota) |
| `npm run verify` | typecheck + lint + test + build + secret scan |

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | — | Server-side only. Missing → honest "not configured" state; the UI still loads. |
| `LIVE_MODEL` | `gemini-3.8-live` | Live (native audio) model |
| `VISION_MODEL` | `gemini-3.6-flash` | Label reading and snapshot answers (falls back to `LOCATE_MODEL` on timeout/5xx/429) |
| `GUIDE_MODEL` / `GUIDE_FALLBACK_MODEL` | `gemini-3.5-flash-lite` / (same, paused retry) | Instruction-guide extraction |
| `LOCATE_MODEL` | `gemini-3.5-flash-lite` | Fast model: find-mode boxes, label text-region pass, fallback reads |
| `LIVE_VOICE` | `Kore` | Prebuilt voice |
| `ASSISTANT_LANGUAGE` | `English` | Reply language; Sightline won't switch because of printed text or background speech |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | 127.0.0.1 is enough for adb reverse and tunnels |
| `ACCESS_TOKEN` | — | Required for any non-localhost host (tunnel/deployment) |
| `ALLOWED_ORIGINS` | — | Extra WebSocket origins if a proxy rewrites Host |
| `MAX_SESSION_MINUTES` / `MAX_CONCURRENT_SESSIONS` | `20` / `2` | Resource limits |
| `APP_TIMEZONE` | `Europe/London` | Date comparisons on packaging |
| `DETECTOR_URL` | — | `http://127.0.0.1:8765` enables object boxes and Find an object |
| `FIND_GEMINI` | `false` | Experimental Gemini boxes for unsupported Find items (uses quota) |

## Object boxes (optional local YOLO detector)

```sh
cd services/detector && uv sync && cd ../..   # one time, ~1 GB (PyTorch); weights (~5.5 MB) download on first start
npm run detector                              # terminal 2: serves http://127.0.0.1:8765
# in .env: DETECTOR_URL=http://127.0.0.1:8765   then restart `npm run dev`
```

`/api/health` then reports `"detector": "ok"`, and Settings › *Show object boxes* is on by default. Without the
detector, Find mode still works through Gemini (one box, about once a second).

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

- Tested against real Gemini (see test results) and informally on a Galaxy S25. The formal phone checklist ([docs/mobile-checklist.md](docs/mobile-checklist.md)),
  Find with Bluetooth earbuds, and the instruction companion on the phone have not been fully run. Phone latency
  has not been measured.
- On the Gemini free tier, requests sometimes fail with overload or quota errors. Sightline reports this rather
  than guessing.
- Gemini Live is a preview API; model names, limits and behaviour may change.
- Echo cancellation quality on the phone speaker is unverified; use headphones or push-to-talk if the assistant
  hears itself.
- "Stop speaking" silences playback and discards the rest of the turn; the provider may still finish generating it.
- Date parsing covers common UK/EU packaging formats; anything else is reported as printed, not interpreted.
- No blind or low-vision participants have tested this prototype yet.

## Repository map

`src/shared/protocol.ts` (message contract) · `src/client/{camera,audio,session,ui}` · `src/server/{session,live,vision,http}` ·
`services/detector` (optional YOLO) · `tests/` · `docs/` · [ai.md](ai.md) · [WRITEUP.md](WRITEUP.md) ·
[demo-script.md](demo-script.md) · [ATTRIBUTION.md](ATTRIBUTION.md)
