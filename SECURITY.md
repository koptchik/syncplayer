# Security notes

## Access model

Rooms use cryptographically random 128-bit invitation IDs. Anyone with an invitation can join. Each member receives a separate 256-bit session token in a room-scoped, HttpOnly, SameSite=Strict cookie. Only a SHA-256 digest is stored server-side. Requests through the configured public HTTPS origin set Secure cookies; explicit ALLOWED_HOSTS remain available over local HTTP with host-scoped non-Secure cookies. Sessions are independent across hostnames. Room membership is checked for uploads and queue additions; host authority is required for removal. Any authenticated room member may control playback or select a queued video. The last accepted user command wins; stale background checkpoints cannot overwrite it.

Media requests require an authenticated member of the owning room. Internal filenames are random and omitted from room snapshots. There is no public uploads directory, arbitrary filesystem access or unrestricted backend fetching of user-provided URLs. The narrowly scoped YummyAnime resolver is described below. YouTube, Twitch, Vimeo and Kodik use exact hostname and ID allowlists. Direct HTTPS video/HLS URLs are played by browsers without backend URL fetching. Credentials, nonstandard ports, literal IP addresses and common local-only hostnames are rejected; remote domains and redirects may still resolve to private networks and remain subject to browser network protections. External providers receive viewer IP addresses. CSP allows HTTPS media and connections for HLS, while script and iframe origins remain allowlisted.

## Request and content protections

- State-changing requests require an exact matching Origin; WebSocket upgrades require both matching Origin and a valid session.
- Hostnames are allowlisted to restrict DNS rebinding. Forwarded headers are not trusted automatically.
- Zod validates JSON payloads; request bodies, messages, queues and room membership are bounded.
- Chat and names are rendered with textContent. CSP forbids inline scripts, object embeds and framing of the application. The player loads provider scripts only when required.
- Uploads stream to private files with size limits, storage reservation, concurrent-upload limits and cleanup on failure. Media responses use fixed video MIME types and nosniff.
- Room creation, joining, chat and controls are rate-limited. WebSocket payload size, message rate, connection counts and outgoing buffers are bounded.
- Temporary rooms expire; one permanent room is saved with its queue, chat and hashed member sessions in a mode-0600 file using atomic replacement. Referenced permanent uploads do not expire. Remaining orphan uploads after a restart count toward storage limits and are eventually removed.

## Deployment assumptions and limits

Run one process per data directory. Use HTTPS behind a reverse proxy for Internet access; keep the application bound to loopback. Configure PUBLIC_ORIGIN to the exact public origin and preserve Host through the proxy. The proxy is not trusted for client IPs, so requests behind it share its rate-limit bucket.

Invitation links are secrets and should not be published. The server operator can read uploaded media and room data; this is not end-to-end encryption. Anyone who receives media can save it. Provider scripts and iframes remain third-party code. MP4/MKV extensions are not a malware scan; browser codec support and browser security updates still matter.

Limits reduce abuse but do not provide full DDoS protection. No independent penetration test has been performed. Dependency auditing checks published advisories and cannot establish that the application is free of vulnerabilities.

## Verification

Run `npm run check`, `npm run test:e2e` and `npm audit`. Server tests exercise shared playback authorization, member queue additions and host-only removal, session isolation, cross-origin writes, WebSocket hijacking, upload rejection/cleanup, private Range delivery, payload validation and chat rate limits. Browser tests verify literal rendering of hostile HTML and shared playback across independent sessions.

Report reproducible security issues privately to the repository owner, without including live invitation links, session cookies or private media. There is no dedicated reporting address configured yet.

## Imported embed codes

HTML is parsed as data using parse5 (8 KiB input limit). Exactly one iframe with a src and without srcdoc is accepted; only its validated URL reaches the queue. Raw HTML and attributes never reach the application DOM. Kodik is restricted to HTTPS kodikplayer.com episode/movie paths (query and fragment removed), plus season paths pinned to a validated episode with fixed selection parameters. Its frame uses a sandbox that allows scripts, its own origin and presentation but does not grant popups, top navigation or forms. Incoming messages must match both the exact iframe contentWindow and its HTTPS origin; numeric positions and rates are bounded. Outgoing commands use that exact targetOrigin. No generic webpage fetcher or arbitrary iframe embedding was added.

## Permanent rooms and page discovery

Only the host can promote a room; the server permits one permanent room. All state and hashed session credentials are persisted before mutation broadcasts, and playback resumes paused after restart. A corrupt persistence file prevents startup rather than silently replacing the invitation. Explicit leave revokes the member token and closes that member’s sockets; an in-flight upload rechecks membership before publishing. Leaving transfers host authority to another member or the next person to join an empty room. A permanent room uses the existing invitation trust model, not a persistent account owner. At capacity, offline non-host sessions may be evicted. Back up the JSON and uploads together and restrict access to DATA_DIR.

Page discovery requires room authentication and exact Origin, and is separately rate limited. Only HTTPS old.yummyani.me catalog slugs are accepted. The server fetches that page and a numeric anime videos API path on the same fixed hostname. DNS is restricted to public IPv4, and the actual connection uses the validated address. Redirects, cookies, user-provided headers and arbitrary target hosts are not supported. Both responses have deadlines and byte limits, with bounded concurrency and caching. Extracted sources pass the normal media allowlist before selection. HTML is parsed as data; site scripts are never executed on the server. The source sees the server’s IP address.

Catalog variants are selected by a stable ID from the server-resolved list, never a client-supplied replacement URL. Membership is rechecked after discovery. Switching increments a source version so delayed commands from the previous iframe cannot affect the new source. Only the active queue entry can be switched. CVH and Alloha require exact HTTPS hosts and paths with validated, reconstructed parameters; both use sandboxed frames. CVH messages require matching origin and frame window, with bounded numeric values. Alloha has no playback adapter: shared playback commands are rejected for manual sources. Variant lists are fetched separately rather than included in every room broadcast.

## Queue roulette

Authenticated members may nominate up to three existing queue entries each; the host starts and resets rounds. The server uses crypto.randomInt with Fisher–Yates over distinct media IDs. It selects the winner paused and records the elimination order and timestamps before broadcasting. Playback, selection, variant changes, deletion and repeat draws are rejected during the animation. The animation presents an already decided result; it is not a gambling or adversarial-verifiability system. Artwork is limited to YouTube and validated static.yani.tv poster URLs, loaded by the viewer's browser without a backend image proxy.
