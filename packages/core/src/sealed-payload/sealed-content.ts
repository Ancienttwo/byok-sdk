/**
 * Sealed content v1 (#654 design §8.1, §8.2, §8.6, §9.1).
 *
 * A member seals the fields one category moves out of a payload. The result is
 * a header the Host may read — version, suite, category, scope, chain head,
 * sender, salt, nonce, padded length and content MAC — and the ciphertext
 * bytes. Whether the ciphertext travels inline or by reference is the wire
 * schema's rule, not this module's.
 *
 * The plaintext is the canonical JSON of the moved fields. It is framed before
 * encryption: `u32be(contentLength) || content || zeros`, padded in 256-byte
 * steps up to 16 KiB and with Padmé above. The frame is inside the AEAD, so the
 * length and the padding are authenticated, and one content has exactly one
 * legal padded length.
 *
 * The AAD binds every identity the Host could otherwise swap: tenant, scope,
 * epoch, key id, chain head, sender, message family, direction, the write's
 * identity, target device, Agent, the task's sealing categories, padded length
 * and content MAC. Envelope `id`, `seq` and `ts` stay out, so an envelope that
 * a dead-letter replay re-encodes still opens.
 *
 * `contentMac` is a keyed MAC over category, family, identity and plaintext. The
 * Host compares two submissions of one identity by it, without a key.
 *
 * A blob field is sealed by the same frame and key rule, before its outer
 * content. Its AAD is the outer AAD without `paddedLength` and `contentMac`,
 * plus its own `paddedLength` and the JSON Pointer `fieldPath` to its BlobRef.
 */
import { z } from 'zod';

import { canonicalizeJson, canonicalizeJsonBytes, type JsonObject } from '../attestation';
import { CONTENT_HASH_PATTERN } from '../blob';
import { ByokCoreError } from '../errors';
import { isCanonicalTimestamp } from '../time';
import { safeParseTotal } from '../total-parse';
import { webCryptoSubtle } from '../webcrypto';
import { MEMBER_ID_PATTERN } from './member-chain';
import {
  base64UrlBytes,
  copy,
  decodeBase64Url,
  encodeBase64Url,
  hex,
  hmacSha256,
  invalidInput,
  randomBytes,
  utf8,
  type Bytes,
} from './primitives';
import {
  SCOPE_KEY_ID_PATTERN,
  SEALED_SALT_BYTES,
  deriveScopeKeyId,
  deriveSealedContentKey,
  deriveSealedMacKey,
} from './scope-key';
import { canonicalizeSealedJson } from './sealed-json';

export const SEALED_CONTENT_VERSION = 1;

/** The only suite v1 admits. A new suite is a new constant and a new capability, never a parser branch. */
export const SEALED_CONTENT_SUITE = 'byok-sealed-v1.hkdf-sha256.aes-256-gcm';

/** C1–C4, in their canonical order. A task's sealing categories are listed in this order. */
export const SEALED_CATEGORIES = ['task-input', 'agent-message', 'task-output', 'memory-projection'] as const;
export type SealedCategory = (typeof SEALED_CATEGORIES)[number];

export const SEALED_DIRECTIONS = ['server-to-daemon', 'daemon-to-server'] as const;
export type SealedDirection = (typeof SEALED_DIRECTIONS)[number];

export const SEALED_NONCE_BYTES = 12;

/** @internal Shared with `sealed-blob.ts`. Stripped from the published declarations. */
export const AEAD_TAG_BYTES = 16;
const FRAME_HEADER_BYTES = 4;
const ALIGNED_FRAME_LIMIT = 16 * 1024;
const FRAME_ALIGNMENT = 256;
const MAX_CONTENT_LENGTH = 0xffff_ffff;

const CONTENT_MAC_PREFIX = 'byok-content-mac-v1\n';
const CONTENT_MAC_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;

/** Dot-separated lowercase words, e.g. `task.offer`. It can never hold the MAC's `\n` separator. */
const FAMILY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const IDENTITY_FIELD_PATTERN = /^[a-z][A-Za-z0-9]*$/u;
/** The one family that binds no device (design §6.3). */
const ROUTINE_TEMPLATE_FAMILY = 'routine.template';

// ---------------------------------------------------------------------------
// Padding and framing (§8.1, §8.6)
// ---------------------------------------------------------------------------

