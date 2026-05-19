#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
OUTPUT="$BACKUP_DIR/klps-data-room-$TIMESTAMP.sql"

pg_dump "$DATABASE_URL" \
  --schema=data_room \
  --no-owner \
  --no-privileges \
  --file="$OUTPUT"

if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  openssl enc \
    -aes-256-cbc \
    -salt \
    -pbkdf2 \
    -in "$OUTPUT" \
    -out "$OUTPUT.enc" \
    -pass "pass:$BACKUP_ENCRYPTION_PASSPHRASE"

  rm "$OUTPUT"
  echo "Encrypted backup written to $OUTPUT.enc"
else
  echo "Backup written to $OUTPUT"
  echo "Set BACKUP_ENCRYPTION_PASSPHRASE to encrypt local exports."
fi
