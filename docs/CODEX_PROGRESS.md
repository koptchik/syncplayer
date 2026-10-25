# SyncPlayer Codex Progress

- Last updated (UTC): 2026-10-25T12:13:40+00:00
- Current stage/substage: A2 — deterministic tests of the Yummy fixed-host network boundary.
- Status: in_progress
- Branch / commit SHA: test/yummy-network-boundary-a2, based on main 40a825bf2c5332f4f3126b7610e7f83d865f454f.
- Production deployed SHA: d33187c37069e55c03dcaa7c9f155a37c633ac2c, verified immediately before A2.
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: A1 remains deployed. A2 adds an injectable DNS/HTTPS transport for deterministic tests, revalidates catalog/API paths at the request boundary, closes non-200 responses instead of draining them and rejects the deprecated 192.88.99.0/24 relay range. Production defaults and valid-provider behavior remain fixed-host HTTPS.
- Commands/tests and outcomes: npm run check PASS (ESLint, Prettier, 31 Node/security tests); npm run test:e2e PASS (13 Chromium scenarios on this tested code). Transport tests inject DNS and responses; they do not contact outside hosts. No dependency changes.
- Deployment command and result: pending; deploy only the tested A2 release SHA with `/opt/syncplayer/deploy.sh <SHA>`.
- Smoke test results: pending.
- Known issues / blockers: A2 must still be deployed and smoke-tested. This test seam does not constitute a penetration test or prove third-party uptime. Stage A is not yet declared complete. AGENTS.md remains unchanged. User-provided CODEX_SYNCPLAYER_ROADMAP.md remains local/untracked and excluded from formatting.
- Remaining tasks for next session (prioritized, max 5):
  1. Complete A2 commit/push, deploy and production health/two-client smoke test.
  2. Reassess completion of stage A before starting stage B.
- Next single shippable increment: finish the A2 deployment and smoke test.
- Quota observed: unavailable; do not infer a percentage.

## Architecture and scope

Express authenticates room-scoped APIs and validates Origin/Host. RoomStore owns the queue and revision model, persisting one permanent room. PlayerController uses browser provider adapters. parseSource validates known links/iframe URLs; Yummy alone performs fixed-host HTTPS requests with DNS pinning and response limits. The facade reuses both rather than rewriting them. Inspection never fetches a submitted URL and describes format compatibility, not guaranteed playback. Direct media continues to load in viewers' browsers and retains its documented DNS/redirect/CORS limitations.
