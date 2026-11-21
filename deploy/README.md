# LXC deployment

Run `setup-lxc.sh` as root inside the Debian 13 container after creating `/home/deploy/.ssh/github_syncplayer_deploy` and cloning this repository to `/opt/syncplayer/repo` as `deploy`.

The setup installs the checksum-verified Node.js 24.22.1 binary, creates the restricted `syncplayer` service account, writes `/etc/syncplayer.env`, installs systemd and the root-owned atomic release switch, and grants `deploy` permission to call only that switch. Keep the deploy account's private GitHub key read-only and scoped to this repository.

As `deploy`, run `/opt/syncplayer/deploy.sh main`. Each successful deployment checks out a commit into its own release directory, installs production dependencies, atomically activates the release, restarts systemd, and checks `/api/health`. The privileged switch automatically restores the previous release if start or health verification fails. Releases are retained for manual rollback.

## Recover a legacy permanent room

An administrator can assign the first owner profile to a room saved before owner profiles existed. Use the Proxmox root console. Replace the nickname with the intended owner's nickname. The container ID for this installation is 100.

```bash
pct exec 100 -- bash -c '
  set -e
  systemctl stop syncplayer
  trap "systemctl start syncplayer" EXIT
  cd /opt/syncplayer/current
  runuser -u syncplayer -- /opt/syncplayer/node/bin/node --env-file=/etc/syncplayer.env deploy/recover-room.mjs "$1"
' syncplayer-recovery 'Owner nickname'
```

The command saves a private backup of the room state alongside the active file and prints the invitation, nickname, and generated password. Give the password to the intended owner through a private channel. The room stays available after the service starts. The owner can close it from the invitation via «Владельцу комнаты». The command refuses rooms that already have an owner profile. To preserve uploaded videos for a possible restore, back up the uploads separately before closing the room.

## Persistent data

The persistent media path is `/var/lib/syncplayer`. The setup creates the initial env file only when one does not exist; edit it as root to change settings. Deployments restart the process: temporary rooms reset, while the permanent room is restored from `/var/lib/syncplayer/permanent-room.json` with playback paused. Back up this file and uploads together. Rolling back to a release older than permanent-room support will not restore the room and may expire its uploads.

## Inspect or clean upload storage

Run maintenance in the Proxmox root console. The command stops SyncPlayer for an accurate inventory and starts it afterward. Temporary rooms expire on restart. Use `report` for counts and byte totals, `clean-orphans` to remove unreferenced managed uploads, or `close-and-clean` to also permanently delete the room, its state, and its uploads. Unrecognized entries and deliberate backups are excluded.

```bash
pct exec 100 -- bash -c '
  set -e
  systemctl stop syncplayer
  trap "systemctl start syncplayer" EXIT
  cd /opt/syncplayer/current
  runuser -u syncplayer -- /opt/syncplayer/node/bin/node --env-file=/etc/syncplayer.env deploy/storage-maintenance.mjs "$1"
  systemctl start syncplayer
  trap - EXIT
  curl -fsS --retry 8 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/api/health
' syncplayer-maintenance report
```

The application also scans upload storage on startup and runs cleanup each minute. Queue files remain protected while their room exists. After a restart, abandoned `.part` files are removed immediately and unreferenced completed files expire according to `ROOM_TTL_HOURS`. Check `MAX_STORAGE_BYTES` and `MIN_FREE_STORAGE_BYTES` to adjust the application's quota and disk reserve independently.
