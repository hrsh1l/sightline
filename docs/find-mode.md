# Find an object (directional stereo guidance)

Say **"Find a bottle"** (or tap **Find an object → Bottle**). Sightline detects matching objects in the rear-camera
picture with the local YOLO26n detector, locks onto one, and plays a gentle stereo beacon:

- object **left** of the camera view → sound toward the **left** ear
- object **right** of the view → sound toward the **right** ear
- near the centre → balanced; pulses get faster as the object gets closer to the **centre of the picture**
  (pulse rate = alignment, never distance)
- stably centred → one confirmation chime and "Bottle centred in the camera." The beacon stops.
- above/below centre → an occasional spoken "Tilt the phone up slightly." / "…down slightly."

> Sounds indicate where the object is in your phone's camera view. Move the phone toward the sound.

Then ask **"Read its label"**: Sightline takes a fresh photo and reads the object you centred. If it is no longer sure
which object you mean (lost, or several similar objects), it asks you to centre it again instead of reading a
different item.

This is camera aiming help only. It does not estimate distance, give walking directions, judge whether it is safe to
reach, or track your head.

## Supported objects (v1)

| Say | Detector class |
|---|---|
| cup, mug | `cup` |
| bottle | `bottle` |
| bowl | `bowl` |
| apple | `apple` |
| banana | `banana` |

Anything else ("find my keys", "find the salt") gets an honest reply listing these items; you can still ask normal
questions about what the camera sees. These come from COCO classes the detector was trained on; boxes come only from
real detector output (Gemini text is never used as coordinates). `FIND_GEMINI=true` re-enables experimental Gemini
box detection for other items; it is off by default (and uses API quota).

## Setup

1. Detector (one time, then each session):
   ```sh
   cd services/detector && uv sync && cd ../..
   npm run detector                      # second terminal: http://127.0.0.1:8765
   ```
2. `.env`: `DETECTOR_URL=http://127.0.0.1:8765`, then restart `npm run dev`. `/api/health` shows `"detector":"ok"`.
3. Phone: rear camera; Galaxy Buds3 Pro (or any stereo earbuds/headphones) connected.

## Galaxy Buds3 Pro: calibrate first

1. In the **Galaxy Wearable** app turn **360 Audio / head tracking off** for a predictable left/right baseline.
   Sightline cannot read or change this setting.
2. In Sightline: **Find an object → Check stereo (calibrate)**. You hear "Left ear" + a tone, "Right ear" + a tone,
   "Both ears" + a tone. (Browsers cannot pan synthesized speech, so the words are centred; the **tones** carry the
   channel.) Answer **Yes** if the first tone was left, the second right, the third centred.
3. Answer **No** (one side only, no difference) → Sightline switches to **Spoken directions** ("Left", "Right", "Up",
   "Down" instead of panned beeps).

### Why the microphone matters (Bluetooth)

On Android, when an app records from a Bluetooth headset microphone, the earbuds usually switch from stereo media
audio to mono "call" audio. Sightline cannot see or control that routing. So:

- Run the calibration **with the microphone on** (normal session). If stereo works: keep **Keep microphone on**
  (voice commands work during Find).
- If stereo fails only while the mic is on: choose **Release microphone for stereo**. Find then turns the mic off and
  you **hold Talk** to speak (sequential interaction). Calibrate again to confirm.
- If it still fails: use **Spoken directions**.

Guidance sounds are blanked from the microphone stream and pause while you or Sightline speak, so they are not
treated as your voice.

## Controls

Find an object (supported-item buttons) · candidate buttons when several match ("Left cup", "Right cup") · Stop
guidance · Cue volume · Stereo beeps / Spoken directions · Keep / Release microphone during Find · Hold to talk (when
released) · Check stereo. Voice: "Find a cup", "The one on the left", "Stop finding", "Find the bottle instead",
"Read its label". No action requires tapping a box on the preview.

## Manual acceptance (S25 + Buds3 Pro)

Record date, Sightline commit, mic policy, guidance mode, and the diagnostics' detection age/rate for each run.

| # | Check | Expected | Result |
|---|---|---|---|
| A | Bottle left of camera centre | Left-biased beacon | |
| B | Move phone until centred | Balanced cue, then one chime + "Bottle centred in the camera." | |
| C | Bottle right of centre | Right-biased beacon | |
| D | Above / below centre | "Tilt the phone up/down slightly." (correct direction) | |
| E | Remove bottle | Cues stop; loss announced once | |
| F | Two cups | Asks left/right; selection by voice and button; no jumping | |
| G | "Read its label" | Reads the selected object from a fresh photo | |
| H | Interrupt speech; Stop guidance | Speech stops; cues stop immediately | |
| I | Stereo with microphone ACTIVE (calibration with mic on) | Left/right distinct — or note mono and the release-mic result | |
| J | Original conversation + Read label demo | Unchanged | |

Status: see [test-results.md](test-results.md). Hardware checks A–J have **not** been run by the build environment.
