import type { ApprovalStore, PendingSigningRequest, SigningRequestStatus } from '@gateway/signing';
import { decimalToUnits, unitsToDecimal, type DatabaseClient, type SigningApprovalRequest } from '@gateway/database';

/**
 * Durable `ApprovalStore` (Phase 12 exit criteria: "approvals survive a
 * restart"). Backed by the `signing_approval_requests` table
 * (`packages/database`'s schema, migration `20260912133232_signing_approval_requests`)
 * rather than an ad-hoc store here, so the same row a Prisma migration
 * created is the one this class reads and writes - no separate schema to
 * keep in sync.
 */
export class PrismaApprovalStore implements ApprovalStore {
  constructor(private readonly db: DatabaseClient) {}

  async save(entry: PendingSigningRequest): Promise<void> {
    const data = {
      merchantId: entry.request.merchantId,
      network: entry.request.network,
      asset: entry.request.asset,
      fromAddress: entry.request.fromAddress,
      toAddress: entry.request.toAddress,
      amount: unitsToDecimal(entry.request.amount),
      requestedBy: entry.request.requestedBy,
      requestedAt: entry.request.requestedAt,
      status: entry.status,
      approvals: [...entry.approvals],
      rejectedBy: entry.rejectedBy ?? null,
      rejectionReason: entry.rejectionReason ?? null,
    };

    await this.db.signingApprovalRequest.upsert({
      where: { id: entry.request.id },
      create: { id: entry.request.id, ...data },
      update: data,
    });
  }

  async get(requestId: string): Promise<PendingSigningRequest | undefined> {
    const row = await this.db.signingApprovalRequest.findUnique({ where: { id: requestId } });
    return row ? PrismaApprovalStore.toDomain(row) : undefined;
  }

  static toDomain(row: SigningApprovalRequest): PendingSigningRequest {
    return {
      request: {
        id: row.id,
        merchantId: row.merchantId,
        network: row.network,
        asset: row.asset,
        fromAddress: row.fromAddress,
        toAddress: row.toAddress,
        amount: decimalToUnits(row.amount),
        requestedBy: row.requestedBy,
        requestedAt: row.requestedAt,
      },
      status: row.status as SigningRequestStatus,
      approvals: row.approvals as string[],
      rejectedBy: row.rejectedBy ?? undefined,
      rejectionReason: row.rejectionReason ?? undefined,
    };
  }
}
