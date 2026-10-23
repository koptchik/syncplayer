# LXC deployment

Run `setup-lxc.sh` as root inside the Debian 13 container after creating `/home/deploy/.ssh/github_syncplayer_deploy` and cloning this repository to `/opt/syncplayer/repo` as `deploy`.

The setup installs the checksum-verified Node.js 24.22.1 binary, creates the restricted `syncplayer` service account, writes `/etc/syncplayer.env`, installs systemd and the root-owned atomic release switch, and grants `deploy` permission to call only that switch. Keep the deploy account's private GitHub key read-only and scoped to this repository.

As `deploy`, run `/opt/syncplayer/deploy.sh main`. Each successful deployment checks out a commit into its own release directory, installs production dependencies, atomically activates the release, restarts systemd, and checks `/api/health`. The privileged switch automatically restores the previous release if start or health verification fails. Releases are retained for manual rollback.

The persistent media path is `/var/lib/syncplayer`. The setup creates the initial env file only when one does not exist; edit it as root to change settings. Deployments restart the process, so in-memory rooms reset.
