#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

if [ $# -ne 1 ]; then
  echo "Usage: scripts/restore-data-room-db.sh path/to/backup.sql" >&2
  exit 1
fi

psql "$DATABASE_URL" \
  --set ON_ERROR_STOP=on \
  --file="$1"
