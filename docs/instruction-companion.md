# Instruction companion

> Sightline helps blind and low-vision users get visual information through conversation. It guides camera
> framing, reads relevant instructions, and walks through them at the user's pace while handling questions and
> interruptions.

Works for cooking instructions, ordinary packaging (storage, usage) and simple printed assembly sheets. Nothing is
hard-coded: every step comes from a fresh photo.

## Using it

Say **"Guide me through these instructions"** (or "Read the storage instructions"), or tap **Instructions → Guide me
through instructions**. Then talk naturally:

| You say | What happens |
|---|---|
| "Guide me through these instructions" | Fresh photo. If the instructions aren't readable: ONE adjustment based on what's actually in the photo (e.g. "The bottom of the instructions is outside the frame. Move the phone slightly back."). |
| "How about now?" / "Like this?" | A **new** photo is checked for the same goal (never the previous image). |
| (several methods visible) | "I can see oven and microwave instructions. Which would you like?" Methods are never merged. |
| (readable) | "Step 1 of 4: Pierce the film several times." |
| "Wait, what does that mean?" | Explanation of the current step; your place and progress don't change. |
| "Next" | Presents the next step. Does **not** mark the previous step done. |
| "Done" / "I've finished this step" | Records that **you** confirmed this step, then offers the next. |
| "Previous" / "Repeat" / "Explain that" | Navigation only; completion unchanged. |
| "Where were we?" | Current step and which steps you've confirmed. |
| "Pause" / "Resume" | Stops speech and keeps the guide; resumes at the same step (an interrupted step restarts from its beginning). |
| "Undo that" | Reverses the most recent confirmation. |
| "Stop the guide" | Leaves guide mode; normal questions keep working. |
| "Do I say done?" / "I'm not done" | Not treated as confirmation. |

Buttons do the same: Check this view, Previous, Repeat, Next, Explain, Done, Undo last done, Pause/Resume, Where were
we?, Stop guide, and **Show source text** (verbatim extracted text for checking). Typed questions work as a fallback.

At the last step Sightline says "That is the final instruction" and, if earlier steps are unconfirmed, how many.
It reports completion only from your confirmations ("You've confirmed all 4 steps"), never from silence, time or images.

## How it works

1. **Capture.** "Check this view" / a voice request takes a fresh full-resolution still (same path as Read label).
   Inspections are throttled (one per 2.5 s); a newer request cancels an older in-flight analysis (latest wins).
2. **Extraction** (`VisionService.extractGuide`, `src/server/vision/guideExtract.ts`): a fast pass finds the
   instruction blocks; one structured extraction call reads overview + full-resolution crops. Output is validated
   (`GuideExtraction` in `src/shared/guide.ts`): sections per method, verbatim `sourceText` per step, a short
   `spoken` version, quantities, warnings, what's missing, and one evidence-based view issue + adjustment.
   - `spoken` must keep every number and unit of `sourceText` (`src/shared/guideChecks.ts`); otherwise the verbatim
     source text is read instead.
   - Cut-off views always get a fixed "move slightly back" adjustment (the model's up/down wording was
     inconsistent in live tests).
   - Default model: `GUIDE_MODEL=gemini-3.5-flash-lite` (5–6 s per check in live tests), falling back once to
     `VISION_MODEL` on timeout/5xx/429/invalid output.
3. **Application-owned state** (`src/server/guide/**`): a state machine (idle, acquiring_image, needs_better_view,
   choosing_section, preparing_guide, guiding, paused, completed, error) with guide id, revision, current step,
   presented vs confirmed steps and confirmation history. Every mutation is bound to the guide id + revision (+ step
   id), is idempotent per request/tool-call id, and returns the authoritative snapshot. Rescanning creates a new
   revision; confirmations carry over only to steps whose text matches.
4. **Conversation.** Gemini Live interprets intent and calls validated tools (`start_guide`,
   `inspect_current_view`, `choose_section`, `navigate_step`, `confirm_step`, `undo_completion`, `pause_guide`,
   `resume_guide`, `get_guide_status`, `stop_guide`). `confirm_step` is applied only if both the model's quoted
   utterance and the actual final user transcript are affirmative completions. The app supplies the exact text to
   speak for each step; buttons inject the same text as app events. In snapshot mode (no Live) the phone's
   text-to-speech reads it.
5. **Audio.** One speech source at a time: Live audio, or local TTS in snapshot mode. Pause/Stop silence playback
   locally first. Find-mode beacons are suppressed while speech plays.
6. **Recovery.** Guide state lives on the server outside the Gemini session (a Gemini reconnect keeps your place)
   and is re-attached after a brief network drop using a memory-only resume key. Mutations are never replayed.
   After a page reload the state is gone and the app says so.

## Boundaries

Reads only visible text; never invents steps, amounts, temperatures or settings; asks for the missing part instead
of claiming a full guide. Explanations separate the packet's text from general information. It does not certify
food is safe or cooked, guide blade movements, or infer allergens are absent from incomplete labels. Text in images
is content to read, never instructions to the assistant or the app.

## Test evidence

See [test-results.md](test-results.md) (automated, fixture, live-provider and device sections are kept separate).
