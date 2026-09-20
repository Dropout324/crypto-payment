import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@gateway/shared';
import { redact } from '@gateway/security';
import { type DatabaseClient, Prisma, type TransactionClient } from '@gateway/database';
import type { FastifyRequest } from 'fastify';
import { PRISMA_CLIENT } from '../database/prisma.module.js';

/** Request context worth recording alongside a privileged action - who, and from where. */
export interface AuditMeta {
  ip: string;
  userAgent: string | null;
}

/** Every controller that calls a privileged, audit-logged action extracts its `AuditMeta` this way, so the shape stays consistent. */
export function requestAuditMeta(request: FastifyRequest): AuditMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export interface AuditLogEntry {
  /** Omit for a system-originated action (no human actor in scope) - `actorType` becomes `"system"` and `userId` stays null, rather than pointing a foreign key at a fabricated user id. */
  actorUserId?: string;
  /** e.g. "merchant.suspended", "refund.approved". */
  action: string;
  resourceType: string;
  resourceId?: string;
  merchantId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  meta?: AuditMeta;
}

/**
 * Append-only privileged-action log (SPEC section 22). Every admin mutation
 * calls `record()` inside the same transaction as the mutation itself, so the
 * audit row and the change it describes commit atomically - an admin action
 * that isn't recorded never happened, by construction.
 */
@Injectable()
export class AuditLogService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async record(entry: AuditLogEntry, executor: TransactionClient | DatabaseClient = this.db): Promise<void> {
    await executor.auditLog.create({
      data: {
        id: newId('auditLog'),
        actorType: entry.actorUserId ? 'user' : 'system',
        actorId: entry.actorUserId ?? null,
        userId: entry.actorUserId ?? null,
        merchantId: entry.merchantId ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        ipAddress: entry.meta?.ip ?? null,
        userAgent: entry.meta?.userAgent ?? null,
        // Never trust a caller not to hand us a secret by accident - redact
        // before it ever reaches the append-only table.
        before: entry.before ? (redact(entry.before) as Prisma.InputJsonValue) : Prisma.JsonNull,
        after: entry.after ? (redact(entry.after) as Prisma.InputJsonValue) : Prisma.JsonNull,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
}