/** `floor(log2(value))` for a positive safe integer, without floating-point logarithms. */
function floorLog2(value: number): number {
  let exponent = 0;
  for (let remaining = value; remaining >= 2; remaining = Math.floor(remaining / 2)) exponent += 1;
  return exponent;
}

/**
 * The one legal padded length of a frame whose unpadded length is
 * `frameLength` (`4 + contentLength`). Up to 16 KiB: the next multiple of 256.
 * Above: Padmé — `E = floor(log2 n)`, `S = floor(log2 E) + 1`, rounded up to a
 * multiple of `2^(E − S)`, which adds less than 6.25%.
 */
export function sealedPaddedLength(frameLength: number): number {
  if (!Number.isSafeInteger(frameLength) || frameLength < FRAME_HEADER_BYTES) {
    throw invalidInput('Sealed frame length must be a safe integer of at least 4');
  }
  if (frameLength <= ALIGNED_FRAME_LIMIT) return Math.ceil(frameLength / FRAME_ALIGNMENT) * FRAME_ALIGNMENT;
  const exponent = floorLog2(frameLength);
  const step = 2 ** (exponent - (floorLog2(exponent) + 1));
  return Math.ceil(frameLength / step) * step;
}

/**
 * Total on any number: zod runs this refinement even after the integer checks fail.
 * @internal Shared with `sealed-blob.ts`. Stripped from the published declarations.
 */
export function isLegalPaddedLength(paddedLength: number): boolean {
  return Number.isSafeInteger(paddedLength)
    && paddedLength >= FRAME_ALIGNMENT
    && sealedPaddedLength(paddedLength) === paddedLength;
}

/** `u32be(contentLength) || content || zeros`, as long as {@link sealedPaddedLength} says. */
export function encodeSealedFrame(content: Uint8Array): Bytes {
  if (content.byteLength > MAX_CONTENT_LENGTH) throw invalidInput('Sealed content exceeds the 32-bit frame length');
  const frame = new Uint8Array(sealedPaddedLength(FRAME_HEADER_BYTES + content.byteLength));
  new DataView(frame.buffer).setUint32(0, content.byteLength, false);
  frame.set(content, FRAME_HEADER_BYTES);
  return frame as Bytes;
}

/**
 * The content of a decrypted frame, or `undefined` when one of the five
 * receiver checks fails: frame length equals `paddedLength`; the content fits;
 * `paddedLength` is the padded length of exactly this content; every padding
 * byte is zero; the content is within the message type's plaintext limit.
 */
export function decodeSealedFrame(frame: Uint8Array, paddedLength: number, maxContentLength: number): Uint8Array | undefined {
  if (frame.byteLength !== paddedLength || paddedLength < FRAME_HEADER_BYTES) return undefined;
  const contentLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (contentLength > paddedLength - FRAME_HEADER_BYTES) return undefined;
  if (sealedPaddedLength(FRAME_HEADER_BYTES + contentLength) !== paddedLength) return undefined;
  if (contentLength > maxContentLength) return undefined;
  for (let index = FRAME_HEADER_BYTES + contentLength; index < paddedLength; index += 1) {
    if (frame[index] !== 0) return undefined;
  }
  return frame.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + contentLength);
}

// ---------------------------------------------------------------------------
// Header and binding
// ---------------------------------------------------------------------------

const NonEmptyStringSchema = z.string().min(1);
/** @internal Shared with `sealed-blob.ts`. Stripped from the published declarations. */
export const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** What the Host may read of one sealed content. The ciphertext travels next to it. */
export const SealedContentHeaderV1Schema = z.strictObject({
  v: z.literal(SEALED_CONTENT_VERSION),
  suite: z.literal(SEALED_CONTENT_SUITE),
  category: z.enum(SEALED_CATEGORIES),
  scope: z.strictObject({
    id: NonEmptyStringSchema,
    epoch: PositiveIntegerSchema,
    keyId: z.string().regex(SCOPE_KEY_ID_PATTERN),
  }),
  chainHead: z.strictObject({
    seq: PositiveIntegerSchema,
    hash: z.string().regex(CONTENT_HASH_PATTERN),
  }),
  sender: z.string().regex(MEMBER_ID_PATTERN),
  salt: base64UrlBytes(SEALED_SALT_BYTES),
  nonce: base64UrlBytes(SEALED_NONCE_BYTES),
  paddedLength: PositiveIntegerSchema.refine(isLegalPaddedLength, 'must be a legal padded frame length'),
  contentMac: z.string().regex(CONTENT_MAC_PATTERN),
});
export type SealedContentHeaderV1 = z.infer<typeof SealedContentHeaderV1Schema>;

