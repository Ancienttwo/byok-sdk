import { z } from 'zod';
import { canonicalBase64UrlByteLength } from './base64url.js';

/** Domain separator of {@link pairDeviceDigest}; a new digest definition takes a new namespace. */
export const PAIR_DEVICE_DIGEST_NAMESPACE = 'byok-pair-device-v1';

/** Canonical unpadded base64url of the 32-byte SHA-256 output: exactly one spelling per digest. */
export const PairDeviceDigestSchema = z
  .string()
  .refine((value) => canonicalBase64UrlByteLength(value) === 32, 'must be canonical unpadded base64url of 32 bytes');

export interface PairDeviceDigestInput {
  readonly tenantId: string;
  readonly productId: string;
  readonly deviceId: string;
}

/**
 * The pairing fence's name for one registered device (#2045, docs/protocol.md
 * §6.1): base64url SHA-256 of the UTF-8 JSON array
 * `["byok-pair-device-v1", tenantId, productId, deviceId]`. The device and
 * every store compute it with this one function.
 *
 * A JSON array of strings has one serialization, so no field can bleed into
 * its neighbour. Tenant and product salt the digest: the same device id
 * yields unrelated digests in two scopes, and a digest cannot be matched
 * across tenants. Device ids are server-minted UUIDs, so the digest cannot be
 * inverted; it only tells whether the device changed.
 */
export async function pairDeviceDigest(input: PairDeviceDigestInput): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([PAIR_DEVICE_DIGEST_NAMESPACE, input.tenantId, input.productId, input.deviceId]),
  );
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
