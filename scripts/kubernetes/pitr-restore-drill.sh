#!/usr/bin/env bash
# The destructive event + point-in-time recovery restore, run for real
# against whatever cluster kubectl's current context points at (Phase 14,
# ADR 0028). This is the in-cluster driver
# infrastructure/kubernetes/backup/pitr-restore-job.template.yaml's header
# describes: it destroys the live postgres-data PVC (a real loss of the
# actual database and its filesystem - not a simulation), then stages and
# starts a PITR restore from a base backup plus the archived WAL, both of
# which live on separate PVCs (postgres-backups, wal-archive) untouched by
# this destruction - see ADR 0028 for why the drill scopes the destructive
# event to postgres-data rather than tearing down the whole cluster/node
# (that would also destroy the backup store, which in production lives in
# genuinely separate offsite storage).
#
# Usage: scripts/kubernetes/pitr-restore-drill.sh [basebackup-name|latest] [target-time|latest]
# Prints wall-clock timestamps for the disaster declaration and for the
# moment Postgres is verified Ready again - the RTO number.
set -euo pipefail
cd "$(dirname "$0")/../.."

NS=gateway
BASEBACKUP_NAME="${1:-latest}"
TARGET_TIME="${2:-latest}"

echo "=== PITR restore drill: basebackup=$BASEBACKUP_NAME target=$TARGET_TIME ==="
echo "disaster declared: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
T_DISASTER=$(date -u +%s)

echo "--- scaling postgres to 0 ---"
kubectl -n "$NS" scale deployment postgres --replicas=0
kubectl -n "$NS" wait --for=delete pod -l app=postgres --timeout=60s || true

echo "--- destroying postgres-data PVC: THE actual disaster ---"
kubectl -n "$NS" delete pvc postgres-data --wait=true

echo "--- recreating an empty postgres-data PVC ---"
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: gateway
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 5Gi
EOF

T_RESTORE_START=$(date -u +%s)
echo "--- staging PITR restore job (extracts base backup, writes recovery.signal + restore_command) ---"
kubectl -n "$NS" delete job postgres-pitr-restore --ignore-not-found
sed -e "s/__BASEBACKUP_NAME__/${BASEBACKUP_NAME}/" -e "s/__TARGET_TIME__/${TARGET_TIME}/" \
  infrastructure/kubernetes/backup/pitr-restore-job.template.yaml | kubectl apply -f -
kubectl -n "$NS" wait --for=condition=complete job/postgres-pitr-restore --timeout=120s || {
  echo "--- pitr staging job logs ---"
  kubectl -n "$NS" logs job/postgres-pitr-restore
  exit 1
}
kubectl -n "$NS" logs job/postgres-pitr-restore

echo "--- scaling postgres back to 1: Postgres itself now replays WAL and promotes ---"
kubectl -n "$NS" scale deployment postgres --replicas=1
kubectl -n "$NS" rollout status deployment/postgres --timeout=240s
T_RESTORE_DONE=$(date -u +%s)

echo "=== timings ==="
echo "disaster declared:        $(date -u -d "@$T_DISASTER" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "postgres verified Ready:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "RTO (disaster -> postgres Ready): $((T_RESTORE_DONE - T_DISASTER))s"
echo "restore staging -> postgres Ready: $((T_RESTORE_DONE - T_RESTORE_START))s"
