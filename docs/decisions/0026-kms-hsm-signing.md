# ADR 0026 - KMS/HSM signing: durable approvals, an audit trail, and an emulated-HSM reference backend

Status: Accepted
Date: 2026-09-12

## Context

Phase 12 (`README.md#roadmap`) picks up where ADR 0013
left off. That ADR built the policy engine
(`PolicyEnforcingSigningService`) and explicitly did not build: a real
signing backend, durable storage for `ApprovalStore`/`SpendTracker`, an
audit trail, or any application wiring. The gap it left open - no cloud
KMS/HSM account exists in this environment to integrate and test a real
signer against - still holds. This phase closes everything else on the
exit-criteria list without pretending to close that one.

Mode A (custodial signing) is **not live** as a result of this phase, and
nothing here makes it live. `README.md#roadmap`'s Open
decision #4 - whether custody is in scope at all - remains
open. This ADR only makes the *architecture* real, auditable and
restart-durable, so a technical review has something concrete to
evaluate instead of an unwired library.

## Decisions

### The `HsmKeyStore` seam, not just `SigningBackend`

`SigningBackend.sign(request)` (ADR 0013) is the transaction-signing seam.
It says nothing about key *lifecycle* - generation, rotation, retrieving a
public key - because a real KMS/HSM exposes that as its own API surface,
independent of any chain's transaction format. `HsmKeyStore`
(`packages/signing/src/hsm-key-store.ts`) fills that gap:
`generateKey`/`getPublicKey`/`sign`/`rotateKey`, every method taking or
returning a `keyId` or a public key - never a private key. The shape
mirrors AWS KMS's asymmetric `ECC_SECG_P256K1` key spec and
`Sign`/`GetPublicKey` operations (and GCP KMS's / a PKCS#11 HSM's
equivalent), so a real adapter for any of them implements this same
interface with no redesign.

**`EmulatedHsmKeyStore`** is the only implementation shipped - a software
emulation of an HSM's key isolation, explicitly labelled *simulated*, in
the same fail-closed spirit as `DisabledSigningBackend`. It uses Node's
built-in `crypto` module (`generateKeyPairSync('ec', { namedCurve:
'secp256k1' })`, `crypto.sign`/`crypto.verify`) - no new dependency, and the
same curve AWS/GCP KMS use for this key type, so a signature this store
produces has the identical shape (DER-encoded ECDSA) a real backend's
output would have. Private key material lives only in a true ES `#private`
class field - not TypeScript `private`, which is erased at compile time and
still reachable via bracket notation or `JSON.stringify`. No method, on any
path including errors, returns, logs or serializes it.
`packages/signing/test/hsm-key-store.test.ts` asserts this directly:
`JSON.stringify`, `util.inspect(..., { showHidden: true })` and
`Object.getOwnPropertyNames` on a live store never surface key bytes, and a
produced signature verifies against the matching public key but not any
other key's.

### What `HsmBackedSigningBackend` actually signs

`HsmBackedSigningBackend` (`packages/signing/src/hsm-signing-backend.ts`)
composes an `HsmKeyStore` with a `KeyMapping` (resolves a signing key from
a `fromAddress`/`network` pair - `StaticKeyMapping` is the only
implementation, since this package holds no `wallets` table access by
design) into a `SigningBackend`. It signs the SHA-256 digest of a canonical
JSON encoding of the request's own fields - **not** a chain-serialized raw
transaction. Producing an actual broadcastable transaction needs a nonce,
gas parameters and RLP/PSBT encoding that ADR 0013 deliberately keeps out
of this package ("no chain-specific... knowledge"); that composition is
`packages/blockchain`'s job, gated on the still-open custody decision. The
`rawTxHex` field on the resulting `SignedTransaction` therefore carries a
hex-encoded signature over that canonical payload - proof that the key
never leaves the store and that the architecture works end to end, not a
live broadcast path. This is stated in the class's own doc comment, not
just here, so nobody mistakes a passing test for a working payout.

### Durable `ApprovalStore` and `SpendTracker`, and a real audit trail - as library seams first

`PolicyEnforcingSigningService` gained:
* **`reject(requestId, actorId, reason?)`** - a real gap in ADR 0013's
  version: `SigningRequestStatus` already included `'REJECTED'`, but
  nothing ever set it. A rejected request now can't later be "approved"
  into existence (`SigningRequestAlreadyDecidedError`), and the rejecter
  and reason are recorded on the `PendingSigningRequest`.
