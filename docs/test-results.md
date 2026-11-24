# Sightline test results

Date of run: **2026-11-23**. Machine: macOS (Darwin 27.2.0, arm64), the verification worker's git worktree based on
integration commit `620a037`.

Versions: Node `v26.5.1` (repo requires ≥ 22.12), TypeScript 6.0.3, Vitest 5.1.1, Playwright 1.65.1 with
Chrome Headless Shell **159.0.8154.6** (Playwright build `chromium-headless-shell v1255`).

The five sections below are deliberately separate. Only sections 1–3 were run. **FIXTURE** means a scripted
fake in the test code (`tests/fixtures/`, `src/**/__fixtures__`, fakes inside `*.test.ts`). Fixture results show
that the code plumbing works; they say nothing about how the real Gemini models behave or how the app runs on
the phone.

## Static checks and build (all passed)

| Command | Result |
|---|---|
| `npm run typecheck` | passed (client, server and test tsconfigs; includes `tests/**` and `playwright.config.ts`) |
| `npm run lint` | passed, 0 problems |
| `npm run build` | passed (`dist/client`: index.html, CSS, main JS 381 kB / 116 kB gzip, separate mic worklet file) |
| `npm run check:secrets` | passed: "scanned 4 client build files; no secrets or direct provider endpoints found" |

## 1. Automated unit tests

Command: `npx vitest run` (unit and integration run together: **23 files, 444 tests, all passed**). Section 2
breaks out the integration files. Unit share: **21 files, 417 tests**.

- Pre-existing worker tests: 18 files, 322 tests (camera, audio, session controller, socket, UI/RTL, server
  session with FIXTURE Live connector, Live bridge, vision with FIXTURE `ai`, dates, detector, security).
- New in this verification pass (`tests/unit/`, 95 tests):
  - `tests/unit/protocol.test.ts` (69): every `ClientMessage` and `ServerMessage` variant accepted from a
    valid fixture (checked against the union's own variant list, so a new message type without a fixture
    fails), and 40 invalid cases rejected: oversize audio/frames/text, `data:` prefixes, bad mime, unknown
    types/actions/tools/codes, out-of-range boxes, too many detections. Also checks that a max-size frame fits
    under the WebSocket payload cap and that the health payload has no field that could carry a secret.
  - `tests/unit/controller.coverage.test.ts` (21, jsdom, FIXTURE camera/mic/player/socket): detection TTL and
    ordering edge cases; frames never queued during reconnect; mic denied / both denied / camera disconnected
    mid-session / camera denied → `snapshot.unavailable camera_denied`; retry after allowing the camera; late
    transcript of an interrupted turn dropped; turn rejection across reconnects; end() during pending reconnect
    and pending permission prompts; **regression for bug 1 below**; live → snapshot fallback (connect failure
    and mid-session loss); snapshot TTS + Stop speaking; explicit Read label capture freshness.
  - `tests/unit/ui.coverage.test.tsx` (5, jsdom, FIXTURE controller): disconnected camera, mic denied and camera
    in-use messaging; fallback banner with the provider message; missing-credentials Start screen.

## 2. Integration tests with FIXTURE providers against the real server

Command: `npx vitest run tests/integration` — **2 files, 27 tests, all passed** (about 6 s).

The **real** `startServer()` from `src/server/index.ts` is started on a free port, with a **FIXTURE** Live
connector (`tests/fixtures/fixtureLive.ts`: records every `sendRealtimeInput` / `sendClientContent` /
`sendToolResponse` / `close`, emits `setupComplete`, audio parts, transcriptions, `interrupted`, `turnComplete`,
`toolCall`, `toolCallCancellation`, `goAway`, `sessionResumptionUpdate`, provider closes) and **FIXTURE** vision
(`tests/fixtures/fixtureVision.ts`). The client is a real `ws` WebSocket sending an `Origin` header.

`tests/integration/server.test.ts` (24), development mode:
- `/api/health` matches the contract, `Cache-Control: no-store`, no key or secret-like field; security headers.
- Non-localhost `Host` refused (HTTP 403, WS 403) without `ACCESS_TOKEN`; with a token: `/?access=` sets an
  HttpOnly, SameSite=Strict HMAC cookie (not the token) and redirects; cookie then allows HTTP and WS; WS without
  the cookie → 401.