function isCanonicalCategoryList(categories: readonly SealedCategory[]): boolean {
  return categories.every((category, index) =>
    index === 0 || SEALED_CATEGORIES.indexOf(categories[index - 1]!) < SEALED_CATEGORIES.indexOf(category));
}

/**
 * What the receiver knows from its own context and the payload's plaintext
 * fields. The receiver builds it; the sealed bytes never supply it.
 */
export interface SealedBinding {
  readonly tenantId: string;
  /** Message family, e.g. `task.offer`, or `routine.template`. */
  readonly family: string;
  readonly direction: SealedDirection;
  /** The write's identity: `{ taskId }`, `{ messageId }`, … or `{ routineId, definitionVersion }`. */
  readonly identity: { readonly [field: string]: string | number };
  /** Target device. `null` only for the `routine.template` family, which binds no device. */
  readonly deviceId: string | null;
  readonly agentRef: { readonly agentId: string; readonly profileRevision: string } | null;
  /** The task's `sealing.categories`, unique and in {@link SEALED_CATEGORIES} order. */
  readonly categories: readonly SealedCategory[];
  /** A `routine.template`'s expiry; `null` for every other family. */
  readonly notAfter: string | null;
}

/** @internal Shared with `sealed-blob.ts`. Stripped from the published declarations. */
export const SealedBindingSchema = z
  .strictObject({
    tenantId: NonEmptyStringSchema,
    family: z.string().regex(FAMILY_PATTERN),
    direction: z.enum(SEALED_DIRECTIONS),
    identity: z
      .record(
        z.string().regex(IDENTITY_FIELD_PATTERN),
        z.union([NonEmptyStringSchema, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]),
      )
      .refine((identity) => Object.keys(identity).length > 0, 'identity must name at least one field'),
    deviceId: z.union([z.null(), NonEmptyStringSchema]),
    agentRef: z.union([z.null(), z.strictObject({ agentId: NonEmptyStringSchema, profileRevision: NonEmptyStringSchema })]),
    categories: z.array(z.enum(SEALED_CATEGORIES)).min(1).refine(isCanonicalCategoryList, 'categories must be unique and in canonical order'),
    notAfter: z.union([z.null(), z.string().refine(isCanonicalTimestamp, 'must be a canonical UTC instant')]),
  })
  .superRefine((binding, ctx) => {
    const template = binding.family === ROUTINE_TEMPLATE_FAMILY;
    if ((binding.deviceId === null) !== template || (binding.notAfter === null) === template) {
      ctx.addIssue({
        code: 'custom',
        path: ['deviceId'],
        message: 'a routine template binds an expiry and no device; every other family binds a device and no expiry',
      });
    }
  });
/** @internal Shared with `sealed-blob.ts`. Stripped from the published declarations. */
export type ParsedBinding = z.infer<typeof SealedBindingSchema>;

/** @internal Shared with `sealed-blob.ts`. Stripped from the published declarations. */
export function parseBinding(binding: SealedBinding): ParsedBinding {
  const parsed = safeParseTotal(SealedBindingSchema, binding);
  if (!parsed.success) throw invalidInput('Sealed content binding is invalid');
  return parsed.data;
}

/** @internal Shared with `sealed-blob.ts`. Stripped from the published declarations. */
export function assertMaxContentLength(maxContentLength: number): void {
  if (!Number.isSafeInteger(maxContentLength) || maxContentLength < 0 || maxContentLength > MAX_CONTENT_LENGTH) {
    throw invalidInput('Sealed content limit must be a non-negative 32-bit integer');
  }
}

/**
 * The header fields that do not depend on the plaintext. A blob is sealed before its outer content, so it knows only these.
 * @internal Shared with `sealed-blob.ts`. Stripped from the published declarations.
 */
export type SealedAadContext = Pick<SealedContentHeaderV1, 'v' | 'suite' | 'category' | 'scope' | 'chainHead' | 'sender'>;

