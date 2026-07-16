import { createPublicKey, randomBytes, verify as verifyEd25519Raw } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

/**
 * Auth v2 (docs/protocol.md §6): device identity (Ed25519 keypair, public
 * half registered at pairing time), single-use nonce challenge/response for
 * token renewal, and JWT access tokens. Kept separate from `pairing.ts`
 * (which now only owns the one-time pairing-code lifecycle) because these
 * concerns span every authed surface (WSS upgrade, blob routes, events
 * long-poll), not just `POST /byok/pair`.
 */

/** Access tokens are JWTs with a ~1h lifetime (docs/protocol.md §6.1/§6.2). */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** A challenge nonce is single-use and expires after ~5min (docs/protocol.md §6.2). */
const NONCE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// TokenSigner — interface-shaped so a SaaS can supply its own signer later
// (e.g. an asymmetric org-wide signer, or one backed by a KMS) without this
// package caring how tokens are actually signed/verified. The default is an
// in-memory HS256 secret generated fresh per server instance — good enough
// for a single-process reference server, not meant to survive a restart.
// ---------------------------------------------------------------------------

export interface AccessTokenClaims {
  deviceId: string;
}

export interface TokenSigner {
  sign(claims: AccessTokenClaims, expiresInSeconds: number): Promise<string>;
  /** Returns the claims for a valid, unexpired token, or `undefined` if invalid/expired/malformed. */
  verify(token: string): Promise<AccessTokenClaims | undefined>;
}

/** Default {@link TokenSigner}: HS256 over a random 32-byte secret held in memory for this process's lifetime. */
export function createHmacTokenSigner(secret: Uint8Array = randomBytes(32)): TokenSigner {
  return {
    async sign(claims, expiresInSeconds) {
      return new SignJWT({ deviceId: claims.deviceId })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
        .sign(secret);
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret);
        if (typeof payload.deviceId !== 'string') return undefined;
        return { deviceId: payload.deviceId };
      } catch {
        return undefined;
      }
    },
  };
}

/** Mint a fresh access token + its ISO-8601 expiry, per {@link ACCESS_TOKEN_TTL_SECONDS}. */
export async function mintAccessToken(
  signer: TokenSigner,
  deviceId: string,
): Promise<{ accessToken: string; expiresAt: string }> {
  const accessToken = await signer.sign({ deviceId }, ACCESS_TOKEN_TTL_SECONDS);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  return { accessToken, expiresAt };
}

// ---------------------------------------------------------------------------
// DeviceRegistry — device identity directory: deviceId -> {deviceName,
// devicePublicKey, revoked}. Registered at `/byok/pair` time; consulted by
// every authed surface so a revoked device's JWT (even if not yet expired)
// stops working immediately (§6.3).
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  /** Ed25519 public key, base64url-encoded (JWK `x` form — see {@link verifyEd25519Signature}). */
  devicePublicKey: string;
  revoked: boolean;
}

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();

  register(deviceId: string, deviceName: string, devicePublicKey: string): void {
    this.devices.set(deviceId, { deviceId, deviceName, devicePublicKey, revoked: false });
  }

  get(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  /** `true` for both an unknown deviceId and one that's been revoked — either way, not authorized. */
  isRevokedOrUnknown(deviceId: string): boolean {
    const record = this.devices.get(deviceId);
    return !record || record.revoked;
  }

  /**
   * Revoke a device (public API via `createByokServer(...).devices.revoke`).
   * Its next `/byok/challenge`, `/byok/token`, WSS connect, or authed HTTP
   * call gets a 401; the daemon's only recourse is to re-run `/byok/pair`
   * (docs/protocol.md §6.3).
   */
  revoke(deviceId: string): void {
    const record = this.devices.get(deviceId);
    if (record) record.revoked = true;
  }

  getName(deviceId: string): string | undefined {
    return this.devices.get(deviceId)?.deviceName;
  }

  listIds(): string[] {
    return [...this.devices.keys()];
  }
}

// ---------------------------------------------------------------------------
// NonceStore — single-use challenge nonces for token renewal (§6.2).
// ---------------------------------------------------------------------------

interface NonceRecord {
  deviceId: string;
  expiresAt: number;
  used: boolean;
}

export class NonceStore {
  private readonly nonces = new Map<string, NonceRecord>();

  issue(deviceId: string): string {
    const nonce = randomBytes(24).toString('base64url');
    this.nonces.set(nonce, { deviceId, expiresAt: Date.now() + NONCE_TTL_MS, used: false });
    return nonce;
  }

  /** `true` iff `nonce` exists, belongs to `deviceId`, is unexpired, and hasn't been consumed yet. Does not mutate. */
  validate(deviceId: string, nonce: string): boolean {
    const record = this.nonces.get(nonce);
    if (!record) return false;
    if (record.used) return false;
    if (record.deviceId !== deviceId) return false;
    if (Date.now() > record.expiresAt) return false;
    return true;
  }

  /** Mark `nonce` consumed so a replay of the same (deviceId, nonce, signature) is rejected. */
  markUsed(nonce: string): void {
    const record = this.nonces.get(nonce);
    if (record) record.used = true;
  }
}

// ---------------------------------------------------------------------------
// Ed25519 signature verification (node:crypto — no new crypto dependency).
// ---------------------------------------------------------------------------

/**
 * Verify `signature` (base64url) is a valid Ed25519 signature over `message`
 * (UTF-8) made by the private key matching `devicePublicKey` (base64url raw
 * 32-byte Ed25519 public key — the same encoding as a JWK's `x` field, which
 * is how we hand it to `node:crypto` without needing DER/SPKI conversion).
 */
export function verifyEd25519Signature(devicePublicKey: string, message: string, signature: string): boolean {
  try {
    const keyObject = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: devicePublicKey },
      format: 'jwk',
    });
    return verifyEd25519Raw(null, Buffer.from(message, 'utf8'), keyObject, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bearer-token extraction + authentication shared by ws-server.ts and http.ts.
// ---------------------------------------------------------------------------

export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export interface AuthDeps {
  tokenSigner: TokenSigner;
  devices: DeviceRegistry;
}

/**
 * Resolve an `Authorization: Bearer <jwt>` header to an authenticated
 * deviceId, or `undefined` if the header is missing, the token doesn't
 * verify, or the device has since been revoked (§6.3) — the single check
 * every authed HTTP route and the WSS upgrade share.
 */
export async function authenticateBearer(header: string | undefined, deps: AuthDeps): Promise<string | undefined> {
  const token = extractBearerToken(header);
  if (!token) return undefined;
  const claims = await deps.tokenSigner.verify(token);
  if (!claims) return undefined;
  if (deps.devices.isRevokedOrUnknown(claims.deviceId)) return undefined;
  return claims.deviceId;
}
