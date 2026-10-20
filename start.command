#!/bin/sh
set -eu
OR_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$OR_SCRIPT_DIR/openreading" ]; then
  exec "$OR_SCRIPT_DIR/openreading" "$@"
fi
exec "$OR_SCRIPT_DIR/release/openreading" "$@"
