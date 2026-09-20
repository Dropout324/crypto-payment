import { Inject, Injectable } from '@nestjs/common';
import {
  AmountCeilingExceededError,
  DestinationNotAllowedError,
  isSignedTransaction,
  KeyNotFoundError,
  NoKeyMappedError,
  PolicyEnforcingSigningService,
  SelfApprovalError,
  SigningNotConfiguredError,
  SigningRequestAlreadyDecidedError,
  UnknownSigningRequestError,
  type PendingSigningRequest,
  type SigningRequest,
} from '@gateway/signing';
import { ConflictError, ErrorCode, ForbiddenError, NotFoundError, UnprocessableError, ValidationError, newId } from '@gateway/shared';
import { SIGNING_SERVICE } from './signing.provider.js';
import { PrismaApprovalStore } from './prisma-approval-store.js';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import type { DatabaseClient } from '@gateway/database';
import { toAdminSigningResponse, type AdminSigningRequestResponse, type AdminSigningRequestState } from './admin-signing.mapper.js';
import type { SubmitSigningRequestDto } from './admin-signing.dto.js';

/**
 * Thin orchestration over `@gateway/signing`'s `PolicyEnforcingSigningService`
 * - the actual policy logic lives there and is unit-tested there
 * (`packages/signing/test/`); this layer only translates its errors into the
 * `AppError` vocabulary `AppExceptionFilter` understands (the package has no
 * dependency on this app's HTTP framework, by design - ADR 0013) and maps
 * its return shapes into the wire format.
 *
 * Not tied to `Settlement` or `Refund` yet: composing "approve this refund"
 * into "submit a signing request for it" is Phase 25's job, gated on the
 * custody decision this roadmap leaves open (`docs/commercial/readiness-roadmap.md`,
 * "Open decisions" #4). This module proves the signing architecture end to
 * end on its own, generic terms.
 */
@Injectable()
export class AdminSigningService {
  constructor(
    @Inject(SIGNING_SERVICE) private readonly signing: PolicyEnforcingSigningService,
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
  ) {}

  async list(status?: 'PENDING_APPROVAL' | 'SIGNED' | 'REJECTED'): Promise<AdminSigningRequestResponse[]> {
    const rows = await this.db.signingApprovalRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => toAdminSigningResponse(toState(PrismaApprovalStore.toDomain(row))));
  }

  async get(requestId: string): Promise<AdminSigningRequestResponse> {
    const row = await this.db.signingApprovalRequest.findUnique({ where: { id: requestId } });
    if (!row) throw new NotFoundError('signing request', requestId);
    return toAdminSigningResponse(toState(PrismaApprovalStore.toDomain(row)));
  }

  async submit(actorUserId: string, dto: SubmitSigningRequestDto): Promise<AdminSigningRequestResponse> {
    const request: SigningRequest = {
      id: newId('signingRequest'),
      merchantId: dto.merchant_id,
      network: dto.network,
      asset: dto.asset,
      fromAddress: dto.from_address,
      toAddress: dto.to_address,
      amount: BigInt(dto.amount),
      requestedBy: actorUserId,
      requestedAt: new Date(),
    };

    return this.withTranslatedErrors(async () => {
      const result = await this.signing.submit(request);
      return isSignedTransaction(result)
        ? toAdminSigningResponse({ request, status: 'SIGNED', approvals: [actorUserId], rawTxHex: result.rawTxHex })
        : toAdminSigningResponse(toState(result));
    });
  }

  async approve(actorUserId: string, requestId: string): Promise<AdminSigningRequestResponse> {
    return this.withTranslatedErrors(async () => {
      const before = await this.mustGetPending(requestId);
      const result = await this.signing.approve(requestId, actorUserId);
      return isSignedTransaction(result)
        ? toAdminSigningResponse({ ...toState(before), status: 'SIGNED', rawTxHex: result.rawTxHex })
        : toAdminSigningResponse(toState(result));
    });
  }

  async reject(actorUserId: string, requestId: string, reason?: string): Promise<AdminSigningRequestResponse> {
    return this.withTranslatedErrors(async () => {
      const rejected = await this.signing.reject(requestId, actorUserId, reason);
      return toAdminSigningResponse(toState(rejected));
    });
  }

  private async mustGetPending(requestId: string): Promise<PendingSigningRequest> {
    const row = await this.db.signingApprovalRequest.findUnique({ where: { id: requestId } });
    if (!row) throw new UnknownSigningRequestError(requestId);
    return PrismaApprovalStore.toDomain(row);
  }

  /** Translates `@gateway/signing`'s own error vocabulary into this app's `AppError` hierarchy - see this class's doc comment. */
  private async withTranslatedErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DestinationNotAllowedError) throw new ValidationError(error.message);
      if (error instanceof AmountCeilingExceededError) {
        throw new UnprocessableError(ErrorCode.SIGNING_CEILING_EXCEEDED, error.message);
      }
      if (error instanceof SelfApprovalError) throw new ForbiddenError(error.message);
      if (error instanceof UnknownSigningRequestError) throw new NotFoundError('signing request');
      if (error instanceof SigningRequestAlreadyDecidedError) throw new ConflictError(error.message);
      if (error instanceof SigningNotConfiguredError || error instanceof NoKeyMappedError || error instanceof KeyNotFoundError) {
        throw new UnprocessableError(ErrorCode.SIGNING_NOT_CONFIGURED, error.message);
      }
      throw error;
    }
  }
}

function toState(pending: PendingSigningRequest): AdminSigningRequestState {
  return {
    request: pending.request,
    status: pending.status,
    approvals: pending.approvals,
    rejectedBy: pending.rejectedBy,
    rejectionReason: pending.rejectionReason,
  };
}