/**
 * The 16 AAD members that the outer content and its blobs share (§8.2, §8.1).
 * @internal Shared with `sealed-blob.ts`. Stripped from the published declarations.
 */
export function bindingAad(header: SealedAadContext, binding: ParsedBinding) {
  return {
    v: header.v,
    suite: header.suite,
    category: header.category,
    tenantId: binding.tenantId,
    scopeId: header.scope.id,
    epoch: header.scope.epoch,
    keyId: header.scope.keyId,
    chainHead: { seq: header.chainHead.seq, hash: header.chainHead.hash },
    sender: header.sender,
    family: binding.family,
    direction: binding.direction,
    identity: binding.identity,
    deviceId: binding.deviceId,
    agentRef: binding.agentRef === null
      ? null
      : { agentId: binding.agentRef.agentId, profileRevision: binding.agentRef.profileRevision },
    categories: [...binding.categories],
    notAfter: binding.notAfter,
  };
}

function aadBytes(header: SealedContentHeaderV1, binding: ParsedBinding): Uint8Array {
  return canonicalizeJsonBytes({ ...bindingAad(header, binding), paddedLength: header.paddedLength, contentMac: header.contentMac });
}

/** The canonical AAD bytes of a header under a binding (§8.2). */
export function sealedContentAad(header: SealedContentHeaderV1, binding: SealedBinding): Uint8Array {
  const parsed = safeParseTotal(SealedContentHeaderV1Schema, header);
  if (!parsed.success) throw invalidInput('Sealed content header is invalid');
  return aadBytes(parsed.data, parseBinding(binding));
}

// ---------------------------------------------------------------------------
// Plaintext and content MAC (§9.1)
// ---------------------------------------------------------------------------

function isNonEmptyPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.keys(value).length > 0;
}

/** The plaintext text, with the RFC 8785 number rule (#786). The AAD and the MAC identity keep `canonicalizeJson`. */
function canonicalPlaintext(plaintext: JsonObject): string {
  try {
    if (isNonEmptyPlainObject(plaintext)) return canonicalizeSealedJson(plaintext);
  } catch (cause) {
    // A throwing getter or proxy trap reaches here too, from either check; the caller sees one typed error.
    throw new ByokCoreError('sealed_secret_invalid', 'Sealed plaintext is not canonical JSON', { cause });
  }
  throw invalidInput('Sealed plaintext must be a non-empty plain JSON object');
}

/** Decoded content, only when it is the canonical JSON text of a non-empty plain object. */
function parseCanonicalPlaintext(content: Uint8Array): { readonly value: JsonObject; readonly text: string } | undefined {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    value = JSON.parse(text);
    if (!isNonEmptyPlainObject(value) || canonicalizeSealedJson(value as JsonObject) !== text) return undefined;
  } catch {
    return undefined;
  }
  return { value: value as JsonObject, text };
}

/**
 * `"hmac-sha256:" + hex(HMAC-SHA-256(K_mac, "byok-content-mac-v1\n" || category
 * || "\n" || family || "\n" || canonicalJson(identity) || "\n" || plaintext))`.
 * No field before the plaintext can hold a raw `\n`, so the input splits one way.
 */
async function contentMacOf(scopeKey: Uint8Array, category: SealedCategory, binding: ParsedBinding, plaintextText: string): Promise<string> {
  const macKey = await deriveSealedMacKey(scopeKey);
  try {
    const input = `${CONTENT_MAC_PREFIX}${category}\n${binding.family}\n${canonicalizeJson(binding.identity)}\n${plaintextText}`;
    return `hmac-sha256:${hex(await hmacSha256(macKey, utf8(input)))}`;
  } finally {
    macKey.fill(0);
  }
}

/** The content MAC of one plaintext under one scope key (§9.1). */
export async function sealedContentMac(input: {
  readonly scopeKey: Uint8Array;
  readonly category: SealedCategory;
  readonly binding: SealedBinding;
  readonly plaintext: JsonObject;
}): Promise<string> {
  return contentMacOf(input.scopeKey, input.category, parseBinding(input.binding), canonicalPlaintext(input.plaintext));
}

// ---------------------------------------------------------------------------
// Seal and open
// ---------------------------------------------------------------------------

