# ADR 0021 - Docker runtime images: `pnpm deploy --prod` per target, not a shared `pnpm prune --prod` stage

Status: Accepted
Date: 2026-09-11

## Context

Phase 9.5 (ADR 0019/0020) claimed all four Docker runtime targets
(`api`/`worker`/`monitor`/`web`) built and worked. Neither was true. A later
audit that actually ran the runtime images - not just `docker build`, which
is not evidence a container works - found two independent, compounding
failures in `infrastructure/docker/Dockerfile`'s shared `runtime-deps` stage
(`FROM build AS runtime-deps` → `RUN pnpm prune --prod`):

1. **The build hung forever.** `pnpm prune --prod` prints "The modules
   directories will be removed and reinstalled from scratch. Proceed?
   (Y/n)" and waits on stdin. `docker build` gives a `RUN` step no stdin, so
   the step blocked indefinitely - confirmed directly: Docker Desktop's own
   VM sat at 0.00% CPU for the whole hang, and the same command run in a
   disposable container was still waiting when a 90-second `timeout` killed
   it (exit 143).
2. **Bypassed (`--config.confirm-modules-purge=false`), the image still
   didn't work.** `pnpm prune --prod`, run at the workspace root, does not
   scope itself to the root importer - it recomputes linking for the whole
   workspace and, in doing so, deleted every OTHER workspace project's own
   `node_modules` symlinks too, not just devDependencies: `apps/web`'s link
   to `next`, `apps/worker`'s link to `@gateway/database`, `apps/api`'s link
   to `@nestjs/core`, `packages/database`'s link to `@prisma/client` were all
   gone after prune. Every runtime target crashed with `Cannot find module`
   before the process ever reached a database or Redis connection.

