#!/bin/sh
set -e

# Docker creates missing bind-mount paths itself, as root, before the container
# ever starts — so the app cannot be the one to create them with the right
# owner. Instead this runs as root, fixes ownership, then drops privileges and
# hands over to the app, which spends its whole life as PUID:PGID.
#
# If compose sets `user:` explicitly we are already unprivileged, and this just
# execs straight through.

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  for dir in "${DATA_DIR:-/config}" "${CACHE_DIR:-/cache}"; do
    mkdir -p "$dir"
    # Only chown when it is actually wrong: recursing over a large transcode
    # cache on every start would be slow for no reason.
    if [ "$(stat -c '%u:%g' "$dir")" != "$PUID:$PGID" ]; then
      echo "pinchtube: taking ownership of $dir for $PUID:$PGID"
      chown -R "$PUID:$PGID" "$dir"
    fi
  done

  # Keep the supplementary groups compose granted (the GPU render group), but
  # never carry root's own group through.
  SUPP="$(id -G | tr ' ' '\n' | grep -v '^0$' | tr '\n' ',' | sed 's/,$//')"

  if [ -n "$SUPP" ]; then
    exec setpriv --reuid "$PUID" --regid "$PGID" --groups "$SUPP" -- "$@"
  fi
  exec setpriv --reuid "$PUID" --regid "$PGID" --clear-groups -- "$@"
fi

exec "$@"
