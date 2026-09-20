import { describe, expect, it } from 'vitest';
import { EnvSecretsProvider } from '../src/index.js';

describe('EnvSecretsProvider', () => {
  it('returns a set value', () => {
    const provider = new EnvSecretsProvider({ MY_SECRET: 'value' });
    expect(provider.getSecret('MY_SECRET')).toBe('value');
    expect(provider.requireSecret('MY_SECRET')).toBe('value');
  });

  it('treats an unset variable and an empty string the same way', () => {
    const provider = new EnvSecretsProvider({ EMPTY: '' });
    expect(provider.getSecret('MISSING')).toBeUndefined();
    expect(provider.getSecret('EMPTY')).toBeUndefined();
  });

  it('requireSecret throws with the variable name in the message', () => {
    const provider = new EnvSecretsProvider({});
    expect(() => provider.requireSecret('DATABASE_URL')).toThrow(/DATABASE_URL/);
  });

  it('defaults to process.env when constructed with no arguments', () => {
    process.env.SECRETS_PROVIDER_TEST_VAR = 'from-process-env';
    const provider = new EnvSecretsProvider();
    expect(provider.getSecret('SECRETS_PROVIDER_TEST_VAR')).toBe('from-process-env');
    delete process.env.SECRETS_PROVIDER_TEST_VAR;
  });
});
