import { ByokKeysError } from './errors';

/**
 * Normalize a provider base URL, fail-closed.
 *
 * Ported from `aip-main-open@c6a5385` `providers.ts:1558-1588` plus the two
 * host predicates at `:2216-2242`. Rules, unchanged:
 * - must be an absolute URL;
 * - no embedded credentials, no fragment, no query string;
 * - HTTPS only, except that HTTP is allowed for loopback hosts;
 * - private-network literals are rejected unless they are loopback;
 * - one trailing slash is stripped.
 */
export function normalizeProviderUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ByokKeysError(
      'PROVIDER_URL_INVALID',
      'Provider base URL must be absolute',
    );
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHost(url.hostname)))
  ) {
    throw new ByokKeysError(
      'PROVIDER_URL_INVALID',
      'Provider URL requires HTTPS; HTTP is allowed only for localhost',
    );
  }
  if (isPrivateNetworkLiteral(url.hostname) && !isLoopbackHost(url.hostname)) {
    throw new ByokKeysError(
      'PROVIDER_URL_INVALID',
      'Private-network provider IPs are not allowed',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

/** Whether an already-parseable provider URL points at a loopback host. */
export function isLoopbackProviderUrl(value: string): boolean {
  return isLoopbackHost(new URL(value).hostname);
}

export function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

/**
 * Conservative private-network literal check. Any IPv6 literal counts as
 * private (the `:` branch), matching the source: the guard cannot cheaply
 * classify IPv6 ranges, so it refuses all of them and lets hostnames through.
 */
export function isPrivateNetworkLiteral(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (value.includes(':')) return true;
  const parts = value.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}
