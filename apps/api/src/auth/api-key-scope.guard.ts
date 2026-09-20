import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthenticatedError } from '@gateway/shared';
import type { FastifyRequest } from 'fastify';

/**
 * Coarse-grained scopes an API key can be issued with (Phase 17 pass 1).
 * `<resource>:<action>` matches the naming `MerchantPermission` already uses
 * for dashboard RBAC (`permissions.ts`) - a merchant reading these two
 * systems side by side sees one convention, not two.
 *
 * Add freely; a scope string is part of the public API contract once a key
 * holding it exists, so never repurpose or remove one a live key could hold.
 */
export const ApiKeyScope = {
  INVOICES_READ: 'invoices:read',
  INVOICES_WRITE: 'invoices:write',
  ADDRESSES_READ: 'addresses:read',
  ADDRESSES_WRITE: 'addresses:write',
  TRANSACTIONS_READ: 'transactions:read',
  BALANCE_READ: 'balance:read',
  WEBHOOKS_WRITE: 'webhooks:write',
} as const;
export type ApiKeyScopeValue = (typeof ApiKeyScope)[keyof typeof ApiKeyScope];

/** Every scope a key may be issued - the allowlist `CreateApiKeyDto` validates against. */
export const ALL_API_KEY_SCOPES: readonly ApiKeyScopeValue[] = Object.values(ApiKeyScope);

export const API_KEY_SCOPE_KEY = 'requiredApiKeyScopes';

/** Gates a route to API keys holding ALL of the given scopes. Must follow `ApiKeyGuard`. */
export const RequireScope = (...scopes: ApiKeyScopeValue[]) => SetMetadata(API_KEY_SCOPE_KEY, scopes);

/**
 * API-key scope enforcement (Phase 17 pass 1).
 *
 * Before this guard, `ApiKey.scopes` was stored at creation and returned in
 * every response but never read by anything - a key created with
 * `scopes: ["invoices:read"]` could still call `POST /v1/payment-invoices`
 * or register deposit addresses, because no code path ever compared the
 * presented key's scopes against the endpoint it was calling. Applied as
 * `@UseGuards(ApiKeyGuard, ApiKeyScopeGuard)`, with each handler declaring
 * `@RequireScope(...)` - mirrors `MerchantRoleGuard`/`PlatformRoleGuard`'s
 * `Reflector` + `SetMetadata` pattern exactly, just keyed off
 * `request.merchantContext.scopes` instead of a role.
 *
 * A route with no `@RequireScope` decorator is open to any authenticated key
 * regardless of scopes (same "no metadata -> no restriction" default the
 * role guards use) - every route in this file's target list has one.
 */
@Injectable()
export class ApiKeyScopeGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const merchant = request.merchantContext;
    if (!merchant) {
      throw new UnauthenticatedError('missing API key context');
    }

    const required =
      this.reflector.get<ApiKeyScopeValue[]>(API_KEY_SCOPE_KEY, context.getHandler()) ??
      this.reflector.get<ApiKeyScopeValue[]>(API_KEY_SCOPE_KEY, context.getClass());

    if (!required || required.length === 0) return true;

    const granted = new Set(merchant.scopes);
    const missing = required.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new ForbiddenError(`this API key is missing required scope(s): ${missing.join(', ')}`, {
        required_scopes: required,
        missing_scopes: missing,
      });
    }

    return true;
  }
}