- Cross-origin and missing-Origin WebSockets → 403; first message must be `hello` (close 1008).
- hello → status connecting/live → ready; mic audio forwarded with `audio/pcm;rate=16000`, frames as
  `image/jpeg`; **1 FPS guard** (frames every 200 ms for 3 s → 3–4 forwarded, gaps ≥ 900 ms); stale (old
  `capturedAt`) and out-of-order (lower `frameId`) frames dropped.
- `interrupted` → `turn interrupted`; later audio/transcript of that turn discarded; next turn flows.
  `playback.stop` → `turn cancelled`, remaining audio discarded.
- `read_label` tool round trip: toolCall → `snapshot.request` (maxDim 1600) → `snapshot.result` → FIXTURE vision
  → `evidence` → `sendToolResponse` with the same call id containing dates and batch codes.
  `toolCallCancellation` → tool cancelled, a late `snapshot.result` gets no tool response.
- Read label button: evidence → ordered client content to Live; stale frame → `frame_stale`.
- goAway → reconnect with the resumption handle; old provider session closed; media flows only to the new one.
- Invalid messages after hello (bad JSON, `data:` prefix, unknown type) → recoverable `invalid_message`.
- `bye` → close 1000, provider session closed, provider messages afterwards trigger nothing, no sends after
  close, `session_disposed reason=bye`. Abrupt close disposes too. Message larger than `maxPayload` → close 1009
  and disposal.
- Connect failure (404) → `model_unavailable` with `fallback: snapshot` (raw provider text not forwarded) →
  `ready(snapshot)` → typed question answered by FIXTURE vision; missing frame → `frame_missing`.
  Unauthorized without vision → non-recoverable, `fallback: none`, status closed.
- Missing credentials: health `configured:false`; `ready(snapshot, nothing available)` + exact
  `missing_credentials` message; later questions get the same error and never an answer or evidence.
- `MAX_CONCURRENT_SESSIONS=1` → second socket 503, slot frees after close.

`tests/integration/production.test.ts` (3), `NODE_ENV=production`, needs `dist/client` (built by
`npm run build`; if missing, the file reports one skipped test instead): serves `index.html` for `/` and SPA
routes (**regression for bug 2**), strict CSP, hashed asset served with no key-like string, WS hello → ready.

## 3. Desktop browser e2e with Chromium fake media + FIXTURE providers

Command: `npx playwright test` — **9 tests, all passed**, run twice in a row with the same result (about 23 s
each). Not flaky in those two runs.

Setup: `playwright.config.ts` builds the client (`vite build`) and starts `tests/e2e/fixture-server.ts`
(real `startServer`, production mode, FIXTURE Live + FIXTURE vision on port 3101, a no-credentials server on
3102, and a test-only control/stats API on 127.0.0.1:3109). Chromium runs headless with
`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` (fake test-pattern camera, fake beep
microphone). It does **not** use `--autoplay-policy`: audio is unlocked by a real click on Start. Phone emulation:
384×832, `isMobile`, `hasTouch`, deviceScaleFactor 3.

Scenarios (`tests/e2e/sightline.spec.ts`):
1. Start screen shows purpose and privacy text; no media requested before the tap.
2. Full live session: status Live, camera and mic on; frames reach the FIXTURE provider at ≤ 1 FPS (2–5 in 4 s,
   gaps ≥ 900 ms); audio arrives only as `audio/pcm;rate=16000`; FIXTURE reply transcript appears; **Stop
   speaking** silences a 6 s FIXTURE reply and it stays silent while the FIXTURE keeps streaming that turn (server
   `audioOutDiscarded > 0`); **Mute** sets `aria-pressed=true`, audio forwarding stops (count unchanged over 2 s,
   `audioStreamEnd` sent) and resumes on unmute; **Read label** sends a fresh capture (captured within 2.5 s of
   the press, ≤ 1600 px) to FIXTURE vision and shows exact text, dates, batch codes ("not dates") and the
   interpretation in separate sections, and injects the evidence into Live; voice `read_label` tool round trip
   through the page; diagnostics show Frames sent; **End session** closes the provider session, no frames/audio
   for 3 s afterwards, every camera/mic track `ended`, `<video>.srcObject` null, `session_disposed reason=bye`.
3. Camera permission denied (getUserMedia rejects video with `NotAllowedError`): "Denied" status, banner with
   "set Camera to Allow" and Open settings; voice still reaches the provider and the reply appears; Read label
   fails honestly without evidence.
4. Missing credentials server: "Not set up yet" message, Start disabled, no transcript, all tracks released
   (**regression for bug 1**).