The live SIGTERM verification ADR 0019 cited as evidence graceful shutdown
worked was run against the `debug` target - `build`, given a name of its
own, which deliberately skips `pnpm prune --prod` entirely (see the
Dockerfile's comment on `debug`, predating this ADR). That test was real and
its finding (`RedisLifecycle.onModuleDestroy()`'s synchronous throw) was a
real bug worth fixing, but it verified the application's shutdown *code*,
not the runtime *image* - the two had already diverged by the time that test
ran, and nothing had run the runtime image itself since.

## Decisions

### `pnpm deploy --prod --legacy`, one stage per runtime target, not one shared prune stage

`pnpm deploy` isolates a single workspace project - itself plus its own
transitive prod-only dependency graph, nothing else - into a self-contained,
non-monorepo directory. Given `@gateway/api`, it resolves and copies exactly
what `apps/api` needs (walking through `@gateway/database`,
`@gateway/security`, `@nestjs/core`, `reflect-metadata`, `@node-rs/argon2`,
...) without touching or needing to understand any other workspace
project's own dependency graph. This is the property `prune` was supposed
to have and didn't: `deploy` never recomputes linking for the whole
workspace, so it cannot delete a sibling project's symlinks as a side
effect. Four small, target-specific stages (`deploy-api`, `deploy-worker`,
`deploy-monitor`, `deploy-web`) replaced the single shared `runtime-deps`
stage; each final stage (`api`/`worker`/`monitor`/`web`) now `COPY
--from=deploy-<x>` the entire self-contained output directly, rather than
assembling `node_modules`/`packages`/`apps/<x>` by hand from a shared prune
result.

`--legacy` (equivalently, `inject-workspace-packages=true`) is required:
pnpm 10's default `deploy` implementation refuses to run against a
workspace unless one of these is set. `--config.confirm-modules-purge=false`
is required for the same reason `deps`'s `pnpm install --frozen-lockfile`
needed it - `deploy`'s own fresh install of the isolated target directory
asks the identical "remove and reinstall from scratch?" question `prune`
did, and a `RUN` step has no stdin to answer it with either.

### The Prisma client: stash it from `build` before `deploy` runs, don't trust `deploy`'s own regeneration

`deploy`'s isolated reinstall re-triggers `@prisma/client`'s postinstall
hook, which searches for `prisma/schema.prisma` relative to the deploy
root - but the schema lives nested inside
`node_modules/.../@gateway/database/prisma/` in that tree (deploy has no
"files" field to trim what it copies, so the whole `packages/database`
source tree, schema included, comes along - just not at a path the
postinstall auto-detection looks at). The result is a **silent** stub
client with no engine and no generated model types, not an install failure -
nothing about `pnpm deploy`'s own output or exit code indicated anything
was wrong.

Two things were tried and rejected before landing on the stash:

* **Re-running `pnpm --filter @gateway/database generate` inside the deploy
  stage, immediately before `deploy`, trusting its output to still be there
  after `deploy` runs.** This was the first fix attempted and it reproduced
  the exact same missing-client failure on every retry (three independent
  builds, byte-identical failure each time) - `deploy`'s own dependency-graph
  reconciliation over the shared `node_modules` tree does not reliably leave
  a dynamically-generated, not-lockfile-tracked directory
  (`node_modules/.prisma/client`, a sibling of `@prisma/client`, not a
  descendant of it) intact. Root cause aside, depending on `deploy`'s
  internal side effects on a directory it has no reason to know about is
  fragile by construction.
* **Running `prisma generate` again inside the deploy tree, using whatever
  `prisma` CLI ends up there.** Rejected: `pnpm deploy --prod` does not
  carry `prisma` (a devDependency) into the isolated output at all -
  confirmed directly (`find` turned up nothing under the deploy tree's
  `node_modules` for it) - so there is no CLI there to invoke.

The fix that stuck: **copy the already-correctly-generated client
(`packages/database/prisma/schema.prisma` was already run once, earlier, in
the shared `build` stage) to a location outside any `node_modules` tree
(`/tmp/prisma-client`) *before* invoking `deploy`**, then after `deploy`
produces its stub, overwrite every `.prisma/client` `deploy` created with
that stashed copy. This has no dependency on what `deploy` does or does not
preserve in `node_modules` - the source of truth lives somewhere `deploy`
never looks. (The actual bug that made the first three attempts fail was
separately found and fixed too, independent of switching to a stash: the
path arithmetic locating `.prisma/client` from `.../node_modules/@prisma/client`
was off by one `..` - `@prisma/client` is a *two*-segment path, so reaching
its sibling `.prisma` at the `node_modules` level needs `../../.prisma/client`,
not `../.prisma/client`, which stayed trapped one level too deep inside
`@prisma/`. Both fixes - the stash, and the corrected path - are kept:
the corrected path made the bug reproducible-and-fixable at all; the stash
makes the whole mechanism independent of `deploy`'s internal behavior on a
directory it has no reason to preserve.)

### `docker-compose.yml`'s dev services now build the `debug` target, not the runtime targets

`docker-compose.yml`'s `api`/`worker`/`blockchain-monitor`/`web` services
bind-mount source and run `pnpm --filter <x> dev` (`tsx watch` /
`next dev`) - both need devDependencies (`tsx`, `next`'s own dev tooling)
that a runtime target, by design, no longer carries after this pass (it
never carried them correctly before this pass either, but for the wrong
reason - see Context). Pointing these services at `debug` (`build`, given a
name of its own, full devDependencies, full monorepo layout, no `USER
node`/no `ENTRYPOINT tini`) is what actually matches what the bind-mount +
`dev` command combination needs; a runtime target was never the right
target for these services even before the `deploy` change, since `dev`
requires devDependencies no runtime stage has ever intentionally carried.

## Consequences

* All four runtime images build from a cold cache without hanging (verified
  with `--no-cache`) and, once running from their own image's own CMD as the
  `node` user, answer their health/readiness/metrics endpoints; `api`'s
  login round-trips through `@node-rs/argon2` and a real Prisma query;
  `SIGTERM` drains in-flight work and exits 0. `scripts/docker/smoke-test.mjs`
  runs and checks all of this on demand - Phase 10's CI is the next caller,
  but nothing further has to be built for it to have this to call.
* A second, independent bug surfaced by *actually* running the graceful-shutdown
  test against a runtime image rather than `debug`: `apps/api/src/main.ts`
  called `app.enableShutdownHooks()` with no arguments, believing (per its
  own comment) that this attached no signal listeners of Nest's own. NestJS's
  implementation does the opposite - an empty/omitted `signals` array is
  read as "listen for every `ShutdownSignal`". This created a second,
  competing `SIGTERM` handler: Nest's own cleanup (`callDestroyHook()`,
  i.e. `onModuleDestroy` on every provider) ran in parallel with and faster
  than `main.ts`'s own drain-then-close sequence, then re-raised the same
  signal via `process.kill(process.pid, signal)` once done - which
  `main.ts`'s `process.once('SIGTERM', ...)`, already fired and self-removed
  on the first delivery, no longer caught. Node's default disposition for
  that second, now-unhandled delivery terminated the process outright (exit
  143, no "shutdown complete" log line - reproduced identically whether the
  signal came via `docker kill` through tini or `kill -TERM` sent directly
  to the Node PID, ruling out a tini/signal-forwarding explanation before
  landing on this one). Removed the call: `app.close()` already runs every
  destroy/shutdown hook on its own regardless of whether
  `enableShutdownHooks()` was ever invoked - that method exists purely to
  wire OS signals to an automatic `close()`, which is exactly what
  `main.ts`'s own handlers already do by hand.
* Each runtime image now carries more than the strict minimum a production
  image would want - `pnpm deploy` has no "files"-field-driven trimming to
  lean on (none of this repo's `package.json`s declare one), so a deployed
  package's `test/`, `src/` (alongside its compiled `dist/`), and config
  files (`vitest.config.ts`, `tsconfig.json`) come along too. None of it is
  sensitive (no secrets, no host artifacts - `.dockerignore` still keeps
  `.env`/`.pgdata`/host `node_modules` out of the build context entirely,
  unchanged by this ADR) and none of it is wrong, just not minimal. Adding
  `"files"` arrays to trim deploy output is reasonable follow-up work, not
  done here - out of scope for a pass whose job was making the images work
  at all.
* Not covered by this pass: reducing image size further, a non-root
  `USER` inside `debug` (unchanged - `debug` is explicitly a development/
  debugging target, never what ships), or wiring `scripts/docker/smoke-test.mjs`
  into CI (Phase 10's job, once CI exists to wire it into).

## Addendum (Phase 10) - the build-time network dependency this ADR left open, now tested

This ADR's own Context section named a real risk without testing it: `pnpm
deploy --prod` needs network access to `registry.npmjs.org` on every build,
even though every dependency's tarball already sits in the `deps` stage's
pnpm store. Phase 10's Kubernetes work hit this directly - a real
`docker build --target monitor` failed mid-`deploy` with `ETIMEDOUT`/
`ENETUNREACH` against unrelated packages (`source-map-js`,
`hdr-histogram-js`, several `@img/sharp-*` platform variants) after
resolving over 380 packages successfully, i.e. a transient registry
timeout, not a missing dependency.

Two mitigations were tried:

* **`--offline`** ("fail on a cache miss instead of fetching from the
  registry, using only packages already in the store") was tried first and
  **rejected** - it fails immediately, deterministically, on the very first
  build attempted with it:
  `ERR_PNPM_NO_OFFLINE_META  Failed to resolve @types/node@>=22.10.5 <23.0.0-0
  in package mirror .../registry.npmjs.org/@types/node.json`. The root cause:
  pnpm's legacy deploy mode re-resolves every semver-range dependency (a
  workspace `package.json` written as `^22.10.5`, not a lockfile-pinned exact
  version) against registry **metadata**, not just tarball content -  and
  that metadata was never fetched during `deps`'s own
  `pnpm install --frozen-lockfile`, which trusts the lockfile's
  already-resolved versions and skips metadata resolution by design. No
  amount of the store already having the right tarball helps `--offline`
  when what's missing is the metadata document describing which tarball a
  range resolves to.
* **`--prefer-offline`** ("prefer packages already in the cache over the
  network, even past their freshness window") was tried second and adopted:
  it does not eliminate the registry dependency (a fetch still happens when
  genuinely needed, e.g. that same metadata lookup), so it is not a fix for
  a total network outage - but it removes freshness-driven revalidation
  requests for anything the store already has confidently resolved, which is
  most of this fully-frozen-lockfile build. All four `deploy-*` stages in
  `infrastructure/docker/Dockerfile` now pass it.

**Conclusion, stated plainly for whoever reads this next**: `pnpm deploy
--prod` against this repository's workspace has an irreducible network
dependency on `registry.npmjs.org` for metadata resolution - there is no
flag that makes the build fully offline while `--legacy`/
`inject-workspace-packages=true` deploy mode is required (ADR 0021's main
decision, unchanged - non-legacy `deploy` refuses to run against a
workspace at all). CI and any other automated build of these images must
have real, reliable network egress to the npm registry; a build that fails
with `ETIMEDOUT`/`ENETUNREACH` mid-`deploy` is a transient registry/network
issue, not a broken image, and should simply be retried - `--prefer-offline`
lowers how often that happens without pretending to remove the dependency.
