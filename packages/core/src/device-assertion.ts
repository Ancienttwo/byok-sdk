/**
 * Device assertion envelope, canonical signing bytes, and verifier
 * (plan `device-assertion-broker`, P3 ①-⑤).
 *
 * A device assertion is a short-lived, audience-scoped statement a *paired
 * device* makes about itself — "this device, paired to this product against
 * this server, wants to talk to `<audience>` for the next two minutes" — signed
 * with the same Ed25519 device identity key `attestation.ts`'s device proof
 * uses. A sibling CLI installed alongside the daemon presents one to the host's
 * cloud, which exchanges it for a product session. It is NOT a request-bound
 * proof (`attestation.ts`) and the two must never be interchangeable; see the
 * domain prefix below.
 *
 * Four decisions this file encodes, none of them re-litigable here:
 *
 * 1. **A custom JSON signing envelope, not JWS.** The domain prefix has to be
 *    *inside* the signed bytes. JWS puts its type tag in a header that no
 *    verifier is required to check, which is a fail-open shape: a token minted
 *    for one purpose verifies for another as long as the key matches. So this
 *    clones the mechanism `attestation.ts` already froze — RFC 8785-subset
 *    canonicalization (`canonicalizeJson`, imported, never re-implemented) plus
 *    a golden fixture pinning the exact bytes.
 * 2. **What the claims deliberately do NOT carry.** No `devicePublicKey`: a
 *    verifier must resolve the key from its own device directory by `deviceId`,
 *    or the envelope becomes self-authenticating. No caller identity: every
 *    process under the same UID can reach the control socket, so a "who asked"
 *    field would be synthesized authority, not evidence. No `keyId`: there is
 *    no key-rotation story for this envelope yet, and a field nothing populates
 *    honestly is a structure that invites a verifier to trust it.
 * 3. **`audience` is a single string, never an array.** A multi-audience token
 *    forces every verifier to agree on the same containment rule; one string
 *    compared with `===` cannot be got wrong.
 * 4. **The verifier cannot forget the revocation check.** {@link
 *    verifyDeviceAssertion} takes `revoked` as a REQUIRED dependency, so a
 *    caller that never looked the device row up does not compile. The daemon's
 *    own local checks (see `@byok-sdk/client`'s `assertion.issue`) are only half
 *    of revocation; the other half is this recheck at exchange time, and no
 *    documentation may claim the daemon satisfies "synchronous invalidation"
 *    on its own.
 *
 * Like `attestation.ts`, this module is crypto-free: signature verification is
 * an injected port (`DeviceAssertionVerifier`), because core must load on
 * Workers and `node:crypto`/WebCrypto disagree about key handling.
 */
import { z } from 'zod';
import { canonicalizeJson, type JsonObject, type JsonValue } from './attestation';
import { ByokCoreError } from './errors';

/** Envelope schema id, self-consistent with the domain prefix below. */
export const DEVICE_ASSERTION_SCHEMA_ID = 'byok-device-assertion-v1';

/**
 * Domain separation prefix, prepended to the canonical claim bytes before
 * signing.
 *
 * Must remain mutually NON-PREFIX with the other two things this same Ed25519
 * device key signs — `byok-nonce-v1\n` (challenge/token renewal, see
 * `@byok-sdk/client`'s `device-keys.ts`) and `byok-device-proof-v1\n`
 * (`attestation.ts`) — so no signature over one domain can ever be reinterpreted
 * as a signature over another. `packages/core/src/__tests__/device-assertion.test.ts`
 * asserts the three-way non-prefix property directly; that assertion is the
 * falsifier for this whole design, not a nicety.
 */
export const DEVICE_ASSERTION_DOMAIN_PREFIX = 'byok-device-assertion-v1\n';

export const DEVICE_ASSERTION_VERSION = 1;

/** Signature algorithms this envelope version admits. */
export const DEVICE_ASSERTION_ALGORITHMS = ['ed25519'] as const;
export type DeviceAssertionAlgorithm = (typeof DEVICE_ASSERTION_ALGORITHMS)[number];

/**
 * Default assertion lifetime. Short on purpose: the daemon keeps no `jti`
 * ledger (it is not on the verification path and could not stop a real replay
 * anyway), so a narrow expiry window plus a burn-on-use verifier is the whole
 * replay story.
 */