5. All buttons have an accessible name and are ≥ 44 px tall; no horizontal overflow at 384 px.
6. 320 px wide; root font-size 200% at 384 px; 192 CSS px width (200% page-zoom equivalent); landscape 832×384
   — no horizontal overflow (**regression for bug 3** at 200%), controls reachable.

Screenshots (git-ignored) in `test-results/screenshots/`: `01-start-portrait`, `02-live-portrait-reply`,
`03-evidence-portrait`, `04-ended-portrait`, `05-camera-denied-portrait`, `06-missing-credentials-portrait`,
`07-start-320`, `08-session-320`, `09-session-text-200pct`, `10-session-zoom-192`, `11-session-landscape`.

Limitations of this section: the fake camera has no `facingMode`, so the status reads "Camera on", not "Rear
camera" (rear-camera selection is untested in a browser); the fake microphone is a synthetic beep, so speech
detection, echo cancellation and barge-in from real speech are not exercised (barge-in is FIXTURE `interrupted`);
headless Chromium's audio output is not heard by anyone; the latency metrics are not meaningful here; no
TalkBack, no Android permission UI, no backgrounding or screen lock.

## 4. Live provider tests

The original pass (above) had no key. The repository owner later added `GEMINI_API_KEY` locally; these are
real calls from the development Mac (2026-11-23, evening, London). Text-only prompts; no user media.

`npm run check:models`:

| Check | Result |
|---|---|
| `gemini-3.6-flash` models.get + generateContent | ok (with a 20-token cap the reply was empty: thinking tokens count against `maxOutputTokens`; cap raised to 512) |
| `gemini-3.5-flash-lite` models.get + generateContent | ok |
| `gemini-3.8-live` Live session | ok: setup 299 ms, first audio 664 ms after connect, output transcription received |

Latency probe ("Reply with the single word OK", `maxOutputTokens` 1024, 20 s client timeout):

| Model | default thinking | MINIMAL | LOW |
|---|---|---|---|
| gemini-3.6-flash | 1249 ms, 1886 ms (79–82 thought tokens) | 576 ms; later 504 "Deadline expired" | 504 "Deadline expired" |
| gemini-3.5-flash-lite | 476 ms | 523 ms | 414 ms |
| gemini-3.8-flash | 503 "high demand" | 400 (MINIMAL not supported) | 503 "high demand" |

An earlier single `check:models` run measured 33.4 s for `gemini-3.6-flash` and 3.7 s for flash-lite. Conclusion:
provider latency for the Flash vision model was highly variable that evening; the label pipeline therefore uses
flash-lite for fast steps and falls back to it on 503/504/timeouts (see implementation status).

### Label reading, live (2026-11-23, late evening)

- **Bug found only by live testing:** every label extraction failed with HTTP 400 *"The specified schema produces a
  constraint that has too many states for serving"* — the model-facing JSON schema used nested `maxItems` limits.
  Unit tests with FIXTURE models could not catch this. Fixed: model-facing schemas carry no size/range keywords
  (`src/server/vision/servingSchema.ts`, regression test); all three schemas (extraction, text regions, locate)
  were then accepted by the live API. This is the most likely cause of "can't read small labels" on the S25.
- `npx tsx scripts/eval-label.ts` on a **SYNTHETIC** packet-back image (label panel 900×420 px with ~15 px text on a
  4000×3000 photo): two-pass detail read recovered **12/12** ground-truth facts (product, ingredients with %, mustard
  advice, 800 W microwave steps incl. "1 minute 30 seconds", oven 190 °C / Gas 5, "use within 24 hours", printed
  date, batch code kept separate). "BEST BEFORE END: 03 2027" → best_before_end, 2027-03-31, future. 6 regions
  cropped; pass 1 took 1.4 s. Total 19.0 s because `gemini-3.6-flash` hit the 15 s timeout and the read fell back to
  `gemini-3.5-flash-lite`. A 1190 px single-pass read also scored 12/12 (17.2 s, same fallback): this synthetic
  image is too clean to show the benefit of cropping; real packaging photos are needed for that comparison.
- During testing the account returned 429 (quota) for `gemini-3.6-flash`; the vision fallback now also covers 429.

### Find mode locate, live

On the Ultralytics sample photo `bus.jpg`: Gemini locate "the bus" → box (x 0.000, y 0.214, w 0.991, h 0.466),
confidence 0.98, 1227 ms; the local YOLO26n detector's bus box on the same image was (0.000, 0.213, 0.992, 0.482).
"a pineapple" (absent) → no boxes, 846 ms. One earlier locate attempt returned 503 (provider overloaded).

