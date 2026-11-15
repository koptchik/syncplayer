# SyncPlayer Codex Progress

- Last updated (UTC): 2026-11-15T08:15:36+00:00
- Current stage/substage: User-requested increment — Rutube playback, automatic metadata/artwork and multi-source title search.
- Status: in_progress
- Branch / commit SHA: feat/rutube-metadata-search; base 2b1042ea434038839531bf6c83a1958ee3671bbe.
- Production deployed SHA: cfb69acf2be3a47c15618540fd140cfef3fbcfb4; confirmed during preflight.
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: Canonical Rutube URL/iframe imports and official iframe play/pause/seek adapter (rate 1), source/window checks and ad-time filtering. Best-effort Rutube/YouTube/Vimeo metadata with custom-title preservation, bounded network/cache and artwork in queue/roulette; LordFilm page artwork. Unified live Rutube/YummyAnime/LordFilm title search with per-source failures and add-to-queue; explicit external search links for YouTube/Vimeo/Twitch. Existing rooms, schedule and uploads retained.
- Commands/tests and outcomes: npm run check PASS (37 server/security tests), npm run test:e2e PASS (16 Chromium scenarios). Real Rutube sample metadata yielded its title/artwork and real iframe played, emitting advancing currentTime. Real title search returned all three sources successfully. No new dependencies.
- Deployment command and result: pending; deploy the tested SHA through existing deploy.sh.
- Smoke test results: production pending. Local real Rutube sample played successfully; deterministic browsers verified two-client synchronization, search add, image display and ad/spoof isolation.
- Known issues / blockers: No current deployment blocker. Search is first-page/bounded results and source availability/embedding restrictions still apply. Auto metadata falls back for unavailable services; file/Twitch/Kodik names may remain unchanged. Stage B yt-dlp remains off and requires separate isolation work. Roadmap file remains local/untracked and unmodified.
- Remaining tasks for next session (prioritized, max 5):
  1. Complete exact-SHA deploy and production search/metadata/playback smoke.
  2. Await feedback; extend sources only with explicit host policies and tested adapters.
- Next single shippable increment: finish this user-requested deployment and stop.
- Quota observed: unavailable; no percentage inferred.

## Architecture and scope

Known-source parser and PlayerController gain a Rutube adapter using its public iframe protocol. Bounded metadata and search services reuse fixed-host HTTPS transport and safe artwork URLs. New authenticated search API uses existing room sessions/Origin rules. Source additions recheck membership after metadata resolution. Metadata and search I/O are explicitly injected into automated tests; production uses only real bounded adapters. No subprocess, arbitrary site fetcher, media proxy or DRM/login bypass was added.
