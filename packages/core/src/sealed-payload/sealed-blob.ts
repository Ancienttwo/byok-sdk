/**
 * Sealed blob bytes v1 (#654 design §8.1, E1c).
 *
 * A protocol field blob (`instruction.blobRef`, a progress spill, an artifact)
 * is sealed before its outer content, by the same frame, key and AEAD rule.
 * Its AAD is the 16 outer AAD members that do not depend on the outer
 * plaintext, the blob's own `paddedLength`, and `fieldPath`: the RFC 6901
 * JSON Pointer from the moved-fields object to its BlobRef. The blob's salt,
 * nonce and padded length travel next to the BlobRef inside the outer
 * plaintext, so the outer AEAD and content MAC cover them.
 *
 * Internal: the subpath index does not import this module, so it adds no
 * bytes to the published closure.
 */
import { z } from 'zod';

import { canonicalizeJsonBytes } from '../attestation';
import { safeParseTotal } from '../total-parse';
import { copy, decodeBase64Url, encodeBase64Url, invalidInput, randomBytes, base64UrlBytes, type Bytes } from './primitives';
import { SEALED_SALT_BYTES, deriveScopeKeyId, deriveSealedContentKey } from './scope-key';
import {
  AEAD_TAG_BYTES,
  PositiveIntegerSchema,
  SEALED_CONTENT_SUITE,
  SEALED_CONTENT_VERSION,
  SEALED_NONCE_BYTES,
  SealedBindingSchema,
  SealedContentHeaderV1Schema,
  aesGcm,
  assertMaxContentLength,
  bindingAad,
  decodeSealedFrame,
  encodeSealedFrame,
  failure,
  isLegalPaddedLength,
  parseBinding,
  type ParsedBinding,
  type SealedAadContext,
  type SealedBinding,
  type SealedCategory,
  type SealedContentHeaderV1,
  type SealedContentOpenFailure,
  type SealedContentRandomness,
} from './sealed-content';

/**
 * An RFC 6901 JSON Pointer from the moved-fields object to one BlobRef node,
 * e.g. `/instruction/blobRef` or `/events/0/spill/blob`. A segment is a field
 * name or a canonical decimal index, so no segment needs a `~` escape.
 */
const BLOB_FIELD_PATH_PATTERN = /^(?:\/(?:[A-Za-z][A-Za-z0-9]*|0|[1-9][0-9]*))+$/u;

/** What the outer plaintext carries next to a sealed blob's BlobRef. */
export const SealedBlobParamsV1Schema = z.strictObject({
  salt: base64UrlBytes(SEALED_SALT_BYTES),
  nonce: base64UrlBytes(SEALED_NONCE_BYTES),
  paddedLength: PositiveIntegerSchema.refine(isLegalPaddedLength, 'must be a legal padded frame length'),
});
export type SealedBlobParamsV1 = z.infer<typeof SealedBlobParamsV1Schema>;

/**
 * The blob AAD: the 16 shared members, the blob's own `paddedLength` and
 * `fieldPath`. The outer `paddedLength` and `contentMac` depend on the outer
 * plaintext, which holds this blob's BlobRef, so they stay out. The outer AAD
 * always has `contentMac` and never `fieldPath`, so the two AADs never match.
 */
function blobAadBytes(context: SealedAadContext, binding: ParsedBinding, paddedLength: number, fieldPath: string): Uint8Array {
  return canonicalizeJsonBytes({ ...bindingAad(context, binding), paddedLength, fieldPath });
}

function assertBlobFieldPath(fieldPath: string): void {
  if (!BLOB_FIELD_PATH_PATTERN.test(fieldPath)) throw invalidInput('Sealed blob field path must be a JSON Pointer of field names and indexes');
}

/**
 * The canonical AAD bytes of a blob sealed under an outer header (§8.1).
 */
export function sealedBlobAad(header: SealedContentHeaderV1, binding: SealedBinding, paddedLength: number, fieldPath: string): Uint8Array {
  const parsed = safeParseTotal(SealedContentHeaderV1Schema, header);
  if (!parsed.success || !isLegalPaddedLength(paddedLength)) throw invalidInput('Sealed blob header input is invalid');
  assertBlobFieldPath(fieldPath);
  return blobAadBytes(parsed.data, parseBinding(binding), paddedLength, fieldPath);
}

/**
 * The input of one blob seal. Scope, chain head, sender, category and binding
 * must be the ones of the outer content that will carry the BlobRef.
 */
export interface SealBlobInput {
  readonly scopeKey: Uint8Array;
  readonly scope: { readonly id: string; readonly epoch: number };
  readonly chainHead: { readonly seq: number; readonly hash: string };
  readonly sender: string;
  readonly category: SealedCategory;
  readonly binding: SealedBinding;
  /** The pointer to the BlobRef node in the moved-fields object. */
  readonly fieldPath: string;
  /** The raw blob bytes. */
  readonly bytes: Uint8Array;
  /** The plaintext limit of this field, in bytes. */
  readonly maxContentLength: number;
}

export interface SealedBlob {
  readonly params: SealedBlobParamsV1;
  /** AES-256-GCM output: the padded frame followed by the 16-byte tag. Upload these bytes. */
  readonly ciphertext: Uint8Array;
}

