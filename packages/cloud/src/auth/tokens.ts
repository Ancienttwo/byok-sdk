/**
 * Access tokens for the hosted device surface (docs/protocol.md §6).
 *
 * The token carries the identity TRIPLE — `(deviceId, tenantId, productId)` —
 * and all three legs are lookup keys, never authority: `authenticateBearer`
 * (`bearer.ts`) resolves them against the device directory and answers with
 * the ROW's identity. A token missing a leg is not a partially usable token;
 * it is not a token this deployment minted.
 *
 * {@link TokenSigner} is a port for the same reason `@byok/server` made it
 * one: a SaaS with an org-wide asymmetric signer or a KMS swaps its own in.
 * The reference implementation below is HS256 over a caller-supplied secret,
 * built on WebCrypto so the package stays runtime-neutral (no `jose`, no
 * `node:crypto`).
 */
import type { Clock } from '@byok/core';
import {
  base64UrlDecode,
  base64UrlEncode,
  type CryptoKeyLike,
  type KeyUsageLike,
} from '../crypto/web-crypto';

/** Access tokens are ~1h, matching the reference server (docs/protocol.md §6.1/§6.2). */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export interface AccessTokenClaims {
  readonly deviceId: string;
  /** Unbranded on the wire: the value is only a lookup key until a device row vouches for it. */
  readonly tenantId: string;
  readonly productId: string;
}

export interface TokenSigner {
  sign(claims: AccessTokenClaims, expiresInSeconds: number): Promise<string>;
  /** Claims for a valid, unexpired token, or `undefined` for invalid/expired/malformed — no reason is ever reported. */
  verify(token: string): Promise<AccessTokenClaims | undefined>;
}

interface TokenPayload {
  readonly deviceId: unknown;
  readonly tenantId: unknown;
  readonly productId: unknown;
  readonly exp: unknown;
}

function encodeSegment(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * HS256 JWT signer over `secret`.
 *
 * `clock` is injected rather than read off `Date.now()` so expiry is testable
 * and so the whole package keeps a single notion of "now" (the same one the
 * stores use for TTLs).
 */
export function createHmacTokenSigner(secret: Uint8Array, clock: Clock): TokenSigner {
  async function signingKey(usage: KeyUsageLike): Promise<CryptoKeyLike> {
    return globalThis.crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
  }

  async function signature(signingInput: string): Promise<string> {
    const key = await signingKey('sign');
    const bytes = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
    return base64UrlEncode(new Uint8Array(bytes));
  }

  return {
    async sign(claims, expiresInSeconds) {
      const issuedAt = Math.floor(clock.now().getTime() / 1000);
      const header = encodeSegment({ alg: 'HS256', typ: 'JWT' });
      const payload = encodeSegment({
        deviceId: claims.deviceId,
        tenantId: claims.tenantId,
        productId: claims.productId,
        iat: issuedAt,
        exp: issuedAt + expiresInSeconds,
      });
      const signingInput = `${header}.${payload}`;
      return `${signingInput}.${await signature(signingInput)}`;
    },

    async verify(token) {
      const parts = token.split('.');
      if (parts.length !== 3) return undefined;
      const [header, payload, provided] = parts as [string, string, string];

      const key = await signingKey('verify');
      const providedBytes = base64UrlDecode(provided);
      if (providedBytes === undefined) return undefined;
      const ok = await globalThis.crypto.subtle.verify(
        'HMAC',
        key,
        providedBytes,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      if (!ok) return undefined;

      const headerBytes = base64UrlDecode(header);
      const payloadBytes = base64UrlDecode(payload);
      if (headerBytes === undefined || payloadBytes === undefined) return undefined;

      let decodedHeader: unknown;
      let decodedPayload: TokenPayload;
      try {
        decodedHeader = JSON.parse(new TextDecoder().decode(headerBytes));
        decodedPayload = JSON.parse(new TextDecoder().decode(payloadBytes)) as TokenPayload;
      } catch {
        return undefined;
      }

      const alg = (decodedHeader as { alg?: unknown } | null)?.alg;
      if (alg !== 'HS256') return undefined;

      const { deviceId, tenantId, productId, exp } = decodedPayload;
      if (typeof deviceId !== 'string' || typeof tenantId !== 'string' || typeof productId !== 'string') {
        return undefined;
      }
      if (typeof exp !== 'number' || clock.now().getTime() / 1000 >= exp) return undefined;

      return { deviceId, tenantId, productId };
    },
  };
}
