#!/usr/bin/env bash
# Restores a scripts/backup/pg-backup.sh dump into a target database. The
# target database must already exist and be empty (or at least not the
# live database - this never restores over DATABASE_URL by accident, it
# takes an explicit target).
#
# Usage: scripts/backup/pg-restore.sh <dump-file> <target-database-url>
# Example:
#   scripts/backup/pg-restore.sh ./backups/gateway-20260911T000000Z.dump \
#     postgresql://gateway:gateway@localhost:5432/gateway_restore_test
set -euo pipefail

DUMP_FILE="${1:?Usage: pg-restore.sh <dump-file> <target-database-url>}"
TARGET_URL="${2:?Usage: pg-restore.sh <dump-file> <target-database-url>}"

if [ ! -f "$DUMP_FILE" ]; then
  echo "FATAL: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

echo "restoring $DUMP_FILE -> $TARGET_URL"
pg_restore --clean --if-exists --no-owner --no-acl -d "$TARGET_URL" "$DUMP_FILE"
echo "restore complete"
