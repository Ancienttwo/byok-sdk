import { createPublicKey, randomBytes, verify as verifyEd25519Raw } from 'node:crypto';
import { nonceSigningBytes } from '@byok-sdk/core';
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

/**
 * S1 (GAP-004): the domain-separation prefix a device signs along with a
 * challenge nonce. The device key is a long-lived identity key that later
 * planes (S6 device proof) will also sign structured messages with; without a
 * domain tag, a signature produced for one purpose is a valid signature for
 * another, and an attacker who can get a device to sign anything shaped like
 * a nonce holds a token-renewal credential.
 *
 * The literal lives in `@byok-sdk/core` (`src/pairing.ts`) and the client signs
 * the same binding (`packages/client/src/daemon/device-keys.ts`) — it used to
 * be three copies, each commented as byte-identical to the other two, which is
 * an agreement that holds only until someone edits one. Re-exported here so
 * this module's public surface is unchanged.
 *
 * There is deliberately no dual mode: a raw, unprefixed nonce signature is
 * simply invalid here, with no flag, fallback, or grace window that would
 * make the old encoding acceptable again. Because the four packages have no
 * published compatibility contract yet, the recovery path for a device on
 * the old encoding is a re-pair, not a server-side shim.
 */
export { NONCE_SIGNING_DOMAIN } from '@byok-sdk/core';

// ---------------------------------------------------------------------------
// TokenSigner — interface-shaped so a SaaS can supply its own signer later
// (e.g. an asymmetric org-wide signer, or one backed by a KMS) without this
// package caring how tokens are actually signed/verified. The default is an
// in-memory HS256 secret generated fresh per server instance — good enough
// for a single-process reference server, not meant to survive a restart.
// ---------------------------------------------------------------------------

/**
 * S1: server-local tenant identifier. A plain string alias for now — S2 moves
 * the branded/shared form into `@byok-sdk/core`, which does not exist yet, and
 * depending on an unbuilt package would be worse than naming the concept
 * here. What matters at this stage is that every identity-carrying shape in
 * this package names the tenant explicitly and required, never optional.
 */
export type TenantId = string;

/**
 * S1: an access token binds a device to the tenant AND product its row was
 * paired into. All three are required — there is no tenant-less token shape.
 * These are LOOKUP KEYS, not authority: `authenticateBearer` resolves them
 * against the device registry and answers with the ROW's identity (see
 * {@link AuthenticatedDevice}).
 */
export interface AccessTokenClaims {
  deviceId: string;
  tenantId: TenantId;
  productId: string;
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
      return new SignJWT({ deviceId: claims.deviceId, tenantId: claims.tenantId, productId: claims.productId })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
        .sign(secret);
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret);
        // A token missing any leg of the identity triple is not a
        // partially-usable token — it is not a token this server minted.
        if (typeof payload.deviceId !== 'string') return undefined;
        if (typeof payload.tenantId !== 'string') return undefined;
        if (typeof payload.productId !== 'string') return undefined;
        return { deviceId: payload.deviceId, tenantId: payload.tenantId, productId: payload.productId };
      } catch {
        return undefined;
      }
    },
  };
}

/** Mint a fresh access token + its ISO-8601 expiry, per {@link ACCESS_TOKEN_TTL_SECONDS}. */
export async function mintAccessToken(
  signer: TokenSigner,
  claims: AccessTokenClaims,
): Promise<{ accessToken: string; expiresAt: string }> {
  const accessToken = await signer.sign(claims, ACCESS_TOKEN_TTL_SECONDS);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  return { accessToken, expiresAt };
}

// ---------------------------------------------------------------------------
// DeviceRegistry — device identity directory, keyed by (tenantId, deviceId).
// Registered at `/byok/pair` time from the redeemed pairing-code claims;
// consulted by every authed surface so a revoked device's JWT (even if not
// yet expired) stops working immediately (§6.3) — revocation deletes the row,
// so the lookup that used to find a flagged row now finds nothing.
//
// S1: every lookup that has a tenant in scope MUST pass it — the composite
// key is the lookup, not a post-hoc comparison, so a token whose tenant does
// not own the device simply finds nothing. The one exception is
// `resolveByDeviceId`, kept off this package's public entry point on purpose;
// see its own doc comment.
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  /** S1: the tenant this device was paired into. Comes from the pairing-code claims and is never client-supplied. */
  tenantId: TenantId;
  /** S1: the product this device was paired into — checked against `conn.hello.productId` and against every token's claims. */
  productId: string;
  deviceId: string;
  deviceName: string;
  /** Ed25519 public key, base64url-encoded (JWK `x` form — see {@link verifyEd25519Signature}). */
  devicePublicKey: string;
}

