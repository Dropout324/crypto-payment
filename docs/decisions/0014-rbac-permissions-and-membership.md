# ADR 0014 - Full RBAC: a permission map over the existing roles, plus the missing membership endpoint

Status: Accepted
Date: 2026-09-10

## Context

Phase 8's "RBAC" line item looked, at first, like it might already be
mostly done: `PlatformRoleGuard` and `MerchantRoleGuard` were already
applied to every controller, checking `User.platformRole` /
`MerchantMember.role` against a hardcoded list of allowed role names per
route (`@RequirePlatformRole('SUPPORT', 'COMPLIANCE_OFFICER', 'ADMIN')` and
similar). Two real gaps remained once that was inventoried:

1. **No single source of truth for "who can do what."** The answer to "can
   `COMPLIANCE_OFFICER` approve a refund" was only discoverable by grepping
   every controller's decorator - nine different call sites, each free to
   drift independently, with no way to answer "what can `SUPPORT` do"
   without reading all nine.
2. **No way to assign a role at all.** `MerchantMember.role` could be
   checked everywhere, but nothing in the API could ever set it - an OWNER
   had no endpoint to invite a teammate, promote them, or remove them. Every
   membership row had to come from the seed script. A role system nobody
   can use through the product is not "full" RBAC by any reasonable
   reading of that phrase.

## Decisions

### A permission map, computed into the existing role lists at decoration time

`apps/api/src/auth/permissions.ts` defines `PlatformPermission` and
`MerchantPermission` string constants, plus one `Record<Role,
Permission[]>` map per role type - twelve platform permissions, ten merchant
permissions, mapped once. `RequirePlatformPermission(...)` and
`RequireMerchantPermission(...)` compute "which roles hold every one of
these permissions" from that map and delegate straight to the existing
`RequirePlatformRole`/`RequireMerchantRole` - which still call the same
`SetMetadata` they always did, read by the same, untouched
`PlatformRoleGuard`/`MerchantRoleGuard`.

This was deliberate: rewriting the guards themselves to understand
permissions directly would have touched proven, tested authorization
logic for a purely organizational win. Computing the role list at
decoration time (decorators run once, at class-definition time, so this
has zero runtime cost) gets the same "one source of truth" benefit with
zero risk to the guards. Every controller was migrated from a raw role
list to a named permission - e.g. `AdminRefundsController`'s class-level
guard is now `RequirePlatformPermission(REFUNDS_READ)` and its
approve/reject routes `RequirePlatformPermission(REFUNDS_DECIDE)`, not
`'SUPPORT', 'COMPLIANCE_OFFICER', 'ADMIN'` and `'ADMIN'` respectively -
same resulting access, but the *reason* ("read" vs "decide") is now the
thing the code says, not something you infer from which role names appear.

### `MerchantRole.DEVELOPER` becomes meaningful

Before this change, `DEVELOPER` and `VIEWER` were behaviorally identical -
every merchant-side mutation decorator listed only `'OWNER', 'ADMIN'`, so a
`DEVELOPER` could do nothing a `VIEWER` couldn't. `DEVELOPER` now holds
`API_KEYS_MANAGE` and `WEBHOOKS_MANAGE` in addition to every read
permission: owning the integration surface (keys, webhooks) day to day is
what "developer" plausibly means on a payments team, without also granting
organizational power over membership. This is a real behavior change,
verified in `apps/api/test/merchant-members.e2e.test.ts` ("a DEVELOPER can
manage API keys and webhook endpoints, but a VIEWER cannot") rather than
just asserted in this ADR.

### Membership management, OWNER-only, with a last-owner guard

New: `GET/POST /v1/merchant/me/members`, `PATCH`/`DELETE
/v1/merchant/me/members/:id` (`members.controller.ts`,
`members.service.ts`). Listing is available to every role
(`MEMBERS_READ`); adding, changing a role, or removing a member requires
`MEMBERS_MANAGE`, which only `OWNER` holds - not even `ADMIN` - specifically
so an `ADMIN` can never grant themselves `OWNER` or remove the actual
owner. `add()` resolves an existing `User` by email; there is no
invite-by-email/signup flow yet (no email-sending infrastructure exists),
so this attaches an *existing* account, not a pending invitation - a
smaller, honest scope rather than a half-built invite system.

Every mutation refuses to demote or remove a merchant's last remaining
`OWNER` (`assertNotLastOwner`, a `count()` excluding the row being
changed) - that role has no self-service recovery path once it hits zero,
so the guard has to live in the service, not just be a UI convention.

### Audit trail now covers the actions it previously missed

`AuditLogService.record()` gained `ipAddress`/`userAgent` fields the
`audit_logs` table already had columns for but nothing ever populated
(`requestAuditMeta(request)` is the one helper every controller now calls).
Merchant self-service mutations - API key create/revoke, webhook endpoint
create/update/rotate-secret, and the new member add/role-change/remove -
now call `AuditLogService.record()` inside the same transaction as the
mutation, exactly like the admin services already did. `GET
/v1/admin/audit-logs` (`admin-audit-logs.controller.ts`) is new: previously
nothing in the API could read the table at all. It is deliberately
restricted to `AUDIT_LOGS_READ` (`COMPLIANCE_OFFICER`/`ADMIN`), tighter than
every other admin list endpoint, because it is the one place that shows
every privileged action across every resource - including ones a `SUPPORT`
user should not be able to browse.

## Consequences

* `apps/api/test/merchant-members.e2e.test.ts` covers add/list/role-change/
  remove, the not-found and duplicate-membership cases, the last-owner
  guard on both demotion and removal, and the `DEVELOPER`/`VIEWER`
  permission split.
* `apps/api/test/admin-audit-logs.e2e.test.ts` covers reading a trail
  another action wrote (including the new ip/user-agent fields) and the
  `SUPPORT`-is-rejected / `COMPLIANCE_OFFICER`-is-allowed split.
* Every existing role-based e2e assertion (e.g. "rejects a SUPPORT-role
  user") still passes unchanged - the permission map was built to reproduce
  today's access exactly, except for the one deliberate `DEVELOPER` change
  called out above.
* Not done: attribute-level permissions (e.g. "can approve refunds under
  $X"), and a real invite-by-email flow. Both are bigger, separate features
  with their own prerequisites (an amount-scoped permission model; an
  email-sending subsystem) rather than gaps in what this ADR set out to
  close.
