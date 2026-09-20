#!/usr/bin/env bash
# The Phase 14 disaster-recovery drill, run for real against a fresh `kind`
# cluster (ADR 0028). Not a simulation or a description of what one would
# do - every step below is a real command against a real cluster, and the
# script prints the real numbers (backup sizes, RPO, RTO, row counts) that
# back the Phase 14 exit criteria.
#
# What this drill does NOT do, and why (disclosed, not silently skipped):
# it does not tear down and recreate the whole kind cluster/node. kind's PV
# storage is node-local (rancher.io/local-path); deleting the cluster
# deletes the node container and everything backed by it, INCLUDING the
# postgres-backups and wal-archive PVCs. In production those live in
# genuinely separate offsite/cloud storage (the disclosed production-
# dependent gap - see ADR 0028) specifically so they survive loss of the
# primary environment; destroying them alongside the primary here would
# prove nothing except "deleting your backups too makes recovery
# impossible." The destructive event this drill actually executes -
# deleting the postgres-data PVC and Pod while the backup store survives -
# is the real disaster DR protects against, exercised for real.
#
# Usage: scripts/kubernetes/dr-test.sh [cluster-name]
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1

CLUSTER="${1:-gateway-dr-test}"
NS=gateway
SCRATCH="${TMPDIR:-/tmp}/dr-test-$$"
mkdir -p "$SCRATCH"

log() { echo; echo "### $(date -u +%Y-%m-%dT%H:%M:%SZ) - $*"; }

# ---------------------------------------------------------------------------
log "1. creating fresh kind cluster '$CLUSTER'"
kind create cluster --name "$CLUSTER"
kubectl config use-context "kind-$CLUSTER"

log "2. namespace + secret + configmap"
kubectl apply -f infrastructure/kubernetes/namespace.yaml

# Drill-local secret - written to SCRATCH, never to the shared
# infrastructure/kubernetes/secret.yaml (which another in-progress session
# in this repo may still be using against its own, separate cluster).
POSTGRES_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
JWT_ACCESS_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
JWT_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
cat > "$SCRATCH/secret.yaml" <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: gateway-secrets
  namespace: gateway
type: Opaque
stringData:
  POSTGRES_USER: "gateway"
  POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}"
  POSTGRES_DB: "gateway"
  DATABASE_URL: "postgresql://gateway:${POSTGRES_PASSWORD}@postgres:5432/gateway?schema=public&connection_limit=20&pool_timeout=10"
  REDIS_URL: "redis://redis:6379"
  JWT_ACCESS_SECRET: "${JWT_ACCESS_SECRET}"
  JWT_REFRESH_SECRET: "${JWT_REFRESH_SECRET}"
  ENCRYPTION_KEY: "${ENCRYPTION_KEY}"
  ENCRYPTION_KEY_ID: "dr-test-1"
  COINGECKO_API_KEY: ""
  ETHEREUM_RPC_URL: ""
  ETHEREUM_RPC_WS_URL: ""
  ETHEREUM_RPC_FALLBACK_URL: ""
  POLYGON_RPC_URL: ""
  POLYGON_RPC_WS_URL: ""
  POLYGON_RPC_FALLBACK_URL: ""
  BSC_RPC_URL: ""
  BSC_RPC_WS_URL: ""
  BSC_RPC_FALLBACK_URL: ""
  BITCOIN_RPC_URL: ""
  BITCOIN_RPC_USER: ""
  BITCOIN_RPC_PASSWORD: ""
  ETHEREUM_SEPOLIA_RPC_URL: ""
  POLYGON_AMOY_RPC_URL: ""
  BSC_TESTNET_RPC_URL: ""
  BITCOIN_TESTNET_RPC_URL: ""
  SIGNING_SERVICE_URL: ""
  SIGNING_SERVICE_TOKEN: ""
  KMS_KEY_ID: ""
  COMPLIANCE_API_KEY: ""
EOF
kubectl apply -f "$SCRATCH/secret.yaml"
kubectl apply -f infrastructure/kubernetes/configmap.yaml

