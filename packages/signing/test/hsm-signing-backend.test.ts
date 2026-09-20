import { describe, expect, it } from 'vitest';
import { EmulatedHsmKeyStore } from '../src/hsm-key-store.js';
import { HsmBackedSigningBackend, StaticKeyMapping } from '../src/hsm-signing-backend.js';
import { InMemorySigningAuditTrail } from '../src/audit-trail.js';
import { NoKeyMappedError, KeyNotFoundError } from '../src/errors.js';
import type { SigningRequest } from '../src/types.js';

function request(overrides: Partial<SigningRequest> = {}): SigningRequest {
  return {
    id: 'req_1',
    merchantId: 'mch_1',
    network: 'ETHEREUM',
    asset: 'USDT',
    fromAddress: '0xHotWallet',
    toAddress: '0xallowed',
    amount: 1_000_000n,
    requestedBy: 'usr_requester',
    requestedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('HsmBackedSigningBackend', () => {
  it('signs a request end to end and produces a signature verifiable against the mapped key\'s public half', async () => {
    const keyStore = new EmulatedHsmKeyStore();
    const { publicKey } = await keyStore.generateKey('key_hot_1');
    const keyMapping = new StaticKeyMapping([{ fromAddress: '0xHotWallet', network: 'ETHEREUM', keyId: 'key_hot_1' }]);
    const auditTrail = new InMemorySigningAuditTrail();
    const backend = new HsmBackedSigningBackend(keyStore, keyMapping, auditTrail);

    const req = request();
    const signed = await backend.sign(req);

    expect(signed.requestId).toBe(req.id);
    expect(signed.rawTxHex.startsWith('0x')).toBe(true);
    const signature = Buffer.from(signed.rawTxHex.slice(2), 'hex');
    const digest = HsmBackedSigningBackend.canonicalDigest(req);
    expect(EmulatedHsmKeyStore.verify(publicKey, digest, signature)).toBe(true);
  });

  it('matches the key mapping case-insensitively on the from-address', async () => {
    const keyStore = new EmulatedHsmKeyStore();
    await keyStore.generateKey('key_hot_1');
    const keyMapping = new StaticKeyMapping([{ fromAddress: '0xhotwallet', network: 'ETHEREUM', keyId: 'key_hot_1' }]);
    const backend = new HsmBackedSigningBackend(keyStore, keyMapping, new InMemorySigningAuditTrail());

    await expect(backend.sign(request({ fromAddress: '0xHOTWALLET' }))).resolves.toBeDefined();
  });

  it('throws NoKeyMappedError, without touching the key store, when the source address has no mapped key', async () => {
    const keyStore = new EmulatedHsmKeyStore();
    const backend = new HsmBackedSigningBackend(keyStore, new StaticKeyMapping(), new InMemorySigningAuditTrail());

    await expect(backend.sign(request())).rejects.toThrow(NoKeyMappedError);
  });

  it('records a key_used audit event containing the key id but never key material', async () => {
    const keyStore = new EmulatedHsmKeyStore();
    await keyStore.generateKey('key_hot_1');
    const keyMapping = new StaticKeyMapping([{ fromAddress: '0xHotWallet', network: 'ETHEREUM', keyId: 'key_hot_1' }]);
    const auditTrail = new InMemorySigningAuditTrail();
    const backend = new HsmBackedSigningBackend(keyStore, keyMapping, auditTrail);

    await backend.sign(request());

    const events = auditTrail.list('req_1');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('key_used');
    expect(events[0]?.detail).toEqual({ keyId: 'key_hot_1', network: 'ETHEREUM' });
    expect(JSON.stringify(events[0])).not.toMatch(/private/i);
  });

  it('records a sign_failed audit event and rethrows when the mapped key does not exist in the store', async () => {
    const keyStore = new EmulatedHsmKeyStore();
    const keyMapping = new StaticKeyMapping([{ fromAddress: '0xHotWallet', network: 'ETHEREUM', keyId: 'key_never_generated' }]);
    const auditTrail = new InMemorySigningAuditTrail();
    const backend = new HsmBackedSigningBackend(keyStore, keyMapping, auditTrail);

    await expect(backend.sign(request())).rejects.toThrow(KeyNotFoundError);
    const events = auditTrail.list('req_1');
    expect(events.map((e) => e.type)).toEqual(['sign_failed']);
  });

  it('produces the same canonical digest for the same request and a different one for a different amount', () => {
    const digestA = HsmBackedSigningBackend.canonicalDigest(request());
    const digestB = HsmBackedSigningBackend.canonicalDigest(request());
    const digestC = HsmBackedSigningBackend.canonicalDigest(request({ amount: 2_000_000n }));

    expect(digestA).toEqual(digestB);
    expect(digestA).not.toEqual(digestC);
  });
});
