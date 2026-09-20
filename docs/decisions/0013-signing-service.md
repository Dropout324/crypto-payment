# ADR 0013 - Signing service: the policy engine, not the signer

Status: Accepted
Date: 2026-09-10

## Context

ADR 0002 named the prerequisite for Mode A (custodial wallets) explicitly:
"a KMS/HSM-backed signing service with policy controls (allowed
destinations, amount ceilings, rate limits, approvals)." Phase 8's roadmap
line item is that signing service. Nothing existed for it before this ADR.

Two very different things hide under "signing service":

1. **The signer**: the component that actually holds (or calls out to) key
   material and produces a signature. This is custody, in the fullest sense
   - the exact thing principle #7 says this application must never do
   itself ("the application never holds private keys... signing is
   delegated to a policy-enforcing service backed by a KMS/HSM").
2. **The policy engine**: the component that decides whether a given
   request should be signed at all - is the destination allowed, is it
   under the amount ceiling, has it collected enough approvals - before it
   ever reaches the signer.

This ADR builds (2) and explicitly does not build (1), for the same reason
ADR 0012 didn't build a KMS-backed `SecretsProvider`: there is no
AWS CloudHSM / GCP KMS / comparable account in this project to integrate
and integration-test a real signer against, and shipping one untested would
look done without being verified - worse than the honest gap.

## Decision

New package, `@gateway/signing`, with no dependency on any other package in
this monorepo (deliberately - it holds no chain-specific or
custody-specific knowledge yet):

* **`SigningBackend`** (`signing-backend.ts`) - the interface a real
  KMS/HSM integration implements: `sign(request): Promise<SignedTransaction>`.
  **`DisabledSigningBackend`** is the only implementation shipped, and it
  always throws `SigningNotConfiguredError`. This is fail-closed by
  construction: nothing that wires this package up before a real backend
  exists can ever produce an actual signature, no matter what policy
  configuration surrounds it.
* **`SigningPolicy`** (`policy.ts`) - one policy per network: an
  allowed-destination set, a per-transaction amount ceiling, a rolling
  window ceiling, and a required-approval count.
* **`PolicyEnforcingSigningService`** (`policy-signing-service.ts`) - the
  actual engine. `submit()` checks the destination allowlist and both
  ceilings before doing anything else; if `requiredApprovals <= 1` it signs
  immediately, otherwise it records a `PENDING_APPROVAL` request and
  returns it. `approve()` records one approver's decision, refuses
  self-approval, is idempotent for a repeated approver, and - once the
  required count is reached - **re-checks the ceilings again** before
  signing, because budget can have been consumed by an unrelated request
  while this one sat waiting for sign-off. A rejected request never reaches
  `SigningBackend.sign()`.
* **`SpendTracker`** and **`ApprovalStore`** are both interfaces with an
  in-memory default only (`InMemorySpendTracker`, `InMemoryApprovalStore`).
  Both need durable, restart-surviving storage in production - an in-memory
  window ceiling that resets on every deploy is not a ceiling - so, same as
  `SigningBackend`, these are seams for a real (Postgres-backed, most
  likely) implementation, not that implementation itself.

**Not built, and not wired into `apps/api`**: any real `SigningBackend`;
persistence for `SpendTracker`/`ApprovalStore`; any HTTP endpoint. This
package is a standalone library with no consumer yet - the same posture as
building `KeyProvider` before a KMS existed to plug into it, just one layer
further from done. Wiring it up is a separate, later decision that also
needs: which KMS/HSM, a real destination-allowlist data model (per merchant?
per network? admin-managed?), and where approvals surface in the admin
dashboard - none of which this ADR decides.

## Consequences

* `packages/signing/test/policy-signing-service.test.ts` (10 tests) covers
  the policy logic in full - both ceilings, the allowlist, multi-approval
  accumulation, self-approval rejection, idempotent re-approval, and the
  re-check-at-approval-time behavior - all against a `FakeSigningBackend`,
  because the policy logic is what needs proving here, not any real chain's
  signing format.
* `DisabledSigningBackend` is covered by its own test asserting it always
  throws - the fail-closed guarantee is itself a testable property, not
  just a comment.
* README's Phase 8 roadmap line moves from "signing service: not started"
  to "policy engine built, unwired, no real backend" - a real step, but
  Mode A itself remains not live until a KMS/HSM integration exists to sit
  behind `SigningBackend`.
