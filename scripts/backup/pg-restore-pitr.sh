#!/usr/bin/env bash
# Point-in-time recovery restore (Phase 14, ADR 0028) - stages a fresh PGDATA
# from a scripts/backup/pg-basebackup.sh backup plus the archived WAL, so
# starting Postgres against it replays WAL forward to a target time and
# promotes. This is the mechanism script (runnable by hand against local
# filesystem paths - a base backup directory and a WAL archive directory both
# reachable from wherever this runs, e.g. after `kubectl cp`-ing them out of
# the cluster, or directly on a host with access to the volumes).
#
# The in-cluster drill (scripts/kubernetes/pitr-restore-drill.sh +
# infrastructure/kubernetes/backup/pitr-restore-job.template.yaml) runs the
# same staging steps as an inline POSIX `sh -c` Kubernetes Job instead of
# calling this file directly, for the same reason ADR 0022 gives for
# pg-backup.sh/pg-restore.sh vs. the CronJob: the postgres:17-alpine image
# has no bash. Both are kept in sync by review.
#
# Usage:
#   scripts/backup/pg-restore-pitr.sh <basebackup-dir> <wal-archive-dir> <pgdata-target> [target-time|latest]
#
# <basebackup-dir>   directory produced by pg-basebackup.sh (contains base.tar.gz)
# <wal-archive-dir>  the archive_command target directory (WAL segments as
#                    plain files, exactly as archived)
# <pgdata-target>    empty directory to stage the restored PGDATA into - must
#                    not already exist with contents
# [target-time]      an RFC3339 UTC timestamp, e.g. 2026-09-12T03:15:00Z, or
#                    "latest" (default) to replay every WAL segment the
#                    archive has and let Postgres promote once it runs out
#
# After this script finishes, start Postgres with PGDATA=<pgdata-target> (or
# copy its contents into place) - it will detect recovery.signal, replay WAL
# via restore_command, reach the target, and promote automatically. This
# script does not start Postgres itself: in the cluster, that is the
# postgres Deployment's own container, restarted against the restored volume
# (see docs/operations/disaster-recovery-runbook.md).
set -euo pipefail

BASEBACKUP_DIR="${1:?Usage: pg-restore-pitr.sh <basebackup-dir> <wal-archive-dir> <pgdata-target> [target-time|latest]}"
WAL_ARCHIVE_DIR="${2:?Usage: pg-restore-pitr.sh <basebackup-dir> <wal-archive-dir> <pgdata-target> [target-time|latest]}"
PGDATA_TARGET="${3:?Usage: pg-restore-pitr.sh <basebackup-dir> <wal-archive-dir> <pgdata-target> [target-time|latest]}"
TARGET_TIME="${4:-latest}"

TAR="$BASEBACKUP_DIR/base.tar.gz"
if [ ! -f "$TAR" ]; then
  echo "FATAL: base backup not found: $TAR" >&2
  exit 1
fi
if [ ! -d "$WAL_ARCHIVE_DIR" ]; then
  echo "FATAL: WAL archive directory not found: $WAL_ARCHIVE_DIR" >&2
  exit 1
fi
if [ -d "$PGDATA_TARGET" ] && [ -n "$(ls -A "$PGDATA_TARGET" 2>/dev/null)" ]; then
  echo "FATAL: $PGDATA_TARGET already exists and is not empty - refusing to restore into it" >&2
  exit 1
fi

mkdir -p "$PGDATA_TARGET"
echo "staging base backup $TAR -> $PGDATA_TARGET"
tar -xzf "$TAR" -C "$PGDATA_TARGET"
chmod 700 "$PGDATA_TARGET"

# Standard archive-recovery signal file (PostgreSQL 12+) - its mere presence
# is what makes Postgres enter recovery on this next start instead of
# treating PGDATA as a normal cluster.
touch "$PGDATA_TARGET/recovery.signal"

{
  echo "restore_command = 'cp \"$WAL_ARCHIVE_DIR/%f\" \"%p\"'"
  if [ "$TARGET_TIME" != "latest" ]; then
    echo "recovery_target_time = '$TARGET_TIME'"
    echo "recovery_target_action = 'promote'"
  fi
  # With no recovery_target_time (the "latest" case), Postgres replays every
  # WAL segment restore_command can still find and promotes automatically
  # once restore_command starts failing to produce the next one - the
  # standard "recover to the end of the archive" behavior, not a special case
  # handled here.
} >> "$PGDATA_TARGET/postgresql.auto.conf"

echo "PGDATA staged at $PGDATA_TARGET, target=$TARGET_TIME"
echo "next: start Postgres with this PGDATA - it will replay WAL and promote."