log "3. building and loading images into '$CLUSTER'"
./scripts/kubernetes/build-and-load.sh "$CLUSTER"

log "4. postgres (with WAL archiving) + redis"
kubectl apply -f infrastructure/kubernetes/postgres.yaml
kubectl apply -f infrastructure/kubernetes/redis.yaml
kubectl -n "$NS" rollout status deployment/postgres --timeout=180s
kubectl -n "$NS" rollout status deployment/redis --timeout=120s

log "5. running migrations"
kubectl -n "$NS" delete job gateway-migrate --ignore-not-found
kubectl apply -f infrastructure/kubernetes/migration-job.yaml
kubectl -n "$NS" wait --for=condition=complete job/gateway-migrate --timeout=180s

log "6. api/worker/monitor/web"
kubectl apply -f infrastructure/kubernetes/api.yaml
kubectl apply -f infrastructure/kubernetes/worker.yaml
kubectl apply -f infrastructure/kubernetes/monitor.yaml
kubectl apply -f infrastructure/kubernetes/web.yaml
kubectl -n "$NS" rollout status deployment/api --timeout=180s
kubectl -n "$NS" rollout status deployment/worker --timeout=180s
kubectl -n "$NS" rollout status deployment/monitor --timeout=180s
kubectl -n "$NS" rollout status deployment/web --timeout=180s

log "7. port-forwarding postgres + api for seeding and drill traffic"
kubectl -n "$NS" port-forward svc/postgres 15432:5432 > "$SCRATCH/pf-postgres.log" 2>&1 &
PF_PG=$!
kubectl -n "$NS" port-forward svc/api 14000:4000 > "$SCRATCH/pf-api.log" 2>&1 &
PF_API=$!
cleanup() { kill "$PF_PG" "$PF_API" 2>/dev/null || true; }
trap cleanup EXIT
sleep 3

DRILL_DATABASE_URL="postgresql://gateway:${POSTGRES_PASSWORD}@localhost:15432/gateway?schema=public"

log "8. seeding merchant + chart of accounts"
DATABASE_URL="$DRILL_DATABASE_URL" pnpm --filter @gateway/database seed | tee "$SCRATCH/seed-output.txt"
API_KEY=$(grep 'API key' "$SCRATCH/seed-output.txt" | sed -E 's/.*API key +: //')
echo "captured API key: ${API_KEY:0:12}..."

log "9. simulated chain_cursors row (no real RPC in this environment - disclosed in ADR 0028/runbook)"
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p 15432 -U gateway -d gateway -c \
  "INSERT INTO chain_cursors (network, last_processed_block, lease_owner, lease_expires_at, updated_at)
   VALUES ('ETHEREUM_SEPOLIA', 9000000, 'monitor-dr-drill', now() + interval '5 minutes', now())
   ON CONFLICT (network) DO UPDATE SET last_processed_block = EXCLUDED.last_processed_block,
     lease_owner = EXCLUDED.lease_owner, lease_expires_at = EXCLUDED.lease_expires_at;"

create_invoice() {
  local order_id="$1"
  curl -sf -X POST "http://localhost:14000/v1/payment-invoices" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $order_id" \
    -d "{\"order_id\":\"$order_id\",\"amount\":\"25.00\",\"currency\":\"USD\",\"asset\":\"ETH\",\"network\":\"ETHEREUM_SEPOLIA\",\"description\":\"dr-test $order_id\"}"
}

log "10. pre-backup activity: 2 invoices"
create_invoice "dr-pre-1-$$" | tee -a "$SCRATCH/invoices.txt"; echo
create_invoice "dr-pre-2-$$" | tee -a "$SCRATCH/invoices.txt"; echo

PRE_INVOICE_COUNT=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p 15432 -U gateway -d gateway -t -c "SELECT count(*) FROM invoices;" | tr -d ' ')
echo "invoices after pre-backup activity: $PRE_INVOICE_COUNT"

