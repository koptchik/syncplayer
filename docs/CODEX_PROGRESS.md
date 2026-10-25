# SyncPlayer Codex Progress

- Last updated (UTC): 2026-10-25T12:14:57+00:00
- Current stage/substage: A — foundation and link diagnostics (A1+A2 complete).
- Status: deployed
- Branch / commit SHA: test/yummy-network-boundary-a2 / aded055ec522c1b1ea7ad69f80016b938bdfeeb0; fast-forwarded to main after all checks.
- Production deployed SHA: aded055ec522c1b1ea7ad69f80016b938bdfeeb0 (verified via release symlink after deployment).
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: Stage A complete across A1+A2: common safe source facade and network-free diagnostics; legacy sources/catalog preserved; DNS answers validated and pinned; fixed request paths; no redirects; DNS/response deadlines and 2 MiB cap; bounded concurrency/cache; rate-limit, rejected-input, SSRF and rebinding coverage. No dependency changes.
- Commands/tests and outcomes: npm run check PASS (ESLint, Prettier, 31 server/security tests); npm run test:e2e PASS (13 Chromium scenarios). No external-network fixtures. Preflight confirmed current main and deploy permissions.
- Deployment command and result: `/opt/syncplayer/deploy.sh aded055ec522c1b1ea7ad69f80016b938bdfeeb0`; deployment healthy, systemd active and exact SHA verified. No rollback needed.
- Smoke test results: public `/api/health` returned 200; authenticated Yummy catalog classification passed; two independent production browser sessions played, sought and paused an uploaded fixture via WebSocket/HTTP. Test upload removed and sessions revoked. Temporary smoke room has no media and expires normally.
- Known issues / blockers: A stage complete; Stage B has not started. Tests deterministically prove configured network behavior, not third-party uptime or a full penetration test. AGENTS.md remains unchanged. User-provided CODEX_SYNCPLAYER_ROADMAP.md remains local/untracked and excluded from formatting.
- Remaining tasks for next session (prioritized, max 5):
  1. Plan the smallest Stage B increment around one or two explicit public providers and the yt-dlp isolation/resource constraints.
  2. Do not enable any extractor until destination restrictions and subprocess/network isolation are tested.
- Next single shippable increment: Stage B provider-scope and yt-dlp safety preflight; do not start until a new user-triggered continuation.
- Quota observed: unavailable; no percentage inferred.

## Architecture and scope

Express authenticates room-scoped APIs and validates Origin/Host. RoomStore owns the queue and revision model, persisting one permanent room. PlayerController uses browser provider adapters. parseSource validates known links/iframe URLs; Yummy alone performs fixed-host HTTPS requests with DNS pinning and response limits. The facade reuses both rather than rewriting them. Inspection never fetches a submitted URL and describes format compatibility, not guaranteed playback. Direct media continues to load in viewers' browsers and retains its documented DNS/redirect/CORS limitations.
