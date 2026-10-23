#!/usr/bin/env bash
set -Eeuo pipefail
umask 0027

ROOT=/opt/syncplayer
REPO="$ROOT/repo"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
NODE="$ROOT/node/bin/node"
NPM="$ROOT/node/bin/npm"
TARGET="${1:-main}"
HEALTH_URL=http://127.0.0.1:3000/api/health
export PATH="$ROOT/node/bin:$PATH"

if [[ ! "$TARGET" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ || "$TARGET" == *..* || "$TARGET" == */*/* ]]; then
  printf 'Invalid branch name: %s\n' "$TARGET" >&2
  exit 2
fi
if [[ ! -x "$NODE" || ! -x "$NPM" || ! -d "$REPO/.git" ]]; then
  echo 'Run deploy/setup-lxc.sh as root before deploying.' >&2
  exit 1
fi
mkdir -p "$HOME/.cache/syncplayer"
exec 9>"$HOME/.cache/syncplayer/deploy.lock"
if ! flock -n 9; then echo 'Another Syncplayer deployment is already running.' >&2; exit 1; fi

GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'
export GIT_SSH_COMMAND
git -C "$REPO" fetch --prune origin "$TARGET"
COMMIT="$(git -C "$REPO" rev-parse --verify 'FETCH_HEAD^{commit}')"
RELEASE="$RELEASES/$COMMIT"
mkdir -p "$RELEASES"
if [[ ! -d "$RELEASE" ]]; then git -C "$REPO" worktree add --detach "$RELEASE" "$COMMIT"; fi
"$NODE" --version | grep -Eq '^v24\.'
"$NPM" --prefix "$RELEASE" ci --omit=dev --no-audit --no-fund

if ! sudo -n /usr/local/sbin/syncplayer-switch-release "$COMMIT"; then
  echo "Deployment failed; previous release restored." >&2
  exit 1
fi
