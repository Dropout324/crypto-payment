#!/usr/bin/env bash
# Redis recovery drill (Phase 14, ADR 0028). Actually destroys the
# in-cluster Redis's persisted state (deletes its PVC, not just a FLUSHALL,
# so the drill is a real loss of the AOF file too) and then checks that the
# system heals on its own using only Postgres-held state - no Redis backup
# exists or is restored here, on purpose (ADR 0022's original reasoning,
# reaffirmed by this drill's result):
#
#   - `chain_cursors` (Postgres) carries `last_processed_block` and the
#     scanner's lease (`lease_owner`/`lease_expires_at`), not Redis - a lost
#     Redis queue cannot make the scanner re-scan or skip a block.
#   - `webhook_deliveries` is insert-per-attempt in Postgres; a delivery left
#     `IN_FLIGHT` by a worker that was mid-send when Redis (or the worker
#     itself) died is picked back up by the next worker poll tick, which
#     reads its schedule from Postgres, not from a Redis queue of record.
#   - Redis here is a cache/rate-limit/dedup layer, not a system of record -
#     nothing it holds is the only copy of anything financial.
#
# Usage: scripts/kubernetes/redis-recovery-drill.sh
# Requires: kubectl pointed at the target cluster.
set -euo pipefail
cd "$(dirname "$0")/../.."

NS=gateway

echo "=== redis recovery drill: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo "--- before: readiness of api/worker/monitor ---"
kubectl -n "$NS" get pods -l 'app in (api,worker,monitor)'

echo "--- before: Postgres-held recovery state (this is what the drill claims is sufficient) ---"
PG_POD=$(kubectl -n "$NS" get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" exec "$PG_POD" -- psql -U gateway -d gateway -c \
  "SELECT network, last_processed_block, lease_owner, lease_expires_at FROM chain_cursors;"
kubectl -n "$NS" exec "$PG_POD" -- psql -U gateway -d gateway -c \
  "SELECT status, count(*) FROM webhook_deliveries GROUP BY status ORDER BY status;"

T0=$(date -u +%s)
echo "=== destroying Redis: deleting pod + PVC (real AOF loss, not just FLUSHALL) at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
kubectl -n "$NS" delete deployment redis --wait=true
kubectl -n "$NS" delete pvc redis-data --wait=true
kubectl apply -f infrastructure/kubernetes/redis.yaml

echo "--- waiting for redis to come back ---"
kubectl -n "$NS" rollout status deployment/redis --timeout=120s

echo "--- waiting for api/worker/monitor to report ready again ---"
kubectl -n "$NS" rollout status deployment/api --timeout=120s
kubectl -n "$NS" rollout status deployment/worker --timeout=120s
kubectl -n "$NS" rollout status deployment/monitor --timeout=120s
T1=$(date -u +%s)

echo "--- after: Postgres-held recovery state unchanged by the Redis loss ---"
kubectl -n "$NS" exec "$PG_POD" -- psql -U gateway -d gateway -c \
  "SELECT network, last_processed_block, lease_owner, lease_expires_at FROM chain_cursors;"
kubectl -n "$NS" exec "$PG_POD" -- psql -U gateway -d gateway -c \
  "SELECT status, count(*) FROM webhook_deliveries GROUP BY status ORDER BY status;"

echo "--- api /ready after Redis loss ---"
kubectl -n "$NS" run redis-drill-check --rm -i --restart=Never --image=curlimages/curl:8.11.1 --quiet -- \
  curl -sf "http://api.$NS.svc.cluster.local:4000/v1/ready" && echo " -> api /ready OK"

echo "=== redis recovery drill complete: $((T1 - T0))s from delete to all three deployments rolled out and ready ==="
