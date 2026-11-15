# SyncPlayer Codex Progress

- Last updated (UTC): 2026-11-15T07:40:22+00:00
- Current stage/substage: User-requested increment — meeting proposals/votes and LordFilm CVH page adapter.
- Status: in_progress
- Branch / commit SHA: feat/watch-schedule-lordfilm; base 02d3a7514c48e0ae51e408392d049f8009eb8ecf.
- Production deployed SHA: aded055ec522c1b1ea7ad69f80016b938bdfeeb0, confirmed during preflight.
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: Members propose future times and queued films/roulette; bounded availability voting; host confirmation, binding of completed roulette results and manual start paused; local time-zone display; permanent-room persistence; mobile dialog and next-meeting banner. Fixed-host LordFilm parser extracts title and numeric CVH identifiers; opaque sandbox relay supports shared play/pause/seek at rate 1. Added separate join rate bucket for full rooms.
- Commands/tests and outcomes: npm run check PASS (33 server/security tests); npm run test:e2e PASS (15 Chromium scenarios, including independent time zones, host permissions and opaque-sandbox playback). Final targeted schedule/LordFilm scenarios PASS after avoiding forced resync on non-playback schedule mutations. No dependencies changed.
- Deployment command and result: pending; use existing deploy.sh with exact tested commit SHA.
- Smoke test results: Local real-page resolver imported “Парни со стволами (2016)” from the supplied page and CVH loaded metadata/player; the provider rejected the media stream with access/CORS errors. Its alternate Alloha returned 404. Playback availability is not guaranteed; errors are surfaced and original-page link provided. Production smoke pending.
- Known issues / blockers: Production deployment available through deploy SSH. Stage B yt-dlp remains blocked and unchanged: new fixed-host page adapter does not invoke an extractor or proxy video. LordFilm mirror/domain support limited to 8.lordfilms.mobile numeric pages with kp CVH components; other mirrors and player types require explicit adapters. No email/push/calendar service or automatic scheduled playback. Roadmap file remains user-owned/untracked.
- Remaining tasks for next session (prioritized, max 5):
  1. Complete exact-SHA deployment and production smoke of this user-requested increment.
  2. For Stage B, provision an isolated worker/egress policy before enabling yt-dlp; do not infer that the new page adapter resolves that blocker.
- Next single shippable increment: Finish this increment's deployment, then stop and await user direction.
- Quota observed: unavailable; no percentage inferred.

## Architecture and scope

RoomStore snapshots include bounded schedule entries, UTC instants and author time zones. Dedicated schedule actions enforce membership, Origin, roles and per-event revisions. Existing fixed-host HTTPS transport is shared by Yummy and LordFilm without user-supplied hostnames; redirects/private DNS are rejected and body/time limits retained. The LordFilm component runs in an opaque sandbox without room storage/cookies; frame-window/origin/nonce checks bind relay messages. Third-party network/media restrictions are reported, not bypassed. No service configuration changes required.
