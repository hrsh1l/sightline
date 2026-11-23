# Sightline: manual acceptance checklist (physical Samsung Galaxy S25, Chrome)

This is the human test plan for the real device and the real Gemini models. None of it has been run yet.
Automated unit, integration and desktop-Chromium tests use FIXTURE providers and fake media, so they do
**not** replace this checklist (see [test-results.md](test-results.md)).

Tester: ____________ Date: ____________ Phone build / Chrome version: ____________
Server commit: ____________ `LIVE_MODEL`: ____________ `VISION_MODEL`: ____________

## 0. Before you start (one time per test run)

1. On the laptop, put a real key in `.env` (`GEMINI_API_KEY=...`; never commit or paste it anywhere).
2. Run `npm run check:models`. Record which Live and vision models are available to the key. If the configured
   `LIVE_MODEL` is not listed, steps 1–8 can't pass; fix `.env` first.
3. Run `npm run verify` (typecheck, lint, unit + integration tests, build, secret scan). It must pass.
4. Connect the phone using method A (USB + `adb reverse tcp:3000 tcp:3000`, open `http://localhost:3000`) or
   method B (HTTPS tunnel + `ACCESS_TOKEN`) from [s25-connection.md](s25-connection.md).
5. Start the server in a visible terminal: `npm run dev` (or `npm run build && npm start`). Keep the log visible:
   evidence for several steps comes from its JSON lines (`hello`, `live_ready`, `tool_done`, `label_extracted`,
   `live_connect_failed`, `session_disposed` …). Logs contain metadata only, no media or transcripts.
6. On the phone: media volume up, Bluetooth audio off, Do Not Disturb off.
7. Optional but recommended for evidence: on the laptop open `chrome://inspect/#devices` → **inspect** the phone
   tab to see the console, and use the phone's screen recorder (quick panel → Screen recorder → "Media sounds
   and mic") so speech and replies are captured. Do **not** record other people without consent.
8. In the app, open **Settings and diagnostics** and tick **Show diagnostics** (used for latency and frame counts).

How to record evidence for every step: a screen recording file name (or screenshot), the relevant server log
lines (copy the JSON lines), and the diagnostics values where asked. Mark each step Pass / Fail and add notes.

## 1. The 10 acceptance steps

### Step 1 — Rear camera + spoken conversation

- **Setup:** Fresh page load. Phone held normally, rear camera facing a desk.
- **Steps:**
  1. Read the Start screen privacy text aloud or confirm it is visible.
  2. Tap **Start assistant**. Allow camera and microphone in the Chrome prompts.
  3. Say: "Hello, can you hear me?"
- **Expected:** Status shows **Connection: Live**, **Camera: Rear camera**, **Microphone: On**. The preview shows
  the rear camera (not mirrored, not the selfie camera). Sightline answers by voice within a few seconds; your
  words and the answer appear in the transcript (provider transcription). Server log: `hello`, `live_ready`.
- **Evidence:** Screenshot of status bar + transcript; log lines `hello`, `live_connected`, `live_ready`.

### Step 2 — Identify an ordinary object, then a follow-up

- **Setup:** Live session. A mug (or similar everyday object) 30–50 cm from the camera, good light.
- **Steps:**
  1. Say: "What am I holding?"
  2. Then: "What colour is it?" (follow-up that needs the previous turn).
- **Expected:** First answer names the object plainly and briefly. The follow-up answers about the same object
  without you naming it again. No invented details (brand, text) that are not visible.
- **Evidence:** Recording; transcript screenshot; diagnostics **Frame age at question** and **Question to first
  audio** values (see section 4).

### Step 3 — Read visible product text and printed instructions

- **Setup:** A food pack with clear printed cooking instructions and a date (e.g. "BEST BEFORE END …", "USE BY …").
- **Steps:**
  1. Hold the instructions side 20–30 cm away, flat, no glare.
  2. Tap **Read label**. Then, separately, say: "Read the cooking instructions." (voice tool path)
- **Expected:** The **Label reading** panel shows **Exact text read from the label** (verbatim, grouped), **Dates**
  (printed text + interpretation + neutral comparison naming the timezone), **Batch/lot codes (not dates)** if
  any, and **Interpretation** clearly separated. Voice summary matches the panel; it does not read a batch code
  as a date or invent a year. Server log: `label_extracted` (`via: action`, then `via: tool`), `tool_done ok:true`.
- **Evidence:** Screenshot of the panel; compare by eye with the real pack and write any mismatch in notes;
  log lines with `latencyMs`.

