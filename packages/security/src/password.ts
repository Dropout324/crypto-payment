import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id, not bcrypt: it resists both GPU and side-channel attack, and the
 * cost parameters are explicit rather than a single opaque round count. The
 * defaults below follow OWASP's minimum for Argon2id (19 MiB, t=2, p=1).
 *
 * The encoded hash carries its own parameters, so raising the cost later does
 * not invalidate existing hashes - `needsRehash` detects them on next login.
 */

export interface Argon2Params {
  memoryCostKib: number;
  timeCost: number;
  parallelism: number;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memoryCostKib: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function argon2ParamsFromEnv(env: NodeJS.ProcessEnv = process.env): Argon2Params {
  const params: Argon2Params = {
    memoryCostKib: Number(env.ARGON2_MEMORY_KIB ?? DEFAULT_ARGON2_PARAMS.memoryCostKib),
    timeCost: Number(env.ARGON2_TIME_COST ?? DEFAULT_ARGON2_PARAMS.timeCost),
    parallelism: Number(env.ARGON2_PARALLELISM ?? DEFAULT_ARGON2_PARAMS.parallelism),
  };

  // Refuse to start with parameters weaker than the OWASP floor: a typo in an
  // env var must not quietly downgrade every password in the system.
  if (params.memoryCostKib < 19_456 || params.timeCost < 2 || params.parallelism < 1) {
    throw new Error(
      `Argon2 parameters below the accepted minimum (m>=19456, t>=2, p>=1): ${JSON.stringify(params)}`,
    );
  }

  return params;
}

export async function hashPassword(
  plaintext: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  // Argon2 has no practical input length limit, but an unbounded password is a
  // cheap way to burn CPU on every login attempt.
  if (Buffer.byteLength(plaintext, 'utf8') > 1024) {
    throw new Error('password exceeds 1024 bytes');
  }

  return hash(plaintext, {
    algorithm: Algorithm.Argon2id,
    memoryCost: params.memoryCostKib,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}

/**
 * Verify a password. Returns false for a malformed or unknown-format hash
 * rather than throwing, so a corrupt row cannot be distinguished from a wrong
 * password by an attacker watching error behaviour.
 */
export async function verifyPassword(plaintext: string, encodedHash: string): Promise<boolean> {
  if (!plaintext || !encodedHash) return false;
  try {
    return await verify(encodedHash, plaintext);
  } catch {
    return false;
  }
}

/** True when the stored hash was produced with weaker parameters than current. */
export function needsRehash(encodedHash: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): boolean {
  const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encodedHash);
  if (!match) return true;

  const [, memory, time, parallelism] = match;
  return (
    Number(memory) < params.memoryCostKib ||
    Number(time) < params.timeCost ||
    Number(parallelism) < params.parallelism
  );
}
