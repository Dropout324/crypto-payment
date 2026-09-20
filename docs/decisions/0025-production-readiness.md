# ADR 0025 - Production readiness: fail-fast config validation, self-signed TLS baseline, mainnet RPC fallback required

Status: Accepted
Date: 2026-09-12

## Context

Phase 11 (`README.md#roadmap`) owns what Phase 10
explicitly deferred: production configuration validation, TLS/reverse-proxy
assumptions, production PostgreSQL/Redis guidance, RPC fallback
configuration, resource limits, and a deployment guide a new owner can
follow unaided. The roadmap's zero-cost constraint (no budget, no
maintainer involvement after handover) shaped every decision below: there is no
real domain, no cloud account, and no mainnet RPC provider account in this
environment.

## Decisions

### Fail-fast production config validation, not a warning

`apps/api`, `apps/worker` and `apps/blockchain-monitor` each gained a
`validateProductionConfig()` called once at boot, after `loadConfig()` and
before anything else starts - a no-op outside `NODE_ENV=production`. It
throws (crashing the process before it accepts traffic) rather than logging
a warning, matching this codebase's existing philosophy
(`apps/api/src/config/env.ts`'s own file comment: "a missing `DATABASE_URL`
should crash on boot, not on the first request that happens to touch it").
A warning that nobody reads is not a production gate; Phase 10's
`kind` baseline (`CORS_ALLOWED_ORIGINS: http://localhost:3000`, always run
with `NODE_ENV=production`) would have sailed through a warning-only check
unnoticed - it is exactly the config this phase's validation now refuses,
which is the point, not a regression.

What each service checks, and why, is documented in
`docs/operations/deployment-guide.md`'s "Production configuration
validation" section rather than repeated here. `ENCRYPTION_KEY`'s own shape
was already enforced unconditionally by `EnvKeyProvider` - deliberately not
duplicated.

### RPC fallback required for every *mainnet* network in production, not just Ethereum

`EvmRpcClient` (`packages/blockchain`) already implemented fallback-URL
failover and was already tested (`packages/blockchain/test/rpc-adapter.test.ts`)
- but `apps/blockchain-monitor/src/config.ts` only wired a
`_FALLBACK_URL` env var for Ethereum. Polygon and BSC got the same
`POLYGON_RPC_FALLBACK_URL`/`BSC_RPC_FALLBACK_URL` treatment, and
`validateProductionConfig` now refuses to boot if any *mainnet* network is
configured without one. Testnets are exempt (see the comment on
`EVM_NETWORK_ENV`): a testnet outage is not a real-money incident, and there
is nothing to fail over to in practice. This phase has no mainnet RPC
account to validate the fallback *works* end-to-end under a real provider
outage - that is Phase 24 (mainnet validation)'s job; this phase only
ensures the configuration required for it is present and wired, and a
free-tier public Sepolia endpoint (`https://rpc.sepolia.org`) stood in for
local verification, since Sepolia's testnet exemption makes that
sufficient to prove "the monitor boots in production and watches at least
one network."

### `NEXT_PUBLIC_API_URL` as a Docker build ARG, not a runtime-config fetch

ADR 0024's addendum flagged this as a known limitation: Next.js inlines
`process.env.NEXT_PUBLIC_*` into the client bundle at `next build` time, so
`infrastructure/kubernetes/configmap.yaml`'s `NEXT_PUBLIC_API_URL` key had
no effect on the running `web` image. Two fixes were possible - a build
ARG threaded through per environment, or switching to a runtime-config
fetch (an endpoint the client calls once to learn its own API URL, avoiding
the bake-in entirely). The ARG was chosen: it is a one-line Dockerfile
change (`ARG NEXT_PUBLIC_API_URL=http://localhost:4000` immediately before
`pnpm build`, defaulted to the existing hardcoded fallback so every build
invocation that does not pass it - api/worker/monitor/debug targets, and
any `web` build with no override - is bit-for-bit unaffected), whereas a
runtime-config fetch would touch `apps/web`'s client code and add a network
round-trip before the app could make its first real API call. The real
cost of the ARG approach is disclosed, not hidden: a `web` image is tied to
one public API URL and must be rebuilt per environment that needs a
different one - acceptable because Phase 15's CI pipeline is the natural
place this becomes "build once per target environment" rather than a
manual step, and rebuilding a Next.js image is not expensive.

### Self-signed `ClusterIssuer` for this pass's TLS verification, ACME deferred

`infrastructure/kubernetes/ingress.yaml` (two `Ingress` resources, one per
public-facing service) needs a `ClusterIssuer` to get a certificate from.
A real ACME issuer (Let's Encrypt) requires a publicly resolvable domain to
complete an HTTP-01 challenge against - this environment has none. A
`selfSigned` `ClusterIssuer` was used instead: cert-manager still issues a
real, working certificate (TLS termination, SNI routing and the
now-`https://`-only `CORS_ALLOWED_ORIGINS` check all genuinely exercised),
it is simply not one any browser trusts. This is disclosed as a known
limitation in the deployment guide, with the exact one-annotation,
two-hostname swap to a real ACME issuer once a domain exists - nothing else
in the manifests changes. Verification used `kubectl port-forward` plus
`curl --resolve` against `*.gateway.local` hostnames rather than editing
`/etc/hosts` or recreating the `kind` cluster with port mappings (which
would have discarded the already-verified Phase 10 cluster) - a real
cluster's Ingress controller normally gets a `LoadBalancer` with a real
external IP, making the port-forward step specific to local verification,
not part of the production pattern.

### Resource limits documented with their reasoning, not re-measured

Phase 10's baseline CPU/memory requests and limits were kept as-is; Phase
11 adds the table in `docs/operations/deployment-guide.md` explaining what
drives each number's order of magnitude (argon2id's memory cost for `api`,
poll-loop-only for `worker`/`monitor`, `max_connections` for the baseline
Postgres). None of this is load-test-derived - that is explicitly Phase
28's job (capacity and performance validation), and the roadmap's own
boundary table assigns "resource limits sized from any load test" to this
phase's *missing* list, not its *scope*. Documenting the existing rationale
honestly, rather than inventing a measured-sounding number with no load
test behind it, was judged more useful to a reviewer's technical
assessment than leaving the table out entirely.

## Consequences

* `infrastructure/kubernetes/configmap.yaml`'s `CORS_ALLOWED_ORIGINS`,
  `PUBLIC_API_URL` and `PUBLIC_WEB_URL` changed from `localhost`/in-cluster
  DNS names to `https://{app,api}.gateway.local`, matching
  `ingress.yaml`'s hostnames - a direct consequence of
  `validateProductionConfig` now refusing the old values. A new owner
  deploying to a real domain changes these three values and the `web`
  image's build-arg together; the deployment guide says so explicitly.
* `scripts/kubernetes/build-and-load.sh` gained a second, optional argument
  (`next-public-api-url`) and now builds `web` as its own `docker build`
  invocation with that value as a `--build-arg`, rather than looping it
  through the same command as the other four targets.
* `infrastructure/kubernetes/secret.example.yaml`, `generate-secret.sh` and
  `.env.example` all gained `POLYGON_RPC_FALLBACK_URL`/`BSC_RPC_FALLBACK_URL`
  alongside the existing `ETHEREUM_RPC_FALLBACK_URL`.
* Real evidence for every claim above (pod status, curl output against the
  Ingress, a deliberately-bad Secret value actually being refused) is
  recorded in `README.md`'s Phase 11 row and
  `README.md#roadmap`'s Phase 11 state column, not
  repeated here.
* **Found, not fixed (out of this phase's scope):** re-running
  `apps/api`'s full test suite while verifying this phase surfaced
  `test/admin-audit-logs.e2e.test.ts`'s first case
  ("an ADMIN can read the trail an earlier action wrote") failing
  consistently, including in isolation and on the pre-Phase-11 baseline
  with none of this phase's changes applied. The audit-log write this test
  depends on is plausibly not awaited before its triggering request
  responds, so the immediately-following read wins the race. Unrelated to
  any change in this ADR; left for whichever phase owns audit-log
  correctness (Phase 16 or Phase 17) to investigate and fix.
