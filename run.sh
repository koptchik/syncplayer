#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -x .tools/node/bin/node ]; then
  PATH="$PWD/.tools/node/bin:$PATH"
  export PATH
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 24 LTS from https://nodejs.org/ and run npm ci.' >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  printf '%s\n' 'Dependencies are missing. Run npm ci first.' >&2
  exit 1
fi
exec node --env-file-if-exists=.env src/server/index.mjs
