#!/usr/bin/env bash
# Deploys the gateway to whatever cluster kubectl's current context points
# at, in the order the manifests actually depend on (Kustomize alone applies
# everything at once and does not wait for Postgres before running
# migrations). Run from the repo root:
#
#   ./scripts/kubernetes/deploy.sh
#
# Prerequisites:
#   - kubectl pointed at the target cluster (kind/minikube/a real cluster)
#   - infrastructure/kubernetes/secret.yaml generated
#     (scripts/kubernetes/generate-secret.sh) or applied from your own
#     secrets manager
#   - the four runtime images (gateway-api/worker/monitor/web:local) and
#     gateway-debug:local built and loaded into the cluster - see
#     scripts/kubernetes/build-and-load.sh for kind
set -euo pipefail
cd "$(dirname "$0")/../.."

NS=gateway
K=infrastructure/kubernetes

kubectl apply -f "$K/namespace.yaml"

if [ ! -f "$K/secret.yaml" ]; then
  echo "FATAL: $K/secret.yaml not found - run scripts/kubernetes/generate-secret.sh first" >&2
  exit 1
fi
kubectl apply -f "$K/secret.yaml"
kubectl apply -f "$K/configmap.yaml"

kubectl apply -f "$K/postgres.yaml"
kubectl apply -f "$K/redis.yaml"
echo "waiting for postgres and redis..."
kubectl -n "$NS" rollout status deployment/postgres --timeout=120s
kubectl -n "$NS" rollout status deployment/redis --timeout=120s

echo "running database migrations..."
kubectl -n "$NS" delete job gateway-migrate --ignore-not-found
kubectl apply -f "$K/migration-job.yaml"
kubectl -n "$NS" wait --for=condition=complete job/gateway-migrate --timeout=180s

kubectl apply -f "$K/api.yaml"
kubectl apply -f "$K/worker.yaml"
kubectl apply -f "$K/monitor.yaml"
kubectl apply -f "$K/web.yaml"

echo "waiting for api/worker/monitor/web..."
kubectl -n "$NS" rollout status deployment/api --timeout=120s
kubectl -n "$NS" rollout status deployment/worker --timeout=120s
kubectl -n "$NS" rollout status deployment/monitor --timeout=120s
kubectl -n "$NS" rollout status deployment/web --timeout=120s

echo "all deployments ready:"
kubectl -n "$NS" get pods
