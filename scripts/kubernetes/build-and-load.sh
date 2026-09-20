#!/usr/bin/env bash
# Builds all five Docker targets (api/worker/monitor/web + debug, the last
# one needed by migration-job.yaml) and loads them into a kind cluster,
# since kind's nodes run their own containerd and cannot see images that
# only exist in the host Docker daemon. Not needed against a real cluster
# that pulls from a registry - push there instead and update the image:
# fields (or set an image registry/tag via `kustomize edit set image`).
#
# Usage: ./scripts/kubernetes/build-and-load.sh [kind-cluster-name] [next-public-api-url]
#
# The second argument only affects the `web` target - it is baked into its
# client bundle at build time (see infrastructure/docker/Dockerfile's
# NEXT_PUBLIC_API_URL ARG and docs/operations/deployment-guide.md). Defaults
# to the value infrastructure/kubernetes/configmap.yaml documents for local
# `kind` + Ingress verification; a real deployment passes its own real
# domain instead (no port - Ingress there listens on 443, not a
# port-forward).
set -euo pipefail
cd "$(dirname "$0")/../.."

CLUSTER="${1:-gateway}"
NEXT_PUBLIC_API_URL="${2:-https://api.gateway.local:8443}"
TAG=local

for target in api worker monitor debug; do
  echo "=== building $target ==="
  docker build -f infrastructure/docker/Dockerfile --target "$target" -t "gateway-$target:$TAG" .
done

echo "=== building web (NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL) ==="
docker build -f infrastructure/docker/Dockerfile --target web \
  --build-arg "NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL" \
  -t "gateway-web:$TAG" .

echo "=== loading images into kind cluster '$CLUSTER' ==="
for target in api worker monitor web debug; do
  kind load docker-image "gateway-$target:$TAG" --name "$CLUSTER"
done

echo "done - images available in-cluster as gateway-<target>:$TAG"
