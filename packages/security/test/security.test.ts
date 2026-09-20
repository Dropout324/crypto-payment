import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARGON2_PARAMS,
  EncryptionError,
  EnvKeyProvider,
  REDACTED,
  argon2ParamsFromEnv,
  ciphertextKeyId,
  computeSignature,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  generateOpaqueToken,
  generateWebhookSecret,
  hashPassword,
  isSensitiveKey,
  maskCredential,
  needsRehash,
  parseApiKey,
  redact,
  secretFingerprint,
  sha256Hex,
  signJwt,
  signWebhook,
  verifyApiKeySecret,
  verifyJwt,
  verifyPassword,
  verifyWebhookSignature,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

describe('password hashing', () => {
  it('hashes and verifies with argon2id', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('never produces the same hash twice for the same password', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b); // per-hash salt
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('', 'irrelevant')).toBe(false);
  });

  it('rejects an unbounded password instead of burning CPU', async () => {
    await expect(hashPassword('a'.repeat(2000))).rejects.toThrow(/1024 bytes/);
  });

  it('refuses argon2 parameters below the OWASP floor', () => {
    expect(() => argon2ParamsFromEnv({ ARGON2_MEMORY_KIB: '1024' })).toThrow(/below the accepted minimum/);
    expect(() => argon2ParamsFromEnv({ ARGON2_TIME_COST: '1' })).toThrow(/below the accepted minimum/);
    expect(argon2ParamsFromEnv({})).toEqual(DEFAULT_ARGON2_PARAMS);
  });

  it('detects hashes that predate a cost increase', async () => {
    const hash = await hashPassword('x', { memoryCostKib: 19_456, timeCost: 2, parallelism: 1 });
    expect(needsRehash(hash)).toBe(false);
    expect(needsRehash(hash, { memoryCostKib: 65_536, timeCost: 3, parallelism: 1 })).toBe(true);
    expect(needsRehash('$2b$12$legacybcrypthash')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

describe('API keys', () => {
  it('splits into a public prefix and a hashed secret', async () => {
    const key = await generateApiKey('live');

    expect(key.keyPrefix.startsWith('pk_live_')).toBe(true);
    expect(key.plaintext.startsWith(`${key.keyPrefix}.`)).toBe(true);
    expect(key.livemode).toBe(true);

    // The stored hash must not contain the secret.
    const secret = key.plaintext.slice(key.keyPrefix.length + 1);
    expect(key.secretHash).not.toContain(secret);
    expect(await verifyApiKeySecret(secret, key.secretHash)).toBe(true);
    expect(await verifyApiKeySecret('wrong-secret', key.secretHash)).toBe(false);
  });

  it('marks test keys distinctly', async () => {
    const key = await generateApiKey('test');
    expect(key.keyPrefix.startsWith('pk_test_')).toBe(true);
    expect(key.livemode).toBe(false);
  });

  it('generates unique credentials', async () => {
    const keys = await Promise.all(Array.from({ length: 20 }, () => generateApiKey('test')));
    expect(new Set(keys.map((k) => k.keyPrefix)).size).toBe(20);
    expect(new Set(keys.map((k) => k.plaintext)).size).toBe(20);
  });

  it('parses a well-formed credential', async () => {
    const key = await generateApiKey('live');
    const parsed = parseApiKey(key.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyPrefix).toBe(key.keyPrefix);
    expect(parsed?.livemode).toBe(true);
  });

  it.each([
    '',
    'garbage',
    'pk_live_abc',
    'pk_live_abcdefgh.short',
    'pk_prod_abcdefgh.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'pk_live_abcdefgh.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extra',
    'Bearer pk_live_abcdefgh.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ])('rejects malformed credential %j before touching the database', (input) => {
    expect(parseApiKey(input)).toBeNull();
  });

  it('fingerprints a secret without revealing it', () => {
    const secret = generateWebhookSecret();
    const fingerprint = secretFingerprint(secret);
    expect(fingerprint).toHaveLength(16);
    expect(secret).not.toContain(fingerprint);
    expect(secretFingerprint(secret)).toBe(fingerprint);
  });

  it('stores only the hash of an opaque session token', () => {
    const { token, tokenHash } = generateOpaqueToken();
    expect(tokenHash).toBe(sha256Hex(token));
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret_value';
  const body = JSON.stringify({
    event: 'payment.paid',
    id: 'evt_01',
    data: { invoice_id: 'inv_01', amount: '100.000000' },
  });

  it('signs and verifies a payload', () => {
    const now = 1_770_000_000;
    const signed = signWebhook(secret, body, now);
    expect(signed.signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    const result = verifyWebhookSignature(secret, body, signed.signature, { nowSeconds: now });
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = 1_770_000_000;
    const signed = signWebhook(secret, body, now);
    const tampered = body.replace('100.000000', '999.000000');

    const result = verifyWebhookSignature(secret, tampered, signed.signature, { nowSeconds: now });
    expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects a forged signature made with the wrong secret', () => {
    const now = 1_770_000_000;
    const forged = signWebhook('attacker-secret', body, now);
    const result = verifyWebhookSignature(secret, body, forged.signature, { nowSeconds: now });
    expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects a replayed signature outside the window', () => {
    const signedAt = 1_770_000_000;
    const signed = signWebhook(secret, body, signedAt);

    // Same bytes, same signature, presented an hour later.
    const result = verifyWebhookSignature(secret, body, signed.signature, {
      nowSeconds: signedAt + 3600,
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_range' });
  });

  it('rejects a signature timestamped in the future', () => {
    const now = 1_770_000_000;
    const signed = signWebhook(secret, body, now + 3600);
    const result = verifyWebhookSignature(secret, body, signed.signature, {
      nowSeconds: now,
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_range' });
  });

  it('cannot be replayed by swapping in a fresh timestamp', () => {
    const signedAt = 1_770_000_000;
    const signed = signWebhook(secret, body, signedAt);
    const digest = signed.signature.split('v1=')[1];

    // The attacker keeps the old digest but claims it is current.
    const forgedHeader = `t=${signedAt + 3600},v1=${digest}`;
    const result = verifyWebhookSignature(secret, body, forgedHeader, {
      nowSeconds: signedAt + 3600,
    });
    expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('accepts the previous secret during rotation', () => {
    const now = 1_770_000_000;
    const oldSecret = 'whsec_old';
    const newSecret = 'whsec_new';
    const signed = signWebhook(oldSecret, body, now);

    expect(
      verifyWebhookSignature(newSecret, body, signed.signature, { nowSeconds: now }),
    ).toEqual({ valid: false, reason: 'signature_mismatch' });

    const result = verifyWebhookSignature(newSecret, body, signed.signature, {
      nowSeconds: now,
      previousSecret: oldSecret,
    });
    expect(result).toEqual({ valid: true, timestamp: now, usedPreviousSecret: true });
  });

  it.each([
    '',
    'garbage',
    'v1=abc',
    't=abc,v1=' + 'a'.repeat(64),
    't=1770000000',
    't=1770000000,v1=tooshort',
    't=1770000000,v2=' + 'a'.repeat(64),
  ])('rejects malformed header %j', (header) => {
    const result = verifyWebhookSignature(secret, body, header, { nowSeconds: 1_770_000_000 });
    expect(result.valid).toBe(false);
  });

  it('binds the signature to the timestamp', () => {
    const a = computeSignature(secret, `1000.${body}`);
    const b = computeSignature(secret, `2000.${body}`);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

describe('secret encryption', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const provider = new EnvKeyProvider({ ENCRYPTION_KEY: key, ENCRYPTION_KEY_ID: 'k1' });

  it('round-trips a secret', () => {
    const secret = generateWebhookSecret();
    const encrypted = encryptSecret(secret, provider);

    expect(encrypted.startsWith('v1.k1.')).toBe(true);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted, provider)).toBe(secret);
  });

  it('produces different ciphertext each time', () => {
    const a = encryptSecret('same-value', provider);
    const b = encryptSecret('same-value', provider);
    expect(a).not.toBe(b); // random IV
    expect(decryptSecret(a, provider)).toBe(decryptSecret(b, provider));
  });

  it('detects tampering with the ciphertext', () => {
    const encrypted = encryptSecret('sensitive', provider);
    const parts = encrypted.split('.');
    const flipped = Buffer.from(parts[4] as string, 'base64url');
    flipped[0] = (flipped[0] as number) ^ 0xff;
    parts[4] = flipped.toString('base64url');

    expect(() => decryptSecret(parts.join('.'), provider)).toThrow(EncryptionError);
  });

  it('detects a swapped key id', () => {
    const encrypted = encryptSecret('sensitive', provider);
    const twoKeyProvider = new EnvKeyProvider({
      ENCRYPTION_KEY: key,
      ENCRYPTION_KEY_ID: 'k2',
      ENCRYPTION_KEY_RETIRED: `k1:${key}`,
    });

    // Same key material under a different id: the AAD binding must reject it.
    const relabelled = encrypted.replace('v1.k1.', 'v1.k2.');
    expect(() => decryptSecret(relabelled, twoKeyProvider)).toThrow(/failed authentication/);
  });

  it('still decrypts ciphertext written by a retired key', () => {
    const oldKey = Buffer.alloc(32, 1).toString('base64');
    const oldProvider = new EnvKeyProvider({ ENCRYPTION_KEY: oldKey, ENCRYPTION_KEY_ID: 'old' });
    const encrypted = encryptSecret('legacy-secret', oldProvider);

    const rotated = new EnvKeyProvider({
      ENCRYPTION_KEY: key,
      ENCRYPTION_KEY_ID: 'new',
      ENCRYPTION_KEY_RETIRED: `old:${oldKey}`,
    });

    expect(ciphertextKeyId(encrypted)).toBe('old');
    expect(decryptSecret(encrypted, rotated)).toBe('legacy-secret');
    expect(encryptSecret('fresh', rotated).startsWith('v1.new.')).toBe(true);
  });

  it('refuses a key of the wrong length', () => {
    expect(
      () => new EnvKeyProvider({ ENCRYPTION_KEY: 'c2hvcnQ=', ENCRYPTION_KEY_ID: 'k1' }),
    ).toThrow(/must decode to 32 bytes/);
  });

  it.each(['', 'v1.k1', 'v9.k1.a.b.c', 'not.even.close.to.valid'])(
    'rejects malformed ciphertext %j',
    (input) => {
      expect(() => decryptSecret(input, provider)).toThrow(EncryptionError);
    },
  );
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('log redaction', () => {
  it('redacts sensitive field names', () => {
    const result = redact({
      email: 'merchant@example.com',
      password: 'hunter2',
      apiKey: 'pk_live_abc.secret',
      webhook_secret: 'whsec_xyz',
      authorization: 'Bearer abc',
      privateKey: '0xdead',
      amount: '100.00',
    }) as Record<string, unknown>;

    expect(result.email).toBe('merchant@example.com');
    expect(result.amount).toBe('100.00');
    expect(result.password).toBe(REDACTED);
    expect(result.apiKey).toBe(REDACTED);
    expect(result.webhook_secret).toBe(REDACTED);
    expect(result.authorization).toBe(REDACTED);
    expect(result.privateKey).toBe(REDACTED);
  });

  it('redacts credential-shaped values found in innocent fields', () => {
    const result = redact({
      message: 'request failed for key pk_live_abcdefgh.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }) as Record<string, string>;

    expect(result.message).toContain(REDACTED);
    expect(result.message).not.toContain('pk_live_abcdefgh');
  });

  it('redacts a seed phrase even in a harmless field name', () => {
    const mnemonic =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const result = redact({ note: mnemonic }) as Record<string, string>;
    expect(result.note).toBe(REDACTED);
  });

  it('redacts nested structures', () => {
    const result = redact({
      merchant: { id: 'mch_1', credentials: { secret: 's3cr3t' } },
      items: [{ token: 'abc' }, { safe: 'value' }],
    }) as { merchant: { credentials: unknown }; items: Array<Record<string, unknown>> };

    expect(result.merchant.credentials).toBe(REDACTED);
    expect(result.items[0]?.token).toBe(REDACTED);
    expect(result.items[1]?.safe).toBe('value');
  });

  it('survives cycles and bounds depth', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect((redact(cyclic) as Record<string, unknown>).self).toBe('[Circular]');

    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain('MAX_DEPTH');
  });

  it('serialises bigint amounts without throwing', () => {
    const result = redact({ units: 100_000_000n }) as Record<string, string>;
    expect(result.units).toBe('100000000');
  });

  it('recognises sensitive key names', () => {
    for (const key of ['password', 'apiKey', 'api_key', 'PRIVATE_KEY', 'mnemonic', 'xprv']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['amount', 'invoiceId', 'network', 'email']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('masks a credential for display', () => {
    expect(maskCredential('pk_live_abcdefgh.secretpart')).toBe('pk_live_abcd...');
    expect(maskCredential('short')).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Session JWTs
// ---------------------------------------------------------------------------

describe('jwt', () => {
  const opts = { expiresInSeconds: 900, issuer: 'gateway-test', audience: 'gateway-dashboard' };

  it('signs and verifies a round trip', () => {
    const token = signJwt({ sub: 'usr_123', email: 'a@b.test' }, 'secret', opts);
    const claims = verifyJwt<{ sub: string; email: string }>(token, 'secret', opts);
    expect(claims.sub).toBe('usr_123');
    expect(claims.email).toBe('a@b.test');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signJwt({ sub: 'usr_123' }, 'secret-a', opts);
    expect(() => verifyJwt(token, 'secret-b', opts)).toThrow(/signature mismatch/);
  });

  it('rejects a tampered payload', () => {
    const token = signJwt({ sub: 'usr_123' }, 'secret', opts);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'usr_999' }), 'utf8').toString('base64url');
    expect(() => verifyJwt(`${header}.${forgedPayload}.${signature}`, 'secret', opts)).toThrow(/signature mismatch/);
  });

  it('rejects an expired token', () => {
    const token = signJwt({ sub: 'usr_123' }, 'secret', { ...opts, expiresInSeconds: -1 });
    expect(() => verifyJwt(token, 'secret', opts)).toThrow(/expired/);
  });

  it('rejects a wrong issuer or audience', () => {
    const token = signJwt({ sub: 'usr_123' }, 'secret', opts);
    expect(() => verifyJwt(token, 'secret', { ...opts, issuer: 'someone-else' })).toThrow(/issuer mismatch/);
    expect(() => verifyJwt(token, 'secret', { ...opts, audience: 'someone-else' })).toThrow(/audience mismatch/);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyJwt('not-a-jwt', 'secret', opts)).toThrow(/malformed token/);
    expect(() => verifyJwt('a.b', 'secret', opts)).toThrow(/malformed token/);
  });
});
