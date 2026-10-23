#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != 0 ]]; then echo 'Run this script as root inside the LXC.' >&2; exit 1; fi

APP=/opt/syncplayer
REPO="$APP/repo"
NODE_VERSION=24.22.1
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_BASE="https://nodejs.org/dist/v${NODE_VERSION}"
DEPLOY_KEY=/home/deploy/.ssh/github_syncplayer_deploy

getent passwd deploy >/dev/null || { echo 'Create the deploy user first.' >&2; exit 1; }
getent passwd syncplayer >/dev/null || useradd --system --home-dir /var/lib/syncplayer --no-create-home --shell /usr/sbin/nologin syncplayer
[[ -s "$DEPLOY_KEY" && -s "$DEPLOY_KEY.pub" ]] || { echo "Create the read-only GitHub deploy key at $DEPLOY_KEY and add it to repository settings first." >&2; exit 1; }
[[ -f "$REPO/deploy/deploy.sh" && -f "$REPO/package-lock.json" ]] || { echo "Clone git@github.com:koptchik/syncplayer.git into $REPO first." >&2; exit 1; }

install -d -o root -g root -m 0755 "$APP"
install -d -o deploy -g deploy -m 0755 "$APP/releases"
install -d -o deploy -g deploy -m 0750 "$REPO"
install -d -o root -g root -m 0755 /etc/syncplayer
install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
install -m 0644 -o root -g root "$REPO/deploy/github.com.known_hosts" /etc/syncplayer/github.com.known_hosts
install -m 0644 -o root -g root "$REPO/deploy/syncplayer.service" /etc/systemd/system/syncplayer.service
install -m 0755 -o root -g root "$REPO/deploy/switch-release" /usr/local/sbin/syncplayer-switch-release
install -m 0644 -o deploy -g deploy "$REPO/deploy/github.com.known_hosts" /home/deploy/.ssh/known_hosts
install -m 0600 -o deploy -g deploy "$REPO/deploy/github.sshconfig" /home/deploy/.ssh/config
install -m 0755 -o deploy -g deploy "$REPO/deploy/deploy.sh" "$APP/deploy.sh"

NODE_PREFIX="$APP/node-v${NODE_VERSION}"
if [[ ! -x "$NODE_PREFIX/bin/node" ]]; then
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 300 --retry 2 "$NODE_BASE/$NODE_ARCHIVE" -o "$TEMP_DIR/$NODE_ARCHIVE"
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 "$NODE_BASE/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"
  HASH="$(awk -v name="$NODE_ARCHIVE" '$2 == name || $2 == "*" name { print $1; count++ } END { if (count != 1) exit 1 }' "$TEMP_DIR/SHASUMS256.txt")"
  (cd "$TEMP_DIR" && printf '%s  %s\n' "$HASH" "$NODE_ARCHIVE" | sha256sum --check --status)
  install -d -o root -g root -m 0755 "$NODE_PREFIX"
  tar -xJf "$TEMP_DIR/$NODE_ARCHIVE" --strip-components=1 -C "$NODE_PREFIX"
fi
ln -sfn "$NODE_PREFIX" "$APP/node"

if [[ ! -f /etc/syncplayer.env ]]; then
  cat > /etc/syncplayer.env <<'ENV'
HOST=0.0.0.0
PORT=3000
ALLOWED_HOSTS=localhost,127.0.0.1,[::1],192.168.0.16,stream.koptchik.duckdns.org
PUBLIC_ORIGIN=https://stream.koptchik.duckdns.org
DATA_DIR=/var/lib/syncplayer
MAX_FILE_BYTES=4294967296
MAX_STORAGE_BYTES=10737418240
ROOM_TTL_HOURS=24
ENV
fi
chown root:syncplayer /etc/syncplayer.env
chmod 0640 /etc/syncplayer.env

cat > /etc/sudoers.d/syncplayer-deploy <<'SUDOERS'
deploy ALL=(root) NOPASSWD: /usr/local/sbin/syncplayer-switch-release *
SUDOERS
chmod 0440 /etc/sudoers.d/syncplayer-deploy
visudo --check --file=/etc/sudoers.d/syncplayer-deploy
systemctl daemon-reload
systemctl enable syncplayer
printf 'Node %s installed. Run /opt/syncplayer/deploy.sh main as deploy.\n' "$NODE_VERSION"
