# ADR 0024 - Kubernetes baseline: plain manifests + Kustomize, in-cluster Postgres/Redis, kind for local verification

Status: Accepted
Date: 2026-09-11

## Context

Phase 10's boundary (`README.md#roadmap`) is "services
deployable" - Phase 11 owns production configuration validation, TLS/
reverse-proxy assumptions, production PostgreSQL/Redis configuration,
detailed resource sizing and secrets-backend integration. Before this pass
`infrastructure/kubernetes/` did not exist at all (`README.md`'s project
structure section said so explicitly). Three tooling questions had to be
settled before writing any manifest.

## Decisions

### Plain manifests + Kustomize, not Helm

No Helm chart exists to adapt, and a from-scratch chart would spend most of
its lines re-implementing what Kustomize's `envFrom`/`configMapGenerator`
already does for four structurally similar Deployments (api/worker/monitor/
web all share the same ConfigMap+Secret shape, differing only in port
numbers and probe paths). Helm's templating value shows up when there is a
values-per-environment matrix to manage - exactly Phase 11's job (dev/
staging/prod overlays), not this baseline's. Kustomize was chosen over
`kubectl apply -f` on loose files for one concrete reason:
`configMapGenerator` (used for the Grafana dashboard JSON,
`infrastructure/kubernetes/monitoring/kustomization.yaml`) keeps a
provisioned dashboard's JSON as a single source file instead of a
hand-escaped YAML block.

### In-cluster Postgres/Redis as plain Deployments, not StatefulSets or an operator

A StatefulSet's ordinal identity and per-replica storage matter for a
multi-replica database; this baseline runs exactly one replica of each,
so a Deployment + PVC (`strategy: Recreate` so Kubernetes never runs two
Postgres pods against the same volume during a rollout) gives the same
practical guarantee with less to explain to a new owner. Both are
explicitly a **development/baseline convenience**, not a production
database - `infrastructure/kubernetes/postgres.yaml` and `redis.yaml` say so
in their own header comments, and a real deployment should point
`DATABASE_URL`/`REDIS_URL` at a managed instance and skip these two files
entirely. Running Postgres inside Kubernetes at all is a legitimate
production choice (a self-managed Postgres operator, e.g. CloudNativePG),
just not one this baseline commits to - that decision, if load-bearing, is
Phase 11's to make deliberately rather than inherit from what was
convenient to write here.

### `kind` for local cluster verification, chosen over `minikube` or a cloud cluster

Neither `kind` nor `minikube` nor a cloud Kubernetes account existed in this
environment. `kind` was chosen because it runs Kubernetes-in-Docker with no
VM/hypervisor layer, matching the Docker Desktop that already exists here,
and because it is the tool most CI systems already use for exactly this
purpose (a disposable, fast-to-create cluster to validate manifests against
before a real cluster exists) - the same reasoning a Phase 15 CI pipeline
would reach for if it needed to smoke-test manifests, not just build images.
`kind load docker-image` (see `scripts/kubernetes/build-and-load.sh`) is
`kind`-specific and has no effect against a real cluster, which instead
pulls from a registry the CI pipeline would need to push to - a Phase 11/15
concern, not solved here.

### One Secret, generated locally, not committed

`infrastructure/kubernetes/secret.example.yaml` is a template with
placeholder values, never applied as-is;
`scripts/kubernetes/generate-secret.sh` produces the real
`infrastructure/kubernetes/secret.yaml` (gitignored) with freshly random
JWT/encryption/Postgres-password values. This is the Kubernetes-manifest
equivalent of `.env.example` vs `.env` - deliberately not a KMS/Vault
integration (`@gateway/security`'s `SecretsProvider` seam, ADR 0012, is
where a Phase 11 pass would wire a real backend in); it exists so the
manifests are deployable standalone without inventing a secrets-management
story this phase was never scoped to build.

## Addendum - `startupProbe` on every workload, found necessary by a real deploy

