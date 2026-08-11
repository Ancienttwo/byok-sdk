import { describe, expect, it } from 'vitest';

import { ByokKeysError } from './errors';
import {
  isLoopbackHost,
  isLoopbackProviderUrl,
  isPrivateNetworkLiteral,
  normalizeProviderUrl,
} from './url';

const expectUrlRejected = (value: string) => {
  let thrown: unknown;
  try {
    normalizeProviderUrl(value);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ByokKeysError);
  expect((thrown as ByokKeysError).code).toBe('PROVIDER_URL_INVALID');
};

describe('normalizeProviderUrl', () => {
  it('accepts an HTTPS URL and strips the trailing slash', () => {
    expect(normalizeProviderUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('rejects plain HTTP on a public host', () => {
    expectUrlRejected('http://api.openai.com/v1');
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
  ])('allows HTTP on the loopback host %s', (value) => {
    expect(normalizeProviderUrl(value)).toBe(value);
  });

  it('rejects a relative URL', () => {
    expectUrlRejected('/v1/chat/completions');
  });

  it.each([
    'https://user:pass@api.openai.com/v1',
    'https://api.openai.com/v1?key=leak',
    'https://api.openai.com/v1#fragment',
  ])('rejects %s because credentials, query, and fragment are not allowed', (value) => {
    expectUrlRejected(value);
  });

  it.each([
    'https://10.0.0.5/v1',
    'https://192.168.1.10/v1',
    'https://172.16.0.1/v1',
    'https://172.31.255.254/v1',
    'https://169.254.169.254/v1',
    'https://[fd00::1]/v1',
  ])('rejects the private-network literal %s', (value) => {
    expectUrlRejected(value);
  });

  it.each(['https://172.15.0.1/v1', 'https://172.32.0.1/v1', 'https://8.8.8.8/v1'])(
    'accepts the public literal %s just outside the private ranges',
    (value) => {
      expect(normalizeProviderUrl(value)).toBe(value);
    },
  );

  it('accepts 127.0.0.1 over HTTPS even though 127/8 is a private literal', () => {
    expect(normalizeProviderUrl('https://127.0.0.1:8443/v1')).toBe(
      'https://127.0.0.1:8443/v1',
    );
  });
});

describe('host predicates', () => {
  it.each(['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST'])(
    'treats %s as loopback',
    (value) => {
      expect(isLoopbackHost(value)).toBe(true);
    },
  );

  it.each(['example.com', '10.0.0.1', '127.0.0.2'])(
    'does not treat %s as loopback',
    (value) => {
      expect(isLoopbackHost(value)).toBe(false);
    },
  );

  it('treats every IPv6 literal as private', () => {
    expect(isPrivateNetworkLiteral('2001:4860:4860::8888')).toBe(true);
  });

  it('does not treat a hostname as a private literal', () => {
    expect(isPrivateNetworkLiteral('api.openai.com')).toBe(false);
  });

  it('detects a loopback provider URL', () => {
    expect(isLoopbackProviderUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackProviderUrl('https://api.openai.com/v1')).toBe(false);
  });
});
