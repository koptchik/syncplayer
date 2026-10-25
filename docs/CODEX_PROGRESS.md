# SyncPlayer Codex Progress

- Last updated (UTC): 2026-10-25T12:19:41+00:00
- Current stage/substage: B0 — yt-dlp isolation and runtime feasibility preflight.
- Status: blocked
- Branch / commit SHA: main; base a2d0fe3af9816f8c4c92cc13cf48d3be4f2c40da.
- Production deployed SHA: aded055ec522c1b1ea7ad69f80016b938bdfeeb0; verified during preflight.
- Production URL: https://stream.koptchik.duckdns.org
- Implemented & acceptance criteria met: Stage A remains complete and deployed. No Stage B application code has been activated. Checked actual LXC worker and service isolation requirements before choosing an extractor.
- Commands/tests and outcomes: Read-only LXC preflight: service active and `/api/health` OK. `yt-dlp` absent, `/usr/bin/bwrap` absent, `/usr/bin/prlimit` and `/usr/bin/unshare` available. The production unit has no `MemoryMax`, `CPUQuota`, `PrivateNetwork`, `IPAddressAllow` or `IPAddressDeny` restrictions. Deploy may invoke only the fixed root-owned release-switch command. No quota meter available.
- Deployment command and result: No application deploy in B0; production remains on verified A2 SHA above.
- Smoke test results: `/api/health` returned `{"ok":true}` during preflight.
- Known issues / blockers: An extractor child process on this host would inherit unrestricted network access. Its initial URL allowlist would not constrain extractor/API/CDN requests, and subprocess flags alone are not an OS egress boundary. `prlimit` alone cannot enforce destination hosts. Enabling yt-dlp before a restricted worker/egress boundary exists would violate the roadmap's network-safety requirements.
- Remaining tasks for next session (prioritized, max 5):
  1. Provision a dedicated unprivileged yt-dlp worker with CPU/memory/time/output caps and an enforceable egress policy that validates every destination and DNS result; document one or two supported providers and their required host policy.
  2. Then implement the adapter disabled by default, with mocked extractor/egress tests; enable only after the production worker passes the same boundary checks.
- Next single shippable increment: deploy the restricted worker prerequisites through an approved Proxmox/LXC root operation, then resume B1.
- Quota observed: unavailable; no percentage inferred.

## Architecture and scope

Express validates room access and source URLs. `src/server/sources.mjs` routes known formats to browser playback; `src/server/yummy.mjs` is the only server-side fetcher and pins every connection to a checked public IPv4. RoomStore owns room and queue state. A new extractor would create a second server-side network client running external code. The current production unit has no egress or per-child resource sandbox, and the deploy account intentionally cannot change root-owned service configuration. Stage B remains off until those controls exist.
