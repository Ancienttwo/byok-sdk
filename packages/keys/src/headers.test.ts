import { describe, expect, it } from 'vitest';

import { ByokKeysError } from './errors';
import { providerHeaders, requiredProviderSecret } from './headers';

const CANARY = 'sk-canary-headers-0001';

const profile = (auth_mode: 'bearer' | 'x_api_key' | 'none') =>
  ({ auth_mode, kind: 'model' }) as const;

describe('providerHeaders', () => {
  it('emits exactly accept, content-type, and authorization for bearer', () => {
    expect(providerHeaders(profile('bearer'), CANARY)).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${CANARY}`,
    });
  });

  it('emits x-api-key plus anthropic-version for x_api_key', () => {
    expect(providerHeaders(profile('x_api_key'), CANARY)).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': CANARY,
    });
  });

  it('emits only accept and content-type for none', () => {
    expect(providerHeaders(profile('none'), undefined)).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  it('does not leak the secret into a non-authenticating mode', () => {
    const headers = providerHeaders(profile('none'), CANARY);
    expect(JSON.stringify(headers)).not.toContain(CANARY);
  });

  it('formats the bearer header as "Bearer <secret>" with a single space', () => {
    const { authorization } = providerHeaders(profile('bearer'), CANARY);
    expect(authorization).toBe(`Bearer ${CANARY}`);
    expect(authorization).toMatch(/^Bearer [^ ]+$/u);
  });

  it('fails closed when bearer has no secret', () => {
    expect(() => providerHeaders(profile('bearer'), undefined)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_SECRET_MISSING' }),
    );
  });

  it('fails closed when x_api_key has no secret', () => {
    expect(() => providerHeaders(profile('x_api_key'), '')).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_SECRET_MISSING' }),
    );
  });
});

describe('requiredProviderSecret', () => {
  it('returns the secret unchanged when present', () => {
    expect(requiredProviderSecret(profile('bearer'), CANARY)).toBe(CANARY);
  });

  it('allows an absent secret when auth_mode is none', () => {
    expect(requiredProviderSecret(profile('none'), undefined)).toBeUndefined();
  });

  it('throws a ByokKeysError naming the credential store', () => {
    let thrown: unknown;
    try {
      requiredProviderSecret(profile('bearer'), undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ByokKeysError);
    expect((thrown as ByokKeysError).code).toBe('PROVIDER_SECRET_MISSING');
    expect((thrown as ByokKeysError).message).toBe(
      'model provider requires a secret in the operating-system credential store',
    );
  });
});
