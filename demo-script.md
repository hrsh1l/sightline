# Demo script (2–3 minutes)

A truthful, live demonstration on a Samsung Galaxy S25 connected by USB (`adb reverse tcp:3000 tcp:3000`,
Chrome at `http://localhost:3000`). No knives, hob or oven are used. Everything said by Sightline is whatever
the live model actually says — do not script its lines; the "expected" notes describe the behaviour to look for.
If something fails, say so and use the recovery shown.

## Props (on a table, good light)

- A ready meal or microwave-rice pouch with printed microwave **and** oven instructions on the back.
- A packet or jar with a clearly printed **best before** or **use by** date (and ideally a batch code nearby).
- Two similar items side by side (e.g. a tin of chopped tomatoes and a tin of beans), labels facing the camera.
- An everyday non-food object (a mug, or a pen).
- A bottle (for Find) and Galaxy Buds3 Pro or other stereo earbuds; detector running (`npm run detector`).
- Optional: headphones, in case the room is noisy or the speaker echoes.

## Before you start (off camera)

`npm run check:models` passes; server running; phone unlocked, screen brightness up, media volume ~70%;
TalkBack off unless demonstrating it; app open on the start screen; diagnostics enabled in Settings (to show
latency afterwards).

## Script

| Time | Presenter action / words | What to look for |
|---|---|---|
| 0:00 | "Sightline lets people ask about what's in front of them and get short spoken help. This is a phone prototype; today we'll use it in a kitchen." Show the privacy line on screen, tap **Start assistant**, allow camera and mic. | Status: Live, rear camera, microphone on. |
| 0:15 | Hold the ready meal (front facing). "What am I holding?" | A short, cautious identification based on the current image. |
| 0:30 | "What are the cooking instructions?" — turn the pack to the back when asked, or proactively. | Model calls `read_label` (status: "Reading label…"); the Label reading panel shows exact text vs interpretation; spoken summary of the most useful part. |
| 0:50 | "Just the microwave instructions." | Only the microwave steps, read from the extracted text. |
| 1:05 | While it is speaking, say "Stop" — or tap **Stop speaking**. | Audio stops immediately; session stays live. |
| 1:10 | "Repeat that." | It repeats the last answer. |
| 1:20 | Hold the dated packet with the date partly covered by a thumb, or angled away. "When is the best before date?" | It says what it can't read and asks for one adjustment (e.g. turn or move closer) — no invented date. |
| 1:35 | Adjust and tap **Look again** (or say "Look again"). | Reads the printed date with its type ("best before…"), says whether it is before/after today if the date is complete; any batch code is not called a date. |
| 1:55 | Place the two tins side by side. "What's this one?" | A short clarifying question ("the one on the left or the right?") rather than a guess. Answer it. |
| 2:10 | Point at the mug/pen. "What's this?" | Plain identification; no invented ownership or history. |
| 2:15 | (Earbuds in; stereo checked beforehand.) Put a bottle to one side of the table. "Find a bottle." Sweep the phone toward the sound until it chimes. "Read its label." | Beacon on the correct side; one chime + "Bottle centred in the camera."; label of that bottle read from a fresh photo. |
| 2:20 | Recovery: tap **Mute microphone**, then unmute; optionally unplug USB for ~3 s and replug (`adb reverse` may need re-running). | Mute is announced; on reconnect, status returns to Live with no stale audio replayed. |
| 2:35 | Tap **End session**. "Ending the session stops the camera, microphone and transmission immediately." | Camera indicator disappears; status Ended. Optionally show Diagnostics latency values measured during the demo. |
| 2:45 | Close: "It runs on a phone today. A future native app could bring the same interaction to supported smart glasses — that isn't built yet." | — |

## Fallback during the demo

If Live fails to connect (quota, network), the app shows a typed error and offers **Snapshot mode**: type
"Read the label", it takes a fresh photo and reads the answer aloud. Say clearly that this is the fallback mode.

## Don'ts

Don't claim it is tested with blind users, that it identifies any product, that it certifies food safety, or that
it works on glasses. Don't edit the recording to hide failures; mention them.