* **`SigningAuditTrail`** (`packages/signing/src/audit-trail.ts`) - an
  optional fifth constructor argument (defaulted to
  `InMemorySigningAuditTrail`, so every existing four-argument call site,
  including `packages/signing`'s own test suite, is unaffected). Every
  transition - `submitted`, `approved`, `rejected`, `signed`,
  `validation_failed`, `sign_failed` - is recorded with a pre-serialized,
  redaction-safe `detail` object (amounts as strings, never a raw
  `bigint`, never key material). `HsmBackedSigningBackend` records its own
  `key_used`/`sign_failed` events independently, since a key-compromise
  investigation needs "which physical key signed what" even if the policy
  layer's own trail were ever lost.

`InMemoryApprovalStore`/`InMemorySpendTracker`/`InMemorySigningAuditTrail`
remain the package's only shipped implementations - ADR 0013's posture,
unchanged: this package stays free of any database dependency. Durability
is `apps/api`'s job (below).

### Durability in `apps/api`: two tables, not one, and why

`packages/database`'s schema gained:
* **`signing_approval_requests`** (migration
  `20260912133232_signing_approval_requests`) - one row per signing
  request, backing `PrismaApprovalStore`. Amount is `Decimal(78,0)`,
  crossing the bigint boundary through `packages/database`'s existing
  `money-mapper.ts`, same as every other monetary column.
* **`signing_spend_entries`** (migration `20260912134311_signing_spend_entries`)
  - an independent, append-only table backing `PrismaSpendTracker`,
  deliberately **not** derived from `signing_approval_requests.status =
  'SIGNED'`. `finalizeAndSign` calls `SpendTracker.record()` and
  `ApprovalStore.save()` as two separately-awaited steps; deriving the
  spend total from the approval table's current status would leave a real
  window, under concurrent requests, where a second request's ceiling
  check could run between those two awaits and see stale state. A
  dedicated table with its own write closes that gap.

Neither table stores key material or a raw transaction - only the request
metadata and its approval history. The signature itself, when one is ever
produced, is not persisted in either table; it is recorded once, in the
audit trail (below), which is where the exit criteria's "every signing
request and decision is audited" is actually satisfied.

**A durable audit trail reuses the existing `audit_logs` table.**
`PrismaSigningAuditTrail` (`apps/api/src/signing/prisma-signing-audit-trail.ts`)
writes through the existing `AuditLogService` rather than a new table -
"every privileged action lands here" (SPEC section 22) already describes
exactly this. `AuditLogService.record()`'s `actorUserId` became optional as
part of this change: a system-originated event (`HsmBackedSigningBackend`'s
`key_used`, which runs with no human actor) now writes `actorType:
"system"` with a null `userId`, instead of the alternative that was
briefly considered and rejected - passing a fabricated `"system"` string
as `actorUserId`, which would have violated `audit_logs.user_id`'s foreign
key to a real `User` row.

### Wired into the application, without turning on custody

`apps/api` gained a `SigningModule`-shaped (flat, matching this app's
existing single-`AppModule` convention) composition: `signingServiceProvider`
builds one `PolicyEnforcingSigningService` from `APP_CONFIG`, and
`AdminSigningController`/`AdminSigningService` expose it at
`/v1/admin/signing/requests` (list, get, submit, approve, reject) gated by
two new permissions - `signing:read` (SUPPORT, COMPLIANCE_OFFICER, ADMIN)
and `signing:decide` (ADMIN only, same posture as `refunds:decide`).

This is deliberately **not** wired into `Settlement` or `Refund` approval.
Composing "approve this refund" into "submit a signing request for it" is
Phase 25's job (operator revenue model), explicitly gated in the roadmap on
both this phase and the custody decision. Wiring it here, ahead of that
decision, would have made a Tier 2, not-yet-purchased feature look like it
turns on fund movement - exactly what Rule 6 (custody boundaries) and Rule
7 (no inflated capabilities) exist to prevent. `AdminSigningController`
proves the signing architecture on its own, generic terms: any
`merchant_id`/`network`/`asset`/address pair a caller supplies, not
necessarily one backed by a real `Settlement` row.

### Fail-closed by configuration, not just by default

`SIGNING_BACKEND` (`disabled` default, or `emulated-hsm-staging`) selects
`DisabledSigningBackend` or `HsmBackedSigningBackend` in
`signing.provider.ts`. `validateProductionConfig` (`config/env.ts`, Phase
11's mechanism) now refuses to boot in production with anything but
`disabled` - the same "crash before accepting traffic" posture already
applied to CORS and JWT secrets. This means the emulated backend cannot
reach a production deployment even by operator misconfiguration, not just
by nobody choosing to enable it.

### Known limitation: no key-mapping UI yet

`signingServiceProvider` constructs `HsmBackedSigningBackend` with an empty
`StaticKeyMapping` - there is no admin surface yet to associate a
`fromAddress` with a generated `HsmKeyStore` key id, because that
association belongs with `Wallet.signingKeyRef` (custodial wallet
management), which does not exist as a live feature. Concretely: even with
`SIGNING_BACKEND=emulated-hsm-staging` configured, a request that reaches
`HsmBackedSigningBackend.sign()` today throws `NoKeyMappedError` (mapped to
HTTP 422, `signing_not_configured`) until an operator extends the wiring
with real key generation and mapping. `packages/signing/test/hsm-signing-backend.test.ts`
and `packages/signing/test/hsm-key-store.test.ts` prove the underlying
mechanism works in isolation; `apps/api/test/admin-signing.e2e.test.ts`
proves the full submit/approve/reject/audit flow against a real Postgres
database with the default `disabled` backend, including the case of two
distinct approvals still failing closed. This is disclosed here, and must
be disclosed again in the Phase 12 exclusion/inclusion writeup at the M2
gate (`README.md#roadmap`), rather than left to be
discovered in due diligence.

### Key rotation strategy

`HsmKeyStore.rotateKey(oldKeyId)` generates a new physical key and marks
the old one retired: its public half stays retrievable (so a signature it
already produced can still be independently verified), but the store
refuses to sign with it again. The recommended production procedure this
models: generate the replacement key inside the real KMS/HSM, update the
`KeyMapping` to point at the new key id, keep the old key's public material
available for the retention period any past signature might need to be
re-verified against, then destroy the old key through the KMS/HSM
provider's own deletion process (which typically enforces its own waiting
period). No calendar cadence is prescribed here - that is an operational
decision for whoever holds the real KMS/HSM account - but the mechanism to
carry it out exists and is tested.

## Consequences

* `packages/signing`: `reject()`, `SigningAuditTrail`/`InMemorySigningAuditTrail`,
  `HsmKeyStore`/`EmulatedHsmKeyStore`, `KeyMapping`/`StaticKeyMapping`,
  `HsmBackedSigningBackend`, and two new error types
  (`KeyNotFoundError`, `NoKeyMappedError`). 42 tests total (up from 19),
  covering the policy engine's new `reject()`/audit-trail behavior, key
  isolation, signature verification against the correct (and only the
  correct) key, and end-to-end HSM-backed signing.
* `packages/database`: two new tables (`signing_approval_requests`,
  `signing_spend_entries`), a new `SigningRequestStatus` enum, and two new
  `ID_PREFIXES` entries (`sgr`, `sse`) in `@gateway/shared`.
* `apps/api`: `AuditLogEntry.actorUserId` is now optional (system-originated
  audit rows); two new permissions (`signing:read`, `signing:decide`); six
  new `AppConfig` fields (`signingBackend` and five policy settings) driven
  by new `SIGNING_*` env vars; two new `ErrorCode` entries
  (`signing_ceiling_exceeded`, `signing_not_configured`); a new
  `/v1/admin/signing/requests` surface; `SIGNING_BACKEND` refused outside
  `disabled` in production.
* README's Phase 12 roadmap line moves from "policy engine only" to "policy
  engine plus durable approvals, an audit trail, and an emulated-HSM
  reference backend - unwired to any fund-moving action, Mode A still not
  live."
* **Not built, deliberately:** any real cloud KMS/HSM integration (no
  account exists to test one against - unchanged from ADR 0013); a
  key-mapping admin UI; wiring signing into `Settlement`/`Refund` approval
  (Phase 25's job); per-network or per-merchant policies (one global,
  statically-configured `SigningPolicy` today - a disclosed simplification,
  revisit if a real KMS/HSM account and a concrete merchant requirement
  both exist).
