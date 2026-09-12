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
import type { DevicePrincipal } from './principals';
import { isTenantId, type TenantId } from './tenant';

/** Envelope schema id, self-consistent with the domain prefix below. */
export const DEVICE_ASSERTION_SCHEMA_ID = 'byok-device-assertion-v1';

/**
 * Domain separation prefix, prepended to the canonical claim bytes before
 * signing.
 *
 * Must remain mutually NON-PREFIX with the other three things this same Ed25519
 * device key signs — `byok-nonce-v1\n` (challenge/token renewal, see
 * `@byok-sdk/client`'s `device-keys.ts`), `byok-device-proof-v1\n`
 * (`attestation.ts`), and `byok-task-assertion-v1\n` ({@link
 * TASK_ASSERTION_DOMAIN_PREFIX}) — so no signature over one domain can ever be
 * reinterpreted as a signature over another.
 * `packages/core/src/__tests__/device-assertion.test.ts` asserts the property
 * across the three core-owned prefixes and
 * `packages/client/src/__tests__/device-assertion-broker.test.ts` across all
 * four; those assertions are the falsifier for this whole design, not a nicety.
 */
export const DEVICE_ASSERTION_DOMAIN_PREFIX = 'byok-device-assertion-v1\n';

export const DEVICE_ASSERTION_VERSION = 1;

/**
 * Envelope schema id of the task-scoped assertion (contract §8.1), kept beside
 * the device one so the two are read — and reviewed — together.
 */
export const TASK_ASSERTION_SCHEMA_ID = 'byok-task-assertion-v1';

/**
 * Domain separation prefix for `byok-task-assertion-v1`.
 *
 * Joins the mutually NON-PREFIX set the ONE Ed25519 device key signs under:
 * `byok-nonce-v1\n`, `byok-device-proof-v1\n`,
 * `byok-device-assertion-v1\n`, and this. Contract §8.1 requires the old and
 * new envelopes to be non-interchangeable, and domain separation is the half of
 * that which holds even when both envelopes parse: a device-lane signature can
 * never be reinterpreted as a task-lane one, because the signed bytes differ in
 * their first line. The four-way falsifier lives in
 * `packages/client/src/__tests__/device-assertion-broker.test.ts` (the only
 * suite that can import the real nonce domain); the three core-owned prefixes
 * are cross-checked in `packages/core/src/__tests__/device-assertion.test.ts`.
 */
export const TASK_ASSERTION_DOMAIN_PREFIX = 'byok-task-assertion-v1\n';

export const TASK_ASSERTION_VERSION = 1;

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

/**
 * The one `audience` validator both envelope kinds parse through.
 *
 * Declared once rather than restated per schema: a second copy is a second
 * place the byte bound could be relaxed, and `byok-task-assertion-v1` inherits
 * the bound by construction rather than by a reviewer noticing.
 */
const ASSERTION_AUDIENCE = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= DEVICE_ASSERTION_AUDIENCE_MAX_BYTES, {
    message: `audience must be at most ${DEVICE_ASSERTION_AUDIENCE_MAX_BYTES} UTF-8 bytes`,
  });

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
  audience: ASSERTION_AUDIENCE,
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
 * Resolve the effective lifetime ceiling, or `undefined` when the caller asked
 * for one this module refuses to honour.
 *
 * Both envelope kinds resolve it here so `byok-task-assertion-v1` cannot be
 * given a longer window than `byok-device-assertion-v1` — contract §8.1 says
 * the task lane inherits the SDK's existing maximum TTL rather than deriving
 * its own from an unpredictable task lifetime.
 */
function resolveMaxLifetimeMs(requested: number | undefined): number | undefined {
  const maxLifetimeMs = requested ?? DEVICE_ASSERTION_MAX_TTL_MS;
  if (
    !Number.isSafeInteger(maxLifetimeMs) ||
    maxLifetimeMs <= 0 ||
    maxLifetimeMs > DEVICE_ASSERTION_MAX_TTL_MS
  ) {
    return undefined;
  }
  return maxLifetimeMs;
}

/**
 * The time-window rule, shared by both envelope kinds so there is exactly one
 * place it can be widened: a parseable `[issuedAt, expiresAt)` half-open
 * interval, no clock-skew allowance, and a span no longer than the ceiling.
 */
