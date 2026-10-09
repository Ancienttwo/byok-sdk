import { describe, expect, it } from 'vitest';
import { findEnvKeys, getProviders } from '@earendil-works/pi-ai/compat';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '../adapters/provider-credential-environment';

/**
 * #326: the deny list must cover every credential name that the pinned
 * official pi reads. An environment that answers every name makes
 * `findEnvKeys` return all candidate names of each provider, so a pi upgrade
 * that adds a name fails here instead of leaking it to a child process.
 */
describe('provider credential deny list against pinned official pi', () => {
  const denied = new Set<string>(PROVIDER_CREDENTIAL_ENV_DENY_NAMES);
  const everyName = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? 'present' : undefined) });

  it('denies every provider API key name that pi discovers', () => {
    const providers = getProviders();
    expect(providers).toContain('anthropic');
    const read = new Set(providers.flatMap((provider) => findEnvKeys(provider, everyName) ?? []));
    expect(read).toContain('ANTHROPIC_AUTH_TOKEN');
    expect([...read].filter((name) => !denied.has(name)).sort()).toEqual([]);
  });

  it('denies the ambient credentials pi reads outside the provider key map', () => {
    for (const name of ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      expect(denied.has(name), name).toBe(true);
    }
  });
});
