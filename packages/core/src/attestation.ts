/**
 * Device proof envelope and canonical signing bytes (§12.6.3, sprint §S6.2).
 *
 * Three things live here and nothing else:
 *
 * 1. **The protected-claims schema.** Every field a signature must cover so the
 *    proof binds a *specific request*: tenant, product, device, key + epoch,
 *    request id, operation, resource, the request line (method+path or a stable
 *    operation id), and the body's hash *and* size. Signing only the body is
 *    forbidden — it would let a valid proof be replayed against a different
 *    operation or resource.
 * 2. **A dependency-free deterministic canonicalizer.** RFC 8785 (JCS) in the
 *    narrow subset the envelope allows. Node and Workers must produce
 *    byte-identical output, so the accepted value space is deliberately small:
 *    strings, booleans, null, safe integers, plain objects, arrays. Floats,
 *    non-safe integers, `NaN`, `Infinity`, `undefined`, `bigint`, dates and
 *    class instances throw instead of being coerced — a signature over a value
 *    whose serialization is implementation-defined is not a signature.
 * 3. **The verify port.** An interface, never an implementation: core is
 *    Node-free and Workers-safe, and `node:crypto` and WebCrypto disagree about
 *    key handling. The composition brings its own verifier.
 *
 * Claims are **untrusted input**. `tenantId` here is a plain string, not a
 * branded `TenantId`, because a device asserting a tenant proves nothing: the
 * claim is a lookup key used to load the device row, and the row is the
 * authority (§12.6.2 layer 5). Branding happens after that lookup, not here.
 */
import { z } from 'zod';
import { CONTENT_HASH_PATTERN } from './blob';
import { ByokCoreError } from './errors';

/** Envelope schema id, self-consistent with the domain prefix below. */
export const DEVICE_PROOF_SCHEMA_ID = 'byok-device-proof-v1';

/**
 * Domain separation prefix (§12.6.3). Prepended to the canonical claim bytes
 * before signing so a device-proof signature can never be replayed as a nonce
 * signature (`byok-nonce-v1\n`) or a record attestation.
 */
export const DEVICE_PROOF_DOMAIN_PREFIX = 'byok-device-proof-v1\n';

export const DEVICE_PROOF_VERSION = 1;

/** Signature algorithms this envelope version admits. */
export const DEVICE_PROOF_ALGORITHMS = ['ed25519'] as const;
export type DeviceProofAlgorithm = (typeof DEVICE_PROOF_ALGORITHMS)[number];

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HTTP_METHOD_PATTERN = /^[A-Z]+$/;

// ---------------------------------------------------------------------------
// Canonicalization (RFC 8785 subset)
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

function canonicalizationFailure(path: string, reason: string): ByokCoreError {
  return new ByokCoreError(
    'proof_canonicalization_failed',
    `Cannot canonicalize ${path}: ${reason}`,
  );
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeValue(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      // JSON.stringify implements exactly the ECMAScript string serialization
      // RFC 8785 mandates, including well-formed escaping of lone surrogates.
      return JSON.stringify(value);
    case 'number': {
      if (!Number.isSafeInteger(value)) {
        throw canonicalizationFailure(
          path,
          `only safe integers are canonicalizable, received ${String(value)}`,
        );
      }
      // Normalizes -0 to 0; RFC 8785 has no signed zero.
      return String(value === 0 ? 0 : value);
    }
    case 'undefined':
      throw canonicalizationFailure(path, 'undefined has no canonical form');
    case 'bigint':
      throw canonicalizationFailure(path, 'bigint is not a JSON type');
    case 'function':
    case 'symbol':
      throw canonicalizationFailure(path, `${typeof value} is not a JSON type`);
    case 'object':
      break;
    default:
      throw canonicalizationFailure(path, `unsupported type ${typeof value}`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw canonicalizationFailure(path, 'circular reference');
  }
  seen.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      const parts = objectValue.map((entry, index) =>
        canonicalizeValue(entry, `${path}[${index}]`, seen),
      );
      return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(objectValue)) {
      throw canonicalizationFailure(
        path,
        'only plain objects and arrays are canonicalizable',
      );
    }
    // Default string sort compares UTF-16 code units, which is what RFC 8785
    // specifies for member ordering.
    const keys = Object.keys(objectValue).sort();
    const record = objectValue as Record<string, unknown>;
    const parts = keys.map((key) => {
      const encodedKey = JSON.stringify(key);
      const encodedValue = canonicalizeValue(record[key], `${path}.${key}`, seen);
      return `${encodedKey}:${encodedValue}`;
    });
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(objectValue);
  }
}

/**
 * Canonical JSON text for `value`, per RFC 8785 restricted to the value space
 * above. Key insertion order never affects the output; anything outside the
 * accepted space throws `proof_canonicalization_failed`.
 */
export function canonicalizeJson(value: JsonValue): string {
  return canonicalizeValue(value, '<root>', new Set());
}

/** UTF-8 bytes of {@link canonicalizeJson}. `TextEncoder` is a platform global on Node and Workers. */
export function canonicalizeJsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}

// ---------------------------------------------------------------------------
// Protected claims
// ---------------------------------------------------------------------------

/**
 * The signed claim set (§S6.2).
 *
 * The request line is expressible two ways — `method` + `path`, or a stable
 * `operationId` — and exactly one form must be present. Allowing both at once
 * would create two different canonical byte strings for one request; allowing
 * neither would drop the operation binding the whole design rests on.
 */
