# Multi-stage build for every runnable service in the monorepo.
#
# One Dockerfile, one dependency install, several targets. Each service gets its
# own final stage so the image contains only what that service runs.
#
# Build a specific service:
#   docker build -f infrastructure/docker/Dockerfile --target api -t gateway-api .

# =============================================================================
# Base: pnpm on Node 22 LTS
# =============================================================================
FROM node:22-alpine AS base

RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

# OpenSSL is required by Prisma's query engine on Alpine; tini gives us correct
# signal handling so SIGTERM reaches the process and shutdown is graceful.
RUN apk add --no-cache openssl tini

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NODE_ENV=production

WORKDIR /app

# =============================================================================
# Dependencies: cached on lockfile changes only
# =============================================================================
FROM base AS deps

# Every workspace importer in pnpm-lock.yaml must have its package.json here,
# or `--frozen-lockfile` rejects the lockfile as out of date.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/blockchain-monitor/package.json ./apps/blockchain-monitor/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY packages/security/package.json ./packages/security/
COPY packages/observability/package.json ./packages/observability/
COPY packages/signing/package.json ./packages/signing/
COPY packages/blockchain/package.json ./packages/blockchain/
COPY packages/ledger/package.json ./packages/ledger/
COPY packages/payments/package.json ./packages/payments/
COPY packages/exchange-rate/package.json ./packages/exchange-rate/
COPY packages/webhooks/package.json ./packages/webhooks/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# =============================================================================
# Build: compile TypeScript and generate the Prisma client
# =============================================================================
FROM deps AS build

# Next.js inlines every `process.env.NEXT_PUBLIC_*` reference into the client
# bundle at `next build` time (ADR 0024's addendum) - there is no way to
# change it afterwards short of rebuilding. Defaulting the ARG to the
# existing hardcoded fallback keeps every build invocation that doesn't pass
# it (api/worker/monitor targets; a `web` build with no override) bit-for-bit
# identical to before, so this is additive, not a behavior change, until
# someone deliberately overrides it:
#   docker build --target web --build-arg NEXT_PUBLIC_API_URL=https://api.example.com ...
# See docs/operations/deployment-guide.md for when and how to do that per
# environment.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

COPY . .

RUN pnpm --filter @gateway/database generate \
 && pnpm build

# =============================================================================
# Debug: `build`, given a name of its own. DevDependencies (tsx, vitest, ...)
# are still present - for manually running a script or a shell against a real
# build inside the same environment the image runs in (`docker build --target
# debug -t gateway-debug . && docker run --rm -it gateway-debug sh`), and what
# docker-compose's dev services (bind-mounted source, `pnpm ... dev`) build
# from - they need the devDependencies a runtime target below deliberately
# does not carry.
# =============================================================================
FROM build AS debug

# =============================================================================
# Deploy stages: one per runtime target. `pnpm deploy --prod` isolates a
# single workspace project - itself plus its own transitive prod dependency
# graph only - into a self-contained, non-monorepo directory. See ADR 0021
# for why this replaced a single shared `pnpm prune --prod` stage: prune
# prompts for confirmation with no stdin to answer it (the build hangs
# forever), and even bypassed, pruning at the workspace root deleted every
# workspace project's own dependency symlinks, not just devDependencies -
# every runtime target crashed on `Cannot find module` before reaching its
# database. `deploy` never touches the shared workspace linking; it does a
# fresh, isolated install scoped to one project.
#
# `--config.confirm-modules-purge=false` is required for the same reason
# `pnpm install` needed it in `deps`: deploy's own fresh install of the
# isolated directory asks the same "remove and reinstall from scratch?"
# question, and a `docker build` step has no stdin to answer it with.
#
# `--prefer-offline` (see ADR 0021's Phase 10 addendum on the build-time
# network dependency): without it, `deploy`'s own fresh install re-resolves the
# dependency graph against the npm registry even though every package's
# tarball is already in the `deps` stage's pnpm store - a real build hit
# npm registry timeouts mid-`deploy` (`ETIMEDOUT`/`ENETUNREACH` on
# unrelated packages like `source-map-js`) and failed outright. `--offline`
# was tried first and rejected: pnpm's legacy deploy mode re-resolves
# semver-range dependencies (e.g. `@types/node@^22.10.5`) against registry
# *metadata*, not just package tarballs, and that metadata was never cached
# during `deps`'s own `--frozen-lockfile` install (a frozen-lockfile install
# trusts the lockfile's already-resolved versions and skips metadata
# resolution entirely) - `--offline` fails immediately with
# `ERR_PNPM_NO_OFFLINE_META` on the first such range. `--prefer-offline`
# uses the store when it can but still allows a metadata fetch when
# genuinely needed, which is correct for this repo's fully-frozen
# lockfile - it does not eliminate the registry dependency, only avoids
# forcing a fetch pnpm would otherwise skip. Real network access to
# registry.npmjs.org remains a build-time requirement of this Dockerfile;
# CI must have it (GitHub-hosted runners do).
#
# `deploy`'s own reinstall cannot regenerate a working Prisma client: its
# postinstall script looks for `prisma/schema.prisma` relative to the deploy
# root, but the schema lives nested inside `node_modules/.../@gateway/database/
# prisma/` there, so it silently produces an empty stub instead (see ADR
# 0021). Each deploy stage below stashes the client `build` already
# generated correctly to a location outside node_modules *before* running
# `deploy` - `deploy` computes its own isolated dependency graph by
# re-walking and rewriting this same shared node_modules tree, and observed
# behavior is that the generated (not lockfile-tracked) `.prisma/client`
# does not reliably survive that; stashing first removes any dependency on
# what state deploy happens to leave node_modules in. The second RUN then
# overwrites every stub `deploy` produced with the stashed client, and
# fails loudly (rather than with a bare `cp: cannot stat`) if the stash is
# somehow missing.
# =============================================================================

