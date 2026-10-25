# SyncPlayer Codex Progress

- Last updated (UTC): 2026-10-25T09:11:49+00:00.
- Current stage/substage: A1 — network-free source diagnostics and shared resolver facade.
- Status: in_progress
- Branch / commit SHA: feat/source-diagnostics-a1; base 85bcdb26a07c06aca58da3e1a61b82df69f9c4a5.
- Production deployed SHA: 85bcdb26a07c06aca58da3e1a61b82df69f9c4a5 (verified during preflight).
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: Implemented inspection contract, existing-source facade, explicit diagnostic button and fallback. Existing media representations preserved. 10 changed files, no new dependencies; application checks passed, deployment acceptance pending.
- Commands/tests and outcomes: npm run check PASS (ESLint, Prettier, 28 Node tests); npm run test:e2e PASS (13 Chromium scenarios, including two independent clients). Preflight main equals origin/main; service active; health OK; SSH and release-switch permissions confirmed.
- Deployment command and result: pending; deploy tested SHA using existing /opt/syncplayer/deploy.sh.
- Smoke test results: pending.
- Known issues / blockers: no current deployment blocker; provider availability remains external. AGENTS.md describes the original empty repository and is retained unchanged.
- Remaining tasks for next session (prioritized, max 5):
  1. A2: deterministic tests of Yummy DNS pinning/rebinding, redirect rejection, timeouts, response size and concurrency/cache bounds; address demonstrated gaps only.
  2. Reassess completion of stage A before starting stage B.
- Next single shippable increment: A2 — tested network boundary for the existing fixed-host catalog adapter.
- Quota observed: unavailable; one small increment only, no percentage inferred.

## Architecture and scope

Express authenticates room-scoped APIs and validates Origin/Host. RoomStore owns the queue and revision model, persisting one permanent room. PlayerController uses browser provider adapters. parseSource validates known links/iframe URLs; Yummy alone performs fixed-host HTTPS requests with DNS pinning and response limits. The facade reuses both rather than rewriting them. Inspection never fetches a submitted URL and describes format compatibility, not guaranteed playback. Direct media continues to load in viewers' browsers and retains its documented DNS/redirect/CORS limitations.
