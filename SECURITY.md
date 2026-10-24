# Security notes

## Access model

Rooms use cryptographically random 128-bit invitation IDs. Anyone with an invitation can join. Each member receives a separate 256-bit session token in a room-scoped, HttpOnly, SameSite=Strict cookie. Only a SHA-256 digest is stored server-side. Requests through the configured public HTTPS origin set Secure cookies; explicit ALLOWED_HOSTS remain available over local HTTP with host-scoped non-Secure cookies. Sessions are independent across hostnames. Room membership is checked for uploads and queue additions; host authority is required for removal. Any authenticated room member may control playback or select a queued video. The last accepted user command wins; stale background checkpoints cannot overwrite it.

Media requests require an authenticated member of the owning room. Internal filenames are random and omitted from room snapshots. There is no public uploads directory, arbitrary filesystem access or backend fetching of user-provided URLs. YouTube, Twitch and Vimeo use exact hostname and ID allowlists. Direct HTTPS video/HLS URLs are played by browsers without backend URL fetching. Credentials, nonstandard ports, literal IP addresses and common local-only hostnames are rejected; remote domains and redirects may still resolve to private networks and remain subject to browser network protections. External providers receive viewer IP addresses. CSP allows HTTPS media and connections for HLS, while script and iframe origins remain allowlisted.

## Request and content protections

- State-changing requests require an exact matching Origin; WebSocket upgrades require both matching Origin and a valid session.
- Hostnames are allowlisted to restrict DNS rebinding. Forwarded headers are not trusted automatically.
- Zod validates JSON payloads; request bodies, messages, queues and room membership are bounded.
- Chat and names are rendered with textContent. CSP forbids inline scripts, object embeds and framing of the application. The player loads provider scripts only when required.
- Uploads stream to private files with size limits, storage reservation, concurrent-upload limits and cleanup on failure. Media responses use fixed video MIME types and nosniff.
- Room creation, joining, chat and controls are rate-limited. WebSocket payload size, message rate, connection counts and outgoing buffers are bounded.
- Rooms expire. Remaining orphan uploads after a restart count toward storage limits and are eventually removed.

## Deployment assumptions and limits

Run one process per data directory. Use HTTPS behind a reverse proxy for Internet access; keep the application bound to loopback. Configure PUBLIC_ORIGIN to the exact public origin and preserve Host through the proxy. The proxy is not trusted for client IPs, so requests behind it share its rate-limit bucket.

Invitation links are secrets and should not be published. The server operator can read uploaded media and room data; this is not end-to-end encryption. Anyone who receives media can save it. Provider scripts and iframes remain third-party code. MP4/MKV extensions are not a malware scan; browser codec support and browser security updates still matter.

Limits reduce abuse but do not provide full DDoS protection. No independent penetration test has been performed. Dependency auditing checks published advisories and cannot establish that the application is free of vulnerabilities.

## Verification

Run `npm run check`, `npm run test:e2e` and `npm audit`. Server tests exercise shared playback authorization, member queue additions and host-only removal, session isolation, cross-origin writes, WebSocket hijacking, upload rejection/cleanup, private Range delivery, payload validation and chat rate limits. Browser tests verify literal rendering of hostile HTML and shared playback across independent sessions.

Report reproducible security issues privately to the repository owner, without including live invitation links, session cookies or private media. There is no dedicated reporting address configured yet.
