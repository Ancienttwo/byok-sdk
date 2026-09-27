/**
 * Sealed provider provisioning v1 (plan web-sealed-provisioning §3).
 *
 * A browser seals a provider API key to one device's long-lived P-256
 * sealing key; the cloud relays only ciphertext; the device opens it in
 * memory. This module is the single byte authority both ends share:
 *
 * - the request schema (header + non-secret config + optional sealed secret),
 * - canonical AAD bytes, config digest, and request digest,
 * - the sealing-key claim canonical bytes a device signs at registration,
 * - plaintext padding (2-byte length prefix, zero-padded to 256-byte blocks),
 * - one-shot seal/open on top of `hpke.ts`.
 *
 * Every function is WebCrypto-only and `node:`-free so the Web bundle and the
 * device use literally the same code. Nothing here reads a clock, a network,
 * or a store; time windows, replay ledgers, placement and enrollment are the
 * device's (`@byok-sdk/keys`) decisions.
 *
 * Error messages never include plaintext, ciphertext, or key material.
 */
import { z } from 'zod';

import { canonicalizeJson, canonicalizeJsonBytes, type JsonObject, type JsonValue } from './attestation';
import { CONTENT_HASH_PATTERN } from './blob';
import { ByokCoreError } from './errors';
import {
  HPKE_AEAD_TAG_BYTES,
  HPKE_P256_PUBLIC_KEY_BYTES,
  hpkeOpenBase,
  hpkeSealBase,
  importP256PublicKey,
} from './hpke';
import { isCanonicalTimestamp } from './time';
import { webCryptoSubtle, type WebCryptoKey } from './webcrypto';

export type { WebCryptoKey } from './webcrypto';

/** The only HPKE suite v1 admits. There is no negotiation and no second value. */
export const PROVIDER_SECRET_HPKE_SUITE = 'hpke-base.dhkem-p256-hkdf-sha256.hkdf-sha256.aes-128-gcm';

/** HPKE `info`, versioned; a v2 is a new constant, never a parser branch. */
export const PROVIDER_SECRET_HPKE_INFO = 'byok-sdk.provider-secret.v1';

export const PROVIDER_PROVISIONING_REQUEST_VERSION = 1;

export const PROVIDER_PROVISIONING_OPERATIONS = ['configure', 'update_model', 'replace_secret', 'delete'] as const;
export type ProviderProvisioningOperation = (typeof PROVIDER_PROVISIONING_OPERATIONS)[number];

/** Operations whose request must carry exactly one sealed secret. */
export const PROVIDER_PROVISIONING_SECRET_OPERATIONS = ['configure', 'replace_secret'] as const;

/** Upper bound for `expiresAt - issuedAt` (plan D11). */
export const PROVIDER_PROVISIONING_MAX_TTL_MS = 15 * 60 * 1000;

/** Plaintext is padded to a multiple of this many bytes so ciphertext length hides key length. */
export const PROVIDER_SECRET_PAD_BLOCK_BYTES = 256;

/** Largest padded plaintext v1 accepts; the secret itself is at most this minus the 2-byte prefix. */
export const PROVIDER_SECRET_MAX_PADDED_BYTES = 4096;

export const PROVIDER_SECRET_MAX_BYTES = PROVIDER_SECRET_MAX_PADDED_BYTES - 2;

/** Length of a sealing key id: base64url(sha256(raw public key)) truncated to 22 characters. */
export const SEALING_KEY_ID_LENGTH = 22;

// ---------------------------------------------------------------------------
// base64url (strict, unpadded, canonical)
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  for (; index + 3 <= bytes.length; index += 3) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    out += B64URL_ALPHABET[(value >> 18) & 63]! + B64URL_ALPHABET[(value >> 12) & 63]!
      + B64URL_ALPHABET[(value >> 6) & 63]! + B64URL_ALPHABET[value & 63]!;
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const value = bytes[index]! << 16;
    out += B64URL_ALPHABET[(value >> 18) & 63]! + B64URL_ALPHABET[(value >> 12) & 63]!;
  } else if (rest === 2) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    out += B64URL_ALPHABET[(value >> 18) & 63]! + B64URL_ALPHABET[(value >> 12) & 63]!
      + B64URL_ALPHABET[(value >> 6) & 63]!;
  }
  return out;
}

