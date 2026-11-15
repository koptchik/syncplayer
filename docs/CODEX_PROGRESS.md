# SyncPlayer Codex Progress

- Last updated (UTC): 2026-11-15T07:53:38+00:00
- Current stage/substage: User-requested increment — meeting proposals/votes and LordFilm CVH page adapter.
- Status: deployed
- Branch / commit SHA: feat/watch-schedule-lordfilm / be5662beb85f893b175a96623651eb99672f76d3; merged fast-forward. LAN nonce compatibility fix: cfb69acf2be3a47c15618540fd140cfef3fbcfb4 on main.
- Production deployed SHA: cfb69acf2be3a47c15618540fd140cfef3fbcfb4; exact public asset hashes match tested local files.
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: Members propose future times and queued films/roulette; bounded availability voting; host confirmation, binding of completed roulette results and manual start paused; local time-zone display; permanent-room persistence; mobile dialog and next-meeting banner. Fixed-host LordFilm parser extracts title and numeric CVH identifiers; opaque sandbox relay supports shared play/pause/seek at rate 1. Added separate join rate bucket for full rooms.
- Commands/tests and outcomes: npm run check PASS (33 server/security tests); full npm run test:e2e PASS (15 Chromium scenarios); final nonce/LAN compatibility fix passed npm run check and the two affected schedule/LordFilm browser tests. No dependency changes.
- Deployment command and result: `/opt/syncplayer/deploy.sh cfb69acf2be3a47c15618540fd140cfef3fbcfb4` healthy; prior feature release be5662b also deployed successfully. No configuration edits or rollback required.
- Smoke test results: Final public health/assets/UI PASS; public multipart upload 201; two independent public clients proposed, voted, confirmed and started a meeting, then played/sought/paused a real fixture. Real LordFilm page imported with expected CVH identifiers and opaque sandbox mounted. Smoke media/queue entries removed; sessions revoked; empty temporary room and meeting expire normally. Real CVH metadata loaded in a separate local live check but the movie stream failed with provider access/CORS; alternate Alloha returned 404.
- Known issues / blockers: NPM upload issue resolved: CT101 rootfs was full (16 GiB); user expanded it to 24 GiB, confirmed 7.6 GiB free, and repeated public upload/playback smoke passed. No current app deployment blocker. LordFilm stream availability remains dependent on provider access/CORS; error and original-page link are shown. Stage B yt-dlp isolation blocker is unchanged; this fixed-host adapter does not activate yt-dlp. No external notifications or automatic scheduled playback.
- Remaining tasks for next session (prioritized, max 5):
  1. Await user feedback on scheduling workflow and provider availability; if adding mirrors/players, implement exact allowlists and deterministic tests.
  2. For Stage B, provision an isolated worker/egress policy before enabling yt-dlp; do not infer that the new page adapter resolves that blocker.
- Next single shippable increment: user-requested schedule/LordFilm release complete and deployed; await further user direction. Stage B still requires an isolated worker.
- Quota observed: unavailable; no percentage inferred.

## Architecture and scope

RoomStore snapshots include bounded schedule entries, UTC instants and author time zones. Dedicated schedule actions enforce membership, Origin, roles and per-event revisions. Existing fixed-host HTTPS transport is shared by Yummy and LordFilm without user-supplied hostnames; redirects/private DNS are rejected and body/time limits retained. The LordFilm component runs in an opaque sandbox without room storage/cookies; frame-window/origin/nonce checks bind relay messages. Third-party network/media restrictions are reported, not bypassed. No service configuration changes required.
