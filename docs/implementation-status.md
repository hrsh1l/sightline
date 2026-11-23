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
