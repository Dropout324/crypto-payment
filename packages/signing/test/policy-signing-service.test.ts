import { describe, expect, it } from 'vitest';
import {
  AmountCeilingExceededError,
  DestinationNotAllowedError,
  DisabledSigningBackend,
  InMemoryApprovalStore,
  InMemorySigningAuditTrail,
  InMemorySpendTracker,
  PolicyEnforcingSigningService,
  SelfApprovalError,
  SigningNotConfiguredError,
  SigningRequestAlreadyDecidedError,
  UnknownSigningRequestError,
  isSignedTransaction,
  type SignedTransaction,
  type SigningBackend,
  type SigningPolicy,
  type SigningRequest,
} from '../src/index.js';

class FakeSigningBackend implements SigningBackend {
  calls: SigningRequest[] = [];
  async sign(request: SigningRequest): Promise<SignedTransaction> {
    this.calls.push(request);
    return { requestId: request.id, rawTxHex: `0xsigned-${request.id}`, signedAt: new Date() };
  }
}

function request(overrides: Partial<SigningRequest> = {}): SigningRequest {
  return {
    id: overrides.id ?? 'req_1',
    merchantId: 'mch_1',
    network: 'ETHEREUM',
    asset: 'USDT',
    fromAddress: '0xhotwallet',
    toAddress: '0xallowed',
    amount: 1_000_000n,
    requestedBy: 'usr_requester',
    requestedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function policy(overrides: Partial<SigningPolicy> = {}): SigningPolicy {
  return {
    network: 'ETHEREUM',
    allowedDestinations: new Set(['0xallowed']),
    maxAmountPerTx: 5_000_000n,
    maxAmountPerWindow: 10_000_000n,
    windowSeconds: 3600,
    requiredApprovals: 1,
    ...overrides,
  };
}

describe('DisabledSigningBackend', () => {
  it('always throws - there is no real backend to actually sign with', async () => {
    await expect(new DisabledSigningBackend().sign(request())).rejects.toThrow(SigningNotConfiguredError);
  });
});

describe('PolicyEnforcingSigningService', () => {
  it('signs immediately when requiredApprovals is 1', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(backend, policy(), new InMemorySpendTracker(), new InMemoryApprovalStore());

    const result = await service.submit(request());

    expect(isSignedTransaction(result)).toBe(true);
    expect(backend.calls).toHaveLength(1);
  });

  it('rejects a destination not on the allowlist without ever calling the backend', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(backend, policy(), new InMemorySpendTracker(), new InMemoryApprovalStore());

    await expect(service.submit(request({ toAddress: '0xnotallowed' }))).rejects.toThrow(DestinationNotAllowedError);
    expect(backend.calls).toHaveLength(0);
  });

  it('rejects an amount over the per-transaction ceiling', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(backend, policy(), new InMemorySpendTracker(), new InMemoryApprovalStore());

    await expect(service.submit(request({ amount: 6_000_000n }))).rejects.toThrow(AmountCeilingExceededError);
    expect(backend.calls).toHaveLength(0);
  });

  it('rejects once the rolling-window total would be exceeded, even across separate requests', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(backend, policy(), new InMemorySpendTracker(), new InMemoryApprovalStore());

    await service.submit(request({ id: 'req_1', amount: 4_000_000n }));
    await service.submit(request({ id: 'req_2', amount: 4_000_000n }));
    // Third request would bring the trailing total to 12,000,000 > the 10,000,000 window ceiling.
    await expect(service.submit(request({ id: 'req_3', amount: 4_000_000n }))).rejects.toThrow(AmountCeilingExceededError);
    expect(backend.calls).toHaveLength(2);
  });

  it('holds a request pending until enough distinct approvals arrive, then signs', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(
      backend,
      policy({ requiredApprovals: 2 }),
      new InMemorySpendTracker(),
      new InMemoryApprovalStore(),
    );

    const submitted = await service.submit(request());
    expect(isSignedTransaction(submitted)).toBe(false);
    expect(backend.calls).toHaveLength(0);

    const afterOne = await service.approve('req_1', 'usr_approver_1');
    expect(isSignedTransaction(afterOne)).toBe(false);
    expect(backend.calls).toHaveLength(0);

    const afterTwo = await service.approve('req_1', 'usr_approver_2');
    expect(isSignedTransaction(afterTwo)).toBe(true);
    expect(backend.calls).toHaveLength(1);
  });

  it('treats a repeated approval from the same approver as a no-op, not progress', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(
      backend,
      policy({ requiredApprovals: 2 }),
      new InMemorySpendTracker(),
      new InMemoryApprovalStore(),
    );

    await service.submit(request());
    await service.approve('req_1', 'usr_approver_1');
    const stillPending = await service.approve('req_1', 'usr_approver_1');

    expect(isSignedTransaction(stillPending)).toBe(false);
    expect(backend.calls).toHaveLength(0);
  });

  it('refuses to let the requester approve their own request', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(
      backend,
      policy({ requiredApprovals: 2 }),
      new InMemorySpendTracker(),
      new InMemoryApprovalStore(),
    );

    await service.submit(request());
    await expect(service.approve('req_1', 'usr_requester')).rejects.toThrow(SelfApprovalError);
  });

  it('rejects approving a request that was never submitted', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(backend, policy(), new InMemorySpendTracker(), new InMemoryApprovalStore());

    await expect(service.approve('never-submitted', 'usr_approver')).rejects.toThrow(UnknownSigningRequestError);
  });

  it('re-checks ceilings at approval time, not just at submission time', async () => {
    const backend = new FakeSigningBackend();
    const spendTracker = new InMemorySpendTracker();
    const service = new PolicyEnforcingSigningService(
      backend,
      policy({ requiredApprovals: 2, maxAmountPerWindow: 5_000_000n }),
      spendTracker,
      new InMemoryApprovalStore(),
    );

    // Submitted while there was budget; another request consumes it before approval completes.
    await service.submit(request({ id: 'req_1', amount: 4_000_000n }));
    await spendTracker.record('mch_1', 'ETHEREUM', 4_000_000n, new Date('2026-01-01T00:00:00Z'));

    // First approval just records progress - it does not yet hit the required count, so no ceiling re-check happens.
    const afterFirstApproval = await service.approve('req_1', 'usr_approver_1');
    expect(isSignedTransaction(afterFirstApproval)).toBe(false);

    // Second approval crosses the threshold and re-checks: 4,000,000 (already recorded) + 4,000,000 (this request) > 5,000,000.
    await expect(service.approve('req_1', 'usr_approver_2')).rejects.toThrow(AmountCeilingExceededError);
  });

  it('matches the allowlist case-insensitively against the destination address', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(
      backend,
      policy({ allowedDestinations: new Set(['0xallowed']) }),
      new InMemorySpendTracker(),
      new InMemoryApprovalStore(),
    );

    const result = await service.submit(request({ toAddress: '0xALLOWED' }));
    expect(isSignedTransaction(result)).toBe(true);
  });

  it('allows an amount exactly at the per-transaction ceiling', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(
      backend,
      policy({ maxAmountPerTx: 5_000_000n }),
      new InMemorySpendTracker(),
      new InMemoryApprovalStore(),
    );

    const result = await service.submit(request({ amount: 5_000_000n }));
    expect(isSignedTransaction(result)).toBe(true);
  });

  it('allows the rolling-window total to land exactly on the ceiling', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(
      backend,
      policy({ maxAmountPerTx: 10_000_000n, maxAmountPerWindow: 10_000_000n }),
      new InMemorySpendTracker(),
      new InMemoryApprovalStore(),
    );

    await service.submit(request({ id: 'req_1', amount: 6_000_000n }));
    const result = await service.submit(request({ id: 'req_2', amount: 4_000_000n }));
    expect(isSignedTransaction(result)).toBe(true);
  });

  it('rejects approving a request that has already been signed', async () => {
    const backend = new FakeSigningBackend();
    const service = new PolicyEnforcingSigningService(backend, policy(), new InMemorySpendTracker(), new InMemoryApprovalStore());

    // requiredApprovals is 1, so this signs immediately.
    await service.submit(request());
    await expect(service.approve('req_1', 'usr_someone_else')).rejects.toThrow(SigningRequestAlreadyDecidedError);
  });

  describe('reject()', () => {
    it('rejects a pending request outright, so it never reaches the backend even if later "approved"', async () => {
      const backend = new FakeSigningBackend();
      const service = new PolicyEnforcingSigningService(
        backend,
        policy({ requiredApprovals: 2 }),
        new InMemorySpendTracker(),
        new InMemoryApprovalStore(),
      );

      await service.submit(request());
      const rejected = await service.reject('req_1', 'usr_approver_1', 'looks like fraud');

      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejectedBy).toBe('usr_approver_1');
      expect(rejected.rejectionReason).toBe('looks like fraud');
      await expect(service.approve('req_1', 'usr_approver_2')).rejects.toThrow(SigningRequestAlreadyDecidedError);
      expect(backend.calls).toHaveLength(0);
    });

    it('throws UnknownSigningRequestError for a request that was never submitted', async () => {
      const service = new PolicyEnforcingSigningService(
        new FakeSigningBackend(),
        policy(),
        new InMemorySpendTracker(),
        new InMemoryApprovalStore(),
      );

      await expect(service.reject('never-submitted', 'usr_approver')).rejects.toThrow(UnknownSigningRequestError);
    });

    it('throws SigningRequestAlreadyDecidedError for a request that already signed', async () => {
      const service = new PolicyEnforcingSigningService(
        new FakeSigningBackend(),
        policy(),
        new InMemorySpendTracker(),
        new InMemoryApprovalStore(),
      );

      // requiredApprovals is 1, so this signs immediately - nothing left to reject.
      await service.submit(request());
      await expect(service.reject('req_1', 'usr_someone')).rejects.toThrow(SigningRequestAlreadyDecidedError);
    });
  });

  describe('audit trail', () => {
    it('records submitted then signed for an immediate single-approval sign', async () => {
      const auditTrail = new InMemorySigningAuditTrail();
      const service = new PolicyEnforcingSigningService(
        new FakeSigningBackend(),
        policy(),
        new InMemorySpendTracker(),
        new InMemoryApprovalStore(),
        auditTrail,
      );

      await service.submit(request());

      expect(auditTrail.list('req_1').map((e) => e.type)).toEqual(['submitted', 'signed']);
    });

    it('records submitted then validation_failed, without a signed event, for a disallowed destination', async () => {
      const auditTrail = new InMemorySigningAuditTrail();
      const service = new PolicyEnforcingSigningService(
        new FakeSigningBackend(),
        policy(),
        new InMemorySpendTracker(),
        new InMemoryApprovalStore(),
        auditTrail,
      );

      await expect(service.submit(request({ toAddress: '0xnotallowed' }))).rejects.toThrow(DestinationNotAllowedError);

      expect(auditTrail.list('req_1').map((e) => e.type)).toEqual(['submitted', 'validation_failed']);
    });

    it('records the full submitted/approved/approved/signed sequence for a multi-approval request', async () => {
      const auditTrail = new InMemorySigningAuditTrail();
      const service = new PolicyEnforcingSigningService(
        new FakeSigningBackend(),
        policy({ requiredApprovals: 2 }),
        new InMemorySpendTracker(),
        new InMemoryApprovalStore(),
        auditTrail,
      );

      await service.submit(request());
      await service.approve('req_1', 'usr_approver_1');
      await service.approve('req_1', 'usr_approver_2');

      expect(auditTrail.list('req_1').map((e) => e.type)).toEqual(['submitted', 'approved', 'approved', 'signed']);
    });

    it('records rejected for a rejected request', async () => {
      const auditTrail = new InMemorySigningAuditTrail();
      const service = new PolicyEnforcingSigningService(
        new FakeSigningBackend(),
        policy({ requiredApprovals: 2 }),
        new InMemorySpendTracker(),
        new InMemoryApprovalStore(),
        auditTrail,
      );

      await service.submit(request());
      await service.reject('req_1', 'usr_approver_1', 'no');

      expect(auditTrail.list('req_1').map((e) => e.type)).toEqual(['submitted', 'rejected']);
    });

    it('never carries a raw bigint in any recorded detail', async () => {
      const auditTrail = new InMemorySigningAuditTrail();
      const service = new PolicyEnforcingSigningService(
        new FakeSigningBackend(),
        policy(),
        new InMemorySpendTracker(),
        new InMemoryApprovalStore(),
        auditTrail,
      );

      await service.submit(request());

      for (const event of auditTrail.list('req_1')) {
        expect(() => JSON.stringify(event)).not.toThrow();
      }
    });
  });
});