export const DeviceProofProtectedClaimsSchema = z
  .strictObject({
    version: z.literal(DEVICE_PROOF_VERSION),
    tenantId: z.string().min(1),
    productId: z.string().min(1),
    deviceId: z.string().min(1),
    /** Identity of the signing key, resolved against the device row at verify time. */
    keyId: z.string().min(1),
    /** Rotation generation. An older epoch is rejected by the verifier, not here. */
    keyEpoch: z.number().int().nonnegative(),
    /** Idempotency key: exact replay returns the original result, reuse with a different body is a conflict. */
    requestId: z.string().min(1),
    /** Logical operation, e.g. `truth.write`. */
    operation: z.string().min(1),
    /** Tenant-scoped resource the operation targets. */
    resource: z.string().min(1),
    method: z.string().regex(HTTP_METHOD_PATTERN).optional(),
    path: z.string().startsWith('/').optional(),
    operationId: z.string().min(1).optional(),
    bodySha256: z.string().regex(CONTENT_HASH_PATTERN),
    /** Bound alongside the hash so a truncation attack cannot hide behind a hash collision claim. */
    bodySize: z.number().int().nonnegative(),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    nonce: z.string().min(1).optional(),
  })
  .superRefine((claims, ctx) => {
    const hasRequestLine = claims.method !== undefined && claims.path !== undefined;
    const hasOperationId = claims.operationId !== undefined;
    if (hasRequestLine === hasOperationId) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Claims must carry exactly one request binding: both `method` and `path`, or `operationId`.',
      });
    }
    if (!hasRequestLine && (claims.method !== undefined || claims.path !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: '`method` and `path` must be supplied together.',
      });
    }
  });

export type DeviceProofProtectedClaims = z.infer<typeof DeviceProofProtectedClaimsSchema>;

export const DeviceProofEnvelopeV1Schema = z.strictObject({
  schema: z.literal(DEVICE_PROOF_SCHEMA_ID),
  algorithm: z.enum(DEVICE_PROOF_ALGORITHMS),
  protected: DeviceProofProtectedClaimsSchema,
  /** base64url, unpadded. */
  signature: z.string().regex(BASE64URL_PATTERN),
});

export type DeviceProofEnvelopeV1 = z.infer<typeof DeviceProofEnvelopeV1Schema>;

/**
 * Parses an envelope fail-closed.
 *
 * @throws {ByokCoreError} code `proof_envelope_invalid`.
 */
export function parseDeviceProofEnvelope(input: unknown): DeviceProofEnvelopeV1 {
  const result = DeviceProofEnvelopeV1Schema.safeParse(input);
  if (!result.success) {
    throw new ByokCoreError(
      'proof_envelope_invalid',
      `Invalid device proof envelope: ${result.error.issues
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
 * Built field by field rather than by spreading the parsed object: an absent
 * optional must be an *absent key*, never a key holding `undefined`, or
 * `{nonce: undefined}` and `{}` would be the same request with two different
 * signatures. The canonicalizer refuses `undefined` outright, so this
 * projection is where absence is decided.
 */
export function deviceProofCanonicalClaims(claims: DeviceProofProtectedClaims): JsonObject {
  const canonical: Record<string, JsonValue> = {
    version: claims.version,
    tenantId: claims.tenantId,
    productId: claims.productId,
    deviceId: claims.deviceId,
    keyId: claims.keyId,
    keyEpoch: claims.keyEpoch,
    requestId: claims.requestId,
    operation: claims.operation,
    resource: claims.resource,
    bodySha256: claims.bodySha256,
    bodySize: claims.bodySize,
    issuedAt: claims.issuedAt,
  };
  if (claims.method !== undefined) canonical['method'] = claims.method;
  if (claims.path !== undefined) canonical['path'] = claims.path;
  if (claims.operationId !== undefined) canonical['operationId'] = claims.operationId;
  if (claims.expiresAt !== undefined) canonical['expiresAt'] = claims.expiresAt;
  if (claims.nonce !== undefined) canonical['nonce'] = claims.nonce;
  return canonical;
}

/** Canonical JSON text of the protected claim set, without the domain prefix. */
export function deviceProofCanonicalJson(claims: DeviceProofProtectedClaims): string {
  return canonicalizeJson(deviceProofCanonicalClaims(claims));
}

/**
 * The exact bytes a device signs and a verifier reconstructs:
 * `byok-device-proof-v1\n` followed by the canonical claim JSON, UTF-8 encoded.
 *
 * Frozen by `src/__tests__/golden/device-proof-v1.canonical.json`.
 */
export function deviceProofSigningInput(claims: DeviceProofProtectedClaims): Uint8Array {
  return new TextEncoder().encode(
    DEVICE_PROOF_DOMAIN_PREFIX + deviceProofCanonicalJson(claims),
  );
}

// ---------------------------------------------------------------------------
// Verify port
// ---------------------------------------------------------------------------

export interface DeviceProofVerifyInput {
  readonly algorithm: DeviceProofAlgorithm;
  /** Raw public key, base64url — the JWK `x` encoding the device registry stores. */
  readonly publicKey: string;
  readonly signature: string;
  readonly signingInput: Uint8Array;
}

/**
 * Injected signature verification.
 *
 * Not a store port, so it has no tenant parameter: it answers a pure
 * cryptographic question about bytes. Deciding *which* key to check against is
 * the caller's tenant-scoped device-row lookup, and keeping that out of here is
 * what stops a verifier from becoming a second authority on device identity.
 */
export interface DeviceProofVerifier {
  verify(input: DeviceProofVerifyInput): Promise<boolean>;
}
