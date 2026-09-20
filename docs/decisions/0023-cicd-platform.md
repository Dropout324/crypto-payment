# ADR 0023 - CI/CD platform: GitHub Actions, proven locally with `act` (no GitHub remote exists yet)

Status: Accepted
Date: 2026-09-11

## Context

Phase 10 (`README.md#roadmap`) requires "a working
pipeline" that actually runs, not a committed workflow file nobody has
executed - the same "evidence over claims" rule Phase 9.5 violated twice
(ADR 0021). This repository has no git remote and no GitHub repository yet
(`git remote -v` is empty); creating one, authenticating `gh`, and pushing
code to a new or existing GitHub repository is an action with real-world
consequences outside this workspace (a repository under a real account,
visible or push-notifying to that account's other collaborators/settings)
that the operator, not this pass, must authorize. Asked directly, the
decision was: author the GitHub Actions workflow (for the portability
GitHub Actions gives a future reviewer - see
[Milestones and the claims they unlock](../../README.md#roadmap)),
but prove the pipeline logic runs end-to-end *locally*, without creating any
GitHub-hosted resource, using `nektos/act`.

## Decisions

### GitHub Actions, not GitLab CI/Jenkins/CircleCI

GitHub Actions was chosen over the alternatives for one reason that matters
to this project's audience: reviewers and adopters who will run technical due
diligence (`README.md#roadmap`, Phase 20/21). A `.github/workflows/`
file needs nothing beyond a GitHub account to read and re-run - no separate
CI account, no self-hosted runner infrastructure, no vendor lock a new owner
has to unwind. GitLab CI and Jenkins were rejected for the same reason: both
would require the new owner to either adopt a second platform or migrate the
pipeline before they could run it.

### Local proof via `act`, not a real GitHub Actions run

No git remote exists yet, and creating one requires the operator's own
GitHub credentials and produces a real, externally visible artifact (a
repository, possibly billed, under their account) - not something this pass
should do unilaterally. `act` (downloaded directly as a binary release,
`nektos/act` v0.2.89) runs a `.github/workflows/*.yml` file exactly as
written, job-by-job, inside Docker containers that stand in for GitHub's own
hosted runners, using the same `docker`/`actions/checkout`/service-container
semantics the real platform uses - so a green `act` run is evidence the
*workflow itself* is correct (steps, ordering, environment variables, service
containers), with one honest caveat this ADR states plainly: `act`'s runner
image is not byte-for-byte GitHub's hosted `ubuntu-latest` image, and no
push/PR ever touched GitHub's own infrastructure. **This is disclosed, not
hidden**: `README.md`'s Phase 10 row and this ADR both say "workflow authored
and run successfully via `act` locally; not yet run on GitHub's own hosted
infrastructure" rather than claiming a real GitHub Actions run occurred.
Running it for real is a five-minute task the moment a repository exists
(`git remote add`, `git push`) - nothing about the workflow file itself
needs to change to make that transition.

## Addendum - running `act` against this repo requires `--env-file` pointed at an empty file

`act` defaults to reading a file named `.env` from the current directory and
injecting it into every job's environment, taking **precedence over the
workflow's own `env:` blocks** - a deliberate `act` convenience for local
secrets that has no equivalent on a real GitHub Actions runner (GitHub never
auto-loads a repository's `.env` into job env). This repository's real
development `.env` (gitignored, never committed, but present on any
machine that has run the app locally) collided with this directly: a bare
`echo "$TEST_DATABASE_URL"` inside an `act` job printed the *developer's own
local Postgres URL* (`postgresql://postgres@127.0.0.1:5432/gateway_test`,
matching `scripts/dev-postgres.ps1`'s no-Docker setup) instead of the
workflow's own CI-only value, and the real `test` job failed with a Prisma
`P1000` authentication error for user `postgres` as a direct result -
`actions/checkout@v4` under `act` also turned out to `docker cp` the actual
working directory rather than perform a clean `git clone`, which is what
made the real `.env` visible to the container at all.

**Fix**: always invoke `act` with `--env-file` pointed at an empty file, e.g.
`--env-file /tmp/empty.env` (an empty file, not omitting the flag - omitting
it leaves the `.env`-default in place). Every `act` invocation this ADR's
evidence is based on uses this flag. A real GitHub Actions run needs no such
flag and is unaffected - this is purely an artifact of `act`'s local-testing
convenience feature, not a workflow defect.

## Addendum - the `build` job's `apps/web` step is confirmed act-only-broken, not a real defect

Three of `ci.yml`'s four jobs (`lint-typecheck`, `test`, `docker-smoke`) pass
cleanly under `act` (with the `--env-file` fix above); `build` does not, and
this was investigated to a specific, disclosed conclusion rather than left
unexplained.

`pnpm build`'s final step (`apps/web`'s `next build`) fails consistently
under `act`'s `catthehacker/ubuntu:act-latest` runner with `Error occurred
prerendering page "/_global-error" ... TypeError: Cannot read properties of
null (reading 'useContext')`. Three things were tried to isolate the cause:

* **Resource contention** - the same host was running a `kind` cluster with
  eight pods at the time. Scaling those to zero and retrying reproduced the
  identical failure, ruling this out.
* **Node version mismatch** - a diagnostic workflow confirmed
  `actions/setup-node@v4` correctly resolves `node-version: "22"` to a real
  Node 22.x (`v22.23.2`) inside the act container; the `24.19.0` seen
  elsewhere in `act`'s own logs is act's *internal* bootstrap Node for
  running JS-based actions, unrelated to what job steps execute with.
* **A clean local build** (`rm -rf apps/web/.next && pnpm --filter
  @gateway/web build` on this same machine, outside any container) succeeded
  without error, and **the actual production path** - `docker build --target
  web` against `infrastructure/docker/Dockerfile`'s `node:22-alpine`-based
  `build` stage - has succeeded repeatedly throughout this project (Phase
  9.5, and again during this Phase 10 pass) and that exact image is running
  live, healthy, in a real `kind` deployment.

That combination - fails only under one specific third-party Ubuntu-based
`act` runner image, never under the real `node:22-alpine` Docker build path
or a native local build - places this squarely as an environment
incompatibility in `act`'s runner image (or its interaction with this
version of Next.js 16 / React 19's prerendering), not a defect in this
codebase or in the workflow's logic. It is left disclosed rather than
"fixed" by, say, deleting the step: the `build` job as written is correct
GitHub Actions and is expected to pass on a real GitHub-hosted runner - the
`docker-smoke` job's own internal `docker build --target web` (which
performs the equivalent `next build` inside the real Alpine image) already
proves the underlying build succeeds, verified via `act` itself
(`docker-smoke` passed end to end, `=== ALL CHECKS PASSED ===`).

**Honest status**: `lint-typecheck`, `test`, `docker-smoke` are act-verified
green. `build` is unverified under `act` for the reason above and should be
re-checked on the first real GitHub Actions run against an actual `git
push` - not claimed as failing, not claimed as passing, disclosed as
"blocked on an act-specific issue, root-caused, not reproducible in the
equivalent real build path."

## Consequences

* `.github/workflows/ci.yml` is portable the moment a real GitHub remote
  exists - no `act`-specific syntax was introduced into the workflow file
  itself.
* The claim ladder in `README.md#roadmap` and `README.md`
  must say "act-verified locally", never "verified on GitHub Actions", until
  a real push actually happens - see the Phase 10 roadmap row for the exact
  wording and the run transcript this pass produced as evidence.
* Choosing GitHub Actions over a self-hosted alternative (Jenkins, a bare
  script runner) means the pipeline still depends on GitHub's availability
  once a remote does exist - acceptable for a project whose audience is
  expected to already have a GitHub account, and consistent with this
  same ADR's reasoning for choosing GitHub Actions at all.
