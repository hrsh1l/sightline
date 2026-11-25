# Implementation status

Single source of truth for task ownership and **actual** completion. Updated by the lead.
Status values: `todo`, `in progress`, `done (verified: …)`, `deferred`, `blocked (reason)`.

## Execution model

- Lead (Claude Code main session): scaffold, shared contracts, server assembly, dependency/lockfile, integration, acceptance.
- Workers: Claude Code subagents launched with the Agent tool, each in an isolated git worktree, with exclusive file ownership.
  cmux was inspected (`cmux help agents`): it can open panes and message agents, but the Agent tool returns worker
  results directly to the lead, so it was used for delegation. No simulated agent reports.

## File ownership

| Area | Owner | Files |
|---|---|---|
| Root config, deps, lockfile | lead | package.json, package-lock.json, tsconfig*.json, vite/vitest/eslint config, .env.example |
| Shared contracts | lead | src/shared/protocol.ts, src/client/contracts.ts, src/server/contracts.ts |
| Server assembly, security | lead | src/server/index.ts, config.ts, log.ts, http/** |
| Client composition root | lead | src/client/main.tsx, index.html |
| Camera/mobile | camera agent | src/client/camera/** , docs/s25-connection.md |
| Conversation/audio | conversation agent | src/client/audio/**, src/client/session/**, src/server/session/**, src/server/live/** |
| Vision (+ optional YOLO) | vision agent | src/server/vision/**, src/shared/dates.ts, services/detector/** |
| Interface/accessibility | interface agent | src/client/App.tsx, src/client/ui/**, src/client/styles.css |
| Verification/docs | verification agent | tests/**, playwright.config.ts, docs/test-results.md, docs/mobile-checklist.md, README/submission drafts |

## Tasks

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | Scaffold, contracts, server assembly, health, access gate, origin check | lead | done (verified: typecheck, lint, curl smoke test) |
| 2 | Camera controller, sampler, frame quality, S25 connection doc | camera | done (verified: 44 unit tests with injected media fakes; not yet on a physical S25) |
| 3 | Live bridge, session handler, tools, mic/player, assistant controller | conversation | done (verified: 101 unit tests with FIXTURE Live connector/vision; not yet against real Gemini Live) |
| 4 | Gemini vision extraction, snapshot answers, dates, optional YOLO | vision | done (verified: 98 unit tests with FIXTURE `ai`; YOLO26n service ran on this Mac on a sample image, 25–30 ms inference; Gemini extraction not yet live-tested) |
| 5 | Mobile UI, accessibility, announcements, error recovery | interface | done (verified: 69 jsdom/RTL tests with FIXTURE controller; not yet rendered in a real browser or TalkBack) |
| 6 | Integration of 2–5 | lead | done (verified: 4 branches merged without conflicts; main.tsx wired; 322 tests, typecheck, lint, production build, secret scan; real-server WS smoke test: hello → ready + honest missing_credentials) |
| 7 | Integration/e2e tests, mobile checklist, test results | verification | done (verified by lead on the merged branch: `npm run verify` → 23 files / 444 tests pass, build + secret scan OK; `npx playwright test` → 9/9 pass with Chromium fake media + FIXTURE providers) |
| 7b | README, submission, demo script, ai.md, attribution | lead | done (drafts; test numbers to be updated after live/device runs) |
| 8 | Live provider verification | user + lead | in progress (user added GEMINI_API_KEY locally on 2026-11-23; server reports configured: true; `npm run check:models` result not yet recorded) |
| 9 | Physical S25 verification | user + lead | in progress (S25 SM-S931B connected over Wireless debugging; `adb -s 192.168.1.23:38129 reverse tcp:3000 tcp:3000` set; first page load pending) |

## Contract changes after scaffold

- `hello.clientTime` (lead, before workers started): clock-skew estimate for frame-age checks.
- `ready.timeZone` / `ServerInfo.timeZone` (requested by interface worker): UI names the comparison timezone instead of hard-coding it.
- `startServer(config, overrides)` (lead): test-only injection of FIXTURE providers for browser e2e tests.

## Integration notes

- Vite dev middleware blocks non-localhost Host headers; the server relaxes this only when `ACCESS_TOKEN` is set (camera worker finding).
- The mic AudioWorklet is emitted as a separate same-origin file (`?url&no-inline`) so the production CSP (`script-src 'self'`) allows it (conversation worker finding).
- Secret scan rule narrowed: UI help text may name `GEMINI_API_KEY`; env access or `VITE_`-prefixed secrets in the bundle still fail (verified with a planted leak file).

## Bugs found by verification (fixed, with regression tests)

1. Camera/mic/socket stayed on after a non-recoverable server error (e.g. missing credentials) — `AssistantController` now tears down.
2. Production SPA fallback 404'd when the project path contains a dot-directory — `sendFile('index.html', { root })`.
3. Horizontal overflow at 200% zoom/text — `.session__layout` uses `minmax(0, 1fr)`.

## Deferred / not done

- Optional YOLO overlay: implemented and run locally on a sample image, but off by default and not tried on kitchen frames or with the phone.
- Source archive: produce with `git archive` after live/device validation (excludes .env, node_modules, weights by construction).

## v2 (2026-11-23 late): small print, object boxes, find mode, spatial audio

| # | Task | Owner | Status |
|---|---|---|---|
| 10 | Contracts v2 (detail stills, detect frames, find, cues, torch), sharp dependency | lead | done |
| 11 | Detail stills (ImageCapture / sharpest-of-3), torch, autofocus, 2560×1440 stream; two-pass crop reading at ULTRA_HIGH; `locate()`; model fallback | detail-reading worker | done (unit tests; Chromium e2e produced 3840 px stills; live: 12/12 facts on a synthetic label; not yet on S25) |
| 12 | Find mode (YOLO or Gemini tracking, state machine, `find_object` Live tool), spatial cue engine, earcons, haptics, detect sampler | find/audio worker | done (unit tests with fakes; not yet heard on the S25) |
| 13 | Green boxes, Find panel, torch toggle, sound settings, diagnostics | UI worker | done (RTL tests + Chromium e2e; not yet on S25/TalkBack) |
| 14 | Integration: main.tsx wiring, live schema bug fix, 429 fallback, test updates | lead | done (649 unit/integration tests, 9/9 e2e, build, secret scan) |
| 15 | Local YOLO in main tree | lead | done (uv sync, weights downloaded, service answers; user must add DETECTOR_URL to .env) |

## v3 Find mode (directional stereo) — integrated 2026-11-24

| # | Task | Owner | Status |
|---|---|---|---|
| 16 | Contracts v3, supported list (`src/shared/findTargets.ts`), 5 FPS detection from measured latency | lead | done |
| 17 | Real-detector Find e2e harness (`npm run test:e2e:find`, generated videos, cue instrumentation) | lead | done (2/2 pass, twice) |
| 18 | Find UI v3 (selector, candidates, stereo check, guidance/mic settings) | UI worker | done + merged (133 UI tests) |
| 19 | Server tracking/selection/prompts/tools/read-label binding | server worker | done + merged (316 server/shared tests) |
| 20 | Client stereo beacon, guidance speech, calibration, mic policy | audio worker | done + merged (120 audio/session tests) |
| 21 | Integration (shared AudioContext wiring, detector conf 0.30, test updates) | lead | done (763 tests, 9/9 e2e, 2/2 real-detector e2e) |
| 22 | S25 + Buds3 Pro checks A–J | user | **outstanding** |

`feat/sightline` HEAD is green again (typecheck, lint, 763 tests, build, secret scan, both e2e suites).

## v4 Instruction companion — integrated 2026-11-24

| # | Task | Owner | Status |
|---|---|---|---|
| 23 | Contracts v4 (`src/shared/guide.ts`, guide messages, tools, resume key), FIXTURE extractions | lead | done |
| 24 | Extraction + view assessment (`extractGuide`, faithfulness checks) | extraction worker | done + merged |
| 25 | Guide state machine, store, tools, session integration | guide-state worker | done + merged |
| 26 | Client controller + accessible Instructions panel | guide-client worker | done + merged |
| 27 | Integration: fast guide model, fixed cut-off adjustments, edge evidence, same-model retry, prompt fix, camera-start wait | lead | done (1023 tests, 10/10 e2e, live runs above) |
| 28 | Optional timers | — | deferred (core flow prioritised) |
| 29 | S25 demo of the instruction companion | user | outstanding |
| 30 | Pause camera button (camera released, no frames, model told it cannot see; voice continues) | lead | done (unit, integration, Chromium e2e); not yet tried on the S25 |
