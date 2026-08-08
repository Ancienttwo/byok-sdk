import { ByokKeysError } from './errors';
import type { ProviderAuthMode } from './provider-profile';

/** The subset of a profile the header builder reads. */
export interface ProviderAuthProfile {
  auth_mode: ProviderAuthMode;
  kind: string;
}

/**
 * Fail-closed secret check. Ported from `aip-main-open@c6a5385`
 * `providers.ts:1657-1671`: a profile that declares `bearer` or `x_api_key`
 * must have a secret, or the request is refused rather than sent unauthenticated.
 */
export function requiredProviderSecret(
  profile: ProviderAuthProfile,
  secret: string | undefined,
): string | undefined {
  if (
    (profile.auth_mode === 'bearer' || profile.auth_mode === 'x_api_key') &&
    !secret
  ) {
    throw new ByokKeysError(
      'PROVIDER_SECRET_MISSING',
      `${profile.kind} provider requires a secret in the operating-system credential store`,
    );
  }
  return secret;
}

/**
 * Build the outbound request headers for a provider call. Key-for-key
 * equivalent to `providers.ts:1680-1697`:
 * - always `accept` and `content-type`;
 * - `bearer` adds `authorization: Bearer <secret>`;
 * - `x_api_key` adds `x-api-key: <secret>` and `anthropic-version: 2023-06-01`;
 * - `none` adds nothing.
 */
export function providerHeaders(
  profile: ProviderAuthProfile,
  secret: string | undefined,
): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(profile.auth_mode === 'bearer'
      ? { authorization: `Bearer ${requiredProviderSecret(profile, secret)}` }
      : {}),
    ...(profile.auth_mode === 'x_api_key'
      ? {
          'anthropic-version': '2023-06-01',
          'x-api-key': requiredProviderSecret(profile, secret) as string,
        }
      : {}),
  };
}
