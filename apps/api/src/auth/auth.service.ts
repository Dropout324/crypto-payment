import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, UnauthenticatedError, newId } from '@gateway/shared';
import { generateOpaqueToken, sha256Hex, signJwt, verifyPassword } from '@gateway/security';
import { Prisma, type DatabaseClient, runInTransaction } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface AuthMeta {
  ip: string;
  userAgent: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  email: string;
  full_name: string | null;
  platform_role: string;
}

export interface LoginResult extends AuthTokens {
  user: PublicUser;
}

export interface MeResult {
  user: PublicUser;
  memberships: Array<{
    merchant_id: string;
    merchant_name: string;
    merchant_slug: string;
    merchant_status: string;
    role: string;
  }>;
}

/**
 * Dashboard login/session management (Phase 7).
 *
 * Deliberately returns the same generic failure for "no such user", "wrong
 * password" and "account locked" - same posture as `ApiKeyGuard`'s identical
 * 401 for "unknown key" vs "wrong secret" - so a caller cannot use the login
 * endpoint to enumerate registered emails or discover a lockout.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(email: string, password: string, meta: AuthMeta): Promise<LoginResult> {
    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    if (!user || user.status !== 'ACTIVE') {
      throw this.invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw this.invalidCredentials();
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      const failedCount = user.failedLoginCount + 1;
      const locking = failedCount >= MAX_FAILED_LOGIN_ATTEMPTS;
      await this.db.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: locking ? 0 : failedCount,
          lockedUntil: locking ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
        },
      });
      throw this.invalidCredentials();
    }

    const { token: refreshToken, tokenHash } = generateOpaqueToken();

    // This transaction has no cross-row invariant to protect (it
    // unconditionally overwrites this user's lockout fields and inserts a
    // new session row - nothing here is a "read balance, then write" check
    // that Serializable's predicate-conflict detection earns its keep on).
    // Concurrent logins for the same user still all write the same `User`
    // row, though, and at Serializable each writer's snapshot is fixed at
    // its first statement - so a burst of concurrent logins gets some
    // fraction of them rejected with `could not serialize access due to
    // concurrent update` no matter how the writes are ordered afterwards
    // (an advisory lock included: it only serialises *when* a transaction
    // proceeds, not the snapshot it already took before waiting). Load
    // testing (ADR 0015) found that fraction large enough to exhaust
    // `runInTransaction`'s retry budget outright. Running this one
    // transaction at Read Committed instead sidesteps the problem
    // entirely: a plain `UPDATE` under Read Committed re-reads the row and
    // re-evaluates its `WHERE` after waiting out any concurrent writer,
    // rather than aborting - exactly what's needed here, and correct
    // specifically because there is no multi-row invariant depending on the
    // stricter isolation level.
    await runInTransaction(
      this.db,
      async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
        });
        await tx.session.create({
          data: {
            id: newId('session'),
            userId: user.id,
            tokenHash,
            ipAddress: meta.ip,
            userAgent: meta.userAgent,
            expiresAt: new Date(Date.now() + this.config.jwtRefreshTtlSeconds * 1000),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    return {
      accessToken: this.signAccessToken(user.id, user.email, user.platformRole),
      refreshToken,
      user: this.toPublicUser(user),
    };
  }

  async refresh(presented: string, meta: AuthMeta): Promise<AuthTokens> {
    const tokenHash = sha256Hex(presented);
    const session = await this.db.session.findUnique({ where: { tokenHash } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw this.invalidSession();
    }

    const user = await this.db.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'ACTIVE') {
      throw this.invalidSession();
    }

    const { token: newRefreshToken, tokenHash: newTokenHash } = generateOpaqueToken();

    // Rotation: the presented token is immediately revoked and replaced.
    // Presenting an already-revoked token again (reuse of a stolen or
    // previously-rotated token) is rejected above by the revokedAt check.
    await runInTransaction(this.db, async (tx) => {
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await tx.session.create({
        data: {
          id: newId('session'),
          userId: user.id,
          tokenHash: newTokenHash,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          expiresAt: new Date(Date.now() + this.config.jwtRefreshTtlSeconds * 1000),
        },
      });
    });

    return {
      accessToken: this.signAccessToken(user.id, user.email, user.platformRole),
      refreshToken: newRefreshToken,
    };
  }

  /** Idempotent: logging out twice, or with no session at all, is never an error. */
  async logout(presented: string | undefined): Promise<void> {
    if (!presented) return;
    const tokenHash = sha256Hex(presented);
    await this.db.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<MeResult> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await this.db.merchantMember.findMany({
      where: { userId },
      include: { merchant: { select: { id: true, name: true, slug: true, status: true } } },
    });

    return {
      user: this.toPublicUser(user),
      memberships: memberships.map((m) => ({
        merchant_id: m.merchant.id,
        merchant_name: m.merchant.name,
        merchant_slug: m.merchant.slug,
        merchant_status: m.merchant.status,
        role: m.role,
      })),
    };
  }

  private signAccessToken(userId: string, email: string, platformRole: string): string {
    return signJwt({ sub: userId, email, platform_role: platformRole }, this.config.jwtAccessSecret, {
      expiresInSeconds: this.config.jwtAccessTtlSeconds,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
    });
  }

  private toPublicUser(user: { id: string; email: string; fullName: string | null; platformRole: string }): PublicUser {
    return { id: user.id, email: user.email, full_name: user.fullName, platform_role: user.platformRole };
  }

  private invalidCredentials(): UnauthenticatedError {
    return new UnauthenticatedError('invalid email or password', ErrorCode.INVALID_CREDENTIALS);
  }

  private invalidSession(): UnauthenticatedError {
    return new UnauthenticatedError('invalid or expired session', ErrorCode.INVALID_CREDENTIALS);
  }
}