### Step 4 — Ask for another view of an unreadable / obstructed label

- **Setup:** Same pack, but cover half the text with a finger or tilt it into glare / hold it too far away.
- **Steps:**
  1. Tap **Read label** (or say "Read the label").
  2. Follow the suggestion (turn the pack, move closer), then tap **Look again** or **Read label** again.
- **Expected:** First reading shows **Readability: Partly readable/Unreadable** with issues (e.g. "partly
  covered", "glare") and at most one concrete suggestion; the spoken reply asks for a better view rather than
  guessing the hidden text. The second reading, after adjusting, is clearer.
- **Evidence:** Two panel screenshots (before/after); recording of the spoken request for another view.

### Step 5 — Two candidate objects without invented certainty

- **Setup:** Two similar items side by side (e.g. two different cans or two mugs) in view.
- **Steps:** Say: "What is this?" without pointing.
- **Expected:** Sightline says there are two candidates (or asks which one) and does not confidently pick one or
  invent a brand. Asking "the one on the left" then gets a specific answer.
- **Evidence:** Recording + transcript screenshot.

### Step 6 — Interrupt, repeat, mute and stop

- **Setup:** Live session; ask a question that produces a long answer ("Describe everything you can see in detail").
- **Steps:**
  1. While it is speaking, start talking ("Stop, actually…") — barge-in.
  2. Ask another long question; while it speaks, tap **Stop speaking**.
  3. Tap **Repeat**.
  4. Tap **Mute microphone**; speak a sentence; wait 5 s; tap it again to unmute.
- **Expected:** (1) Audio stops within about half a second of you speaking; no old audio resumes afterwards.
  (2) Audio stops immediately on the tap; the rest of that answer never plays. (3) The last answer is repeated.
  (4) Button shows pressed state and **Microphone: Muted**; nothing you said while muted is answered or
  transcribed; after unmuting the conversation continues.
- **Evidence:** Recording (the audio timing is the evidence); note any stale audio that played after a stop.

### Step 7 — Lose and restore the connection without stale playback

- **Setup:** Live session in the middle of an answer.
- **Steps (do each, one at a time):**
  1. Toggle **airplane mode** on for ~5 s, then off (tunnel method) — or unplug USB for ~5 s and re-plug, then
     run `adb reverse tcp:3000 tcp:3000` again (USB method).
  2. Stop the server (Ctrl+C) during an answer, wait 5 s, start it again.
- **Expected:** Status goes to **Reconnecting** (announced), audio stops at once, and when the connection is back
  status returns to **Live** and you can ask a new question. Nothing from before the drop plays after reconnect.
  After 5 failed attempts the app shows "Lost the connection to the Sightline server" with **Try again**.
  Diagnostics **Reconnects** increments. Server log: new `hello` with `resume:true`.
- **Evidence:** Recording; diagnostics screenshot; log lines.

### Step 8 — Operate with YOLO disabled

- **Setup:** `DETECTOR_URL` unset in `.env` (default), server restarted. `curl http://localhost:3000/api/health`
  shows `"detector":"disabled"`.
- **Steps:** Repeat a short version of steps 2 and 3. Open Settings: **Show object detection boxes** is disabled
  with an explanation.
- **Expected:** Conversation and label reading work exactly as before; no boxes, no errors about the detector.
- **Evidence:** Health JSON; screenshot of the settings explanation.

### Step 9 — Complete snapshot fallback

- **Setup:** In `.env` set `LIVE_MODEL=not-a-real-live-model` (keep the valid key and `VISION_MODEL`), restart.
- **Steps:**
  1. Tap **Start assistant**.
  2. Type "What is in front of the camera?" and send. Then tap **Read label** with a pack in view.
- **Expected:** An error explains the Live model is unavailable and that the app **Switched to snapshot mode**;
  the **Snapshot mode** banner is shown; status **Connection: Snapshot mode**. The typed question is answered from
  a still photo (transcript marks "from a still photo") and spoken with the phone's TTS; Read label still works.
  Server log: `live_connect_failed` with `code: model_unavailable`, then `snapshot_answer`.
- **Evidence:** Screenshots; log lines. Restore `LIVE_MODEL` afterwards.

### Step 10 — End the session; verify tracks and sockets stop

- **Steps:** During a live session tap **End session**.
- **Expected:** Start screen says "Session ended. The camera and microphone are off." The green camera/mic
  privacy indicator dot at the top of the Android screen disappears within a couple of seconds. No more speech.
  Server log: `session_disposed` with `reason: "bye"` (counters only). In `chrome://inspect` the `/ws`
  connection shows closed.
- **Evidence:** Screenshot of status bar area before/after (indicator dot), log line.

## 2. TalkBack pass

Turn on TalkBack (Settings → Accessibility → TalkBack). Use swipe right/left to move, double-tap to activate.

| Check | Expected | Pass/Fail | Notes |
|---|---|---|---|
| Focus order on Start screen | Title, tagline, purpose, Privacy heading + text, Start assistant, hint | | |
| Start via double-tap | Session starts; focus moves to the (hidden) "Session" heading, then the status list | | |
| Names | Every button is read with its text: Stop speaking, Mute microphone (with "Muted"/"Microphone on" and pressed state), Read label, Look again, Repeat, Switch camera, End session, Ask (typed question) | | |
| Disabled controls explain why | Stop speaking: "Available while Sightline is speaking"; Switch camera reason | | |
| Announcements | "Live…", "Reading label", "Microphone muted.", errors (assertive) are read once | | |
| Not talking over the assistant | Polite announcements are suppressed while Sightline is speaking; the transcript is not a live region (fragments are not read out as they stream) | | |
| Evidence panel | Headings navigable: Label reading → Exact text → Dates → Batch/lot codes → Interpretation | | |
| Paused / resume | Lock and unlock the phone: a single large "Tap to resume" button gets focus | | |

## 3. Known risk: off-screen muted video may be paused by Chrome

The camera `<video>` is muted and frames are captured from it. Chrome on Android may stop rendering a muted
video that is scrolled off-screen, which would freeze ambient frames.

- **Check:** With diagnostics visible, note **Frames sent**. Scroll down to the transcript so the preview is off
  screen, wait 10 s, scroll back. **Frames sent** must have increased by roughly 8–10 (≤ 1 per second).
  Also ask "What am I holding now?" after changing the object while the preview is off-screen.
- **Result:** Frames sent before ____ after ____ Pass/Fail ____

## 4. Latency measurement (in-app diagnostics)

Definitions exactly as implemented in `src/client/session/AssistantController.ts` (client epoch clock,
`Date.now()`):

- **questionEnd**: for an explicit request (**Read label** / **Look again** / **Repeat** button, typed send) the
  time of the press/send. For a spoken question, the last time a mic chunk's RMS exceeded 0.02
  (`SPEECH_RMS_THRESHOLD`) before the assistant's turn started (only chunks after the previous response began
  count). If unknown, the metrics show "—".