export const DEVICE_ASSERTION_DEFAULT_TTL_MS = 120_000;

/**
 * Hard ceiling on the lifetime, enforced at BOTH ends: a daemon refuses to be
 * configured above it, and {@link verifyDeviceAssertion} refuses an envelope
 * whose own `issuedAt`→`expiresAt` span exceeds it regardless of who minted it.
 */
export const DEVICE_ASSERTION_MAX_TTL_MS = 300_000;

/** Bound on the `audience` claim, in UTF-8 bytes — an allowlist entry is a short identifier, not a document. */
export const DEVICE_ASSERTION_AUDIENCE_MAX_BYTES = 256;

/** base64url of 16 CSPRNG bytes (128 bits), unpadded. */
const JTI_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** base64url of a raw 64-byte Ed25519 signature, unpadded. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * The signed claim set. `strictObject` with every member REQUIRED: an optional
 * claim is a claim a verifier may or may not see, and this envelope is small
 * enough that there is no honest reason for one.
 *
 * `issuer` is the paired server's origin (scheme + host + port, normalized) —
 * it binds the assertion to the deployment the device is actually paired
 * against, so an assertion minted by a device paired to a staging server cannot
 * be presented to production.
 */
export const DeviceAssertionClaimsSchema = z.strictObject({
  version: z.literal(DEVICE_ASSERTION_VERSION),
  /** The paired server's origin, normalized (`new URL(serverUrl).origin`). */
  issuer: z.string().min(1),
  productId: z.string().min(1),
  /** The device row this assertion claims to be. A lookup key, never authority — the row is the authority. */
  deviceId: z.string().min(1),
  /** Exactly one audience, compared with `===` by every verifier. Never an array, never a prefix. */
  audience: z
    .string()
    .min(1)
    .refine((value) => utf8ByteLength(value) <= DEVICE_ASSERTION_AUDIENCE_MAX_BYTES, {
      message: `audience must be at most ${DEVICE_ASSERTION_AUDIENCE_MAX_BYTES} UTF-8 bytes`,
    }),
  /** 128-bit CSPRNG token, base64url unpadded. The verifier burns it; the signer never reuses one. */
  jti: z.string().regex(JTI_PATTERN),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export type DeviceAssertionClaims = z.infer<typeof DeviceAssertionClaimsSchema>;

export const DeviceAssertionEnvelopeV1Schema = z.strictObject({
  schema: z.literal(DEVICE_ASSERTION_SCHEMA_ID),
  algorithm: z.enum(DEVICE_ASSERTION_ALGORITHMS),
  protected: DeviceAssertionClaimsSchema,
  /** Raw 64-byte Ed25519 signature, base64url unpadded. */
  signature: z.string().regex(SIGNATURE_PATTERN),
});

export type DeviceAssertionEnvelopeV1 = z.infer<typeof DeviceAssertionEnvelopeV1Schema>;

/**
 * Parses an envelope fail-closed.
 *
 * @throws {ByokCoreError} code `assertion_envelope_invalid`.
 */
export function parseDeviceAssertionEnvelope(input: unknown): DeviceAssertionEnvelopeV1 {
  const result = DeviceAssertionEnvelopeV1Schema.safeParse(input);
  if (!result.success) {
    throw new ByokCoreError(
      'assertion_envelope_invalid',
      `Invalid device assertion envelope: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * Projects claims into the exact JSON object that gets canonicalized.
 *
 * Built field by field rather than by spreading the parsed object — the same
 * discipline `deviceProofCanonicalClaims` documents. Nothing here is optional,
 * so there is no absent-key decision to get wrong; the explicit projection is
 * what keeps it that way if a field is ever added.
 */
export function deviceAssertionCanonicalClaims(claims: DeviceAssertionClaims): JsonObject {
  const canonical: Record<string, JsonValue> = {
    version: claims.version,
    issuer: claims.issuer,
    productId: claims.productId,
    deviceId: claims.deviceId,
    audience: claims.audience,
    jti: claims.jti,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
  return canonical;
}

/** Canonical JSON text of the claim set, without the domain prefix. */
export function deviceAssertionCanonicalJson(claims: DeviceAssertionClaims): string {
  return canonicalizeJson(deviceAssertionCanonicalClaims(claims));
}

/**
 * The exact bytes a device signs and a verifier reconstructs:
 * `byok-device-assertion-v1\n` followed by the canonical claim JSON, UTF-8
 * encoded.
 *
 * Frozen by `src/__tests__/golden/device-assertion-v1.canonical.json`.
 */
export function deviceAssertionSigningInput(claims: DeviceAssertionClaims): Uint8Array {
  return new TextEncoder().encode(
    DEVICE_ASSERTION_DOMAIN_PREFIX + deviceAssertionCanonicalJson(claims),
  );
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface DeviceAssertionVerifyInput {
  readonly algorithm: DeviceAssertionAlgorithm;
  /** Raw public key, base64url — the JWK `x` encoding the device registry stores. */
  readonly publicKey: string;
  readonly signature: string;
  readonly signingInput: Uint8Array;
}

/**
 * Injected signature verification, for the same reason `DeviceProofVerifier`
 * exists: core is Node-free and Workers-safe, so it answers no cryptographic
 * question itself. Kept separate from `DeviceProofVerifier` even though the
 * shapes coincide — one composition object satisfies both — because this file's
 * entire purpose is that the two domains never become interchangeable, and a
 * shared type is the first step toward a shared code path.
 */
export interface DeviceAssertionVerifier {
  verify(input: DeviceAssertionVerifyInput): Promise<boolean>;
}

/**
 * The device-row fields a verification reads — the verifier's OWN directory
 * row, resolved by `deviceId`, never anything the envelope carried.
 *
 * Both fields together, from one lookup, are what make forgetting impossible:
 * the caller cannot obtain `publicKeyJwkX` without also obtaining the current
 * `revoked` state, because they arrive as one object from one call.
 */
export interface DeviceAssertionDeviceRow {
  /** JWK `x` of the device's registered Ed25519 public key. The ONLY key a signature is ever checked against. */
  readonly publicKeyJwkX: string;
  /** The row's CURRENT revocation state, read in the same lookup as the key. */
  readonly revoked: boolean;
}

/**
 * Everything a verification needs that is NOT in the envelope.
 *
 * The device row is supplied through a LOOKUP PORT, not as a pre-fetched
 * value, and that is the whole point (this is the faithful clone of
 * `DeviceProofVerifier`'s "core is never a second authority on device
 * identity" shape). `verifyDeviceAssertion` reads `deviceId` from the parsed
 * claims and calls `lookupDevice(deviceId)` ITSELF, so:
 *
 * - There is no way to invoke a verification without providing the means to
 *   look the current row up — "I forgot to check revocation" cannot be
 *   expressed, because the function does the lookup, not the caller.
 * - Both the public key AND the revocation state come from that one row, so a
 *   caller cannot pass a key while claiming `revoked: false` from thin air.
 * - The `deviceId` handed to `lookupDevice` is the claimed one; the row it
 *   returns is authority. A device asserting an identity it is not is caught
 *   by the lookup missing, or by the returned row's key failing the signature.
 */
export interface DeviceAssertionVerifyDeps {
  readonly verifier: DeviceAssertionVerifier;
  /**
   * Resolve the verifier's own device row by the claimed `deviceId`.
   * `undefined` for an unknown device. Sync or async; awaited either way.
   */
  readonly lookupDevice: (
    deviceId: string,
  ) => Promise<DeviceAssertionDeviceRow | undefined> | DeviceAssertionDeviceRow | undefined;
  /** Injected instant — core never reads a wall clock (`stores.ts`'s `Clock`). */
  readonly now: Date;
  /** Bound on `issuedAt`→`expiresAt`. Defaults to (and may never exceed) {@link DEVICE_ASSERTION_MAX_TTL_MS}. */
  readonly maxLifetimeMs?: number;
}

function parseInstant(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Raw Ed25519 public key as a JWK `x`: 32 bytes, base64url unpadded — exactly
 * 43 characters. The envelope's `algorithm` is a closed `ed25519`, so the row's
 * key must be an Ed25519 key of this exact shape.
 */
const EDDSA_JWK_X_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * codex round-2 F2: strict runtime validation of a looked-up device row, since
 * `lookupDevice` is a caller-supplied port whose return value TypeScript cannot
 * enforce at runtime. Fails closed on any shape that isn't exactly a usable row:
 *
 * - `revoked` must be the literal boolean `false`. A missing, `undefined`,
 *   truthy, or non-boolean `revoked` is a malformed row — and a missing
 *   `revoked` reading as "not revoked" (`undefined` is falsey) is precisely the
 *   fail-open this guard closes: a revoked device must never slip through on a
 *   row shape the caller got wrong.
 * - `publicKeyJwkX` must be a present, well-formed Ed25519 JWK `x`. A missing or
 *   malformed key is rejected here, before any crypto — so a bad key can never
 *   reach (and throw inside) the verifier port either.
 */
function isUsableDeviceRow(row: unknown): row is DeviceAssertionDeviceRow {
  if (row === null || typeof row !== 'object') return false;
  if ((row as { revoked?: unknown }).revoked !== false) return false;
  const key = (row as { publicKeyJwkX?: unknown }).publicKeyJwkX;
  return typeof key === 'string' && EDDSA_JWK_X_PATTERN.test(key);
}

/**
 * Verifies an assertion and returns its claims, or `undefined`.
 *
 * Every rejected state collapses to `undefined` — malformed input, an unknown
 * or revoked device, an expired or over-long window, a bad signature — so a
 * route has one response for all of them and cannot accidentally leak which
 * check failed. That is the same shape `authenticateDeviceProof`
 * (`@byok-sdk/cloud`) already uses.
 *
 * The row lookup and both authority reads (key, revocation) happen INSIDE this
 * function — see {@link DeviceAssertionVerifyDeps}. What the caller MUST still
 * do afterward, and this cannot: assert `claims.audience` equals the audience
 * it actually serves, assert `claims.issuer`/`claims.productId` match its own
 * deployment, and BURN `claims.jti` so the assertion cannot be presented
 * twice. The daemon keeps no `jti` ledger; single use is entirely the
 * verifier's job.
 */
export async function verifyDeviceAssertion(
  input: unknown,
  deps: DeviceAssertionVerifyDeps,
): Promise<DeviceAssertionClaims | undefined> {
  const maxLifetimeMs = deps.maxLifetimeMs ?? DEVICE_ASSERTION_MAX_TTL_MS;
  if (
    !Number.isSafeInteger(maxLifetimeMs) ||
    maxLifetimeMs <= 0 ||
    maxLifetimeMs > DEVICE_ASSERTION_MAX_TTL_MS
  ) {
    return undefined;
  }

  let envelope: DeviceAssertionEnvelopeV1;
  try {
    envelope = parseDeviceAssertionEnvelope(input);
  } catch {
    return undefined;
  }
  const claims = envelope.protected;

  // Resolve the row by the CLAIMED deviceId, then read authority from the row.
  // An unknown device, a revoked one, and a MALFORMED one all stop here, before
  // any crypto is done on the claimed identity's behalf. The row is validated
  // strictly (codex round-2 F2): `revoked` must be exactly `false` and the key
  // must be a well-formed Ed25519 JWK `x` — a missing `revoked` never reads as
  // "not revoked", and a missing/malformed key never reaches the verifier.
  const row = await deps.lookupDevice(claims.deviceId);
  if (!isUsableDeviceRow(row)) return undefined;

  const issuedAt = parseInstant(claims.issuedAt);
  const expiresAt = parseInstant(claims.expiresAt);
  if (issuedAt === undefined || expiresAt === undefined) return undefined;
  if (expiresAt <= issuedAt) return undefined;
  if (expiresAt - issuedAt > maxLifetimeMs) return undefined;

  // No clock-skew allowance: this envelope's whole safety margin is its short
  // window, and a tolerance knob is just that window quietly widened. A
  // deployment whose clocks disagree by minutes has a clock problem to fix, not
  // an assertion lifetime to extend. Validity is a half-open interval
  // `[issuedAt, expiresAt)` — at the exact `expiresAt` instant the assertion is
  // already expired, so the check is `now >= expiresAt`, not `now > expiresAt`.
  const now = deps.now.getTime();
  if (!Number.isFinite(now)) return undefined;
  if (now < issuedAt || now >= expiresAt) return undefined;

  const verified = await deps.verifier.verify({
    algorithm: envelope.algorithm,
    // The row's key, never an envelope-supplied one.
    publicKey: row.publicKeyJwkX,
    signature: envelope.signature,
    signingInput: deviceAssertionSigningInput(claims),
  });
  if (!verified) return undefined;

  return claims;
}