/**
 * Everything `POST /byok/pair` knows at registration time — which is the whole
 * row. Revocation DELETES the registration (§6.3), so there is no lifecycle
 * flag for the registry to own on top of what pairing supplies.
 */
export type DeviceRegistration = DeviceRecord;

export class DeviceRegistry {
  /** Keyed by {@link DeviceRegistry.key} — `(tenantId, deviceId)`. */
  private readonly devices = new Map<string, DeviceRecord>();
  /**
   * Secondary index over the SAME record objects, for the two pre-tenant
   * endpoints only (see {@link resolveByDeviceId}). It holds the same record
   * objects rather than copies, and {@link revoke} removes the entry here in
   * the same call that removes the composite-key one — a stale entry left
   * behind would be a deleted device that can still get a token.
   */
  private readonly byDeviceId = new Map<string, DeviceRecord>();

  private static key(tenantId: TenantId, deviceId: string): string {
    // NUL separator: neither a tenantId nor a deviceId can contain one, so no
    // pair of distinct identities can collide onto the same key.
    return `${tenantId}\u0000${deviceId}`;
  }

  /**
   * Write a device row. Every identity field is required by
   * {@link DeviceRegistration}, so a row with no tenant cannot be constructed
   * — which is the whole point of S1.
   */
  register(device: DeviceRegistration): void {
    const record: DeviceRecord = { ...device };
    this.devices.set(DeviceRegistry.key(record.tenantId, record.deviceId), record);
    this.byDeviceId.set(record.deviceId, record);
  }

  /** The row `tenantId` owns under `deviceId`, or `undefined` — including when the device exists under a DIFFERENT tenant. */
  get(tenantId: TenantId, deviceId: string): DeviceRecord | undefined {
    return this.devices.get(DeviceRegistry.key(tenantId, deviceId));
  }

  /**
   * Revoke a device (public API via `createByokServer(...).devices.revoke`).
   * Revocation DELETES the registration (docs/protocol.md §6.3): afterwards
   * the device id is byte-for-byte one that was never registered — absent
   * from {@link list}, resolving to nothing on the pre-tenant
   * `/byok/challenge` and `/byok/token` paths, and a 401 on every authed
   * surface. The daemon's only recourse is to re-run `/byok/pair`.
   *
   * There is deliberately no retained `revoked` row: a flag every read path
   * has to remember to exclude is a second way to represent "not a
   * principal", and the first read path that forgets it is a live credential.
   *
   * A tenant can only revoke its own devices: a (tenantId, deviceId) pair it
   * does not own resolves to nothing, deletes nothing, and is silently
   * indistinguishable from revoking one that never existed.
   *
   * Returns whether a row was actually removed — the composition in
   * `index.ts` uses it to delete the device-scoped state that only existed to
   * serve that row (nonces, presence, dedup), so a no-op revoke touches
   * nothing at all.
   */
  revoke(tenantId: TenantId, deviceId: string): boolean {
    const record = this.get(tenantId, deviceId);
    if (!record) return false;
    this.devices.delete(DeviceRegistry.key(tenantId, deviceId));
    // The secondary index holds the SAME object; drop it only if it still
    // points at this row (a re-pair could have replaced it).
    if (this.byDeviceId.get(deviceId) === record) this.byDeviceId.delete(deviceId);
    return true;
  }

  /** Every known device row, across tenants — the in-process read model behind `ByokServer.machines.list()`. */
  list(): DeviceRecord[] {
    return [...this.devices.values()];
  }

