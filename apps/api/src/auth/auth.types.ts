/** Attached to `request.merchantContext` by `ApiKeyGuard` once a key is verified. */
export interface MerchantContext {
  merchantId: string;
  apiKeyId: string;
  livemode: boolean;
  scopes: readonly string[];
}

/** Attached to `request.userContext` by `JwtAuthGuard` once a session is verified. */
export interface UserContext {
  userId: string;
  email: string;
  platformRole: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    merchantContext?: MerchantContext;
    userContext?: UserContext;
    /** Resolved and DB-verified by `MerchantRoleGuard` from the X-Merchant-Id header. */
    currentMerchantId?: string;
    currentMerchantRole?: string;
  }
}
