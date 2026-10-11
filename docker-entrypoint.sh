#!/bin/sh
# Container entrypoint.
#
# The OAuth client store lives on a Docker volume mounted at /app/data. Docker
# creates a volume's mount point owned by root, so a container running as an
# unprivileged user cannot write there — registrations then fail with EACCES
# and are lost on every restart.
#
# The image creates /app/data owned by `node`, which fixes a *fresh* volume:
# Docker copies the image directory's ownership when it initialises an empty
# one. That does not help a volume created before this fix, which already
# exists owned by root. So if we start as root, we correct the ownership and
# then drop privileges. If we are already unprivileged, we simply exec.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true

  if ! chown -R node:node "$DATA_DIR" 2>/dev/null; then
    echo "[entrypoint] warning: could not chown $DATA_DIR; OAuth client" \
         "registrations may not persist." >&2
  fi

  # Drop to the unprivileged user for the actual server process.
  exec su-exec node "$@"
fi

exec "$@"
