# Deployment guide

Phase 11 (production readiness) - see `README.md#roadmap`.
Written so a new owner who did not build this system can deploy all four
services (`api`, `worker`, `blockchain-monitor`, `web`) to a real environment
without contacting the original author. If anything below turns out to be missing a
step, that gap belongs in this guide, not in a conversation.

This guide assumes a Kubernetes cluster and the manifests in
`infrastructure/kubernetes/`. It does not cover provisioning the cluster
itself (a managed Kubernetes service, or your own) - that choice is the new
owner's, and the manifests here make no cloud-provider-specific assumptions.

## What this guide proves, and what it does not

Every command below was actually run against a real `kind` cluster as part
of writing this guide - not drafted from the manifests alone (Rule 1 of the
roadmap: evidence over claims, and Phase 9.5 is the reason that rule exists).
What it does **not** prove:

- **Real TLS.** The ClusterIssuer here is `selfSigned` - no browser will
  trust the resulting certificate. See [TLS](#tls-and-the-reverse-proxy)
  for the one-line swap to a real ACME issuer once a domain exists.
- **A real mainnet RPC provider.** Verified with a free public Sepolia
  endpoint (a testnet) - a production deployment needs the new owner's own
  mainnet provider account(s). See [RPC configuration](#rpc-provider-configuration).
- **A managed PostgreSQL/Redis instance.** Verified against the in-cluster
  baseline Postgres/Redis from Phase 10. See
  [PostgreSQL and Redis](#postgresql-and-redis).
- **Measured resource sizing.** See [Resource limits](#resource-limits) -
  that measurement is Phase 28's job.
- **A real cloud account, domain, or money.** None exist in the environment
  this guide was written in (see
  `README.md#roadmap`'s zero-cost constraint) - every
  step below is the zero-cost path, with the paid alternative named at each
  point it applies.

## 1. Prerequisites

- A Kubernetes cluster and a `kubectl` context pointed at it.
- `kustomize` (bundled with recent `kubectl`).
- Docker, to build the four runtime images (`infrastructure/docker/Dockerfile`).
- A container registry the cluster can pull from, unless deploying to a
  local `kind`/`minikube` cluster (which can load images directly - see
  `scripts/kubernetes/build-and-load.sh`).
- An ingress controller and cert-manager, if using the bundled Ingress/TLS
  manifests - see [TLS](#tls-and-the-reverse-proxy).

## 2. Build the runtime images

```
docker build -f infrastructure/docker/Dockerfile --target api     -t <registry>/gateway-api:<tag> .
docker build -f infrastructure/docker/Dockerfile --target worker  -t <registry>/gateway-worker:<tag> .
docker build -f infrastructure/docker/Dockerfile --target monitor -t <registry>/gateway-monitor:<tag> .
docker build -f infrastructure/docker/Dockerfile --target debug   -t <registry>/gateway-debug:<tag> .
docker build -f infrastructure/docker/Dockerfile --target web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.<your-domain> \
  -t <registry>/gateway-web:<tag> .
docker push <registry>/gateway-api:<tag>      # repeat for worker/monitor/web/debug
```

**`web`'s `--build-arg` is not optional in production.** Next.js inlines
`NEXT_PUBLIC_API_URL` into the client JavaScript bundle at `next build`
time (confirmed directly: it has no effect if set only in
`infrastructure/kubernetes/configmap.yaml` at pod start - ADR 0024's
addendum, fixed in Phase 11). Every environment that needs a different
public API URL needs its own `web` image build - this is a real
consequence of the architecture decision that the browser calls the API
directly rather than through a same-origin proxy
(`apps/web/src/lib/config.ts`), not an oversight; a CI pipeline (Phase 15)
is where this naturally becomes "build once per target environment" rather
than a manual step.

`gateway-debug` is only needed for `infrastructure/kubernetes/migration-job.yaml`
(it carries the devDependencies-free runtime images don't, needed to run
Prisma's migration CLI).

Local `kind` verification instead uses
`scripts/kubernetes/build-and-load.sh <cluster-name> <next-public-api-url>`,
which builds all five targets and loads them directly into the cluster's
containerd, skipping the registry push entirely.

## 3. Generate secrets

```
scripts/kubernetes/generate-secret.sh
kubectl apply -f infrastructure/kubernetes/secret.yaml
```

This writes `infrastructure/kubernetes/secret.yaml` (gitignored - never
commit it) with freshly random JWT/encryption/Postgres-password values, from
`infrastructure/kubernetes/secret.example.yaml`'s shape. Fill in the RPC
URLs (see below) and any exchange-rate/compliance/signing keys you have
before applying. A new owner using a real KMS/Vault instead should generate
the same key *names* from there and `kubectl apply` an equivalent Secret -
`@gateway/security`'s `SecretsProvider` seam (ADR 0012) is unaffected either
way; only how this one Kubernetes Secret gets populated changes.

## 4. PostgreSQL and Redis

`infrastructure/kubernetes/postgres.yaml` and `redis.yaml` are an in-cluster
baseline (Phase 10) - a single `Deployment` + `PersistentVolumeClaim` each,
explicitly **not** production PostgreSQL/Redis. Point `DATABASE_URL` and
`REDIS_URL` (in the Secret above) at a managed instance instead and skip
applying those two files entirely, unless self-managed Postgres-in-Kubernetes
(e.g. a CloudNativePG-operated cluster) is a deliberate choice - that
decision is the new owner's to make, not inherited from what was convenient
for this baseline.

**Two database roles, two secret keys (Phase 17 pass 1, ADR 0031)**:
`DATABASE_URL` (the key `api`/`worker`/`monitor` actually consume) must
point at a least-privilege role - CRUD only, no DDL, no superuser - never
at the role that owns the schema. `DATABASE_MIGRATE_URL` is that
schema-owning role's connection string, used only by
`infrastructure/kubernetes/migration-job.yaml`, which runs `prisma migrate
deploy` and then `packages/database/prisma/provision-app-role.ts`
(idempotent - safe to run on every deploy) to create/update the
least-privilege role and its grants. Generated automatically by
`scripts/kubernetes/generate-secret.sh` for the in-cluster baseline
Postgres; pointing at a managed instance instead means creating the
schema-owning role there yourself (whatever the provider's normal
admin-role mechanism is) and setting `DATABASE_MIGRATE_URL` to it -
`provision-app-role.ts` only needs ordinary `CREATE ROLE`/`GRANT`
privileges, not the instance's own superuser account, so a managed
Postgres's usual "admin" role (which most providers already restrict short
of true superuser) is sufficient. Never skip this split by pointing both
keys at the same role "to simplify" - that is exactly the gap ADR 0031
closed. See `docs/security/findings-register.md` finding 4 for the full
rationale and the test that proves the grants are correctly scoped
(`packages/database/test/least-privilege-role.test.ts`).

If using a managed PostgreSQL:

- Require TLS on the connection (`?sslmode=require` or the provider's
  equivalent in `DATABASE_URL`).
- Size `connection_limit` in `DATABASE_URL` (currently `20`) against the
  provider's own connection ceiling and the number of `api` replicas -
  each replica opens its own pool.
- Point-in-time recovery (continuous WAL archiving plus daily physical base
  backups), measured RPO/RTO and an executed recovery drill are covered in
  [`docs/operations/disaster-recovery-runbook.md`](disaster-recovery-runbook.md)
  and [ADR 0029](../decisions/0029-point-in-time-recovery.md), not this
  guide - `scripts/backup/` (ADR 0022's logical `pg_dump`/`pg_restore`
  baseline, plus ADR 0029's `pg_basebackup`/WAL mechanism) is where the
  scripts live.

If using a managed Redis:

- This codebase uses Redis for caching (`REDIS_CACHE_DB`) and as queue/lease
  state (webhook delivery backlog, blockchain monitor leases) - data loss
  there is a correctness incident, not just a performance one. Use a tier
  with persistence (AOF or equivalent), not a pure cache tier.
- `redis.yaml`'s `--maxmemory-policy noeviction` is load-bearing: a managed
  Redis that silently evicts keys under memory pressure would drop queue
  state. Match this policy explicitly if the provider defaults to an
  eviction policy.

## 5. RPC provider configuration

Set `ETHEREUM_RPC_URL`/`POLYGON_RPC_URL`/`BSC_RPC_URL` (and their
`_FALLBACK_URL` counterparts) in the Secret for every mainnet network the
deployment claims to support, plus the matching testnet URLs if running in
a non-production environment.

**`apps/blockchain-monitor`'s `validateProductionConfig` (Phase 11) refuses
to start in production unless:**
- at least one EVM network has a URL configured, and
- every *mainnet* network configured also has a `_FALLBACK_URL` configured.

This is deliberate, not a bug to work around: a single RPC provider is a
single point of failure for confirmation processing on that network, and
Phase 24 (mainnet validation) exercises the fallback takeover directly. Two
independent providers (for example Alchemy as primary, Infura or a
self-hosted node as fallback) are the production shape; a free-tier account
with each is enough to satisfy this at low volume. Testnets are exempt -
see the comment on `EVM_NETWORK_ENV` in
`apps/blockchain-monitor/src/config.ts`.

This guide's own `kind` verification had no mainnet RPC account available
(zero-cost constraint) and used a free, no-signup public Sepolia endpoint
(`https://rpc.sepolia.org`) instead, which satisfies "at least one network"
without needing a fallback (Sepolia is a testnet).

## 6. Production configuration validation

`NODE_ENV=production` (set in `infrastructure/kubernetes/configmap.yaml`)
makes all three backend services run their own `validateProductionConfig()`
at boot and exit immediately, with a message listing every problem, if any
of the following hold:

- **`apps/api`:** `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` shorter than 32
  characters, equal to each other, or matching a known placeholder pattern
  (`CHANGE_ME`, `replace_with`, `secret`, `password`, `example`,
  `placeholder`, `test`) - catches a value copied from `.env.example` or
  `secret.example.yaml` and never replaced. `CORS_ALLOWED_ORIGINS` empty,
  containing `localhost`/`127.0.0.1`, equal to `*`, or not `https://` -
  nothing a real reverse-proxy/TLS setup would ever send as a browser
  `Origin` header. `SIGNING_BACKEND` set to anything but `disabled` (Phase
  12, ADR 0026) - `emulated-hsm-staging` is a software HSM emulation for
  demonstrating the signing architecture, never a real KMS/HSM, and Mode A
  (custodial signing) is not live.
- **`apps/worker`:** `WEBHOOK_BLOCK_PRIVATE_NETWORKS=false` - this disables
  the SSRF guard on merchant-supplied webhook URLs.
- **`apps/blockchain-monitor`:** see [RPC provider configuration](#rpc-provider-configuration)
  above.

`ENCRYPTION_KEY`'s own shape (must decode to exactly 32 bytes) is already
enforced unconditionally (every environment, not just production) by
`EnvKeyProvider` (`@gateway/security`) - not duplicated here.

None of this runs outside `NODE_ENV=production` - a development or test
config is never held to this bar.

## 7. TLS and the reverse proxy

`infrastructure/kubernetes/ingress.yaml` routes two hostnames - one to
`web`, one to `api` - through whatever `IngressClass: nginx` controller is
installed, with TLS from a cert-manager `ClusterIssuer`.

**Installing the add-ons** (cluster-level, not part of this repo - verified
against ingress-nginx v1.11.3 and cert-manager v1.16.2):

```
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl wait --for=condition=Available deployment/ingress-nginx-controller -n ingress-nginx --timeout=180s
kubectl wait --for=condition=Available deployment/cert-manager deployment/cert-manager-webhook deployment/cert-manager-cainjector -n cert-manager --timeout=180s
```

**Zero-cost baseline (what this guide verified):**
`infrastructure/kubernetes/cert-manager/selfsigned-issuer.yaml` is a
`selfSigned` `ClusterIssuer` - cert-manager issues a real, working
certificate, but one no browser trusts (there is no real CA behind it).
Fine for verifying that TLS termination, the Ingress routing and the
production CORS configuration actually work together; not something to
put in front of real merchants.

**Swapping in real TLS once a domain exists:** replace the `selfsigned`
`ClusterIssuer` with an ACME one, for example:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: <your-email>
    privateKeySecretRef: { name: letsencrypt-account-key }
    solvers:
      - http01:
          ingress: { ingressClassName: nginx }
```

then change `ingress.yaml`'s `cert-manager.io/cluster-issuer` annotation
from `selfsigned` to `letsencrypt` and its two `host` values from
`*.gateway.local` to the real domain names, and update
`CORS_ALLOWED_ORIGINS`/`PUBLIC_API_URL`/`PUBLIC_WEB_URL` in `configmap.yaml`
and the `web` image's `NEXT_PUBLIC_API_URL` build-arg to match. Nothing else
changes - this is the entire production-TLS story.

**Local verification (no real domain, no `/etc/hosts` edit):**

```
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8443:443
curl --resolve app.gateway.local:8443:127.0.0.1 -k https://app.gateway.local:8443/
curl --resolve api.gateway.local:8443:127.0.0.1 -k https://api.gateway.local:8443/v1/health
```

`curl`'s `--resolve` fakes DNS for that one request only, and `-k` accepts
the self-signed certificate. A real cluster's Ingress controller normally
gets a `LoadBalancer` Service with a real external IP, making this
port-forward step unnecessary - it exists only because this guide's `kind`
cluster has none.

## 8. Deploy

```
./scripts/kubernetes/deploy.sh
```

Applies the namespace, Secret, ConfigMap, Postgres/Redis, a one-shot
migration Job (waited on before continuing), then the four services in
order - see the script for exactly what it waits on and why a bare
`kubectl apply -k infrastructure/kubernetes` does not (Kustomize applies
everything at once; nothing there waits for Postgres before the migration
Job runs). Apply the Ingress afterwards, once the add-ons above are
installed:

```
kubectl apply -f infrastructure/kubernetes/cert-manager/selfsigned-issuer.yaml   # or your real ClusterIssuer
kubectl apply -f infrastructure/kubernetes/ingress.yaml
```

## 9. Verify

```
kubectl -n gateway get pods
scripts/docker/smoke-test.mjs   # against the built images directly, not through the cluster
curl --resolve api.gateway.local:8443:127.0.0.1 -k https://api.gateway.local:8443/v1/health
curl --resolve api.gateway.local:8443:127.0.0.1 -k https://api.gateway.local:8443/v1/ready
curl --resolve app.gateway.local:8443:127.0.0.1 -k https://app.gateway.local:8443/
```

Every pod should reach `1/1 Ready`; both `/health` and `/ready` should
return `200`. A log line from `api`/`worker`/`monitor` containing "refusing
to start in production" instead means `validateProductionConfig` caught a
real problem in the Secret/ConfigMap - fix the value it names, it is never
safe to bypass.

## Resource limits

| Workload | Requests (cpu / memory) | Limits (cpu / memory) | Why |
|---|---|---|---|
| `api` | 100m / 192Mi | 500m / 512Mi | NestJS + Prisma; argon2id password hashing (`ARGON2_MEMORY_KIB=19456`, ~19MB per concurrent hash) is the request's main memory spike, not steady-state traffic |
| `web` | 100m / 192Mi | 500m / 512Mi | Next.js server runtime; same order of magnitude as `api` with no comparable CPU-bound step |
| `worker` | 50m / 128Mi | 300m / 384Mi | Two poll loops (webhook dispatch, expiry sweep) against the database - no HTTP server, no heavy per-request computation |
| `monitor` | 50m / 128Mi | 300m / 384Mi | Poll-based chain scanning per configured network - scales with network count more than with traffic |
| `postgres` (baseline) | 100m / 256Mi | 1 / 1Gi | `max_connections=200`; a real deployment sizes this against its managed provider's own tier instead |
| `redis` (baseline) | 50m / 64Mi | 500m / 512Mi | AOF persistence enabled; sized for queue/lease state, not a large cache working set |

**These are Phase 10's baseline defaults, documented here with their
reasoning, not load-test-measured values.** Throughput/latency numbers that
would justify a different number are Phase 28's job (capacity and
performance validation) - treat a `CPUThrottlingHigh` or repeated OOMKill
under real traffic as a signal to revisit this table, not as this guide
being wrong. `monitor` and `worker` both ship at `replicas: 1` regardless of
these limits - see `infrastructure/kubernetes/monitor.yaml`'s own comment on
why multi-replica safety is unverified, also Phase 28.

## Known limitations

- No reverse-proxy/TLS except the bundled Ingress/cert-manager pattern
  above - a new owner preferring a different ingress controller or a
  cloud load balancer's own TLS termination adapts the same `Ingress`
  resource shape.
- No per-environment (dev/staging/prod) manifest overlay system - one
  ConfigMap, hand-edited per environment. A Kustomize overlay per
  environment is a natural next step if more than one environment needs to
  coexist, not built here because only one was needed to verify this guide.
- Point-in-time recovery and measured RPO/RTO are now covered by
  [`docs/operations/disaster-recovery-runbook.md`](disaster-recovery-runbook.md)
  and [ADR 0029](../decisions/0029-point-in-time-recovery.md) (Phase 14) -
  a full gate-enforced CI pipeline and financial alerting remain Phases
  15/16 respectively. This guide covers deployment, not disaster recovery
  or operations day two.
