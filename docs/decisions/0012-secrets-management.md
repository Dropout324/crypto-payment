# ADR 0012 - Secrets management: a `SecretsProvider` seam, not a KMS integration

Status: Accepted
Date: 2026-09-10

## Context

Phase 8's remaining "secrets management" item, per the README roadmap, is
that `ENCRYPTION_KEY` and every other secret this API depends on
(`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`, `REDIS_URL`,
`COINGECKO_API_KEY`) were read directly from `process.env` inside
`apps/api/src/config/env.ts`'s `loadConfig()`, with no seam for a real
secrets backend (AWS Secrets Manager, GCP Secret Manager, Vault) to plug
into later.

This is a narrower problem than it first looks, because half of it already
had a seam: `@gateway/security`'s `KeyProvider` (`encryption.ts`) already
abstracts "which raw key bytes encrypt/decrypt webhook secrets and TOTP
seeds, with rotation by key id" behind an interface, with `EnvKeyProvider` as
the only implementation and an explicit comment that a KMS/HSM-backed one is
the production target. That interface is intentionally left alone by this
ADR - it solves a different, narrower problem (envelope/data-encryption key
material with rotation) than the one addressed here (arbitrary named
secrets, read once at boot).

## Decision

Added `SecretsProvider` (`packages/security/src/secrets-provider.ts`):

```ts
interface SecretsProvider {
  getSecret(name: string): string | undefined;
  requireSecret(name: string): string;
}
```

`EnvSecretsProvider` is the only implementation shipped: it wraps
`process.env`, preserving today's behavior exactly. `loadConfig()` now takes
an optional second argument, `secrets: SecretsProvider = new
EnvSecretsProvider(env)` - every existing call site (`loadConfig()`, no
arguments) is unaffected, and the six actual secrets above now go through
`secrets.requireSecret(...)`/`secrets.getSecret(...)` instead of reading
`env` directly. Non-secret config - ports, TTLs, feature flags, the
`ENCRYPTION_KEY_ID` *label* (as opposed to the key material itself) - stays
a plain env read, because treating configuration as a secret just to reuse
one interface would blur a distinction worth keeping.

**What this deliberately does not do**: implement a KMS/Vault-backed
`SecretsProvider`. This codebase has no AWS/GCP/Vault account to
integration-test against, and shipping an untested cloud integration is
worse than the honest gap it would appear to close - it would look done
without being verified. The seam is complete and swappable
(`loadConfig(env, myKmsBackedProvider)`); the production implementation is
deferred until there is a real target to build and test it against, exactly
the posture `KeyProvider` already took for the same reason.

## Consequences

* Swapping secrets backends in production is a one-line change at the
  `loadConfig()` call site in `bootstrap.ts`, not a search-and-replace across
  every place a secret is read.
* `packages/security/test/secrets-provider.test.ts` covers
  `EnvSecretsProvider` directly; `apps/api/test/env-secrets.test.ts` proves
  `loadConfig()` actually uses an injected `SecretsProvider` rather than
  falling back to `env` silently.
* `KeyProvider` (data-encryption keys) and `SecretsProvider` (named secrets)
  remain two separate interfaces on purpose - conflating them would force a
  KMS integration to implement key-rotation-by-id semantics it may not need
  just to satisfy an interface built for a different job.