/** Decode canonical unpadded base64url, or throw — never a repaired approximation. */
export function decodeBase64Url(value: string, field: string): Uint8Array<ArrayBuffer> {
  if (!B64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new ByokCoreError('sealed_secret_invalid', `${field} is not canonical base64url`);
  }
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of value) {
    buffer = (buffer << 6) | B64URL_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  if (encodeBase64Url(out) !== value) {
    throw new ByokCoreError('sealed_secret_invalid', `${field} is not canonical base64url`);
  }
  return out;
}

function base64UrlField(bytes: { exact?: number; max?: number }) {
  return z.string().superRefine((value, ctx) => {
    try {
      const decoded = decodeBase64Url(value, 'field');
      if (bytes.exact !== undefined && decoded.byteLength !== bytes.exact) {
        ctx.addIssue({ code: 'custom', message: `must decode to exactly ${bytes.exact} bytes` });
      }
      if (bytes.max !== undefined && decoded.byteLength > bytes.max) {
        ctx.addIssue({ code: 'custom', message: `must decode to at most ${bytes.max} bytes` });
      }
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be canonical unpadded base64url' });
    }
  });
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await webCryptoSubtle().digest('SHA-256', new Uint8Array(bytes)));
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function contentDigest(value: JsonValue): Promise<string> {
  return `sha256:${hex(await sha256(canonicalizeJsonBytes(value)))}`;
}

// ---------------------------------------------------------------------------
// Sealing key (public JWK + claim)
// ---------------------------------------------------------------------------

/**
 * The only public-key shape v1 accepts. Strict: a `d` (private) member, an
 * `alg`, `use`, `key_ops` or any other extra member is rejected rather than
 * ignored, so a private JWK can never be published by mistake.
 */
export const SealingPublicJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: base64UrlField({ exact: 32 }),
  y: base64UrlField({ exact: 32 }),
});
export type SealingPublicJwk = z.infer<typeof SealingPublicJwkSchema>;

