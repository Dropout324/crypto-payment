import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, newId } from '@gateway/shared';
import { type DatabaseClient, runInTransaction } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { type AuditMeta, AuditLogService } from '../common/audit-log.service.js';
import { toMemberResponse, type MemberResponse } from './members.mapper.js';
import type { AddMemberDto, UpdateMemberRoleDto } from './members.dto.js';

const INCLUDE_USER = { user: { select: { email: true, fullName: true } } } as const;

/**
 * Completes the RBAC loop: roles (`MerchantRole`) were enforceable
 * everywhere already, but nothing let an OWNER actually grant, change, or
 * revoke one through the API - only a seed script could. `OWNER` is the
 * only role that can call `add`/`updateRole`/`remove` (see
 * `MerchantPermission.MEMBERS_MANAGE` in `permissions.ts`), and the "last
 * owner" guard below exists so that permission can never be used to strand
 * a merchant with zero owners.
 */
@Injectable()
export class MerchantMembersService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async list(merchantId: string): Promise<MemberResponse[]> {
    const rows = await this.db.merchantMember.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'asc' },
      include: INCLUDE_USER,
    });
    return rows.map(toMemberResponse);
  }

  async add(merchantId: string, actorUserId: string, dto: AddMemberDto, meta: AuditMeta): Promise<MemberResponse> {
    const user = await this.db.user.findUnique({ where: { email: dto.email.toLowerCase().trim() } });
    if (!user) {
      throw new NotFoundError('user with that email - they must already have an account');
    }

    const existing = await this.db.merchantMember.findUnique({
      where: { merchantId_userId: { merchantId, userId: user.id } },
    });
    if (existing) {
      throw new ConflictError('this user is already a member of this merchant');
    }

    const created = await runInTransaction(this.db, async (tx) => {
      const row = await tx.merchantMember.create({
        data: { id: newId('merchantMember'), merchantId, userId: user.id, role: dto.role },
        include: INCLUDE_USER,
      });
      await this.auditLog.record(
        {
          actorUserId,
          action: 'merchant_member.added',
          resourceType: 'merchant_member',
          resourceId: row.id,
          merchantId,
          after: { user_id: user.id, email: user.email, role: dto.role },
          meta,
        },
        tx,
      );
      return row;
    });

    return toMemberResponse(created);
  }

  async updateRole(
    merchantId: string,
    actorUserId: string,
    memberId: string,
    dto: UpdateMemberRoleDto,
    meta: AuditMeta,
  ): Promise<MemberResponse> {
    const existing = await this.requireMember(merchantId, memberId);

    if (existing.role === 'OWNER' && dto.role !== 'OWNER') {
      await this.assertNotLastOwner(merchantId, memberId);
    }

    const updated = await runInTransaction(this.db, async (tx) => {
      const row = await tx.merchantMember.update({
        where: { id: memberId },
        data: { role: dto.role },
        include: INCLUDE_USER,
      });
      await this.auditLog.record(
        {
          actorUserId,
          action: 'merchant_member.role_changed',
          resourceType: 'merchant_member',
          resourceId: memberId,
          merchantId,
          before: { role: existing.role },
          after: { role: dto.role },
          meta,
        },
        tx,
      );
      return row;
    });

    return toMemberResponse(updated);
  }

  async remove(merchantId: string, actorUserId: string, memberId: string, meta: AuditMeta): Promise<void> {
    const existing = await this.requireMember(merchantId, memberId);

    if (existing.role === 'OWNER') {
      await this.assertNotLastOwner(merchantId, memberId);
    }

    await runInTransaction(this.db, async (tx) => {
      await tx.merchantMember.delete({ where: { id: memberId } });
      await this.auditLog.record(
        {
          actorUserId,
          action: 'merchant_member.removed',
          resourceType: 'merchant_member',
          resourceId: memberId,
          merchantId,
          before: { user_id: existing.userId, role: existing.role },
          meta,
        },
        tx,
      );
    });
  }

  private async requireMember(merchantId: string, memberId: string) {
    const existing = await this.db.merchantMember.findFirst({ where: { id: memberId, merchantId } });
    if (!existing) throw new NotFoundError('merchant member', memberId);
    return existing;
  }

  /** Refuses to demote/remove a merchant's only remaining OWNER - that role has no self-service recovery path if it ever hit zero. */
  private async assertNotLastOwner(merchantId: string, excludingMemberId: string): Promise<void> {
    const remainingOwners = await this.db.merchantMember.count({
      where: { merchantId, role: 'OWNER', id: { not: excludingMemberId } },
    });
    if (remainingOwners === 0) {
      throw new ConflictError('cannot remove the last owner of a merchant');
    }
  }
}
