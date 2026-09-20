import { RequireMerchantRole } from './merchant-role.guard.js';
import { RequirePlatformRole } from './platform-role.guard.js';

/**
 * Full RBAC (Phase 8): a single, explicit permission -> role mapping,
 * instead of each controller hardcoding its own list of allowed role names.
 *
 * `RequirePlatformPermission`/`RequireMerchantPermission` below compute the
 * matching role list from these maps and delegate to the existing
 * `RequirePlatformRole`/`RequireMerchantRole` decorators - `PlatformRoleGuard`
 * and `MerchantRoleGuard` (and their tests) are untouched. This keeps one
 * place that answers "which roles can do X", instead of that answer being
 * scattered across nine controllers and only discoverable by grepping for
 * role names.
 */

export const PlatformPermission = {
  MERCHANTS_READ: 'merchants:read',
  MERCHANTS_MANAGE: 'merchants:manage',
  COMPLIANCE_READ: 'compliance:read',
  COMPLIANCE_REVIEW: 'compliance:review',
  RECONCILIATION_READ: 'reconciliation:read',
  RECONCILIATION_RESOLVE: 'reconciliation:resolve',
  REFUNDS_READ: 'refunds:read',
  REFUNDS_DECIDE: 'refunds:decide',
  SETTLEMENTS_READ: 'settlements:read',
  AUDIT_LOGS_READ: 'audit_logs:read',
  SIGNING_READ: 'signing:read',
  /** Submit, approve or reject a signing request - ADMIN only, same posture as REFUNDS_DECIDE (not granted to COMPLIANCE_OFFICER or SUPPORT). */
  SIGNING_DECIDE: 'signing:decide',
} as const;
export type PlatformPermissionValue = (typeof PlatformPermission)[keyof typeof PlatformPermission];

type PlatformRoleName = 'USER' | 'SUPPORT' | 'COMPLIANCE_OFFICER' | 'ADMIN';

const READ_ONLY_PLATFORM_PERMISSIONS: readonly PlatformPermissionValue[] = [
  PlatformPermission.MERCHANTS_READ,
  PlatformPermission.COMPLIANCE_READ,
  PlatformPermission.RECONCILIATION_READ,
  PlatformPermission.REFUNDS_READ,
  PlatformPermission.SETTLEMENTS_READ,
  PlatformPermission.SIGNING_READ,
];

const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRoleName, readonly PlatformPermissionValue[]> = {
  USER: [],
  SUPPORT: READ_ONLY_PLATFORM_PERMISSIONS,
  COMPLIANCE_OFFICER: [
    ...READ_ONLY_PLATFORM_PERMISSIONS,
    PlatformPermission.COMPLIANCE_REVIEW,
    PlatformPermission.AUDIT_LOGS_READ,
  ],
  ADMIN: Object.values(PlatformPermission),
};

/** Which roles hold every one of the given permissions - `RequirePlatformRole`'s list is an OR across roles, so a role qualifies once it has all of them. */
function platformRolesWith(permissions: readonly PlatformPermissionValue[]): PlatformRoleName[] {
  return (Object.keys(PLATFORM_ROLE_PERMISSIONS) as PlatformRoleName[]).filter((role) =>
    permissions.every((permission) => PLATFORM_ROLE_PERMISSIONS[role].includes(permission)),
  );
}

/** Gates a route to whichever `PlatformRole`s hold ALL of the given permissions. Must follow `JwtAuthGuard`, same as `RequirePlatformRole`. */
export const RequirePlatformPermission = (...permissions: PlatformPermissionValue[]) =>
  RequirePlatformRole(...platformRolesWith(permissions));

export const MerchantPermission = {
  INVOICES_READ: 'invoices:read',
  BALANCE_READ: 'balance:read',
  TRANSACTIONS_READ: 'transactions:read',
  SETTINGS_READ: 'settings:read',
  API_KEYS_READ: 'api_keys:read',
  API_KEYS_MANAGE: 'api_keys:manage',
  WEBHOOKS_READ: 'webhooks:read',
  WEBHOOKS_MANAGE: 'webhooks:manage',
  MEMBERS_READ: 'members:read',
  /** Invite, change role, or remove a member - deliberately narrower than every other "manage" permission (OWNER only, see below). */
  MEMBERS_MANAGE: 'members:manage',
} as const;
export type MerchantPermissionValue = (typeof MerchantPermission)[keyof typeof MerchantPermission];

type MerchantRoleName = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER';

const READ_ONLY_MERCHANT_PERMISSIONS: readonly MerchantPermissionValue[] = [
  MerchantPermission.INVOICES_READ,
  MerchantPermission.BALANCE_READ,
  MerchantPermission.TRANSACTIONS_READ,
  MerchantPermission.SETTINGS_READ,
  MerchantPermission.API_KEYS_READ,
  MerchantPermission.WEBHOOKS_READ,
  MerchantPermission.MEMBERS_READ,
];

const MERCHANT_ROLE_PERMISSIONS: Record<MerchantRoleName, readonly MerchantPermissionValue[]> = {
  // Every role can see the team roster and its own integration surface -
  // only mutating credentials or membership is gated further.
  VIEWER: READ_ONLY_MERCHANT_PERMISSIONS,
  // "Developer" means owning the integration surface (keys, webhooks) day to
  // day, without the organizational power to add/remove teammates.
  DEVELOPER: [...READ_ONLY_MERCHANT_PERMISSIONS, MerchantPermission.API_KEYS_MANAGE, MerchantPermission.WEBHOOKS_MANAGE],
  // ADMIN can do everything DEVELOPER can, plus see membership, but cannot
  // change who holds OWNER, add, or remove members - that stays OWNER-only
  // so an ADMIN can never engineer their own promotion or lock the owner out.
  ADMIN: [...READ_ONLY_MERCHANT_PERMISSIONS, MerchantPermission.API_KEYS_MANAGE, MerchantPermission.WEBHOOKS_MANAGE],
  OWNER: Object.values(MerchantPermission),
};

function merchantRolesWith(permissions: readonly MerchantPermissionValue[]): MerchantRoleName[] {
  return (Object.keys(MERCHANT_ROLE_PERMISSIONS) as MerchantRoleName[]).filter((role) =>
    permissions.every((permission) => MERCHANT_ROLE_PERMISSIONS[role].includes(permission)),
  );
}

/** Gates a route to whichever `MerchantRole`s hold ALL of the given permissions. Must follow `JwtAuthGuard, MerchantRoleGuard`, same as `RequireMerchantRole`. */
export const RequireMerchantPermission = (...permissions: MerchantPermissionValue[]) =>
  RequireMerchantRole(...merchantRolesWith(permissions));
