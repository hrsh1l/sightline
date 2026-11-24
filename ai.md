# AI tools used to build Sightline

This file records which AI tools and agents contributed, and how. Product runtime AI (what the app uses) is
listed separately at the end.

## Build-time: Claude Code (model: Claude Opus 5.5)

All code and documentation in this repository were produced in one Claude Code session on 2026-11-23, directed
by the repository owner's brief, with the owner choosing to continue the agent orchestration as set up.

### Lead session

- Inspected the empty repository and toolchain; read current provider documentation (via a web-fetch helper
  agent) for Gemini Live, Gemini models/image understanding/ephemeral tokens, and verified the actual SDK API in
  the installed `@google/genai` 3.6.1 type definitions and implementation (e.g. that `live.connect()` resolves
  after `setupComplete`).
- Chose and pinned dependencies (TypeScript pinned to 6.0.3 because typescript-eslint 8.74 requires < 6.1).
- Wrote the shared contracts (`src/shared/protocol.ts`, `src/client/contracts.ts`, `src/server/contracts.ts`),
  server assembly (`src/server/index.ts`, `config.ts`, `log.ts`, `http/security.ts` + tests), the client
  composition root (`src/client/main.tsx`), scripts (`check-models.ts`, `check-client-secrets.mjs`), and
  README, architecture, submission, demo script, attribution and this file.
- Merged worker branches, applied contract-change requests (`ready.timeZone`), fixed integration findings
  (Vite host allow-list behind the access gate, secret-scan false positive), and ran acceptance checks.

### Worker agents (Claude Code subagents, each in an isolated git worktree with exclusive file ownership)

cmux (installed) was inspected; its `claude-teams` command starts a separate interactive session, so workers
were launched with Claude Code's Agent tool, which returns results to the lead. Workers did not edit shared
contracts or dependencies; requests came back to the lead. Reports below are summaries of their actual output.

| Worker | Owned files | Contribution |
|---|---|---|
| Camera/mobile | `src/client/camera/**`, `docs/s25-connection.md` | Rear-camera controller with constraint fallbacks and error mapping, ≤1 FPS latest-frame sampler, frame quality statistics, capture scaling; S25 USB/HTTPS guide. 44 tests. |
| Conversation/audio | `src/server/session/**`, `src/server/live/**`, `src/client/audio/**`, `src/client/session/**` | Gemini Live bridge (reconnect, session resumption, goAway), per-socket session with turn tracking and cancelled-turn filtering, `read_label`/`look_again` tool loop, system prompt; AudioWorklet mic capture + resampling, gap-free PCM player with instant flush, TTS, socket wrapper, assistant controller. 101 tests. |
| Vision | `src/server/vision/**`, `src/shared/dates.ts`, `services/detector/**` | Structured label extraction and snapshot answers via generateContent, error classification, deterministic date interpretation; optional YOLO26n service (ran locally on a sample image) and its client. 98 tests. |
| Interface/accessibility | `src/client/App.tsx`, `src/client/ui/**`, `src/client/styles.css` | Mobile UI, controls, announcer, evidence panel, transcript, settings/diagnostics, overlay geometry, styles. 69 tests. |
| Verification | `tests/**`, `playwright.config.ts`, `docs/test-results.md`, `docs/mobile-checklist.md` | Integration tests against the real server with FIXTURE providers, Chromium e2e with fake media, manual S25 checklist, test results. |

### Later feature rounds (same session, same orchestration)

| Round | Workers (Claude Code subagents, isolated worktrees) | Lead integration |
|---|---|---|
| v2 small print + boxes + find | detail-reading (camera stills, torch, two-pass crops, locate), find/spatial-audio, UI | found and fixed a live 400 (JSON schema "too many states"), 429 fallback |
| v3 directional Find | server tracking/selection, client stereo beacon/calibration, UI | real-YOLO browser test harness (generated video from a COCO photo), shared AudioContext wiring |
| v4 instruction companion | extraction/view assessment, guide state + tools + session, client controller + panel | fast guide model, fixed cut-off adjustments, edge-touch evidence, same-model retry, prompt fix, camera-start wait, live dialogue script |

### Human responsibilities

The repository owner supplies the Gemini API key locally, connects the S25, runs the live/device checklist, and
decides what to submit. No AI agent deployed, published, messaged anyone or submitted anything.

## Runtime: models the app uses

- Google Gemini Live API — default `gemini-3.8-live` (configurable `LIVE_MODEL`) for spoken conversation.
- Google Gemini generateContent — default `gemini-3.6-flash` (configurable `VISION_MODEL`) for label evidence
  and snapshot answers.
- Optional: Ultralytics YOLO26n (COCO-pretrained) for generic object boxes, run locally.

No model was trained or fine-tuned.