/**
 * Seal one blob once, before the outer content. A retry must reuse the
 * uploaded blob, never seal again (§8.6).
 */
export async function sealBlob(input: SealBlobInput): Promise<SealedBlob> {
  return sealBlobWithRandomness(input, { salt: randomBytes(SEALED_SALT_BYTES), nonce: randomBytes(SEALED_NONCE_BYTES) });
}

/**
 * {@link sealBlob} with a caller-chosen salt and nonce, for test vectors only.
 */
export async function sealBlobWithRandomness(input: SealBlobInput, randomness: SealedContentRandomness): Promise<SealedBlob> {
  const binding = parseBinding(input.binding);
  assertMaxContentLength(input.maxContentLength);
  assertBlobFieldPath(input.fieldPath);
  if (!binding.categories.includes(input.category)) {
    throw invalidInput('Sealed blob category is not one of the task sealing categories');
  }
  if (input.bytes.byteLength > input.maxContentLength) throw invalidInput('Sealed blob exceeds its plaintext limit');
  const frame = encodeSealedFrame(input.bytes);
  const context = safeParseTotal(SealedContentHeaderV1Schema.pick({ v: true, suite: true, category: true, scope: true, chainHead: true, sender: true }), {
    v: SEALED_CONTENT_VERSION,
    suite: SEALED_CONTENT_SUITE,
    category: input.category,
    scope: { id: input.scope.id, epoch: input.scope.epoch, keyId: await deriveScopeKeyId(input.scopeKey) },
    chainHead: { seq: input.chainHead.seq, hash: input.chainHead.hash },
    sender: input.sender,
  });
  const params = safeParseTotal(SealedBlobParamsV1Schema, {
    salt: encodeBase64Url(randomness.salt),
    nonce: encodeBase64Url(randomness.nonce),
    paddedLength: frame.byteLength,
  });
  if (!context.success || !params.success) throw invalidInput('Sealed blob input is invalid');
  const contentKey = await deriveSealedContentKey(input.scopeKey, randomness.salt);
  try {
    const aad = blobAadBytes(context.data, binding, frame.byteLength, input.fieldPath);
    return { params: params.data, ciphertext: await aesGcm('encrypt', contentKey, randomness.nonce, aad, frame) };
  } finally {
    contentKey.fill(0);
    frame.fill(0);
  }
}

export interface OpenSealedBlobInput {
  /** The outer header that `openSealedContent` authenticated. */
  readonly header: SealedContentHeaderV1;
  /** The binding the outer content opened under. */
  readonly binding: SealedBinding;
  readonly scopeKey: Uint8Array;
  /** The receiver derives it from where it found the BlobRef, never from a table. */
  readonly fieldPath: string;
  /** From the opened outer plaintext. Its shape is still checked here. */
  readonly params: unknown;
  /** The downloaded blob bytes. The caller checks the BlobRef `contentHash` against them (§9.3). */
  readonly ciphertext: Uint8Array;
  readonly maxContentLength: number;
}

export type SealedBlobOpenResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: SealedContentOpenFailure };

/**
 * Open one blob, fail closed. In order: binding and category
 * (`sealing_policy_mismatch`); header, field path and params shape
 * (`sealed_open_failed`); key id (`sealed_key_unavailable`); ciphertext
 * length, AEAD under the rebuilt blob AAD and the five frame checks (all
 * `sealed_open_failed`). Nothing here throws for hostile input.
 */
export async function openSealedBlob(input: OpenSealedBlobInput): Promise<SealedBlobOpenResult> {
  assertMaxContentLength(input.maxContentLength);
  const parsedBinding = safeParseTotal(SealedBindingSchema, input.binding);
  const header = safeParseTotal(SealedContentHeaderV1Schema, input.header);
  if (!parsedBinding.success || (header.success && !parsedBinding.data.categories.includes(header.data.category))) {
    return failure('sealing_policy_mismatch');
  }
  const params = safeParseTotal(SealedBlobParamsV1Schema, input.params);
  if (!header.success || !params.success || typeof input.fieldPath !== 'string' || !BLOB_FIELD_PATH_PATTERN.test(input.fieldPath)) {
    return failure('sealed_open_failed');
  }
  if ((await deriveScopeKeyId(input.scopeKey)) !== header.data.scope.keyId) return failure('sealed_key_unavailable');
  const { salt, nonce, paddedLength } = params.data;
  if (input.ciphertext.byteLength !== paddedLength + AEAD_TAG_BYTES) return failure('sealed_open_failed');

  const contentKey = await deriveSealedContentKey(input.scopeKey, decodeBase64Url(salt, 'salt'));
  let frame: Bytes;
  try {
    const aad = blobAadBytes(header.data, parsedBinding.data, paddedLength, input.fieldPath);
    frame = await aesGcm('decrypt', contentKey, decodeBase64Url(nonce, 'nonce'), aad, input.ciphertext);
  } catch {
    return failure('sealed_open_failed');
  } finally {
    contentKey.fill(0);
  }
  try {
    const content = decodeSealedFrame(frame, paddedLength, input.maxContentLength);
    return content === undefined ? failure('sealed_open_failed') : { ok: true, bytes: copy(content) };
  } finally {
    frame.fill(0);
  }
}
