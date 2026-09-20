/**
 * Secrets management (Phase 8) - the seam a real KMS/Vault-backed secrets
 * store plugs into.
 *
 * This is deliberately distinct from `KeyProvider` (`encryption.ts`):
 * `KeyProvider` answers "which raw key bytes encrypt/decrypt application
 * data, with rotation by key id" - a narrow, high-frequency operation this
 * process calls on every webhook-secret read/write. `SecretsProvider`
 * answers "what is the value of this named secret" - JWT signing secrets,
 * database/Redis connection strings, third-party API keys - read once at
 * boot via `loadConfig()`, never on a hot path.
 *
 * `EnvSecretsProvider` (below) is the only implementation shipped here: it
 * reads `process.env`, which is where every secret in this codebase comes
 * from today. A production deployment swaps this one object for one backed
 * by AWS Secrets Manager, GCP Secret Manager, or Vault - `loadConfig()`
 * neither knows nor cares which, because it only ever calls this interface.
 * No such backend is implemented here: doing so without a real account to
 * integration-test against would be unverified code shipped as if it
 * worked, which is worse than an honest gap.
 */
export interface SecretsProvider {
  /** `undefined` if unset - the caller decides whether that's fatal. */
  getSecret(name: string): string | undefined;
  /** Throws if unset. Use for anything the process cannot safely start without. */
  requireSecret(name: string): string;
}

export class EnvSecretsProvider implements SecretsProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  getSecret(name: string): string | undefined {
    const value = this.env[name];
    return value === undefined || value === '' ? undefined : value;
  }

  requireSecret(name: string): string {
    const value = this.getSecret(name);
    if (value === undefined) {
      throw new Error(`missing required environment variable: ${name}`);
    }
    return value;
  }
}