Not yet measured: Live question-to-first-audio on the phone; real-packaging accuracy; find mode end to end on the S25.

## 5. Physical S25 tests

Informal: the repository owner ran the app on a Samsung Galaxy S25 (SM-S931B) over Wireless debugging +
`adb reverse` and reported the conversation demo "working good", with two issues: (1) the assistant once replied
in Spanish → fixed by pinning the reply language in the instructions (commit e2e2567); (2) small labels could not
be read → addressed by the detail-reading work in progress. The formal checklist
([mobile-checklist.md](mobile-checklist.md)) has not been completed yet; no measurements recorded.

## Product bugs found and fixed in this pass

1. **Camera and microphone stayed on after a non-recoverable server error** (`src/client/session/AssistantController.ts`,
   `onServerError`). With missing credentials, the UI correctly goes back to the Start screen, which has no End
   button, but the controller left the camera, mic and socket running (camera indicator stays on; the idle socket
   also took a `MAX_CONCURRENT_SESSIONS` slot). Fix: the shared teardown from `end()` was moved into `teardown()`;
   a non-recoverable error now calls it (stops sampler/camera/mic/playback, says `bye`, closes the socket) and
   then shows the error. A permission prompt that resolves later can no longer overwrite the honest error.
   Regression: `tests/unit/controller.coverage.test.ts` (3 tests in "(d)") and e2e scenario 4.
2. **Production build returned 404 for every page when the project path contains a dot-directory**
   (`src/server/index.ts`, SPA fallback). `res.sendFile(absolutePath)` makes `send` refuse paths with a dot
   segment (for example `~/.projects/…` or this `.claude/worktrees/…` checkout). Fix:
   `res.sendFile('index.html', { root: clientDir })`. Regression: `tests/integration/production.test.ts`
   (fails without the fix) and every e2e test.
3. **Horizontal overflow at 200% zoom / large text** (`src/client/styles.css`, `.session__layout`). The implicit
   grid column grew to its content's min-content width (224 px in a 192 px viewport; 410 px at 384 px with
   200% text). Fix: `grid-template-columns: minmax(0, 1fr)` (landscape already used `minmax(0, …)`).
   Regression: e2e scenario 6 (both failed before the fix).

## Not covered by automation

- Real Gemini Live / vision quality, latency, tool-choice behaviour, `goAway` timing, quota errors.
- Real rear camera selection, switching cameras, rotation, Android backgrounding and screen lock (unit tests only).
- Push-to-talk in a browser (unit/RTL only); object-detection overlays in a browser (unit only; YOLO service not run).
- Session duration limit and server heartbeat timeouts (unit tests with fake timers only).
- TalkBack and real assistive-technology announcements.


## v3 Find mode (directional stereo), 2026-11-24

### Automated (unit + integration, FIXTURE providers)
`npm run verify`: 34 files / **763 tests pass**; typecheck, lint, production build and client secret scan pass.
`npx playwright test` (FIXTURE Gemini, Chromium fake media): **9/9 pass**.
Find coverage includes: pan mapping (left/centre/right, portrait/landscape boxes), pulse interval, pan smoothing
(setTargetAtTime), envelopes, stale-observation silence, centred silence, immediate stop cancelling scheduled pulses,
repeated start/stop without leaked voices/timers, shared AudioContext; tracker association/ID persistence, binding
against a bigger/more confident same-class object, loss announced once, reacquisition vs reselect, hysteresis on both
axes, dwell (single/stale/out-of-order frames cannot confirm), one confirmation per episode, not_seen/tilt prompts and
throttling, selection by control and by `select_target`, unsupported items, detector failure leaving conversation
working, latest-frame detection slot, `read_label` subject binding, calibration flow, mic blanking/release policy.

### Real detector in desktop Chromium (`npm run detector` + `npm run test:e2e:find`)
Real YOLO26n detections on generated fake-camera videos built from a real COCO photo (Ultralytics COCO8
`000000000009.jpg`); real client audio graph (pan automation and tone starts recorded by test instrumentation);
Gemini FIXTURE. Two consecutive runs, both **2/2 pass**:

| Scenario | Measured |
|---|---|
| Bowl left of centre (box centre x≈0.22) | 6 pulses, pan −0.56 (formula 2·0.22−1 = −0.56) |
| Slides to centre, held | one "Bowl centred in the camera." at 8.98 s (bowl reaches centre at 9 s); 0 pulses while held |
| Slides right | pans +0.38, +0.45, +0.53 |
| Bowl removed at 16 s | "I've lost the bowl…" once at 16.65 s; 0 cues afterwards |
| Three overlapping bowls | selection asked; after "Left bowl", 10/10 pulses at pan −0.32 (expected ≈ −0.31), no jumping |
| Detection freshness | 97 detect frames in ~20 s (≈4.9/s); detector round trip avg 34 ms / max 219 ms (run 1), avg 32 / max 47 ms (run 2); 0 dropped, 0 out-of-order |