export const SealingKeyIdSchema = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${SEALING_KEY_ID_LENGTH}}$`));

function parseSealingPublicJwk(input: unknown): SealingPublicJwk {
  const result = SealingPublicJwkSchema.safeParse(input);
  if (!result.success) {
    throw new ByokCoreError('sealed_secret_invalid', 'Sealing public key must be a strict P-256 EC public JWK');
  }
  return result.data;
}

/** Uncompressed SEC1 bytes (`0x04 || x || y`) of a sealing public JWK. */
export function sealingPublicKeyBytes(publicJwk: SealingPublicJwk): Uint8Array<ArrayBuffer> {
  const jwk = parseSealingPublicJwk(publicJwk);
  const raw = new Uint8Array(HPKE_P256_PUBLIC_KEY_BYTES);
  raw[0] = 0x04;
  raw.set(decodeBase64Url(jwk.x, 'x'), 1);
  raw.set(decodeBase64Url(jwk.y, 'y'), 33);
  return raw;
}

/** `base64url(sha256(0x04 || x || y))[0..22]` — the device's and the browser's shared key id rule. */
export async function deriveSealingKeyId(publicJwk: SealingPublicJwk): Promise<string> {
  const raw = sealingPublicKeyBytes(publicJwk);
  await importP256PublicKey(raw);
  return encodeBase64Url(await sha256(raw)).slice(0, SEALING_KEY_ID_LENGTH);
}

/**
 * The claim a device signs (through its device-proof signer, host glue) when
 * it registers its sealing key. The proof body is these canonical bytes.
 */
export const SealingKeyClaimV1Schema = z.strictObject({
  version: z.literal(1),
  keyId: SealingKeyIdSchema,
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  publicJwk: SealingPublicJwkSchema,
});
export type SealingKeyClaimV1 = z.infer<typeof SealingKeyClaimV1Schema>;

/** Canonical UTF-8 bytes of a sealing-key claim. */
export function sealingKeyClaimCanonicalBytes(claim: SealingKeyClaimV1): Uint8Array {
  const result = SealingKeyClaimV1Schema.safeParse(claim);
  if (!result.success) {
    throw new ByokCoreError('sealed_secret_invalid', 'Sealing key claim is invalid');
  }
  const parsed = result.data;
  return canonicalizeJsonBytes({
    version: parsed.version,
    keyId: parsed.keyId,
    epoch: parsed.epoch,
    publicJwk: { kty: parsed.publicJwk.kty, crv: parsed.publicJwk.crv, x: parsed.publicJwk.x, y: parsed.publicJwk.y },
  });
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/** Opaque identifier: non-empty, bounded, no surrounding whitespace, no control characters. */
const OpaqueIdSchema = z.string().min(1).max(200).superRefine((value, ctx) => {
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'must not carry surrounding whitespace or control characters' });
  }
});

const CanonicalTimestampSchema = z.string().refine(isCanonicalTimestamp, 'must be a canonical ISO-8601 UTC instant');

const ProfileRefSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u);
const ProviderKindSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u);
const ModelIdSchema = z.string().min(1).max(160).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), 'model id is invalid');
const CapabilitySchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/**
 * `pi_model` travels as an opaque canonicalizable JSON object; the device
 * validates it against `@byok-sdk/keys`' strict `PiModelConfigSchema`. Core
 * only guarantees it has one canonical byte form.
 */
const PiModelJsonSchema = z.custom<JsonObject>((value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    canonicalizeJson(value as JsonObject);
    return true;
  } catch {
    return false;
  }
}, 'piModel must be a canonical JSON object');

const ModelConfigFields = {
  agentId: OpaqueIdSchema,
  providerKind: ProviderKindSchema,
  modelId: ModelIdSchema,
  piModel: PiModelJsonSchema,
  capabilities: z.array(CapabilitySchema).max(8).refine((values) => new Set(values).size === values.length, 'capabilities must be unique'),
};

/**
 * The non-secret configuration, one exact shape per operation. An operation
 * carries only the fields it acts on — `delete` has no model, `replace_secret`
 * declares only the provider kind its key is scoped to — so nothing is
 * accepted and silently ignored.
 */
export const ProviderProvisioningConfigV1Schema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('configure'), ...ModelConfigFields }),
  z.strictObject({ operation: z.literal('update_model'), ...ModelConfigFields }),
  z.strictObject({ operation: z.literal('replace_secret'), agentId: OpaqueIdSchema, providerKind: ProviderKindSchema }),
  z.strictObject({ operation: z.literal('delete'), agentId: OpaqueIdSchema }),
]);
export type ProviderProvisioningConfigV1 = z.infer<typeof ProviderProvisioningConfigV1Schema>;

/** The credential-free provider triple the Host believes is current (A3), or `null` for none. */
export const ProviderProvisioningExpectedProfileSchema = z.union([
  z.null(),
  z.strictObject({
    profileRef: ProfileRefSchema,
    profileRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u),
    profileHash: z.string().regex(CONTENT_HASH_PATTERN),
  }),
]);
export type ProviderProvisioningExpectedProfile = z.infer<typeof ProviderProvisioningExpectedProfileSchema>;

/**
 * Opaque, Host-issued identity version: the enrollment revision (changes on
 * re-pair / re-enrollment of the same device id) or the agent placement
 * revision. The device compares it byte-for-byte with its own snapshot.
 */
export const ProviderProvisioningIdentityRevisionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);

export const ProviderProvisioningHeaderV1Schema = z.strictObject({
  tenantId: OpaqueIdSchema,
  deviceId: OpaqueIdSchema,
  agentId: OpaqueIdSchema,
  requestId: OpaqueIdSchema,
  operation: z.enum(PROVIDER_PROVISIONING_OPERATIONS),
  /** Non-secret, strictly increasing per bot (A3); a device rejects anything not above its high-watermark. */
  operationGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedProfile: ProviderProvisioningExpectedProfileSchema,
  /** The device enrollment revision the Host authorized against (F2). */
  expectedEnrollmentRevision: ProviderProvisioningIdentityRevisionSchema,
  /** The agent placement revision the Host authorized against (F2). */
  expectedPlacementRevision: ProviderProvisioningIdentityRevisionSchema,
  configDigest: z.string().regex(CONTENT_HASH_PATTERN),
  issuedAt: CanonicalTimestampSchema,
  expiresAt: CanonicalTimestampSchema,
});
export type ProviderProvisioningHeaderV1 = z.infer<typeof ProviderProvisioningHeaderV1Schema>;

/** Ciphertext bound: largest padded plaintext plus the AEAD tag. */
const MAX_CIPHERTEXT_BYTES = PROVIDER_SECRET_MAX_PADDED_BYTES + HPKE_AEAD_TAG_BYTES;

export const SealedProviderSecretV1Schema = z.strictObject({
  suite: z.literal(PROVIDER_SECRET_HPKE_SUITE),
  keyId: SealingKeyIdSchema,
  enc: base64UrlField({ exact: HPKE_P256_PUBLIC_KEY_BYTES }),
  ciphertext: base64UrlField({ max: MAX_CIPHERTEXT_BYTES }),
});
export type SealedProviderSecretV1 = z.infer<typeof SealedProviderSecretV1Schema>;

function isSecretOperation(operation: ProviderProvisioningOperation): boolean {
  return (PROVIDER_PROVISIONING_SECRET_OPERATIONS as readonly string[]).includes(operation);
}

export const ProviderProvisioningRequestV1Schema = z
  .strictObject({
    version: z.literal(PROVIDER_PROVISIONING_REQUEST_VERSION),
    header: ProviderProvisioningHeaderV1Schema,
    config: ProviderProvisioningConfigV1Schema,
    sealed: SealedProviderSecretV1Schema.optional(),
  })
  .superRefine((request, ctx) => {
    if (request.header.operation !== request.config.operation) {
      ctx.addIssue({ code: 'custom', path: ['config', 'operation'], message: 'config operation must equal header operation' });
    }
    if (request.header.agentId !== request.config.agentId) {
      ctx.addIssue({ code: 'custom', path: ['config', 'agentId'], message: 'config agentId must equal header agentId' });
    }
    if (isSecretOperation(request.header.operation) !== (request.sealed !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['sealed'], message: 'a sealed secret is required exactly for configure and replace_secret' });
    }
  });
export type ProviderProvisioningRequestV1 = z.infer<typeof ProviderProvisioningRequestV1Schema>;

/** Parse a request fail-closed. Issue text names paths and rules only, never values. */
export function parseProviderProvisioningRequest(input: unknown): ProviderProvisioningRequestV1 {
  const result = ProviderProvisioningRequestV1Schema.safeParse(input);
  if (!result.success) {
    throw new ByokCoreError(
      'provider_provisioning_request_invalid',
      `Invalid provider provisioning request: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Canonical bytes and digests