function assertionWindowAdmits(
  claims: { readonly issuedAt: string; readonly expiresAt: string },
  now: Date,
  maxLifetimeMs: number,
): boolean {
  const issuedAt = parseInstant(claims.issuedAt);
  const expiresAt = parseInstant(claims.expiresAt);
  if (issuedAt === undefined || expiresAt === undefined) return false;
  if (expiresAt <= issuedAt) return false;
  if (expiresAt - issuedAt > maxLifetimeMs) return false;

  const instant = now.getTime();
  if (!Number.isFinite(instant)) return false;
  return instant >= issuedAt && instant < expiresAt;
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
  const maxLifetimeMs = resolveMaxLifetimeMs(deps.maxLifetimeMs);
  if (maxLifetimeMs === undefined) return undefined;

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

  // No clock-skew allowance: this envelope's whole safety margin is its short
  // window, and a tolerance knob is just that window quietly widened. A
  // deployment whose clocks disagree by minutes has a clock problem to fix, not
  // an assertion lifetime to extend. Validity is a half-open interval
  // `[issuedAt, expiresAt)` — at the exact `expiresAt` instant the assertion is
  // already expired. See {@link assertionWindowAdmits}, the one place that rule
  // is written down for both envelope kinds.
  if (!assertionWindowAdmits(claims, deps.now, maxLifetimeMs)) return undefined;

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

// ---------------------------------------------------------------------------
// Authenticate + consume once
// ---------------------------------------------------------------------------

/** The verifier's complete current row. Claims remain lookup keys, never authority. */
export interface DeviceAssertionAuthorityRow extends DeviceAssertionDeviceRow {
  readonly tenantId: TenantId;
  readonly productId: string;
  readonly deviceId: string;
}

/** Trusted deployment values the host compares with exact string equality. */
export interface DeviceAssertionExpectedBinding {
  readonly issuer: string;
  readonly productId: string;
  readonly audience: string;
}

/**
 * The envelope kinds that share one replay authority.
 *
 * A closed union with no default: contract §8.2(2) requires the replay key to
 * carry an envelope-kind discriminator so the same `jti` presented as a device
 * assertion and as a task assertion occupies two key slots and neither lane can
 * burn the other's. A defaulted or optional field would reintroduce exactly the
 * collision the discriminator exists to prevent, so every caller states its
 * lane and a caller that forgets does not compile.
 */
export type DeviceAssertionReplaySchemaId =
  | typeof DEVICE_ASSERTION_SCHEMA_ID
  | typeof TASK_ASSERTION_SCHEMA_ID;

/** One replay key. Every field is derived from verified claims/current authority. */
export interface DeviceAssertionReplayConsumeInput {
  /** Which signed envelope kind produced this key. Required; never inferred, never defaulted. */
  readonly schema: DeviceAssertionReplaySchemaId;
  readonly tenantId: TenantId;
  readonly issuer: string;
  readonly productId: string;
  readonly deviceId: string;
  readonly audience: string;
  readonly jti: string;
  readonly expiresAt: string;
}

/**
 * Atomic single-use authority. `true` means this caller inserted the key;
 * `false` means it was already consumed. Operational failures throw and must
 * never be translated into authenticated success.
 */
export interface DeviceAssertionReplayAuthority {
  consume(input: DeviceAssertionReplayConsumeInput): Promise<boolean>;
}

export interface AuthenticateDeviceAssertionDeps {
  readonly verifier: DeviceAssertionVerifier;
  readonly lookupDevice: (
    deviceId: string,
  ) => Promise<DeviceAssertionAuthorityRow | undefined> | DeviceAssertionAuthorityRow | undefined;
  readonly replay: DeviceAssertionReplayAuthority;
  readonly expected: DeviceAssertionExpectedBinding;
  readonly now: Date;
  readonly maxLifetimeMs?: number;
}

/** Audit-safe result of a consumed assertion; no credential or signature is retained. */
export interface AuthenticatedDeviceAssertion {
  readonly device: DevicePrincipal;
  readonly issuer: string;
  readonly audience: string;
  readonly jti: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function isNonEmptyExactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isAuthorityRow(row: unknown, requestedDeviceId: string): row is DeviceAssertionAuthorityRow {
  if (row === null || typeof row !== 'object') return false;
  const candidate = row as Partial<DeviceAssertionAuthorityRow>;
  return (
    isTenantId(candidate.tenantId) &&
    isNonEmptyExactString(candidate.productId) &&
    candidate.deviceId === requestedDeviceId
  );
}

/**
 * Authenticate one device assertion and atomically consume its JTI.
 *
 * All invalid authentication states collapse to `undefined`. Replay-store
 * operational failures reject the promise, allowing a host to return an
 * availability error without ever degrading to signature-only acceptance.
 */
export async function authenticateDeviceAssertion(
  input: unknown,
  deps: AuthenticateDeviceAssertionDeps,
): Promise<AuthenticatedDeviceAssertion | undefined> {
  if (
    !isNonEmptyExactString(deps.expected.issuer) ||
    !isNonEmptyExactString(deps.expected.productId) ||
    !isNonEmptyExactString(deps.expected.audience) ||
    utf8ByteLength(deps.expected.audience) > DEVICE_ASSERTION_AUDIENCE_MAX_BYTES
  ) {
    return undefined;
  }

  let authorityRow: DeviceAssertionAuthorityRow | undefined;
  const claims = await verifyDeviceAssertion(input, {
    verifier: deps.verifier,
    lookupDevice: async (deviceId) => {
      const row = await deps.lookupDevice(deviceId);
      if (!isAuthorityRow(row, deviceId)) return undefined;
      authorityRow = row;
      return { publicKeyJwkX: row.publicKeyJwkX, revoked: row.revoked };
    },
    now: deps.now,
    ...(deps.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: deps.maxLifetimeMs }),
  });
  if (claims === undefined || authorityRow === undefined) return undefined;

  if (
    claims.issuer !== deps.expected.issuer ||
    claims.productId !== deps.expected.productId ||
    claims.audience !== deps.expected.audience ||
    authorityRow.productId !== deps.expected.productId ||
    authorityRow.deviceId !== claims.deviceId
  ) {
    return undefined;
  }

  const consumed = await deps.replay.consume({
    schema: DEVICE_ASSERTION_SCHEMA_ID,
    tenantId: authorityRow.tenantId,
    issuer: claims.issuer,
    productId: authorityRow.productId,
    deviceId: authorityRow.deviceId,
    audience: claims.audience,
    jti: claims.jti,
    expiresAt: claims.expiresAt,
  });
  if (!consumed) return undefined;

  return {
    device: {
      kind: 'device',
      tenantId: authorityRow.tenantId,
      productId: authorityRow.productId,
      deviceId: authorityRow.deviceId,
    },
    issuer: claims.issuer,
    audience: claims.audience,
    jti: claims.jti,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Task assertion (`byok-task-assertion-v1`) — contract §8.1 / §8.2(2)
// ---------------------------------------------------------------------------

/**
 * The task-scoped assertion: a separate envelope, NOT a device assertion with
 * extra claims.
 *
 * Contract §8.1 fixes the property this section exists to hold: the old and new
 * envelopes are not interchangeable in either direction. Three independent
 * mechanisms carry it, and none of them is "the verifier remembers to check":
 *
 * 1. **Different signed bytes.** {@link TASK_ASSERTION_DOMAIN_PREFIX} is
 *    non-prefix with every other domain this device key signs under, so a
 *    signature made in one lane cannot be reinterpreted in another even if the
 *    claim sets were made to coincide.
 * 2. **Different strict schemas.** `schema` is a literal and `protected` is a
 *    `strictObject`, so a device envelope fails
 *    {@link parseTaskAssertionEnvelope} on its missing `taskId`/`agentRef`/
 *    `toolsetId` and a task envelope fails
 *    {@link parseDeviceAssertionEnvelope} on those same claims being unknown.
 * 3. **Different replay keys.** {@link DeviceAssertionReplayConsumeInput}
 *    carries a required `schema` segment (§8.2(2)), so the two lanes' ledgers
 *    are distinguishable and neither can burn the other's `jti`.
 *
 * What is deliberately NOT duplicated: `jti`/signature encodings, the audience
 * byte bound, {@link DEVICE_ASSERTION_MAX_TTL_MS}, the window rule and the
 * device-row rule are the SAME validators the device lane uses, referenced not
 * copied. Contract §8.1: the task lane inherits the SDK's existing limits and
 * does not define a second, looser set.
 *
 * The claim set carries no caller identity for the reason stated at the top of
 * this file — under one UID every process can reach the control socket, so a
 * self-reported "who asked" is synthesized authority. The task/AgentRef binding
 * here is authority precisely because the daemon signs it after checking its
 * own local registry, not because a caller sent it.
 */

/** Bound on each AgentRef scalar, in UTF-8 bytes. Mirrors `AGENT_REF_MAX_BYTES` in `@byok-sdk/protocol`. */
export const TASK_ASSERTION_AGENT_REF_MAX_BYTES = 160;

/** Bound on `toolsetId`. Mirrors the `ToolsetIdSchema` bound in `@byok-sdk/protocol`. */
export const TASK_ASSERTION_TOOLSET_ID_MAX_LENGTH = 128;

/**
 * AgentRef scalar, restated from the SDK's authoritative `AgentRefSchema`
 * (`@byok-sdk/protocol`'s `messages.ts`) rather than imported.
 *
 * Core may not grow an edge to protocol — the §12.1 invariant that
 * `packages/core/src/__tests__/constraints.test.ts` enforces on shipped source
 * AND tests — so this lane cannot import the authority it must not weaken. The
 * falsifier for the restatement is therefore a BEHAVIOURAL drift test in the
 * client suite (`device-assertion-broker.test.ts`), which imports the real
 * `AgentRefSchema`/`ToolsetIdSchema` alongside these and asserts the two agree
 * on every candidate. A weakened copy here turns that suite red; it does not
 * quietly widen the task lane.
 */
const AGENT_REF_VALUE = z
  .string()
  .min(1)
  .max(TASK_ASSERTION_AGENT_REF_MAX_BYTES)
  .refine((value) => utf8ByteLength(value) <= TASK_ASSERTION_AGENT_REF_MAX_BYTES, {
    message: `AgentRef values must not exceed ${TASK_ASSERTION_AGENT_REF_MAX_BYTES} UTF-8 bytes`,
  })
  .regex(/^[^\u0000-\u001f\u007f\r\n]+$/u, 'AgentRef values must not contain control characters');

const WINDOWS_RESERVED_AGENT_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/** The frozen offer's Agent identity. Same shape and same rules as the SDK's `AgentRefSchema`. */
export const TaskAssertionAgentRefSchema = z
  .object({
    agentId: AGENT_REF_VALUE.regex(/^[^\\/:<>"|?*]+$/u, 'agentId must be one portable pathname segment')
      .refine((value) => value !== '.' && value !== '..', 'agentId must not be a dot segment')
      .refine(
        (value) => !/[. ]$/u.test(value) && !WINDOWS_RESERVED_AGENT_SEGMENT.test(value),
        'agentId must be a portable Windows-safe pathname segment',
      ),
    /**
     * From the FROZEN offer. Contract §8.1 forbids substituting the current
     * revision read from a working directory's `profile.json`; this module
     * cannot enforce that (it never reads a file) — the signer's contract does.
     */
    profileRevision: AGENT_REF_VALUE,
  })
  .strict();

export type TaskAssertionAgentRef = z.infer<typeof TaskAssertionAgentRefSchema>;

/** Logical, host-owned toolset id. Restated from `@byok-sdk/protocol`'s `ToolsetIdSchema`; see {@link TaskAssertionAgentRefSchema}. */
const TOOLSET_ID_VALUE = z
  .string()
  .min(1)
  .max(TASK_ASSERTION_TOOLSET_ID_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u, 'toolset ids must be lowercase logical identifiers');

/**
 * The wire's task id shape: the same `z.string().min(1)` the protocol envelope's
 * `task_id` routing key is built from. Contract §8.1 makes `taskId` the sole
 * execution locator, so this lane must accept exactly what the wire routes —
 * neither inventing a narrower bound nor admitting an empty one.
 */
const TASK_ID_VALUE = z.string().min(1);

/**
 * The signed task claim set: the device claim set plus the three bindings that
 * make the assertion task-scoped, every member required for the same reason the
 * device claims are.
 */
export const TaskAssertionClaimsSchema = z.strictObject({
  version: z.literal(TASK_ASSERTION_VERSION),
  /** The paired server's origin, normalized (`new URL(serverUrl).origin`). */
  issuer: z.string().min(1),
  productId: z.string().min(1),
  /** The device row this assertion claims to be. A lookup key, never authority. */
  deviceId: z.string().min(1),
  /** Exactly one audience, compared with `===`. Participates in the replay key (§8.2(2)). */
  audience: ASSERTION_AUDIENCE,
  /** Same 128-bit CSPRNG token shape the device lane uses; burned once per `schema` segment. */
  jti: z.string().regex(JTI_PATTERN),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** The only execution locator (§8.1). No attemptId is minted beside it. */
  taskId: TASK_ID_VALUE,
  /** The frozen offer's Agent identity, at the SDK's full AgentRef strength. */
  agentRef: TaskAssertionAgentRefSchema,
  /** The frozen toolset this invocation belongs to (the wire's `toolset` field). */
  toolsetId: TOOLSET_ID_VALUE,
});

export type TaskAssertionClaims = z.infer<typeof TaskAssertionClaimsSchema>;

export const TaskAssertionEnvelopeV1Schema = z.strictObject({
  schema: z.literal(TASK_ASSERTION_SCHEMA_ID),
  algorithm: z.enum(DEVICE_ASSERTION_ALGORITHMS),
  protected: TaskAssertionClaimsSchema,
  /** Raw 64-byte Ed25519 signature, base64url unpadded — the device lane's encoding, unchanged. */
  signature: z.string().regex(SIGNATURE_PATTERN),
});

export type TaskAssertionEnvelopeV1 = z.infer<typeof TaskAssertionEnvelopeV1Schema>;

/**
 * Parses a task envelope fail-closed. A device assertion is not a degraded task
 * assertion and is rejected here, not tolerated (§8.1: task lane zero fallback).
 *
 * @throws {ByokCoreError} code `assertion_envelope_invalid`.
 */
export function parseTaskAssertionEnvelope(input: unknown): TaskAssertionEnvelopeV1 {
  const result = TaskAssertionEnvelopeV1Schema.safeParse(input);
  if (!result.success) {
    throw new ByokCoreError(
      'assertion_envelope_invalid',
      `Invalid task assertion envelope: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * Projects task claims into the exact JSON object that gets canonicalized.
 *
 * Built field by field, like the device projection, and covering EVERY claim —
 * contract §8.1 requires the canonical projection to include all added claims,
 * so an unsigned `taskId`, `agentRef` or `toolsetId` would be a claim a verifier
 * reads but no signature covers.
 */
export function taskAssertionCanonicalClaims(claims: TaskAssertionClaims): JsonObject {
  const canonical: Record<string, JsonValue> = {
    version: claims.version,
    issuer: claims.issuer,
    productId: claims.productId,
    deviceId: claims.deviceId,
    audience: claims.audience,
    jti: claims.jti,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    taskId: claims.taskId,
    agentRef: {
      agentId: claims.agentRef.agentId,
      profileRevision: claims.agentRef.profileRevision,
    },
    toolsetId: claims.toolsetId,
  };
  return canonical;
}

/** Canonical JSON text of the task claim set, without the domain prefix. */
export function taskAssertionCanonicalJson(claims: TaskAssertionClaims): string {
  return canonicalizeJson(taskAssertionCanonicalClaims(claims));
}

/**
 * The exact bytes a daemon signs and a verifier reconstructs:
 * `byok-task-assertion-v1\n` followed by the canonical claim JSON, UTF-8
 * encoded.
 *
 * Frozen by `src/__tests__/golden/task-assertion-v1.canonical.json`.
 */
export function taskAssertionSigningInput(claims: TaskAssertionClaims): Uint8Array {
  return new TextEncoder().encode(
    TASK_ASSERTION_DOMAIN_PREFIX + taskAssertionCanonicalJson(claims),
  );
}

/**
 * Verifies a task assertion and returns its claims, or `undefined`.
 *
 * The twin of {@link verifyDeviceAssertion}, with the same
 * collapse-to-`undefined` discipline, the same injected row lookup, and the
 * same window and ceiling rules ({@link assertionWindowAdmits},
 * {@link resolveMaxLifetimeMs}) — and a schema this function will not widen: a
 * `byok-device-assertion-v1` envelope is rejected at the parse step.
 *
 * What the caller MUST still do, exactly as in the device lane: compare
 * `issuer`/`productId`/`audience` against its own deployment, burn the `jti`
 * under this envelope's `schema` segment, and check that `taskId`/`agentRef`/
 * `toolsetId` belong to the frozen offer (§8.2(2)) — the last of which is Host
 * authority that core cannot hold.
 */
export async function verifyTaskAssertion(
  input: unknown,
  deps: DeviceAssertionVerifyDeps,
): Promise<TaskAssertionClaims | undefined> {
  const maxLifetimeMs = resolveMaxLifetimeMs(deps.maxLifetimeMs);
  if (maxLifetimeMs === undefined) return undefined;

  let envelope: TaskAssertionEnvelopeV1;
  try {
    envelope = parseTaskAssertionEnvelope(input);
  } catch {
    return undefined;
  }
  const claims = envelope.protected;

  const row = await deps.lookupDevice(claims.deviceId);
  if (!isUsableDeviceRow(row)) return undefined;

  if (!assertionWindowAdmits(claims, deps.now, maxLifetimeMs)) return undefined;

  const verified = await deps.verifier.verify({
    algorithm: envelope.algorithm,
    publicKey: row.publicKeyJwkX,
    signature: envelope.signature,
    signingInput: taskAssertionSigningInput(claims),
  });
  if (!verified) return undefined;

  return claims;
}

/** Audit-safe result of a consumed task assertion; no credential or signature is retained. */
export interface AuthenticatedTaskAssertion extends AuthenticatedDeviceAssertion {
  readonly taskId: string;
  readonly agentRef: TaskAssertionAgentRef;
  readonly toolsetId: string;
}

/**
 * Authenticate one task assertion and atomically consume its JTI under the
 * `byok-task-assertion-v1` replay segment.
 *
 * Identical in shape and failure discipline to
 * {@link authenticateDeviceAssertion}: every invalid state collapses to
 * `undefined`, and a replay-store operational failure REJECTS rather than
 * degrading to signature-only acceptance (§8.2(2): an unavailable replay store
 * fails, it does not downgrade authentication).
 *
 * Consumption is the last step, after every binding comparison, so a rejected
 * assertion never burns a key — the "reject before side effects" ordering AC11
 * requires. The frozen-offer check (`taskId`/`agentRef`/`toolsetId` belong to
 * this Execution) is deliberately NOT here: that authority lives in the Host,
 * and a core function that accepted it as an argument would be inviting a
 * caller to synthesize it.
 */
export async function authenticateTaskAssertion(
  input: unknown,
  deps: AuthenticateDeviceAssertionDeps,
): Promise<AuthenticatedTaskAssertion | undefined> {
  if (
    !isNonEmptyExactString(deps.expected.issuer) ||
    !isNonEmptyExactString(deps.expected.productId) ||
    !isNonEmptyExactString(deps.expected.audience) ||
    utf8ByteLength(deps.expected.audience) > DEVICE_ASSERTION_AUDIENCE_MAX_BYTES
  ) {
    return undefined;
  }

  let authorityRow: DeviceAssertionAuthorityRow | undefined;
  const claims = await verifyTaskAssertion(input, {
    verifier: deps.verifier,
    lookupDevice: async (deviceId) => {
      const row = await deps.lookupDevice(deviceId);
      if (!isAuthorityRow(row, deviceId)) return undefined;
      authorityRow = row;
      return { publicKeyJwkX: row.publicKeyJwkX, revoked: row.revoked };
    },
    now: deps.now,
    ...(deps.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: deps.maxLifetimeMs }),
  });
  if (claims === undefined || authorityRow === undefined) return undefined;

  if (
    claims.issuer !== deps.expected.issuer ||
    claims.productId !== deps.expected.productId ||
    claims.audience !== deps.expected.audience ||
    authorityRow.productId !== deps.expected.productId ||
    authorityRow.deviceId !== claims.deviceId
  ) {
    return undefined;
  }

  const consumed = await deps.replay.consume({
    schema: TASK_ASSERTION_SCHEMA_ID,
    tenantId: authorityRow.tenantId,
    issuer: claims.issuer,
    productId: authorityRow.productId,
    deviceId: authorityRow.deviceId,
    audience: claims.audience,
    jti: claims.jti,
    expiresAt: claims.expiresAt,
  });
  if (!consumed) return undefined;

  return {
    device: {
      kind: 'device',
      tenantId: authorityRow.tenantId,
      productId: authorityRow.productId,
      deviceId: authorityRow.deviceId,
    },
    issuer: claims.issuer,
    audience: claims.audience,
    jti: claims.jti,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    taskId: claims.taskId,
    agentRef: claims.agentRef,
    toolsetId: claims.toolsetId,
  };
}