  /**
   * Resolve a device by its globally-unique id alone, WITHOUT a tenant in
   * scope. Exists for exactly two callers — `POST /byok/challenge` and
   * `POST /byok/token` — because those two carry no tenant at all: their
   * request DTOs are the pinned wire contract (docs/protocol.md §6.2), the
   * device authenticates by key possession, and the row itself is what tells
   * the server which tenant to mint the next token for. Everything with a
   * token (and therefore a tenant) in scope goes through {@link get}.
   *
   * Deliberately NOT re-exported from this package's entry point (`index.ts`
   * exports no naked-lookup surface at all), so no embedder can turn it into
   * a cross-tenant device oracle: the only reachable public device surface is
   * tenant-first.
   */
  resolveByDeviceId(deviceId: string): DeviceRecord | undefined {
    return this.byDeviceId.get(deviceId);
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

  /** Number of nonce records currently held (post-sweep). Exposed for tests only. */
  get size(): number {
    return this.nonces.size;
  }

  /**
   * Drop every used or expired record. A long-lived server never calls this
   * on a timer, so `issue()` sweeps inline — a full-Map scan is fine at
   * reference-impl scale (single-digit nonces per device, ~5min TTL).
   */
  private sweep(now: number): void {
    for (const [nonce, record] of this.nonces) {
      if (record.used || record.expiresAt <= now) {
        this.nonces.delete(nonce);
      }
    }
  }

  issue(deviceId: string): string {
    const now = Date.now();
    this.sweep(now);
    const nonce = randomBytes(24).toString('base64url');
    this.nonces.set(nonce, { deviceId, expiresAt: now + NONCE_TTL_MS, used: false });
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

  /**
   * Drop every nonce outstanding for `deviceId` — called when the device's
   * registration is deleted (§6.3 revocation). An unspent challenge is state
   * that only existed to serve a row the directory can no longer name, so it
   * goes with the row rather than sitting until its TTL sweeps it.
   */
  deleteForDevice(deviceId: string): void {
    for (const [nonce, record] of this.nonces) {
      if (record.deviceId === deviceId) this.nonces.delete(nonce);
    }
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
 * made by the private key matching `devicePublicKey` (base64url raw 32-byte
 * Ed25519 public key — the same encoding as a JWK's `x` field, which is how we
 * hand it to `node:crypto` without needing DER/SPKI conversion).
 */
function verifyEd25519Signature(devicePublicKey: string, message: Uint8Array, signature: string): boolean {
  try {
    const keyObject = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: devicePublicKey },
      format: 'jwk',
    });
    return verifyEd25519Raw(null, message, keyObject, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * The ONLY nonce-signature check on this server (§6.2): the signed message is
 * core's `nonceSigningBytes` — the domain followed by the nonce. Applying the
 * domain here rather than at the call site is the point — there is one place
 * that decides what a device signature over a nonce means, so no route can be
 * written that accepts the undomained form.
 */
export function verifyNonceSignature(devicePublicKey: string, nonce: string, signature: string): boolean {
  return verifyEd25519Signature(devicePublicKey, nonceSigningBytes(nonce), signature);
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
  /**
   * The product THIS server instance serves (`createByokServer`'s
   * `productId`). Part of authentication, not of routing: a device row paired
   * into another product is not a principal here at all — see
   * {@link authenticateBearer}.
   */
  productId: string;
}

/**
 * S1: the authenticated principal every authed surface works with. Built from
 * the DEVICE ROW, never from the token payload — the token's claims are only
 * the keys used to find that row (see {@link authenticateBearer}). A caller
 * holding one of these is holding identity the registry vouched for.
 */
export interface AuthenticatedDevice {
  deviceId: string;
  tenantId: TenantId;
  productId: string;
}

/**
 * Resolve an `Authorization: Bearer <jwt>` header to an {@link AuthenticatedDevice},
 * or `undefined` — the single check every authed HTTP route and the WSS
 * upgrade share.
 *
 * S1 shape: the token's `(tenantId, deviceId)` are LOOKUP KEYS into the
 * registry, and the row that comes back is the authority. A token for a
 * device that no longer exists, one whose tenant does not own that device,
 * one whose product disagrees with the row, and one whose row belongs to a
 * different product than this instance serves all fail identically here and
 * are indistinguishable to the caller — a revoked device is exactly the first
 * of those, since revocation deleted its row (§6.3) — there
 * is deliberately no "which of those was it" signal to hand back, so no route
 * can turn a 401 into a cross-tenant (or cross-product) existence oracle.
 *
 * The last two checks are different facts and both are needed. Row vs claims
 * says "the token belongs to this row"; row vs instance says "this row
 * belongs to the product this server serves" — a single server can mint
 * pairing codes for any product (`createPairingCode` takes the claims per
 * code), so a row from another product is a real row holding a real token
 * and is still not a principal here. `conn.hello`'s own product checks
 * (`ws-server.ts`) validate the client's ANNOUNCEMENT, which is a third fact
 * and stays where it is.
 */
export async function authenticateBearer(
  header: string | undefined,
  deps: AuthDeps,
): Promise<AuthenticatedDevice | undefined> {
  const token = extractBearerToken(header);
  if (!token) return undefined;
  const claims = await deps.tokenSigner.verify(token);
  if (!claims) return undefined;
  const device = deps.devices.get(claims.tenantId, claims.deviceId);
  if (!device) return undefined;
  if (device.productId !== claims.productId) return undefined;
  if (device.productId !== deps.productId) return undefined;
  return { deviceId: device.deviceId, tenantId: device.tenantId, productId: device.productId };
}
