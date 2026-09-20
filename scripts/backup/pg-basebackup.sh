#!/usr/bin/env bash
# Physical base backup for point-in-time recovery (Phase 14, ADR 0028) -
# `pg_basebackup`, the counterpart to pg-backup.sh's logical `pg_dump`.
#
# A base backup alone is not point-in-time recovery: it is a filesystem-level
# snapshot as of the moment it finishes. What makes recovery to an arbitrary
# point possible is combining it with the continuously archived WAL segments
# (infrastructure/kubernetes/postgres.yaml's `archive_command`, writing to
# the `wal-archive` PVC / WAL_ARCHIVE_DIR below) - scripts/backup/pg-restore-pitr.sh
# replays WAL forward from this backup's end to the target time. This is why
# base backups can run far less often than the RPO target: continuous WAL
# archiving covers the gap between them (see docs/decisions/0028-*.md).
#
# `--wal-method=none` is deliberate: WAL for the backup window is already
# being captured by archive_command, so streaming a redundant copy into the
# base backup itself would just double-store it.
#
# The POSTGRES_USER (`gateway`) is created as a superuser by the official
# Postgres image, so it already carries the replication privilege pg_basebackup
# needs - no separate replication role was added for this baseline.
#
# Usage: DATABASE_URL=postgresql://... scripts/backup/pg-basebackup.sh [out-dir]
#   (or POSTGRES_HOST/POSTGRES_PORT/POSTGRES_USER/POSTGRES_PASSWORD)
# Produces: <out-dir>/basebackup-<timestamp>/base.tar.gz (+ backup_manifest)
set -euo pipefail

OUT_DIR="${1:-./backups/basebackups}"
mkdir -p "$OUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$OUT_DIR/basebackup-${TIMESTAMP}"
mkdir -p "$DEST"

if [ -n "${DATABASE_URL:-}" ]; then
  pg_basebackup -d "$DATABASE_URL" -D "$DEST" -Ft -z --wal-method=none -P -v
else
  : "${POSTGRES_HOST:?set DATABASE_URL or POSTGRES_HOST}"
  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_basebackup \
    -h "$POSTGRES_HOST" -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-gateway}" \
    -D "$DEST" -Ft -z --wal-method=none -P -v
fi

# Record the exact UTC wall-clock moment this backup finished - the earliest
# safe recovery_target_time for a restore from this backup, and the number
# scripts/kubernetes/dr-test.sh reports as part of measured RPO.
date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST/BACKUP_COMPLETE_UTC"

SIZE=$(find "$DEST" -type f -name '*.tar.gz' -exec wc -c {} + 2>/dev/null | tail -1 | awk '{print $1}')
echo "base backup written: $DEST (base.tar.gz ${SIZE:-unknown} bytes, completed $(cat "$DEST/BACKUP_COMPLETE_UTC"))"

# Same "fail loudly on a backup nobody could restore" discipline as
# pg-backup.sh: a base backup taken with -Ft is a tar archive whose
# integrity is at least checkable without touching a live database.
tar -tzf "$DEST/base.tar.gz" > /dev/null
echo "backup verified readable by tar -tzf"