// ---------------------------------------------------------------------------

function configJson(config: ProviderProvisioningConfigV1): JsonObject {
  return config as unknown as JsonObject;
}

/** `sha256:<hex>` over the canonical JSON of the non-secret config. */
export async function providerProvisioningConfigDigest(config: ProviderProvisioningConfigV1): Promise<string> {
  const result = ProviderProvisioningConfigV1Schema.safeParse(config);
  if (!result.success) {
    throw new ByokCoreError('provider_provisioning_request_invalid', 'Provider provisioning config is invalid');
  }
  return contentDigest(configJson(result.data));
}

/**
 * Canonical AAD bytes. Every header field plus the sealing key id is bound,
 * so tampering with any of tenant, device, key, request, agent, operation,
 * generation, expected triple, expected enrollment and placement revisions,
 * config digest, or time window fails the AEAD.
 */
export function providerSecretAadBytes(header: ProviderProvisioningHeaderV1, keyId: string): Uint8Array {
  const parsed = ProviderProvisioningHeaderV1Schema.safeParse(header);
  if (!parsed.success || !SealingKeyIdSchema.safeParse(keyId).success) {
    throw new ByokCoreError('provider_provisioning_request_invalid', 'Provider provisioning AAD input is invalid');
  }
  const value = parsed.data;
  return canonicalizeJsonBytes({
    v: PROVIDER_PROVISIONING_REQUEST_VERSION,
    tenantId: value.tenantId,
    deviceId: value.deviceId,
    keyId,
    requestId: value.requestId,
    agentId: value.agentId,
    operation: value.operation,
    operationGeneration: value.operationGeneration,
    expectedProfile: value.expectedProfile === null
      ? null
      : {
        profileRef: value.expectedProfile.profileRef,
        profileRevision: value.expectedProfile.profileRevision,
        profileHash: value.expectedProfile.profileHash,
      },
    expectedEnrollmentRevision: value.expectedEnrollmentRevision,
    expectedPlacementRevision: value.expectedPlacementRevision,
    configDigest: value.configDigest,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

/**
 * `sha256:<hex>` over the canonical JSON of the complete request. A device
 * compares it for an already-seen `requestId`: equal returns the stored
 * result, different is a conflict.
 */
export async function providerProvisioningRequestDigest(request: ProviderProvisioningRequestV1): Promise<string> {
  const parsed = parseProviderProvisioningRequest(request);
  return contentDigest(parsed as unknown as JsonObject);
}

/** Fail closed unless `header.configDigest` is the digest of `config`. */
export async function assertProviderProvisioningConfigDigest(request: ProviderProvisioningRequestV1): Promise<void> {
  const parsed = parseProviderProvisioningRequest(request);
  if ((await providerProvisioningConfigDigest(parsed.config)) !== parsed.header.configDigest) {
    throw new ByokCoreError('provider_provisioning_request_invalid', 'Provider provisioning config digest does not match its header');
  }
}

// ---------------------------------------------------------------------------
// Padding
// ---------------------------------------------------------------------------

/** `u16be(len) || utf8(secret) || zeros`, total a multiple of 256 bytes. */
export function padProviderSecret(secret: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SECRET_MAX_BYTES) {
    throw new ByokCoreError('sealed_secret_invalid', `Provider secret must be 1 to ${PROVIDER_SECRET_MAX_BYTES} UTF-8 bytes`);
  }
  const total = Math.ceil((bytes.byteLength + 2) / PROVIDER_SECRET_PAD_BLOCK_BYTES) * PROVIDER_SECRET_PAD_BLOCK_BYTES;
  const out = new Uint8Array(total);
  out[0] = bytes.byteLength >> 8;
  out[1] = bytes.byteLength & 0xff;
  out.set(bytes, 2);
  return out;
}

/** Strict inverse of {@link padProviderSecret}: block size, bounds, zero padding, and fatal UTF-8 are all checked. */
export function unpadProviderSecret(padded: Uint8Array): string {
  if (
    padded.byteLength < PROVIDER_SECRET_PAD_BLOCK_BYTES
    || padded.byteLength > PROVIDER_SECRET_MAX_PADDED_BYTES
    || padded.byteLength % PROVIDER_SECRET_PAD_BLOCK_BYTES !== 0
  ) {
    throw new ByokCoreError('sealed_secret_invalid', 'Padded provider secret has an invalid length');
  }
  const length = (padded[0]! << 8) | padded[1]!;
  if (length === 0 || length + 2 > padded.byteLength || padded.byteLength - (length + 2) >= PROVIDER_SECRET_PAD_BLOCK_BYTES) {
    throw new ByokCoreError('sealed_secret_invalid', 'Padded provider secret has an invalid length prefix');
  }
  for (let index = length + 2; index < padded.byteLength; index += 1) {
    if (padded[index] !== 0) {
      throw new ByokCoreError('sealed_secret_invalid', 'Padded provider secret has non-zero padding');
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(padded.subarray(2, length + 2));
  } catch {
    throw new ByokCoreError('sealed_secret_invalid', 'Provider secret is not valid UTF-8');
  }
}

// ---------------------------------------------------------------------------
// One-shot seal / open
// ---------------------------------------------------------------------------

const INFO_BYTES = (): Uint8Array => new TextEncoder().encode(PROVIDER_SECRET_HPKE_INFO);

export interface SealProviderProvisioningRequestInput {
  /** The header without its digest; the digest is computed here from `config`. */
  readonly header: Omit<ProviderProvisioningHeaderV1, 'configDigest'>;
  readonly config: ProviderProvisioningConfigV1;
  /** Required exactly for secret-bearing operations. */
  readonly recipient?: { readonly keyId: string; readonly publicJwk: SealingPublicJwk };
  /** Required exactly for secret-bearing operations. */
  readonly secret?: string;
}

/**
 * Build one immutable provisioning request. Secret-bearing operations are
 * sealed once, to a freshly generated ephemeral key; the key id is re-derived
 * from the public JWK so a claim whose id does not match its key is refused
 * before anything is encrypted.
 */
export async function sealProviderProvisioningRequest(
  input: SealProviderProvisioningRequestInput,
): Promise<ProviderProvisioningRequestV1> {
  const configResult = ProviderProvisioningConfigV1Schema.safeParse(input.config);
  if (!configResult.success) {
    throw new ByokCoreError('provider_provisioning_request_invalid', 'Provider provisioning config is invalid');
  }
  const config = configResult.data;
  const headerResult = ProviderProvisioningHeaderV1Schema.safeParse({
    ...input.header,
    configDigest: await providerProvisioningConfigDigest(config),
  });
  if (!headerResult.success) {
    throw new ByokCoreError('provider_provisioning_request_invalid', 'Provider provisioning header is invalid');
  }
  const header = headerResult.data;
  const needsSecret = isSecretOperation(header.operation);
  if (needsSecret !== (input.secret !== undefined) || needsSecret !== (input.recipient !== undefined)) {
    throw new ByokCoreError(
      'provider_provisioning_request_invalid',
      'A secret and recipient are required exactly for configure and replace_secret',
    );
  }
  let sealed: SealedProviderSecretV1 | undefined;
  if (needsSecret) {
    const recipient = input.recipient!;
    const publicJwk = parseSealingPublicJwk(recipient.publicJwk);
    if ((await deriveSealingKeyId(publicJwk)) !== recipient.keyId) {
      throw new ByokCoreError('sealed_secret_invalid', 'Sealing key id does not match its public key');
    }
    const { enc, ciphertext } = await hpkeSealBase({
      recipientPublicKey: sealingPublicKeyBytes(publicJwk),
      info: INFO_BYTES(),
      aad: providerSecretAadBytes(header, recipient.keyId),
      plaintext: padProviderSecret(input.secret!),
    });
    sealed = {
      suite: PROVIDER_SECRET_HPKE_SUITE,
      keyId: recipient.keyId,
      enc: encodeBase64Url(enc),
      ciphertext: encodeBase64Url(ciphertext),
    };
  }
  return parseProviderProvisioningRequest({
    version: PROVIDER_PROVISIONING_REQUEST_VERSION,
    header,
    config,
    ...(sealed === undefined ? {} : { sealed }),
  });
}

export interface ProviderSecretRecipient {
  readonly keyId: string;
  readonly publicJwk: SealingPublicJwk;
  /** Non-extractable ECDH private key; never leaves the device. */
  readonly privateKey: WebCryptoKey;
}

/**
 * Open the sealed secret of a request, in memory. Checks, in order: request
 * schema, suite (schema literal), recipient key id, config digest, ciphertext
 * length against the padding grammar, HPKE open under the request's own AAD,
 * then strict unpadding. Time windows, replay, and placement are not checked
 * here — they are device state.
 */
export async function openProviderProvisioningSecret(input: {
  readonly request: ProviderProvisioningRequestV1;
  readonly recipient: ProviderSecretRecipient;
}): Promise<string> {
  const request = parseProviderProvisioningRequest(input.request);
  const sealed = request.sealed;
  if (sealed === undefined) {
    throw new ByokCoreError('provider_provisioning_request_invalid', 'Provider provisioning request carries no sealed secret');
  }
  const publicJwk = parseSealingPublicJwk(input.recipient.publicJwk);
  if (sealed.keyId !== input.recipient.keyId || (await deriveSealingKeyId(publicJwk)) !== input.recipient.keyId) {
    throw new ByokCoreError('sealed_secret_invalid', 'Sealed secret is not addressed to this sealing key');
  }
  await assertProviderProvisioningConfigDigest(request);
  const ciphertext = decodeBase64Url(sealed.ciphertext, 'ciphertext');
  const paddedLength = ciphertext.byteLength - HPKE_AEAD_TAG_BYTES;
  if (
    paddedLength < PROVIDER_SECRET_PAD_BLOCK_BYTES
    || paddedLength > PROVIDER_SECRET_MAX_PADDED_BYTES
    || paddedLength % PROVIDER_SECRET_PAD_BLOCK_BYTES !== 0
  ) {
    throw new ByokCoreError('sealed_secret_invalid', 'Sealed secret ciphertext has an invalid length');
  }
  const padded = await hpkeOpenBase({
    recipientPrivateKey: input.recipient.privateKey,
    recipientPublicKey: sealingPublicKeyBytes(publicJwk),
    enc: decodeBase64Url(sealed.enc, 'enc'),
    info: INFO_BYTES(),
    aad: providerSecretAadBytes(request.header, sealed.keyId),
    ciphertext,
  });
  try {
    return unpadProviderSecret(padded);
  } finally {
    padded.fill(0);
  }
}
