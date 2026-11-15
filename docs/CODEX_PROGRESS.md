# SyncPlayer Codex Progress

- Last updated (UTC): 2026-11-15T08:19:57+00:00
- Current stage/substage: User-requested increment — Rutube playback, automatic metadata/artwork and multi-source title search.
- Status: deployed
- Branch / commit SHA: feat/rutube-metadata-search / ea7923a77e62a169ac244dddc46c2676e8738596; merged fast-forward to main after checks.
- Production deployed SHA: ea7923a77e62a169ac244dddc46c2676e8738596; active release symlink and public asset hashes verified.
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: Canonical Rutube URL/iframe imports and official iframe play/pause/seek adapter (rate 1), source/window checks and ad-time filtering. Best-effort Rutube/YouTube/Vimeo metadata with custom-title preservation, bounded network/cache and artwork in queue/roulette; LordFilm page artwork. Unified live Rutube/YummyAnime/LordFilm title search with per-source failures and add-to-queue; explicit external search links for YouTube/Vimeo/Twitch. Existing rooms, schedule and uploads retained.
- Commands/tests and outcomes: npm run check PASS (37 server/security tests), npm run test:e2e PASS (16 Chromium scenarios). Real Rutube sample metadata yielded its title/artwork and real iframe played, emitting advancing currentTime. Real title search returned all three sources successfully. No new dependencies.
- Deployment command and result: `/opt/syncplayer/deploy.sh ea7923a77e62a169ac244dddc46c2676e8738596`; healthy, systemd active, no rollback or configuration changes.
- Smoke test results: Public health/assets PASS. Real search UI returned multi-source results and added a Rutube result with automatic title/artwork. The supplied iframe imported successfully; its actual Rutube video played, sought and paused in two independent public Chromium sessions. Temporary queue cleared and both sessions revoked; empty temporary room expires normally. Earlier local live search confirmed all three providers available and sample metadata/title/artwork returned successfully.
- Known issues / blockers: No current deployment blocker. Search is first-page/bounded results and source availability/embedding restrictions still apply. Auto metadata falls back for unavailable services; file/Twitch/Kodik names may remain unchanged. Stage B yt-dlp remains off and requires separate isolation work. Roadmap file remains local/untracked and unmodified.
- Remaining tasks for next session (prioritized, max 5):
  1. Await user feedback; search remains bounded to first-page results and provider availability.
  2. Await feedback; extend sources only with explicit host policies and tested adapters.
- Next single shippable increment: this request is deployed and verified; stop and await user direction. Stage B yt-dlp remains separate and disabled.
- Quota observed: unavailable; no percentage inferred.

## Architecture and scope

Known-source parser and PlayerController gain a Rutube adapter using its public iframe protocol. Bounded metadata and search services reuse fixed-host HTTPS transport and safe artwork URLs. New authenticated search API uses existing room sessions/Origin rules. Source additions recheck membership after metadata resolution. Metadata and search I/O are explicitly injected into automated tests; production uses only real bounded adapters. No subprocess, arbitrary site fetcher, media proxy or DRM/login bypass was added.
