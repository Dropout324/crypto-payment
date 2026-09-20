# ADR 0028 - CI/CD gates and release process: coverage, SBOM, licence check, informational vulnerability scan, and proof that a broken build is actually blocked

Status: Accepted
Date: 2026-09-12

## Context

Phase 15 (C5, `README.md#roadmap`) owns what Phase 10's CI
baseline (ADR 0023) explicitly deferred: "coverage reporting, SBOM,
vulnerability scanning, a documented release process". Phase 10 proved the
pipeline's four original jobs (`lint-typecheck`, `build`, `test`,
`docker-smoke`) run correctly via `act`; this phase adds the remaining gate
breadth and - the phase's own exit criterion - proves with a real run that a
deliberately broken change is actually blocked, not just assumed to be
because the jobs exist.

## Decisions

### Coverage: instrumented, published, not gated on a minimum

`@vitest/coverage-v8@^3.0.5` (matching the pinned `vitest@^3.0.5`) is a new
root devDependency, resolved by each of the 13 vitest-using
packages/apps via Node's normal upward `node_modules` resolution - the same
pattern `eslint.config.base.mjs` already established for sharing lint
config across the workspace without duplicating the dependency in every
project. Each project's `vitest.config.ts` now imports one shared
`coverage` object from `vitest.coverage.base.mjs` (provider `v8`, reporters
`text`/`json-summary`/`lcov`), added via `coverage: coverage` in its `test`
block rather than a parallel v8-specific config file. Every project gained a
`test:coverage` script (`vitest run --coverage`) alongside its existing
`test`; the plain `test`/`test:unit` scripts, and everything that calls
them (including local development), are unaffected - instrumentation only
runs when `--coverage` is passed.

`scripts/test/aggregate-coverage.mjs` combines every project's own
`coverage/coverage-summary.json` into one repo-wide, line-weighted number,
run after `pnpm test:coverage` (it does not run tests itself). CI's `test`
job runs `pnpm test:coverage` in place of the old `pnpm test`, then the
aggregator, then uploads `coverage/summary.json` as a build artifact.

**No enforced minimum percentage.** A floor invites tests written to move
the number rather than catch regressions - the point here is a baseline a
reviewer can see and track, per the
roadmap's own Phase 15 exit criterion ("coverage baseline measured and
published"), not a new merge gate this phase was not asked to add.

### SBOM: a real CycloneDX document, generated in-house rather than adding a generator dependency

`scripts/sbom/generate-sbom.mjs` emits a CycloneDX 1.5 JSON document
(`sbom/sbom.cdx.json`) built from `pnpm licenses list --json --prod`.
`@cyclonedx/cyclonedx-npm` was considered and rejected: it expects an npm
`package-lock.json`, not a pnpm lockfile, and a pnpm-compatible alternative
(`cdxgen`) would be one more unaudited third-party tool this project runs
exactly once per build, for output this project can already assemble
directly from data `pnpm` itself provides. The generated document uses real
CycloneDX fields (`bomFormat`, `specVersion`, `components[].purl`,
`licenses`) so any tooling that reads CycloneDX can ingest it
without a translation step - verified locally: 241 components across 8
licence families, matching `pnpm licenses list`'s own count exactly.

### Licence check: a real, immediately-enabled gate

`scripts/licenses/check-licenses.mjs` runs the same `pnpm licenses list
--json --prod` and fails the build the moment any production dependency's
licence falls outside an allowlist of the 8 families the project's own
Phase 29 inventory already found (MIT, Apache-2.0, ISC, BSD-2/3-Clause,
0BSD, CC-BY-4.0, and one "Apache-2.0 AND LGPL-3.0-or-later" entry, all
already reviewed as non-blocking in the readiness roadmap's
Phase 29 section). Unlike vulnerability scanning (below), this was safe to
make a hard, blocking gate immediately: every one of the 212 current
production dependencies (measured at the time of this pass -
`@vitest/coverage-v8`, added above, shifted the resolved tree by one package
from the 211 the Phase 29 section originally counted) already passes it, so
turning it on today changes nothing about the current build and only starts
catching the *next* dependency that doesn't belong.

### Vulnerability scanning: real, reported, deliberately not blocking yet

`scripts/security/audit-report.mjs` runs `pnpm audit --prod --json` - the
same tool ADR 0016/0025 already used by hand to arrive at "17 production
dependency advisories (1 critical, 9 high)" - and writes
`security-reports/pnpm-audit.json`. Verified locally at the time of this
pass: 1 critical, 9 high, 6 moderate, 1 low (17 total), matching the by-hand
count this project has cited before exactly.