FROM build AS deploy-api
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @gateway/database generate && \
    real="$(find /app/node_modules -type d -path '*/node_modules/@prisma/client' | head -1)/../../.prisma/client" && \
    test -d "$real" && \
    cp -r "$real" /tmp/prisma-client && \
    pnpm --filter @gateway/api deploy --prod --legacy --prefer-offline --config.confirm-modules-purge=false /out
RUN set -eu; \
    test -d /tmp/prisma-client || { echo "FATAL: stashed Prisma client missing" >&2; exit 1; }; \
    find /out/node_modules -type d -path '*/node_modules/@prisma/client' | while read -r stub; do \
      rm -rf "$stub/../../.prisma"; \
      mkdir -p "$stub/../../.prisma"; \
      cp -r /tmp/prisma-client "$stub/../../.prisma/client"; \
    done

FROM build AS deploy-worker
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @gateway/database generate && \
    real="$(find /app/node_modules -type d -path '*/node_modules/@prisma/client' | head -1)/../../.prisma/client" && \
    test -d "$real" && \
    cp -r "$real" /tmp/prisma-client && \
    pnpm --filter @gateway/worker deploy --prod --legacy --prefer-offline --config.confirm-modules-purge=false /out
RUN set -eu; \
    test -d /tmp/prisma-client || { echo "FATAL: stashed Prisma client missing" >&2; exit 1; }; \
    find /out/node_modules -type d -path '*/node_modules/@prisma/client' | while read -r stub; do \
      rm -rf "$stub/../../.prisma"; \
      mkdir -p "$stub/../../.prisma"; \
      cp -r /tmp/prisma-client "$stub/../../.prisma/client"; \
    done

FROM build AS deploy-monitor
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @gateway/database generate && \
    real="$(find /app/node_modules -type d -path '*/node_modules/@prisma/client' | head -1)/../../.prisma/client" && \
    test -d "$real" && \
    cp -r "$real" /tmp/prisma-client && \
    pnpm --filter @gateway/blockchain-monitor deploy --prod --legacy --prefer-offline --config.confirm-modules-purge=false /out
RUN set -eu; \
    test -d /tmp/prisma-client || { echo "FATAL: stashed Prisma client missing" >&2; exit 1; }; \
    find /out/node_modules -type d -path '*/node_modules/@prisma/client' | while read -r stub; do \
      rm -rf "$stub/../../.prisma"; \
      mkdir -p "$stub/../../.prisma"; \
      cp -r /tmp/prisma-client "$stub/../../.prisma/client"; \
    done

FROM build AS deploy-web
# No @gateway/database dependency - no Prisma client to fix up.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @gateway/web deploy --prod --legacy --prefer-offline --config.confirm-modules-purge=false /out

# =============================================================================
# Runtime base: unprivileged, minimal
# =============================================================================
FROM base AS runtime

# The `node` user ships with the image; never run a payment service as root.
USER node
ENTRYPOINT ["/sbin/tini", "--"]

# =============================================================================
# API
# =============================================================================
FROM runtime AS api

COPY --from=deploy-api --chown=node:node /out ./

EXPOSE 4000 9464
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]

# =============================================================================
# Worker: webhooks, settlement, expiry, reconciliation
# =============================================================================
FROM runtime AS worker

COPY --from=deploy-worker --chown=node:node /out ./

EXPOSE 9465
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||9465)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]

# =============================================================================
# Blockchain monitor
# =============================================================================
FROM runtime AS monitor

COPY --from=deploy-monitor --chown=node:node /out ./

EXPOSE 9466
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MONITOR_HEALTH_PORT||9466)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]

# =============================================================================
# Web: merchant dashboard, admin dashboard, hosted payment page
# =============================================================================
FROM runtime AS web

COPY --from=deploy-web --chown=node:node /out ./

EXPOSE 3000 9467
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