describe('InMemorySpendTracker', () => {
  it('excludes an entry exactly at the window cutoff, not just entries strictly before it', async () => {
    const tracker = new InMemorySpendTracker();
    const now = new Date('2026-01-01T00:10:00Z');
    const cutoff = new Date(now.getTime() - 60_000);

    await tracker.record('mch_1', 'ETHEREUM', 1_000n, cutoff);
    const total = await tracker.windowTotal('mch_1', 'ETHEREUM', 60, now);

    expect(total).toBe(0n);
  });

  it('includes an entry one millisecond inside the window', async () => {
    const tracker = new InMemorySpendTracker();
    const now = new Date('2026-01-01T00:10:00Z');
    const justInside = new Date(now.getTime() - 60_000 + 1);

    await tracker.record('mch_1', 'ETHEREUM', 1_000n, justInside);
    const total = await tracker.windowTotal('mch_1', 'ETHEREUM', 60, now);

    expect(total).toBe(1_000n);
  });

  it('keeps merchants and networks fully independent', async () => {
    const tracker = new InMemorySpendTracker();
    const now = new Date('2026-01-01T00:10:00Z');

    await tracker.record('mch_1', 'ETHEREUM', 1_000n, now);
    await tracker.record('mch_2', 'ETHEREUM', 5_000n, now);
    await tracker.record('mch_1', 'BITCOIN', 9_000n, now);

    expect(await tracker.windowTotal('mch_1', 'ETHEREUM', 3600, now)).toBe(1_000n);
  });
});

describe('InMemoryApprovalStore', () => {
  it('returns undefined for a request id that was never saved', async () => {
    const store = new InMemoryApprovalStore();
    expect(await store.get('never-saved')).toBeUndefined();
  });

  it('overwrites the previous entry when saved again under the same request id', async () => {
    const store = new InMemoryApprovalStore();
    const req = request();

    await store.save({ request: req, status: 'PENDING_APPROVAL', approvals: [] });
    await store.save({ request: req, status: 'PENDING_APPROVAL', approvals: ['usr_a'] });

    expect((await store.get(req.id))?.approvals).toEqual(['usr_a']);
  });
});
