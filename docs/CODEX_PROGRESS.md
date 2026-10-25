# SyncPlayer Codex Progress

- Last updated (UTC): 2026-10-25T09:14:11+00:00
- Current stage/substage: A1 — network-free source diagnostics and shared resolver facade.
- Status: deployed
- Branch / commit SHA: feat/source-diagnostics-a1 / d33187c37069e55c03dcaa7c9f155a37c633ac2c; fast-forwarded to main after checks. This follow-up journal commit changes documentation only and does not require application redeployment.
- Production deployed SHA: d33187c37069e55c03dcaa7c9f155a37c633ac2c (verified via current symlink and public asset hashes).
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: network-free inspection contract, shared facade for existing providers/catalogs, explicit diagnostic button, stale-response protection and ordinary-add fallback. Existing queue/session/playback behavior preserved. Scope stayed at 10 changed files; no dependency changes.
- Commands/tests and outcomes: npm run check PASS (ESLint, Prettier, 28 Node tests); npm run test:e2e PASS (13 Chromium scenarios, including two independent clients). Preflight main equals origin/main; service active; health OK; SSH and release-switch permissions confirmed.
- Deployment command and result: /opt/syncplayer/deploy.sh d33187c37069e55c03dcaa7c9f155a37c633ac2c as deploy over SSH; healthy, service active, exact tested SHA confirmed. No production configuration edits; rollback not needed.
- Smoke test results: public /api/health 200; index.html/app.js match tested release; real room and diagnostic UI passed; adding YouTube/Twitch/Vimeo queue entries passed; Yummy catalog classification passed. Two independent Chromium contexts played, sought and paused a real uploaded fixture through production WebSocket/HTTP. Test queue entries/upload removed and sessions revoked; empty temporary room expires normally. External provider playback availability was not claimed.
- Known issues / blockers: no deployment blocker. A2 transport-failure/rebinding coverage remains pending; A1 is not completion of all stage A. Third-party playback can fail independently. AGENTS.md remains unchanged. User-provided CODEX_SYNCPLAYER_ROADMAP.md remains local/untracked and is excluded from formatting to preserve it verbatim.
- Remaining tasks for next session (prioritized, max 5):
  1. A2: deterministic tests of Yummy DNS pinning/rebinding, redirect rejection, timeouts, response size and concurrency/cache bounds; address demonstrated gaps only.
  2. Reassess completion of stage A before starting stage B.
- Next single shippable increment: A2 — tested network boundary for the existing fixed-host catalog adapter.
- Quota observed: unavailable; one small increment only, no percentage inferred.

## Architecture and scope

Express authenticates room-scoped APIs and validates Origin/Host. RoomStore owns the queue and revision model, persisting one permanent room. PlayerController uses browser provider adapters. parseSource validates known links/iframe URLs; Yummy alone performs fixed-host HTTPS requests with DNS pinning and response limits. The facade reuses both rather than rewriting them. Inspection never fetches a submitted URL and describes format compatibility, not guaranteed playback. Direct media continues to load in viewers' browsers and retains its documented DNS/redirect/CORS limitations.