/** @internal Shared with `sealed-blob.ts`. Stripped from the published declarations. */
export async function aesGcm(
  mode: 'encrypt' | 'decrypt',
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
): Promise<Bytes> {
  const subtle = webCryptoSubtle();
  const cryptoKey = await subtle.importKey('raw', copy(key), { name: 'AES-GCM' }, false, [mode]);
  const params = { name: 'AES-GCM', iv: copy(nonce), additionalData: copy(aad), tagLength: 128 };
  const out = mode === 'encrypt'
    ? await subtle.encrypt(params, cryptoKey, copy(data))
    : await subtle.decrypt(params, cryptoKey, copy(data));
  return new Uint8Array(out) as Bytes;
}

export interface SealContentInput {
  readonly scopeKey: Uint8Array;
  readonly scope: { readonly id: string; readonly epoch: number };
  /** The member chain head the sender verified before sealing. */
  readonly chainHead: { readonly seq: number; readonly hash: string };
  /** The sender's member id. */
  readonly sender: string;
  readonly category: SealedCategory;
  readonly binding: SealedBinding;
  /** The fields this category moves out of the payload. */
  readonly plaintext: JsonObject;
  /** The plaintext limit of this message type, in UTF-8 bytes of canonical JSON. */
  readonly maxContentLength: number;
}

/**
 * The salt and nonce of one seal, for test vectors only.
 * @internal Stripped from the published declarations.
 */
export interface SealedContentRandomness {
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
}

export interface SealedContent {
  readonly header: SealedContentHeaderV1;
  /** AES-256-GCM output: the padded frame followed by the 16-byte tag. */
  readonly ciphertext: Uint8Array;
}

/** Seal one category of a payload once. A retry must resend these bytes, never seal again (§9.2). */
export async function sealContent(input: SealContentInput): Promise<SealedContent> {
  return sealContentWithRandomness(input, { salt: randomBytes(SEALED_SALT_BYTES), nonce: randomBytes(SEALED_NONCE_BYTES) });
}

/**
 * {@link sealContent} with a caller-chosen salt and nonce, for test vectors
 * only. Neither the root nor the subpath exports it: a reused nonce under one
 * content key breaks AES-GCM.
 * @internal Stripped from the published declarations.
 */
export async function sealContentWithRandomness(input: SealContentInput, randomness: SealedContentRandomness): Promise<SealedContent> {
  const binding = parseBinding(input.binding);
  assertMaxContentLength(input.maxContentLength);
  if (!binding.categories.includes(input.category)) {
    throw invalidInput('Sealed content category is not one of the task sealing categories');
  }
  const plaintextText = canonicalPlaintext(input.plaintext);
  const content = utf8(plaintextText);
  if (content.byteLength > input.maxContentLength) throw invalidInput('Sealed content exceeds its plaintext limit');
  const frame = encodeSealedFrame(content);
  const { salt, nonce } = randomness;
  const parsed = safeParseTotal(SealedContentHeaderV1Schema, {
    v: SEALED_CONTENT_VERSION,
    suite: SEALED_CONTENT_SUITE,
    category: input.category,
    scope: { id: input.scope.id, epoch: input.scope.epoch, keyId: await deriveScopeKeyId(input.scopeKey) },
    chainHead: { seq: input.chainHead.seq, hash: input.chainHead.hash },
    sender: input.sender,
    salt: encodeBase64Url(salt),
    nonce: encodeBase64Url(nonce),
    paddedLength: frame.byteLength,
    contentMac: await contentMacOf(input.scopeKey, input.category, binding, plaintextText),
  });
  if (!parsed.success) throw invalidInput('Sealed content header input is invalid');
  const contentKey = await deriveSealedContentKey(input.scopeKey, salt);
  try {
    const ciphertext = await aesGcm('encrypt', contentKey, nonce, aadBytes(parsed.data, binding), frame);
    return { header: parsed.data, ciphertext };
  } finally {
    contentKey.fill(0);
    frame.fill(0);
    content.fill(0);
  }
}

/** The receiver failure codes of design §8.3. */
export type SealedContentOpenFailure =
  | 'sealed_key_unavailable'
  | 'sealed_open_failed'
  | 'sealed_content_mac_mismatch'
  | 'sealing_policy_mismatch';

