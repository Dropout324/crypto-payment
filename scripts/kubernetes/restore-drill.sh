#!/usr/bin/env bash
# Runs a real restore drill inside the cluster: restores a dump already
# sitting on the postgres-backups PVC into a fresh, separate database, then
# runs one sanity query against it. Never touches the live `gateway`
# database.
#
# Usage: scripts/kubernetes/restore-drill.sh <dump-filename> [target-db-name]
# Example:
#   scripts/kubernetes/restore-drill.sh gateway-20260911T030000Z.dump gateway_restore_drill
set -euo pipefail
cd "$(dirname "$0")/../.."

DUMP_FILE="${1:?Usage: restore-drill.sh <dump-filename> [target-db-name]}"
TARGET_DB="${2:-gateway_restore_drill}"
NS=gateway

kubectl -n "$NS" delete job postgres-restore-drill --ignore-not-found

sed -e "s/__DUMP_FILE__/${DUMP_FILE}/" -e "s/__TARGET_DB__/${TARGET_DB}/" \
  infrastructure/kubernetes/backup/restore-job.template.yaml \
  | kubectl apply -f -

kubectl -n "$NS" wait --for=condition=complete job/postgres-restore-drill --timeout=120s || {
  echo "--- restore job logs ---"
  kubectl -n "$NS" logs job/postgres-restore-drill
  exit 1
}
kubectl -n "$NS" logs job/postgres-restore-drill
