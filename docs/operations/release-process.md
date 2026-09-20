# Release process

Phase 15 (C5, `README.md#roadmap`). Written so a new owner
who did not build this system can cut and ship a release without contacting
the original author. Every gate named below is a real job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), not aspirational
- see [ADR 0028](../decisions/0028-cicd-gates-and-release-process.md) for the
evidence that a deliberately broken change is actually blocked by it.

## What "release" means here

There is no package registry publish step - the deployable artifact is four
Docker images (`api`, `worker`, `blockchain-monitor`, `web`, built from
[`infrastructure/docker/Dockerfile`](../../infrastructure/docker/Dockerfile))
plus the database migrations they expect
([`packages/database/prisma/migrations/`](../../packages/database/prisma/migrations/)).
A release is: a commit on `main` that passed every CI gate, tagged, with its
images built and pushed to whatever registry the new owner's cluster pulls
from.

## 1. Before merging to `main`

Every pull request runs the full `CI` workflow. **All of these must be green
before merge** (branch protection requiring these checks is a repository
setting the new owner configures once a real GitHub remote exists - see
[ADR 0023](../decisions/0023-cicd-platform.md) for why this repo was
developed without one):

| Job | Gate | Blocks merge? |
|---|---|---|
| `lint-typecheck` | ESLint + `tsc --noEmit` across all 14 packages/apps | Yes |
| `build` | Every package compiles | Yes |
| `test` | Full unit + integration suite against real Postgres/Redis, with coverage collected | Yes |
| `license-check` | Every production dependency's licence is on the allowlist (`scripts/licenses/check-licenses.mjs`) | Yes |
| `vulnerability-scan` | Zero unresolved critical/high `pnpm audit --prod` findings (`scripts/security/audit-report.mjs`) | Yes - a real gate since [Phase 17 pass 1](../../README.md#roadmap) (ADR 0031) closed the dependency-advisory gap it was reporting; informational (Phase 15) before that |
| `docker-smoke` | All four runtime images build from a cold cache and pass health/readiness/metrics/graceful-shutdown checks (`scripts/docker/smoke-test.mjs`) | Yes |

`docker-smoke` `needs` every gating job above, so a failure anywhere in
`lint-typecheck`, `build`, `test`, `license-check` or `vulnerability-scan`
stops the pipeline before a single Docker image is built - see ADR 0028 for
a real run proving this for the original four jobs, and ADR 0031 for the
`vulnerability-scan` flip to a hard gate.

Coverage and the SBOM are published as workflow artifacts on every run (see
[Coverage](#2-coverage-baseline) and [SBOM](#3-sbom)) - reviewed, not gated,
because a coverage regression or an SBOM diff is a judgement call for the
reviewer, not a fixed pass/fail line.

## 2. Coverage baseline

`pnpm test:coverage` runs the same suites as `pnpm test`, instrumented with
`@vitest/coverage-v8` (each project's own `vitest.config.ts` shares its
settings from [`vitest.coverage.base.mjs`](../../vitest.coverage.base.mjs) -
the same import-per-project pattern `eslint.config.base.mjs` already uses).
`pnpm test:coverage:report` (`scripts/test/aggregate-coverage.mjs`) combines
every project's `coverage/coverage-summary.json` into one repo-wide,
line-weighted number, printed in the `test` job's log and written to
`coverage/summary.json`, uploaded as a build artifact.

There is no enforced minimum percentage. A percentage floor invites tests
written to move the number rather than to catch regressions; the artifact
exists so a reviewer can see the
real baseline and its trend, not to gate merges on it.

```bash
pnpm test:db:migrate   # once, against an empty TEST_DATABASE_URL
pnpm test:coverage
pnpm test:coverage:report
```

## 3. SBOM

`scripts/sbom/generate-sbom.mjs` emits a CycloneDX 1.5 JSON document
(`sbom/sbom.cdx.json`) built from `pnpm licenses list --json --prod` - the
same tool the [readiness roadmap](../../README.md#roadmap)'s
Phase 29 section used to inventory production dependencies by licence, run
fresh on every CI build rather than
a third-party generator (see the script's own header comment for why: no
pnpm-lockfile-compatible generator was worth adding as a dependency for a
tool this project runs once per build). It is generated per build, uploaded
as a workflow artifact, and belongs in the Phase 20 data room for every
tagged release.

```bash
pnpm sbom   # writes sbom/sbom.cdx.json
```

## 4. Licence check

`scripts/licenses/check-licenses.mjs` fails the moment a production
dependency's licence falls outside the allowlist already established by the
readiness roadmap's Phase 29 inventory (MIT, Apache-2.0, ISC, BSD-2/3-Clause, 0BSD, CC-BY-4.0,
and the one "Apache-2.0 AND LGPL-3.0-or-later" entry, all already reviewed as
non-blocking). This is a real gate, not informational - it was
zero-risk to turn on immediately because all 211 current production
dependencies already pass it; its purpose is to catch the *next* dependency
that doesn't.

```bash
pnpm licenses:check
```

## 5. Vulnerability scanning

`scripts/security/audit-report.mjs` runs `pnpm audit --prod --json`, writes
`security-reports/pnpm-audit.json`, and prints a critical/high/moderate/low
summary.
[Phase 17 pass 1](../../README.md#roadmap)
(ADR 0031) closed the open critical/high advisories this script used to
report (bundled Fastify 4.x via `@nestjs/platform-fastify`, tracked since
ADR 0016) by upgrading to `@nestjs/*@11.2.3` and Fastify-5-compatible
plugin majors - `pnpm audit --prod` is now clean across every severity.
This script now exits non-zero on any unresolved critical/high finding from
here on, matching that phase's exit criterion ("zero unresolved critical or
high advisories, risk acceptance not permitted") as a permanent gate, not a
one-time check.

```bash
pnpm audit:report
```

## 6. Migration verification

CI's `test` job runs `pnpm test:db:migrate` against a freshly created,
empty `postgres:17-alpine` service container before any test runs - every
migration in `packages/database/prisma/migrations/` is applied from zero on
every single CI run, not just when a migration changes. There is no separate
"migration check" job because this already is one, on every build.

## 7. Cutting a release

1. Confirm every gate in [step 1](#1-before-merging-to-main) is green on the
   commit being released (the merged `main` HEAD, not a local branch).
2. Tag it: `git tag -a vX.Y.Z -m "..."` following semantic versioning - a
   breaking API or database-migration change bumps the major version, a new
   endpoint or optional config bumps minor, a fix bumps patch.
3. Build the four runtime images from that exact commit and tag them with
   the same version (`docker build --target api -t <registry>/gateway-api:vX.Y.Z ...`,
   repeated per target - see `scripts/kubernetes/build-and-load.sh` for the
   full per-target command list used against a local `kind` cluster; swap
   `kind load` for `docker push` to a real registry).
4. Deploy following [`docs/operations/deployment-guide.md`](deployment-guide.md)
   - update the image tag in `infrastructure/kubernetes/*/deployment.yaml`
   (or your own Kustomize overlay) and roll out.
5. Archive that build's `sbom/sbom.cdx.json`, `coverage/summary.json` and
   `security-reports/pnpm-audit.json` alongside the release (the Phase 20
   data room's evidence trail) - all three are gitignored build artifacts,
   never committed to the repository itself.

## 8. Rollback

Every Deployment in `infrastructure/kubernetes/` is a standard Kubernetes
`Deployment` - rolling back is `kubectl rollout undo deployment/<name> -n
gateway` (or re-applying the previous tagged manifests), which reverts to
the previous image while Kubernetes drains in-flight requests using the same
graceful-shutdown handling verified in
[ADR 0019](../decisions/0019-observability.md). A database migration is only
safe to roll back if it was written to be backward-compatible with the
previous release's code (additive columns/tables, no destructive drops in
the same release that also depends on them) - this project has not yet
needed a destructive migration, and none should ship in the same release
that also depends on the new shape, precisely so this rollback stays simple.

## Known limitations, disclosed

- **E2E and load tests are not in this pipeline.** `pnpm test:e2e:web`
  (Playwright, ADR 0017) and `pnpm loadtest` (ADR 0015) both need a fully
  running stack (API + web + database + Redis) and take materially longer
  than the rest of this pipeline; wiring them into `ci.yml` is left as
  follow-up work, tracked here rather than silently dropped. Both already
  run and pass by hand - see the README's Phase 9 roadmap row.
- **Vulnerability scanning is not a hard gate yet** - see
  [section 5](#5-vulnerability-scanning); this is a Phase 17 dependency, not
  an oversight.
- **No real GitHub Actions run exists** - every job above is `act`-verified
  locally (ADR 0023, ADR 0028); a real push is the natural next step once a
  GitHub remote exists, left to the repo owner.
- **`license-check`'s `act` run did not complete** - two attempts both hit
  `registry.npmjs.org` connection failures on the last 1-3 of 673 packages
  during `pnpm install`, after 27 and 15 minutes respectively; see ADR
  0028's evidence section. Its script logic was verified directly instead
  (`pnpm licenses:check`, `pnpm sbom` - both quoted above); a real GitHub
  Actions run, not subject to `act`'s from-scratch-container-per-run
  install cost, is expected to complete normally.