This step always exits `0` and its CI job carries `continue-on-error: true`
- deliberately not a hard gate, and not silently omitted either. The
project's own M1 gate table already assigns "zero unresolved critical or
high production dependency advisories, risk acceptance not permitted" to
**Phase 17 pass 1**, which is not done yet (the known Fastify 4.x advisories
bundled by `@nestjs/platform-fastify` remain open, tracked since ADR 0016).
Making this script fail the build today would fail every build for a gap
Phase 15 does not own fixing, which is worse than not scanning at all -
teams learn to ignore a check that is always red. Flipping it to a hard
gate once Phase 17 pass 1 closes is a one-line change (delete the "always
exit 0" comment and its early return), called out explicitly in
`docs/operations/release-process.md`.

### `docker-smoke`'s gating jobs: `license-check` added, `vulnerability-scan` deliberately not

`docker-smoke`'s `needs` grew from `[lint-typecheck, build, test]` to
`[lint-typecheck, build, test, license-check]` - `vulnerability-scan` was
deliberately left out, matching its `continue-on-error: true` status above.
A `continue-on-error` job would not actually block `needs` even if it were
listed, but leaving it out of `needs` documents the intent rather than
relying on that GitHub Actions behavior being understood by whoever reads
the workflow next.

## Evidence: a deliberately broken change actually blocks the pipeline

Per the roadmap's Rule 1 ("evidence over claims - a phase closes only after
an independent re-audit that runs the system") and this phase's own exit
criterion, a real deliberate failure was introduced and run through `act`,
not just asserted to work because `needs:` exists in the YAML.

**Change**: a bare `console.log("DELIBERATE_CI_FAILURE_TEST_PHASE15");`
appended to `packages/shared/src/index.ts` - a real violation of this
codebase's `no-console: 'error'` ESLint rule (`eslint.config.base.mjs`,
enforcing README principle 8, "secrets are never logged", which depends on
every log line going through the shared logger, never bare `console`).

**Run**: `act push -j lint-typecheck --env-file <empty>` (the empty env
file is required per ADR 0023's own addendum, to stop `act`'s local
`.env`-autoload from leaking this machine's real dev secrets into the
job). Real output, `catthehacker/ubuntu:act-latest`, this machine:

```
packages/shared lint: /mnt/c/.../packages/shared/src/index.ts
packages/shared lint:   13:1  error  Unexpected console statement  no-console
packages/shared lint: ✖ 1 problem (1 error, 0 warnings)
packages/shared lint: Failed
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @gateway/shared@0.1.0 lint: `eslint .`
Exit status 1
 ELIFECYCLE  Command failed with exit code 1.
[CI/lint-typecheck] ❌  Failure - Main pnpm lint [2m38s]
[CI/lint-typecheck] exitcode '1': failure
[CI/lint-typecheck] 🏁  Job failed
Error: Job 'lint-typecheck' failed
```

`act` exited 1. Because `docker-smoke` (the job that actually builds and
smoke-tests the four runtime images - the thing that would ship) declares
`needs: [lint-typecheck, ...]`, GitHub Actions' own job-dependency semantics
mean it never starts when `lint-typecheck` fails - a deliberately broken
change is blocked before a single deployable artifact is built. The
deliberate `console.log` was reverted immediately after this run;
`git diff packages/shared/src/index.ts` is empty as of this ADR.

**Disclosed, not hidden**: this run's `pnpm install --frozen-lockfile` step
alone took 31 minutes due to sustained `ECONNRESET` retries against
`registry.npmjs.org` from inside the `act` container (visible in the
transcript above the failure) - a real-world registry-flakiness cost, not a
defect in this workflow, consistent with ADR 0021's addendum noting the
same registry dependency during Docker builds. The three new jobs this ADR
adds (`license-check`, `vulnerability-scan`, and the modified `test` job's
coverage step) were each verified by running their underlying script
directly (`pnpm licenses:check`, `pnpm sbom`, `pnpm audit:report`,
`pnpm test:coverage`) against this machine's real dependency tree - each
one's output is quoted inline in `docs/operations/release-process.md` and
above.

**`license-check`'s own `act` run: attempted twice, not completed, disclosed
rather than claimed.** `act push -j license-check` was run twice to get the
same end-to-end proof `lint-typecheck` got above. Both attempts got through
`pnpm install --frozen-lockfile` almost entirely (672/673, then 670/673
packages) before a final package (`react-is@16.13.1`, then
`@types/react-dom@19.3.0`) failed with `ECONNRESET`/"socket hang up" against
`registry.npmjs.org`, exhausting pnpm's retry budget after 27 and 15 minutes
respectively - the same class of registry flakiness ADR 0021's addendum and
the `lint-typecheck` run above both already hit, just landing on the last
package instead of an earlier one both times. Per this project's own
guidance against retrying a failing command in a loop hoping for a different
result, a third attempt was not made. `license-check`'s job logic itself
never got a chance to run in either attempt - the failure was entirely in
dependency installation, identical in form to the already-`act`-proven
`lint-typecheck`/`build`/`test` jobs' own install step. Direct local
verification of `scripts/licenses/check-licenses.mjs` and
`scripts/sbom/generate-sbom.mjs` (above, and quoted in
`docs/operations/release-process.md`) stands as this job's evidence instead;
a real GitHub Actions run - unaffected by `act`'s from-scratch container
per invocation - is the natural way to close this out fully, consistent
with how ADR 0023 already left the `build` job's final act-only gap.

## Consequences

* Coverage, SBOM and vulnerability-report artifacts are gitignored
  (`/coverage/`, `/sbom/`, `/security-reports/`) - generated per build, not
  committed, consistent with how this project already treats `dist/` and
  `.next/`.
* The M1 gate item "a deliberately failing change was blocked from
  deployment; runtime images smoke-tested in CI" (Phase 15) now has direct
  evidence, not an inference from the workflow file's syntax.
* Phase 17 pass 1 remains the phase that turns `vulnerability-scan` into a
  hard gate - this ADR does not change that phase's scope or pull its work
  forward.
* Phase 20's data room gains three new evidence artifacts it can cite
  directly: `coverage/summary.json`, `sbom/sbom.cdx.json`, and
  `security-reports/pnpm-audit.json`.