Detector benchmark (dev Mac, 640 px real photos): inference p50 18 ms / p95 24 ms; HTTP round trip p50 21 ms / p95 28 ms.

### Not yet verified (hardware)
Galaxy S25 + Galaxy Buds3 Pro: actual stereo separation, whether an open microphone switches the earbuds to mono
call audio, the release-microphone fallback, TTS/beacon interplay, TalkBack, and manual checks A–J in
[find-mode.md](find-mode.md). **Outstanding — not passed.**

## v4 Instruction companion, 2026-11-24

### Automated (unit + integration, FIXTURE providers)
`npm run verify`: 42 files / **1023 tests pass**; typecheck, lint, build, client secret scan pass.
Covers: extraction schema (servable, no constraint keywords), missing/ambiguous sections, alternative methods kept
separate, number/unit faithfulness of spoken text (58 cases), cut-off evidence from text regions touching the photo
edge, guide state machine (next vs done, previous/repeat/explain leave completion unchanged, undo, final-step
wording, completion only from confirmations, pause/resume, rescan revisions), negated/quoted commands never
confirming, duplicate events, stale revisions, wrong-step binding, out-of-order results, inspect throttling and
latest-wins cancellation, reconnect restore without replaying mutations, stop/bye cleanup.
`tests/integration/guide.test.ts` drives the real server over WebSocket through the whole flow (cut-off view ->
adjustment -> "How about now?" on a NEW frame -> choose microwave -> step 1 -> explain -> next (not done) ->
duplicate ignored -> wrong step rejected -> done -> stale revision rejected -> pause/resume -> where were we ->
socket drop + resume key restores the same place -> stop -> normal question -> bye drops state) and the voice-tool
path (start_guide takes a fresh still; "I'm not done yet" refused; "Done" delivered twice confirms once).

### Desktop browser (Chromium, phone viewport, FIXTURE providers)
`npx playwright test`: **10/10 pass**, including `tests/e2e/guide.spec.ts` (framing advice, Check this view, choose
method, Next not done, Done confirms exactly one step, pause/resume, where were we, stop). It found a real bug:
tapping "Guide me" while the camera was still starting failed immediately; it now waits for the camera.
Real-detector Find e2e still **2/2**.

### Live provider (real Gemini, synthetic images, typed user turns)
- Extraction (`scripts/eval-guide.ts`, `gemini-3.5-flash-lite`): full two-method packet -> MICROWAVE (4 steps) and
  OVEN (3 steps) kept separate, all steps verbatim incl. "1 minute 30 seconds", "190°C / Fan 170°C / Gas 5";
  a printed "IGNORE PREVIOUS INSTRUCTIONS…" line was treated as text, not obeyed; assembly sheet -> 3 steps with
  "2 x M4 screws", "90°", warning kept separate; cut-off packet -> cut_off_bottom with evidence. Latency 5–6 s when
  the provider was healthy; 12.9 s when it needed the same-model retry. `gemini-3.6-flash` took 12–14 s or timed out
  (504), so the guide defaults to the fast model.
- Conversation (`scripts/live-guide-dialogue.ts` against the dev server with real Gemini Live), first full run:
  start_guide -> step 1 read verbatim; "what does pierce the film mean?" -> "The packet says to poke a few holes in
  the plastic film…" with no progress change; "Next" presented step 2 without confirming step 1; "Done, I've
  finished this step" confirmed step 2 and said "That was the final instruction. One step is not confirmed yet:
  step 1."; "Do I say done…?" did not confirm; "Where were we?" reported step and confirmed progress; "Stop the guide"
  stopped. Bugs found and fixed from live runs: (1) a cut-off photo was accepted as a complete 2-step section ->
  edge-touch cut-off evidence; (2) the model once asked "which instructions?" instead of starting -> prompt fixed
  (verified on the next run); (3) image requests intermittently returned 503 -> paused same-model retry.
  Later live runs were dominated by provider 503s/timeouts; the app reported them honestly ("Nothing has changed").

### Physical S25 / Buds3 Pro
**Not yet run** for the instruction companion. Demo steps: see demo-script.md.