/**
 * An opened content, with the header that the AEAD authenticated. The caller
 * reads `chainHead` and `sender` from it for the sender-view check (§7.3).
 */
export type SealedContentOpenResult =
  | { readonly ok: true; readonly plaintext: JsonObject; readonly header: SealedContentHeaderV1 }
  | { readonly ok: false; readonly reason: SealedContentOpenFailure };

/** The task's frozen `sealing` scope (§6.2). Its `categories` are {@link SealedBinding.categories}. */
export interface SealedScopePolicy {
  readonly scopeId: string;
  /** The lowest epoch the task accepts: the epoch of the offer's C1 content. */
  readonly epoch: number;
}

const SealedScopePolicySchema = z.strictObject({ scopeId: NonEmptyStringSchema, epoch: PositiveIntegerSchema });

export interface OpenSealedContentInput {
  /** The header as received. It is untrusted. */
  readonly header: unknown;
  readonly ciphertext: Uint8Array;
  /** The scope key the receiver holds for `header.scope`. */
  readonly scopeKey: Uint8Array;
  /** Partly written by the Host (`sealing.categories`, `notAfter`), so it is untrusted too. */
  readonly binding: SealedBinding;
  /** From the task's `sealing`, which the Host writes. Untrusted. */
  readonly sealing: SealedScopePolicy;
  readonly maxContentLength: number;
}

/** @internal Shared with `sealed-blob.ts`. Stripped from the published declarations. */
export function failure(reason: SealedContentOpenFailure): { readonly ok: false; readonly reason: SealedContentOpenFailure } {
  return { ok: false, reason };
}

/**
 * Open one sealed content, fail closed. In order: a binding and a task scope
 * that parse (`sealing_policy_mismatch`); header shape (`sealed_open_failed`);
 * the category within the task's categories, and the header scope equal to
 * the task's scope at its epoch or later (both `sealing_policy_mismatch`); key
 * id of the held scope key (`sealed_key_unavailable`); ciphertext length; AEAD
 * under the rebuilt AAD; the five frame checks; canonical JSON of a plain
 * object (all `sealed_open_failed`); and the content MAC
 * (`sealed_content_mac_mismatch`).
 * There is no plaintext fallback, and nothing here throws for hostile input.
 */
export async function openSealedContent(input: OpenSealedContentInput): Promise<SealedContentOpenResult> {
  assertMaxContentLength(input.maxContentLength);
  const parsedBinding = safeParseTotal(SealedBindingSchema, input.binding);
  const parsedSealing = safeParseTotal(SealedScopePolicySchema, input.sealing);
  if (!parsedBinding.success || !parsedSealing.success) return failure('sealing_policy_mismatch');
  const binding = parsedBinding.data;
  const sealing = parsedSealing.data;
  const parsed = safeParseTotal(SealedContentHeaderV1Schema, input.header);
  if (!parsed.success) return failure('sealed_open_failed');
  const header = parsed.data;
  if (
    !binding.categories.includes(header.category)
    || header.scope.id !== sealing.scopeId
    || header.scope.epoch < sealing.epoch
  ) {
    return failure('sealing_policy_mismatch');
  }
  if ((await deriveScopeKeyId(input.scopeKey)) !== header.scope.keyId) return failure('sealed_key_unavailable');
  if (input.ciphertext.byteLength !== header.paddedLength + AEAD_TAG_BYTES) return failure('sealed_open_failed');

  const contentKey = await deriveSealedContentKey(input.scopeKey, decodeBase64Url(header.salt, 'salt'));
  let frame: Bytes;
  try {
    frame = await aesGcm('decrypt', contentKey, decodeBase64Url(header.nonce, 'nonce'), aadBytes(header, binding), input.ciphertext);
  } catch {
    return failure('sealed_open_failed');
  } finally {
    contentKey.fill(0);
  }
  try {
    const content = decodeSealedFrame(frame, header.paddedLength, input.maxContentLength);
    const plaintext = content === undefined ? undefined : parseCanonicalPlaintext(content);
    if (plaintext === undefined) return failure('sealed_open_failed');
    if ((await contentMacOf(input.scopeKey, header.category, binding, plaintext.text)) !== header.contentMac) {
      return failure('sealed_content_mac_mismatch');
    }
    return { ok: true, plaintext: plaintext.value, header };
  } finally {
    frame.fill(0);
  }
}
