# AI tools used to build Sightline

Agent-assisted coding was central to this project, and this file is an honest account of it. It covers which tools
I used, how I used them, what I decided myself, and where the AI got things wrong. The models the **app** uses at
runtime are listed separately at the end.

## Summary

| Tool | Used for |
|---|---|
| **Claude Code** (Anthropic's coding agent; model Claude Opus 5.5) | Writing almost all of the code, tests and docs, using several sub-agents working in parallel, from my written briefs. Running tests and live checks, and debugging. |
| **Google Gemini** (via my own API key) | The product's runtime AI, listed at the end. Also used deliberately during development for live checks of the prompts and schemas. |

I did not hand-write most of the code. My job was choosing the problem, specifying the behaviour, testing on the
phone, finding what was wrong, and deciding what to build next.

## What I did vs. what the AI did

| Me | Claude Code |
|---|---|
| Chose the track (accessibility) and the problem: conversational help with what's in front of you, demonstrated in a kitchen | Read the current Gemini Live and SDK documentation, and checked the installed SDK's real API before using it |
| Wrote the briefs and feature specs it worked from, including the rules: key stays server-side, no recording, no invented results, honest test reporting | Designed the shared message contract, then split the work across sub-agents with clear file ownership (camera, conversation and audio, vision, UI, tests), and merged their work |
| Ran it on my Samsung Galaxy S25 and reported what broke | Implemented each feature, with unit, integration and browser tests |
| Chose each next feature from that testing: green boxes, better small-label reading, spatial audio for Find, the instruction companion, Pause camera | Ran live checks against real Gemini using synthetic images (not real products), and recorded the results in `docs/test-results.md` |
| Supplied the API key locally (never pasted into the chat) and decided what to submit | Wrote first drafts of the docs; I directed the final README, write-up and this file |

## How I worked with it

1. **Brief first.** I gave the agent a full written brief covering the users, the main flows, safety and privacy
   rules, test requirements and the deliverables. Each later feature started as its own written spec, for example
   the directional Find mode and the instruction companion.
2. **Contracts before code.** The lead agent first wrote the shared types (`src/shared/protocol.ts`, plus the
   client and server contracts). Sub-agents then worked in separate git worktrees, each owning its own files, and
   the lead merged their work. That's why the history shows "Merge … worker" commits.
3. **Tests at three levels.**
   - Unit and integration tests run against fake Gemini responses, labelled FIXTURE, so they are free and repeatable.
   - Playwright browser tests use a fake camera and microphone.
   - A few deliberate live runs use real Gemini, because my free-tier quota is small.

   [docs/test-results.md](docs/test-results.md) keeps these kinds of evidence separate.
4. **Real-device feedback loop.** I tested on the S25 and reported problems in plain words. The agent reproduced
   each one, fixed it and added a regression test.

## Where the AI was wrong, and how it was caught

These are the clearest lessons from the project. In most cases the fakes passed, and the bug only appeared live or
on the phone.

| Problem | How it was caught | Fix |
|---|---|---|
| It replied in **Spanish** | Me, on the S25 | The reply language is now set in the instructions (`ASSISTANT_LANGUAGE`) |
| **It couldn't read small labels.** Every label request was rejected with HTTP 400 "schema … too many states" | Live run (the fake tests passed) | The JSON schema sent to the model now has no size limits; added a regression test (`src/server/vision/servingSchema.test.ts`) |
| The model check got **empty replies**: the model's "thinking" used up the whole output budget | Live run | Larger output limits |
| **Quota errors (429) didn't fall back** to the second model | Live run | 429 added to the retryable errors |
| A **photo cut off mid-instructions was accepted as complete** | Live guide run | If text touches the photo edge, the view is treated as possibly cut off |
| The model asked **"which instructions?"** instead of starting | Live guide run | Prompt changed; confirmed on the next run |
| **Tapping "Guide me" right after Start** failed while the camera was still starting | Browser test | The app now waits for the camera |
| One **commit went in with a failing test** | The full test suite | Fixed in the next commit |
| Docs said "not yet run on real Gemini" long after it had been | My review | Rewritten for submission |

## How AI is used inside the app (runtime)

- **Gemini Live** (`gemini-3.8-live`): the spoken conversation, the camera frames it sees, and tool calls such as
  `read_label`, `find_object` and `start_guide`.
- **Gemini Flash models** (`gemini-3.6-flash`, `gemini-3.5-flash-lite`): structured label reading, instruction
  extraction, and snapshot answers when Live is unavailable.
- **Ultralytics YOLO26n** (optional, runs locally): green object boxes, and tracking for 5 everyday items in Find mode. AGPL-3.0; see
  [ATTRIBUTION.md](ATTRIBUTION.md).

Some decisions deliberately keep the model out of the facts:

- Dates are interpreted by code (`src/shared/dates.ts`).
- Guide progress lives in an app-owned state machine (`src/server/guide/GuideMachine.ts`).
- Numbers in reworded steps are checked against the printed text (`src/shared/guideChecks.ts`).
- Text read from images is treated as content, never as instructions.

No model was trained or fine-tuned.

## Where to look in the code

These are the files to start with:

| Path | What it does |
|---|---|
| `src/shared/protocol.ts` | Every message between the phone and the server, validated with zod |
| `src/server/session/ClientSession.ts` | One user's session: Gemini Live, tools, find and guide |
| `src/server/vision/` | Label reading and instruction extraction |
| `src/server/guide/` | The app-owned walkthrough |
| `src/client/session/AssistantController.ts` | The phone side: camera, microphone, playback, reconnects, Pause camera |

[docs/architecture.md](docs/architecture.md) explains the tradeoffs.