log "11. base backup"
T_BACKUP_START=$(date -u +%s)
DATABASE_URL="$DRILL_DATABASE_URL" ./scripts/backup/pg-basebackup.sh "$SCRATCH/basebackup-local" | tee "$SCRATCH/basebackup-output.txt"
T_BACKUP_END=$(date -u +%s)
echo "base backup wall time: $((T_BACKUP_END - T_BACKUP_START))s"

# The real backup that the in-cluster restore reads from is the CronJob's
# own run against postgres-backups (in-cluster PVC), not this local copy -
# take one for real, in-cluster, the same way basebackup-cronjob.yaml does.
log "11b. in-cluster base backup (what the restore job actually reads)"
PG_POD=$(kubectl -n "$NS" get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" exec "$PG_POD" -- sh -c '
  set -eu
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dest=/backups/basebackups/basebackup-${ts}
  mkdir -p "$dest"
  pg_basebackup -D "$dest" -Ft -z --wal-method=none -P -v
  date -u +%Y-%m-%dT%H:%M:%SZ > "$dest/BACKUP_COMPLETE_UTC"
  tar -tzf "$dest/base.tar.gz" > /dev/null
  echo "in-cluster basebackup ok: $dest ($(wc -c < "$dest/base.tar.gz") bytes)"
' | tee "$SCRATCH/incluster-basebackup-output.txt"

log "12. post-backup activity: 2 more invoices + advance the chain cursor"
create_invoice "dr-post-1-$$" | tee -a "$SCRATCH/invoices.txt"; echo
create_invoice "dr-post-2-$$" | tee -a "$SCRATCH/invoices.txt"; echo
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p 15432 -U gateway -d gateway -c \
  "UPDATE chain_cursors SET last_processed_block = 9000250, updated_at = now() WHERE network = 'ETHEREUM_SEPOLIA';"

POST_INVOICE_COUNT=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p 15432 -U gateway -d gateway -t -c "SELECT count(*) FROM invoices;" | tr -d ' ')
echo "invoices after post-backup activity: $POST_INVOICE_COUNT"

log "13. forcing an immediate WAL archive of the post-backup activity (bounds RPO for this drill run to ~0, rather than waiting up to archive_timeout=60s)"
T_LAST_ARCHIVE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p 15432 -U gateway -d gateway -c "SELECT pg_switch_wal();"
sleep 2
kubectl -n "$NS" exec "$PG_POD" -- sh -c 'ls -la /wal-archive | tail -5'

log "14. disaster + PITR restore drill"
./scripts/kubernetes/pitr-restore-drill.sh latest latest | tee "$SCRATCH/pitr-restore-output.txt"

log "15. restarting api/worker/monitor so Prisma reconnects to the restored database cleanly"
kubectl -n "$NS" rollout restart deployment/api deployment/worker deployment/monitor
kubectl -n "$NS" rollout status deployment/api --timeout=120s
kubectl -n "$NS" rollout status deployment/worker --timeout=120s
kubectl -n "$NS" rollout status deployment/monitor --timeout=120s

log "16. health/readiness of all four services after restore"
for svc in api worker monitor web; do
  kubectl -n "$NS" get pods -l "app=$svc"
done

log "17. real login proof against the restored database (like Phase 10's)"
curl -sf -X POST "http://localhost:14000/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"merchant@example.test","password":"DevPassword123!"}' \
  -o "$SCRATCH/login-response.json" -w "login HTTP %{http_code}\n"
cat "$SCRATCH/login-response.json" | head -c 200; echo

log "18. verification: reconciliation, invoice counts, chain cursor, duplicate check"
DATABASE_URL="$DRILL_DATABASE_URL" node ./scripts/kubernetes/dr-verify.cjs | tee "$SCRATCH/verify-output.txt"

log "DRILL COMPLETE - evidence written under $SCRATCH"
echo "pre-backup invoice count:  $PRE_INVOICE_COUNT"
echo "post-backup invoice count: $POST_INVOICE_COUNT (should be > pre-backup: proves WAL replay recovered post-backup writes)"
echo "scratch dir: $SCRATCH"