The first real `kind` deploy of this baseline surfaced two concrete
liveness/readiness bugs, both fixed directly in the manifests rather than
just noted:

1. **`terminationGracePeriodSeconds` nested under `containers[]` instead of
   at the pod spec level** in all four service manifests - a Kubernetes API
   strict-decoding error (`unknown field
   "spec.template.spec.containers[0].terminationGracePeriodSeconds"`) that
   `kubectl apply -k` caught immediately on the first real deploy attempt.
2. **A bare `livenessProbe.initialDelaySeconds` raced the application's own
   boot time.** `api` and `web` were each observed restarted once on a real
   deploy - the kubelet's liveness check fired and killed the container
   before Nest's bootstrap (module wiring, Prisma engine connect) or
   Next.js's server finished starting, especially under concurrent load from
   other pods/builds on the same host. The fix applied to all six workloads
   (api, worker, monitor, web, postgres, redis) and to Prometheus/Grafana:
   add a `startupProbe` using the same check, with a generous
   `failureThreshold * periodSeconds` budget, so liveness/readiness only
   start counting once the app has actually answered once - this is the
   standard Kubernetes pattern for slow-starting containers, not a
   workaround specific to this app.

Grafana's manifest was written *without* this fix initially (it predates
the finding above) and paid for it directly: during a later, sustained
period of host CPU/memory pressure (concurrent `kind` + Docker builds + the
CI verification work below, all sharing one machine's fixed-size Docker
Desktop VM), Grafana's missing `startupProbe` let it get killed and
restarted 50+ times into `CrashLoopBackOff`, while the five workloads that
already had the fix survived the same pressure with their restart counts
climbing but never getting stuck. The control plane itself (`kube-scheduler`,
`kube-controller-manager`) also showed elevated restart counts during this
window and took roughly 20-30 seconds to stabilize once the competing load
ended - not a manifest defect, but worth recording: **a single-node `kind`
cluster sharing a host with heavy concurrent Docker activity is not a
capacity-representative environment**, and Phase 28 (capacity/performance
validation) should not treat anything observed here as a resource-sizing
signal for a real deployment.

## Consequences

* `infrastructure/kubernetes/` deploys the four services plus Postgres,
  Redis and a one-shot migration Job, in the dependency order
  `scripts/kubernetes/deploy.sh` enforces (Kustomize's own `apply -k` applies
  everything at once and does not wait for Postgres to be ready before the
  migration Job runs, which is why the deploy script exists rather than
  documenting a bare `kubectl apply -k` as the whole procedure).
* `apps/web`'s `NEXT_PUBLIC_API_URL` is inlined into its client bundle at
  **Docker build time** (Next.js's own behavior, `apps/web/src/lib/config.ts`),
  not read from this baseline's ConfigMap at pod start - the ConfigMap's
  `NEXT_PUBLIC_API_URL` key currently has no effect on the running image
  unless the Docker build itself is re-run with that value set. This is a
  known limitation, not fixed here: a real per-environment frontend
  configuration story (a build ARG threaded through CI per target
  environment, or a runtime-config fetch instead of a build-time inline) is
  Phase 11 production-configuration scope. Local `kind` verification works
  around it by coincidence - the compiled default (`http://localhost:4000`)
  happens to match what a developer's `kubectl port-forward` of the `api`
  Service to `localhost:4000` would expose.
* monitor and worker ship at `replicas: 1` deliberately - see
  `infrastructure/kubernetes/monitor.yaml`'s own comment: multi-replica
  safety under the existing lease/lock mechanisms
  (`MONITOR_LEASE_SECONDS`, `chain_cursors`) is unverified under real
  concurrency and is Phase 28's job to confirm, not assumed here.
* Real evidence for "deployed and healthy" (not just "manifests exist") is
  recorded in `README.md`'s Phase 10 row and
  `README.md#roadmap`'s Phase 10 state column, from an
  actual `kind` cluster run - see those for pod status output, not this
  ADR, so the evidence lives next to the claim it supports.
