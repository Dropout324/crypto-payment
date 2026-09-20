#!/usr/bin/env bash
# PostgreSQL backup baseline (Phase 10). Takes a `pg_dump` custom-format
# (-Fc) dump - chosen over plain SQL because it supports `pg_restore`'s
# parallel restore and selective table/schema restore, and is what
# point-in-time recovery tooling (Phase 14) will build on rather than
# replace.
#
# This is a full logical backup taken on demand or on a schedule
# (infrastructure/kubernetes/backup/cronjob.yaml runs it nightly in-cluster);
# it is NOT point-in-time recovery (continuous WAL archiving), does not
# measure or bound RPO/RTO, and has no automated retention policy beyond
# what OUT_DIR happens to accumulate - see docs/decisions/0022-backup-baseline.md
# for exactly what this does and does not cover, and
# README.md#roadmap Phase 14 for what closes the gap.
#
# Usage: DATABASE_URL=postgresql://... scripts/backup/pg-backup.sh [out-dir]
#   (or POSTGRES_HOST/POSTGRES_PORT/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB)
set -euo pipefail

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/gateway-${TIMESTAMP}.dump"

if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump "$DATABASE_URL" -Fc -f "$OUT_FILE"
else
  : "${POSTGRES_HOST:?set DATABASE_URL or POSTGRES_HOST}"
  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump \
    -h "$POSTGRES_HOST" -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-gateway}" -d "${POSTGRES_DB:-gateway}" \
    -Fc -f "$OUT_FILE"
fi

SIZE=$(wc -c < "$OUT_FILE" | tr -d ' ')
echo "backup written: $OUT_FILE (${SIZE} bytes)"

# Fail loudly rather than silently accept an empty/truncated dump - an
# unreadable "backup" that was never actually validated is exactly the
# Phase 9.5 failure mode this whole roadmap exists to stop repeating.
pg_restore --list "$OUT_FILE" > /dev/null
echo "backup verified readable by pg_restore --list"