- **Frame age at question**: voice: `questionEnd − capturedAt` of the newest frame sent before `questionEnd`.
  Explicit requests carry their own fresh capture, so it is (time the request was sent) − `capturedAt`.
- **Question to first text**: arrival of the first assistant transcript fragment of the turn (live) or of the
  snapshot answer, minus `questionEnd`.
- **Question to first audio**: the time the first sample of the turn is scheduled to be audible (the player's
  `onTurnAudible`, converted from `performance.now()` to the epoch clock) minus `questionEnd`; for snapshot
  answers, the moment browser TTS reports it started speaking.
- **Frames sent / Frames dropped / Reconnects**: ambient frames sent on the socket; frames dropped by the
  controller plus sampler supersessions; socket re-established count.

Caveats: the voice `questionEnd` depends on the RMS threshold (background noise can push it later, a quiet
voice earlier); the values are per latest question only, so write each one down immediately.

Procedure: for each of 5 spoken questions and 3 **Read label** presses, wait for the answer, then copy the three
values. Report median and worst case.

| # | Kind (voice / Read label / typed) | Frame age at question (ms) | Question to first text (ms) | Question to first audio (ms) | Notes |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |
| 8 | | | | | |

## 5. Results (to be filled in by the human tester)

| Step | Pass / Fail | Evidence (file names, log lines) | Notes |
|---|---|---|---|
| 1. Rear camera + spoken conversation | | | |
| 2. Ordinary object + follow-up | | | |
| 3. Product text and printed instructions | | | |
| 4. Another view of an unreadable label | | | |
| 5. Two candidates, no invented certainty | | | |
| 6. Interrupt, repeat, mute, stop | | | |
| 7. Lose/restore connection, no stale playback | | | |
| 8. YOLO disabled | | | |
| 9. Snapshot fallback | | | |
| 10. End session, tracks and sockets stop | | | |
| TalkBack pass | | | |
| Off-screen video risk | | | |
| Latency measured | | | |
