/**
 * The runtime-neutral checks of the sealed-payload v1 vectors (#654 E1a).
 *
 * The caller passes the parsed golden file. Every vector goes through the core
 * modules: byte outputs must equal the golden bytes, and each receiver must
 * return the expected typed failure for each hostile input. This file imports
 * nothing from `node:`, so the Node suite, the Bun probe and a later workerd
 * probe run the same checks. A mismatch throws; the returned counts let each
 * caller prove that no section was skipped.
 */
import type { JsonObject } from '../../attestation';
import {
  deriveMemberId,
  memberChainEntryHash,
  memberChainSigningInput,
  signMemberChainEntry,
  verifyMemberChainEntry,
  type MemberChainEntryV1,
} from '../../sealed-payload/member-chain';
import type { P256PublicJwk } from '../../sealed-payload/primitives';
import {
  deriveScopeKeyId,
  deriveSealedContentKey,
  deriveSealedMacKey,
  openScopeKeyPackage,
  type ScopeKeyPackage,
  type ScopeKeyPackageOpenResult,
} from '../../sealed-payload/scope-key';
import {
  SEALED_CATEGORIES,
  decodeSealedFrame,
  encodeSealedFrame,
  openSealedContent,
  sealContentWithRandomness,
  sealedContentAad,
  sealedContentMac,
  sealedPaddedLength,
  type OpenSealedContentInput,
  type SealedBinding,
  type SealedCategory,
  type SealedContentHeaderV1,
  type SealedContentOpenFailure,
  type SealedScopePolicy,
} from '../../sealed-payload/sealed-content';
import { openSealedBlob, sealBlobWithRandomness, sealedBlobAad, type OpenSealedBlobInput, type SealedBlobParamsV1 } from '../../sealed-payload/sealed-blob';
import { canonicalizeSealedJson } from '../../sealed-payload/sealed-json';
import { decodeBase64Url, encodeBase64Url } from '../../sealed-provider-secret';
import type { WebCryptoKey } from '../../webcrypto';

/** One P-256 key pair as unpadded base64url JWK members. */
export interface VectorKeyPair {
  readonly d: string;
  readonly x: string;
  readonly y: string;
}

export interface VectorMember {
  readonly name: string;
  readonly memberId: string;
  readonly signing: VectorKeyPair;
  readonly kem: VectorKeyPair;
}

/** A large plaintext written as a rule: `{ [key]: unit.repeat(count) }`. */
export interface PlaintextFill {
  readonly key: string;
  readonly unit: string;
  readonly count: number;
}

export interface SealedVector {
  readonly name: string;
  readonly scope: { readonly id: string; readonly epoch: number };
  readonly chainHead: { readonly seq: number; readonly hash: string };
  readonly sender: string;
  readonly category: SealedCategory;
  readonly binding: SealedBinding;
  /** The task's `sealing` scope the receiver opens under. */
  readonly sealing: SealedScopePolicy;
  readonly plaintext?: JsonObject;
  readonly plaintextFill?: PlaintextFill;
  readonly maxContentLength: number;
  readonly salt: string;
  readonly nonce: string;
  readonly header: SealedContentHeaderV1;
  readonly aad: string;
  readonly macInput: string;
  /** Hex of the whole ciphertext, or only its SHA-256 for a large content. */
  readonly ciphertext?: string;
  readonly ciphertextSha256?: string;
}

/**
 * One sealed blob (#654 E1c). It shares scope, chain head, sender, category
 * and binding with the outer sealed vector named by `outer`.
 */
export interface BlobVector {
  readonly name: string;
  readonly outer: string;
  /** RFC 6901 pointer to the BlobRef node in the moved-fields object. */
  readonly fieldPath: string;
  /** Hex of the blob bytes, or a rule for a large blob: byte `i` is `(i * 31 + 7) & 0xff`. */
  readonly bytes?: string;
  readonly bytesLength?: number;
  readonly maxContentLength: number;
  readonly salt: string;
  readonly nonce: string;
  readonly params: SealedBlobParamsV1;
  readonly aad: string;
  readonly ciphertext?: string;
  readonly ciphertextSha256?: string;
}

/** A ciphertext that decrypts, but fails one receiver check after the AEAD. */
export interface CraftedOpenVector {
  readonly name: string;
  readonly defect: 'content-mac' | 'padding-byte' | 'padded-length' | 'length-overflow' | 'non-canonical-json';
  readonly header: SealedContentHeaderV1;
  readonly binding: SealedBinding;
  readonly sealing: SealedScopePolicy;
  readonly ciphertext: string;
  readonly maxContentLength: number;
  readonly expect: SealedContentOpenFailure;
}

/**
 * A valid sealed content that the receiver refuses before the AEAD: the held
 * key is another key, or the task policy (binding or `sealing`, which the Host
 * writes) does not admit it. A binding or `sealing` here may be malformed.
 */
export interface PolicyOpenVector {
  readonly name: string;
  readonly defect: 'key-id' | 'category-not-sealed' | 'scope-id' | 'epoch-below' | 'categories-order' | 'not-after-format';
  readonly header: SealedContentHeaderV1;
  readonly binding: SealedBinding;
  readonly sealing: SealedScopePolicy;
  readonly ciphertext: string;
  readonly maxContentLength: number;
  readonly expect: SealedContentOpenFailure;
}

/** A member chain entry that fails verification under the key of `signer`. */
export interface ChainFailureVector {
  readonly name: string;
  readonly defect: 'signature' | 'tenant' | 'prev-rule' | 'signer-key';
  readonly signer: string;
  readonly entry: MemberChainEntryV1;
  readonly expect: 'member_chain_entry_invalid' | 'member_chain_signature_invalid';
}

export interface ChainVector {
  readonly signer: string;
  readonly entry: MemberChainEntryV1;
  readonly signingInput: string;
  readonly hash: string;
}

export interface KeyPackageVector {
  readonly name: string;
  readonly sender: string;
  readonly recipient: string;
  readonly expected: { readonly tenantId: string; readonly scopeId: string; readonly epoch: number };
  readonly package: ScopeKeyPackage;
  /** The KEM epoch of the recipient key the checker opens with; 1 when absent. */
  readonly recipientKemEpoch?: number;
  readonly expect: 'ok' | Extract<ScopeKeyPackageOpenResult, { ok: false }>['reason'];
}

/**
 * One RFC 8785 Appendix B sample (#786): the IEEE 754 bits of a double and its
 * canonical text, or `null` when the value has no JSON form.
 */
export interface NumberVector {
  readonly ieee: string;
  readonly json: string | null;
}

export interface SealedPayloadVectors {
  readonly note: string;
  readonly numbers: readonly NumberVector[];
  /** Number texts that JSON parses but that are not canonical. A receiver refuses a plaintext that holds one. */
  readonly nonCanonicalNumbers: readonly string[];
  readonly padding: readonly { readonly frameLength: number; readonly paddedLength: number }[];
  readonly frames: readonly { readonly content: string; readonly frame: string }[];
  readonly scopeKey: {
    readonly key: string;
    readonly keyId: string;
    readonly macKey: string;
    readonly contentKeys: readonly { readonly salt: string; readonly contentKey: string }[];
  };
  readonly members: readonly VectorMember[];
  readonly sealed: readonly SealedVector[];
  readonly blobs: readonly BlobVector[];
  readonly craftedOpenFailures: readonly CraftedOpenVector[];
  readonly policyOpenFailures: readonly PolicyOpenVector[];
  readonly chain: readonly ChainVector[];
  readonly chainFailures: readonly ChainFailureVector[];
  readonly keyPackages: readonly KeyPackageVector[];
}

export interface VectorCheckCounts {
  readonly numbers: number;
  readonly nonCanonicalNumbers: number;
  readonly padding: number;
  readonly frames: number;
  readonly contentKeys: number;
  readonly members: number;
  readonly sealed: number;
  readonly sealedRejections: number;
  readonly blobs: number;
  readonly blobRejections: number;
  readonly craftedOpenFailures: number;
  readonly policyOpenFailures: number;
  readonly chain: number;
  readonly chainFailures: number;
  readonly keyPackages: number;
}

export function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new Error(`not lowercase hex: ${value.slice(0, 16)}`);
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function vectorPlaintext(vector: Pick<SealedVector, 'plaintext' | 'plaintextFill'>): JsonObject {
  if (vector.plaintext !== undefined) return vector.plaintext;
  if (vector.plaintextFill === undefined) throw new Error('sealed vector has no plaintext');
  return { [vector.plaintextFill.key]: vector.plaintextFill.unit.repeat(vector.plaintextFill.count) };
}

export function vectorBlobBytes(vector: Pick<BlobVector, 'bytes' | 'bytesLength'>): Uint8Array<ArrayBuffer> {
  if (vector.bytes !== undefined) return fromHex(vector.bytes);
  if (vector.bytesLength === undefined) throw new Error('blob vector has no bytes');
  return Uint8Array.from({ length: vector.bytesLength }, (_, index) => (index * 31 + 7) & 0xff);
}

export function publicJwk(pair: VectorKeyPair): P256PublicJwk {
  return { kty: 'EC', crv: 'P-256', x: pair.x, y: pair.y };
}

export async function importVectorPrivateKey(pair: VectorKeyPair, use: 'sign' | 'kem'): Promise<WebCryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: pair.d, x: pair.x, y: pair.y },
    { name: use === 'sign' ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' },
    false,
    use === 'sign' ? ['sign'] : ['deriveBits'],
  );
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === 'string' ? actual : canonicalizeSealedJson(actual as JsonObject);
  const b = typeof expected === 'string' ? expected : canonicalizeSealedJson(expected as JsonObject);
  if (a !== b) throw new Error(`${label}: expected ${b.slice(0, 200)}, got ${a.slice(0, 200)}`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

function member(vectors: SealedPayloadVectors, name: string): VectorMember {
  const found = vectors.members.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no vector member ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// Sealed content rejections built from each positive vector
// ---------------------------------------------------------------------------

interface Rejection {
  readonly label: string;
  readonly header?: unknown;
  readonly binding?: SealedBinding;
  readonly sealing?: SealedScopePolicy;
  readonly ciphertext?: Uint8Array;
  readonly scopeKey?: Uint8Array;
  readonly maxContentLength?: number;
  readonly expect: SealedContentOpenFailure;
}

function changed(value: string | number): string | number {
  return typeof value === 'number' ? value + 1 : `${value}-other`;
}

function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const out = new Uint8Array(bytes);
  out[index] = (out[index] ?? 0) ^ 0x01;
  return out;
}

function headerRejections(header: SealedContentHeaderV1, binding: SealedBinding, otherMemberId: string): Rejection[] {
  const failed = (label: string, value: unknown): Rejection => ({ label: `header ${label}`, header: value, expect: 'sealed_open_failed' });
  const listedOther = binding.categories.find((category) => category !== header.category);
  return [
    failed('version', { ...header, v: 2 }),
    failed('suite', { ...header, suite: 'byok-sealed-v1.hkdf-sha256.aes-128-gcm' }),
    failed('extra field', { ...header, ciphertextRef: 'blob-1' }),
    failed('missing field', { ...header, contentMac: undefined }),
    failed('not an object', null),
    {
      label: 'header scope id',
      header: { ...header, scope: { ...header.scope, id: changed(header.scope.id) } },
      expect: 'sealing_policy_mismatch',
    },
    failed('scope epoch', { ...header, scope: { ...header.scope, epoch: header.scope.epoch + 1 } }),
    failed('chain head seq', { ...header, chainHead: { ...header.chainHead, seq: header.chainHead.seq + 1 } }),
    failed('chain head hash', { ...header, chainHead: { ...header.chainHead, hash: `sha256:${'0'.repeat(64)}` } }),
    failed('sender', { ...header, sender: otherMemberId }),
    failed('salt', { ...header, salt: encodeBase64Url(new Uint8Array(32).fill(7)) }),
    failed('nonce', { ...header, nonce: encodeBase64Url(new Uint8Array(12).fill(7)) }),
    failed('content mac', { ...header, contentMac: `hmac-sha256:${'0'.repeat(64)}` }),
    failed('padded length', { ...header, paddedLength: sealedPaddedLength(header.paddedLength + 1) }),
    failed('illegal padded length', { ...header, paddedLength: header.paddedLength + 1 }),
    ...(listedOther === undefined ? [] : [failed('category swap', { ...header, category: listedOther })]),
    {
      label: 'header key id',
      header: { ...header, scope: { ...header.scope, keyId: 'A'.repeat(22) } },
      expect: 'sealed_key_unavailable',
    },
  ];
}

function bindingRejections(category: SealedCategory, binding: SealedBinding): Rejection[] {
  const failed = (label: string, value: SealedBinding): Rejection => ({ label: `binding ${label}`, binding: value, expect: 'sealed_open_failed' });
  const [firstField] = Object.keys(binding.identity);
  const extraCategory = SEALED_CATEGORIES.find((candidate) => !binding.categories.includes(candidate));
  const otherCategory = SEALED_CATEGORIES.find((candidate) => candidate !== category)!;
  const rejections: Rejection[] = [
    failed('tenant', { ...binding, tenantId: changed(binding.tenantId) as string }),
    failed('direction', { ...binding, direction: binding.direction === 'server-to-daemon' ? 'daemon-to-server' : 'server-to-daemon' }),
    failed('identity value', { ...binding, identity: { ...binding.identity, [firstField!]: changed(binding.identity[firstField!]!) } }),
    failed('identity extra field', { ...binding, identity: { ...binding.identity, extraField: 'x' } }),
    failed('agent', {
      ...binding,
      agentRef: binding.agentRef === null
        ? { agentId: 'agent-other', profileRevision: 'rev-other' }
        : { ...binding.agentRef, profileRevision: changed(binding.agentRef.profileRevision) as string },
    }),
    {
      label: 'binding category not sealed',
      binding: { ...binding, categories: [otherCategory] },
      expect: 'sealing_policy_mismatch',
    },
  ];
  const policy = (label: string, value: unknown): Rejection => ({ label: `binding ${label}`, binding: value as SealedBinding, expect: 'sealing_policy_mismatch' });
  // Only `routine.template` binds no device, so a routine template has no
  // other family and no device that still parses: both changes are policy.
  if (binding.deviceId === null) {
    rejections.push(
      policy('family that binds a device', { ...binding, family: 'task.other_family' }),
      policy('template with a device instead of expiry', { ...binding, deviceId: 'device-1', notAfter: null }),
    );
  } else {
    rejections.push(
      failed('family', { ...binding, family: 'task.other_family' }),
      failed('device', { ...binding, deviceId: changed(binding.deviceId) as string }),
      policy('no device for a device-bound family', { ...binding, deviceId: null, notAfter: '2026-12-31T00:00:00.000Z' }),
    );
  }
  rejections.push(
    policy('categories not canonical', { ...binding, categories: [...binding.categories, binding.categories[0]!] }),
    policy('expiry not canonical', { ...binding, family: 'routine.template', deviceId: null, notAfter: '2026-12-31T00:00:00Z' }),
    policy('device and expiry together', { ...binding, deviceId: 'device-1', notAfter: '2026-12-31T00:00:00.000Z' }),
    policy('not an object', null),
  );
  if (binding.notAfter !== null) rejections.push(failed('expiry', { ...binding, notAfter: '2099-01-01T00:00:00.000Z' }));
  if (extraCategory !== undefined) {
    const categories = SEALED_CATEGORIES.filter((candidate) => binding.categories.includes(candidate) || candidate === extraCategory);
    rejections.push(failed('categories', { ...binding, categories }));
  }
  return rejections;
}

function sealingRejections(sealing: SealedScopePolicy): Rejection[] {
  const policy = (label: string, value: unknown): Rejection => ({ label: `sealing ${label}`, sealing: value as SealedScopePolicy, expect: 'sealing_policy_mismatch' });
  return [
    policy('scope id', { ...sealing, scopeId: changed(sealing.scopeId) }),
    policy('epoch above the header', { ...sealing, epoch: sealing.epoch + 1 }),
    policy('epoch zero', { ...sealing, epoch: 0 }),
    policy('extra field', { ...sealing, categories: [] }),
  ];
}

function ciphertextRejections(ciphertext: Uint8Array, scopeKey: Uint8Array, contentLength: number): Rejection[] {
  const failed = (label: string, value: Partial<Rejection>): Rejection => ({ label, ...value, expect: 'sealed_open_failed' });
  const appended = new Uint8Array(ciphertext.byteLength + 1);
  appended.set(ciphertext);
  return [
    failed('ciphertext first byte', { ciphertext: flipByte(ciphertext, 0) }),
    failed('ciphertext tag byte', { ciphertext: flipByte(ciphertext, ciphertext.byteLength - 1) }),
    failed('ciphertext truncated', { ciphertext: ciphertext.subarray(0, ciphertext.byteLength - 1) }),
    failed('ciphertext extended', { ciphertext: appended }),
    failed('content limit', { maxContentLength: contentLength - 1 }),
    { label: 'other scope key', scopeKey: flipByte(scopeKey, 0), expect: 'sealed_key_unavailable' },
  ];
}

async function expectOpenFailure(label: string, input: OpenSealedContentInput, expected: SealedContentOpenFailure): Promise<void> {
  const result = await openSealedContent(input);
  if (result.ok || result.reason !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${result.ok ? 'ok' : result.reason}`);
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function ieeeDouble(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`), false);
  return view.getFloat64(0, false);
}

function checkNumbers(vectors: SealedPayloadVectors): void {
  for (const { ieee, json } of vectors.numbers) {
    const value = ieeeDouble(ieee);
    let text: string | null;
    try {
      text = canonicalizeSealedJson(value);
    } catch {
      text = null;
    }
    if (text !== json) throw new Error(`number ${ieee}: expected ${String(json)}, got ${String(text)}`);
    if (json !== null) expectEqual(`number ${ieee} reparsed`, canonicalizeSealedJson(JSON.parse(json) as number), json);
  }
  for (const text of vectors.nonCanonicalNumbers) {
    if (canonicalizeSealedJson(JSON.parse(text) as number) === text) throw new Error(`number text ${text} is canonical`);
  }
}

async function checkScopeKey(vectors: SealedPayloadVectors): Promise<Uint8Array> {
  const scopeKey = fromHex(vectors.scopeKey.key);
  expectEqual('keyId', await deriveScopeKeyId(scopeKey), vectors.scopeKey.keyId);
  expectEqual('mac key', toHex(await deriveSealedMacKey(scopeKey)), vectors.scopeKey.macKey);
  for (const entry of vectors.scopeKey.contentKeys) {
    expectEqual(`content key ${entry.salt}`, toHex(await deriveSealedContentKey(scopeKey, fromHex(entry.salt))), entry.contentKey);
  }
  return scopeKey;
}

async function checkSealed(vectors: SealedPayloadVectors, scopeKey: Uint8Array): Promise<number> {
  let rejections = 0;
  for (const vector of vectors.sealed) {
    const label = `sealed ${vector.name}`;
    const plaintext = vectorPlaintext(vector);
    const sealed = await sealContentWithRandomness(
      {
        scopeKey,
        scope: vector.scope,
        chainHead: vector.chainHead,
        sender: vector.sender,
        category: vector.category,
        binding: vector.binding,
        plaintext,
        maxContentLength: vector.maxContentLength,
      },
      { salt: fromHex(vector.salt), nonce: fromHex(vector.nonce) },
    );
    expectEqual(`${label} header`, sealed.header, vector.header);
    if (vector.ciphertext !== undefined) expectEqual(`${label} ciphertext`, toHex(sealed.ciphertext), vector.ciphertext);
    else expectEqual(`${label} ciphertext sha256`, await sha256Hex(sealed.ciphertext), vector.ciphertextSha256);
    expectEqual(`${label} aad`, toHex(sealedContentAad(vector.header, vector.binding)), vector.aad);
    expectEqual(
      `${label} content mac`,
      await sealedContentMac({ scopeKey, category: vector.category, binding: vector.binding, plaintext }),
      vector.header.contentMac,
    );

    const base: OpenSealedContentInput = {
      header: vector.header,
      ciphertext: sealed.ciphertext,
      scopeKey,
      binding: vector.binding,
      sealing: vector.sealing,
      maxContentLength: vector.maxContentLength,
    };
    const opened = await openSealedContent(base);
    if (!opened.ok) throw new Error(`${label}: open failed with ${opened.reason}`);
    expectEqual(`${label} plaintext`, opened.plaintext, plaintext);
    expectEqual(`${label} verified header`, opened.header, vector.header);

    const otherMemberId = vectors.members.find((candidate) => candidate.memberId !== vector.sender)!.memberId;
    const contentLength = new TextEncoder().encode(canonicalizeSealedJson(plaintext)).byteLength;
    for (const rejection of [
      ...headerRejections(vector.header, vector.binding, otherMemberId),
      ...bindingRejections(vector.category, vector.binding),
      ...sealingRejections(vector.sealing),
      ...ciphertextRejections(sealed.ciphertext, scopeKey, contentLength),
    ]) {
      await expectOpenFailure(`${label} ${rejection.label}`, {
        header: 'header' in rejection ? rejection.header : base.header,
        ciphertext: rejection.ciphertext ?? base.ciphertext,
        scopeKey: rejection.scopeKey ?? base.scopeKey,
        binding: 'binding' in rejection ? rejection.binding as SealedBinding : base.binding,
        sealing: rejection.sealing ?? base.sealing,
        maxContentLength: rejection.maxContentLength ?? base.maxContentLength,
      }, rejection.expect);
      rejections += 1;
    }
  }
  return rejections;
}

async function expectBlobOpenFailure(label: string, input: OpenSealedBlobInput, expected: SealedContentOpenFailure): Promise<void> {
  const result = await openSealedBlob(input);
  if (result.ok || result.reason !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${result.ok ? 'ok' : result.reason}`);
  }
}

/** A frame with one defect, encrypted under the right blob AAD, so only the frame check can refuse it. */
async function craftedBlobCiphertext(scopeKey: Uint8Array, vector: BlobVector, outer: SealedVector, frame: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(await deriveSealedContentKey(scopeKey, fromHex(vector.salt))), 'AES-GCM', false, ['encrypt']);
  const aad = new Uint8Array(sealedBlobAad(outer.header, outer.binding, frame.byteLength, vector.fieldPath));
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fromHex(vector.nonce), additionalData: aad }, key, new Uint8Array(frame)));
}

function blobRejections(vector: BlobVector, outer: SealedVector, otherMemberId: string): BlobRejection[] {
  const { header, binding } = outer;
  const failed = (label: string, value: Partial<BlobRejection>): BlobRejection => ({ label, ...value, expect: 'sealed_open_failed' });
  const policy = (label: string, value: Partial<BlobRejection>): BlobRejection => ({ label, ...value, expect: 'sealing_policy_mismatch' });
  const [firstField] = Object.keys(binding.identity);
  const listedOther = binding.categories.find((category) => category !== header.category);
  const unlisted = SEALED_CATEGORIES.find((category) => category !== header.category)!;
  const list: BlobRejection[] = [
    failed('field path other field', { fieldPath: '/other' }),
    failed('field path deeper', { fieldPath: `${vector.fieldPath}/0` }),
    ...['instruction/blobRef', '/', '', '/01', '/a~0b', '/a/-', '/blob ref'].map((fieldPath) => failed(`field path syntax ${JSON.stringify(fieldPath)}`, { fieldPath })),
    failed('params salt', { params: { ...vector.params, salt: encodeBase64Url(new Uint8Array(32).fill(7)) } }),
    failed('params nonce', { params: { ...vector.params, nonce: encodeBase64Url(new Uint8Array(12).fill(7)) } }),
    failed('params padded length', { params: { ...vector.params, paddedLength: sealedPaddedLength(vector.params.paddedLength + 1) } }),
    failed('params illegal padded length', { params: { ...vector.params, paddedLength: vector.params.paddedLength + 1 } }),
    failed('params extra field', { params: { ...vector.params, blobRef: {} } }),
    failed('params not an object', { params: null }),
    failed('header chain head', { header: { ...header, chainHead: { ...header.chainHead, seq: header.chainHead.seq + 1 } } }),
    failed('header sender', { header: { ...header, sender: otherMemberId } }),
    failed('header epoch', { header: { ...header, scope: { ...header.scope, epoch: header.scope.epoch + 1 } } }),
    failed('header scope id', { header: { ...header, scope: { ...header.scope, id: `${header.scope.id}-other` } } }),
    failed('header not an object', { header: null as never }),
    { label: 'header key id', header: { ...header, scope: { ...header.scope, keyId: 'A'.repeat(22) } }, expect: 'sealed_key_unavailable' },
    failed('binding tenant', { binding: { ...binding, tenantId: `${binding.tenantId}-other` } }),
    failed('binding direction', { binding: { ...binding, direction: binding.direction === 'server-to-daemon' ? 'daemon-to-server' : 'server-to-daemon' } }),
    failed('binding identity', { binding: { ...binding, identity: { ...binding.identity, [firstField!]: `${String(binding.identity[firstField!])}-other` } } }),
    failed('binding agent', {
      binding: { ...binding, agentRef: binding.agentRef === null ? { agentId: 'agent-other', profileRevision: 'rev-other' } : { ...binding.agentRef, agentId: 'agent-other' } },
    }),
    policy('binding category not sealed', { binding: { ...binding, categories: [unlisted] } }),
    policy('binding not an object', { binding: null as never }),
  ];
  if (binding.deviceId !== null) list.push(failed('binding family', { binding: { ...binding, family: 'task.other_family' } }), failed('binding device', { binding: { ...binding, deviceId: `${binding.deviceId}-other` } }));
  if (listedOther !== undefined) list.push(failed('header category swap', { header: { ...header, category: listedOther } }));
  return list;
}

interface BlobRejection {
  readonly label: string;
  readonly header?: SealedContentHeaderV1;
  readonly binding?: SealedBinding;
  readonly fieldPath?: string;
  readonly params?: unknown;
  readonly ciphertext?: Uint8Array;
  readonly scopeKey?: Uint8Array;
  readonly maxContentLength?: number;
  readonly expect: SealedContentOpenFailure;
}

async function checkBlobs(vectors: SealedPayloadVectors, scopeKey: Uint8Array): Promise<number> {
  let rejections = 0;
  for (const vector of vectors.blobs) {
    const label = `blob ${vector.name}`;
    const outer = vectors.sealed.find((candidate) => candidate.name === vector.outer);
    if (outer === undefined) throw new Error(`${label}: no outer vector ${vector.outer}`);
    const bytes = vectorBlobBytes(vector);
    const sealed = await sealBlobWithRandomness(
      {
        scopeKey,
        scope: outer.scope,
        chainHead: outer.chainHead,
        sender: outer.sender,
        category: outer.category,
        binding: outer.binding,
        fieldPath: vector.fieldPath,
        bytes,
        maxContentLength: vector.maxContentLength,
      },
      { salt: fromHex(vector.salt), nonce: fromHex(vector.nonce) },
    );
    expectEqual(`${label} params`, sealed.params, vector.params);
    if (vector.ciphertext !== undefined) expectEqual(`${label} ciphertext`, toHex(sealed.ciphertext), vector.ciphertext);
    else expectEqual(`${label} ciphertext sha256`, await sha256Hex(sealed.ciphertext), vector.ciphertextSha256);
    expectEqual(`${label} aad`, toHex(sealedBlobAad(outer.header, outer.binding, vector.params.paddedLength, vector.fieldPath)), vector.aad);

    const base: OpenSealedBlobInput = {
      header: outer.header,
      binding: outer.binding,
      scopeKey,
      fieldPath: vector.fieldPath,
      params: vector.params,
      ciphertext: sealed.ciphertext,
      maxContentLength: vector.maxContentLength,
    };
    const opened = await openSealedBlob(base);
    if (!opened.ok) throw new Error(`${label}: open failed with ${opened.reason}`);
    expectEqual(`${label} bytes`, toHex(opened.bytes), toHex(bytes));

    const otherMemberId = vectors.members.find((candidate) => candidate.memberId !== outer.sender)!.memberId;
    const appended = new Uint8Array(sealed.ciphertext.byteLength + 1);
    appended.set(sealed.ciphertext);
    const overflow = encodeSealedFrame(bytes);
    new DataView(overflow.buffer).setUint32(0, overflow.byteLength - 3, false);
    const padding = encodeSealedFrame(bytes);
    const list: BlobRejection[] = [
      ...blobRejections(vector, outer, otherMemberId),
      { label: 'ciphertext first byte', ciphertext: flipByte(sealed.ciphertext, 0), expect: 'sealed_open_failed' },
      { label: 'ciphertext tag byte', ciphertext: flipByte(sealed.ciphertext, sealed.ciphertext.byteLength - 1), expect: 'sealed_open_failed' },
      { label: 'ciphertext truncated', ciphertext: sealed.ciphertext.subarray(0, sealed.ciphertext.byteLength - 1), expect: 'sealed_open_failed' },
      { label: 'ciphertext extended', ciphertext: appended, expect: 'sealed_open_failed' },
      { label: 'other scope key', scopeKey: flipByte(scopeKey, 0), expect: 'sealed_key_unavailable' },
      { label: 'crafted length overflow', ciphertext: await craftedBlobCiphertext(scopeKey, vector, outer, overflow), expect: 'sealed_open_failed' },
    ];
    if (padding.byteLength > 4 + bytes.byteLength) {
      padding[padding.byteLength - 1] = 1;
      list.push({ label: 'crafted padding byte', ciphertext: await craftedBlobCiphertext(scopeKey, vector, outer, padding), expect: 'sealed_open_failed' });
    }
    if (bytes.byteLength > 0) list.push({ label: 'content limit', maxContentLength: bytes.byteLength - 1, expect: 'sealed_open_failed' });
    for (const rejection of list) {
      await expectBlobOpenFailure(`${label} ${rejection.label}`, {
        header: 'header' in rejection ? rejection.header! : base.header,
        binding: 'binding' in rejection ? rejection.binding! : base.binding,
        scopeKey: rejection.scopeKey ?? base.scopeKey,
        fieldPath: 'fieldPath' in rejection ? rejection.fieldPath! : base.fieldPath,
        params: 'params' in rejection ? rejection.params : base.params,
        ciphertext: rejection.ciphertext ?? base.ciphertext,
        maxContentLength: rejection.maxContentLength ?? base.maxContentLength,
      }, rejection.expect);
      rejections += 1;
    }

    // Domain separation: the blob does not open as an outer content, and an outer content does not open as a blob.
    await expectOpenFailure(`${label} opened as an outer content`, {
      header: { ...outer.header, salt: vector.params.salt, nonce: vector.params.nonce, paddedLength: vector.params.paddedLength },
      ciphertext: sealed.ciphertext,
      scopeKey,
      binding: outer.binding,
      sealing: outer.sealing,
      maxContentLength: vector.maxContentLength,
    }, 'sealed_open_failed');
    rejections += 1;
    if (outer.ciphertext !== undefined) {
      await expectBlobOpenFailure(`${label} outer content opened as a blob`, {
        ...base,
        params: { salt: outer.header.salt, nonce: outer.header.nonce, paddedLength: outer.header.paddedLength },
        ciphertext: fromHex(outer.ciphertext),
        maxContentLength: outer.maxContentLength,
      }, 'sealed_open_failed');
      rejections += 1;
    }
  }
  return rejections;
}

async function checkOpenFailures(vectors: SealedPayloadVectors, scopeKey: Uint8Array): Promise<void> {
  for (const vector of [...vectors.craftedOpenFailures, ...vectors.policyOpenFailures]) {
    await expectOpenFailure(`open failure ${vector.name}`, {
      header: vector.header,
      ciphertext: fromHex(vector.ciphertext),
      scopeKey,
      binding: vector.binding,
      sealing: vector.sealing,
      maxContentLength: vector.maxContentLength,
    }, vector.expect);
  }
}

async function checkChainFailures(vectors: SealedPayloadVectors): Promise<void> {
  for (const vector of vectors.chainFailures) {
    const result = await verifyMemberChainEntry(vector.entry, publicJwk(member(vectors, vector.signer).signing));
    if (result.ok || result.reason !== vector.expect) {
      throw new Error(`chain failure ${vector.name}: expected ${vector.expect}, got ${result.ok ? 'ok' : result.reason}`);
    }
  }
}

async function checkChain(vectors: SealedPayloadVectors): Promise<void> {
  for (const vector of vectors.chain) {
    const label = `chain seq ${vector.entry.seq}`;
    const signer = member(vectors, vector.signer);
    const { sig, ...unsigned } = vector.entry;
    expectEqual(`${label} signing input`, toHex(memberChainSigningInput(unsigned)), vector.signingInput);
    expectEqual(`${label} hash`, await memberChainEntryHash(unsigned), vector.hash);
    const verified = await verifyMemberChainEntry(vector.entry, publicJwk(signer.signing));
    if (!verified.ok) throw new Error(`${label}: ${verified.reason}`);
    expectEqual(`${label} verified hash`, verified.hash, vector.hash);

    const tamperedSig = encodeBase64Url(flipByte(decodeBase64Url(sig, 'sig'), 63));
    const outcomes = [
      ['signature', await verifyMemberChainEntry({ ...vector.entry, sig: tamperedSig }, publicJwk(signer.signing)), 'member_chain_signature_invalid'],
      ['tenant', await verifyMemberChainEntry({ ...vector.entry, tenantId: changed(vector.entry.tenantId) }, publicJwk(signer.signing)), 'member_chain_signature_invalid'],
      ['subject', await verifyMemberChainEntry({ ...vector.entry, subject: { ...vector.entry.subject, extra: true } }, publicJwk(signer.signing)), 'member_chain_signature_invalid'],
      ['other signer key', await verifyMemberChainEntry(vector.entry, publicJwk(otherMember(vectors, vector.signer).signing)), 'member_chain_entry_invalid'],
      ['prev rule', await verifyMemberChainEntry({ ...vector.entry, seq: vector.entry.seq === 1 ? 2 : 1 }, publicJwk(signer.signing)), 'member_chain_entry_invalid'],
      ['extra field', await verifyMemberChainEntry({ ...vector.entry, ts: 1 }, publicJwk(signer.signing)), 'member_chain_entry_invalid'],
    ] as const;
    for (const [what, result, reason] of outcomes) {
      if (result.ok || result.reason !== reason) throw new Error(`${label} ${what}: expected ${reason}, got ${result.ok ? 'ok' : result.reason}`);
    }

    const resigned = await signMemberChainEntry(unsigned, {
      publicJwk: publicJwk(signer.signing),
      privateKey: await importVectorPrivateKey(signer.signing, 'sign'),
    });
    const reverified = await verifyMemberChainEntry(resigned, publicJwk(signer.signing));
    if (!reverified.ok || reverified.hash !== vector.hash) throw new Error(`${label}: a fresh signature does not verify`);
  }
}

function otherMember(vectors: SealedPayloadVectors, name: string): VectorMember {
  return vectors.members.find((candidate) => candidate.name !== name)!;
}

async function checkKeyPackages(vectors: SealedPayloadVectors, scopeKey: Uint8Array): Promise<void> {
  for (const vector of vectors.keyPackages) {
    const label = `key package ${vector.name}`;
    const recipient = member(vectors, vector.recipient);
    const sender = member(vectors, vector.sender);
    const opened = await openScopeKeyPackage({
      package: vector.package,
      expected: vector.expected,
      recipient: {
        memberId: recipient.memberId,
        kemPublicJwk: publicJwk(recipient.kem),
        kemPrivateKey: await importVectorPrivateKey(recipient.kem, 'kem'),
        kemEpoch: vector.recipientKemEpoch ?? 1,
      },
      senderSigningPublicJwk: publicJwk(sender.signing),
    });
    if (vector.expect === 'ok') {
      if (!opened.ok) throw new Error(`${label}: ${opened.reason}`);
      expectEqual(`${label} scope key`, toHex(opened.scopeKey), toHex(scopeKey));
      expectEqual(`${label} key id`, opened.keyId, vectors.scopeKey.keyId);
    } else if (opened.ok || opened.reason !== vector.expect) {
      throw new Error(`${label}: expected ${vector.expect}, got ${opened.ok ? 'ok' : opened.reason}`);
    }
  }
}

/** Run every vector check. Throws on the first mismatch. */
export async function checkSealedPayloadVectors(vectors: SealedPayloadVectors): Promise<VectorCheckCounts> {
  checkNumbers(vectors);
  for (const { frameLength, paddedLength } of vectors.padding) {
    expectEqual(`padded length of ${frameLength}`, String(sealedPaddedLength(frameLength)), String(paddedLength));
  }
  for (const { content, frame } of vectors.frames) {
    const encoded = encodeSealedFrame(fromHex(content));
    expectEqual(`frame of ${content.length / 2} bytes`, toHex(encoded), frame);
    const decoded = decodeSealedFrame(encoded, encoded.byteLength, content.length / 2);
    if (decoded === undefined || toHex(decoded) !== content) throw new Error(`frame of ${content.length / 2} bytes does not decode`);
  }
  for (const entry of vectors.members) {
    expectEqual(`member id ${entry.name}`, await deriveMemberId(publicJwk(entry.signing)), entry.memberId);
  }
  const scopeKey = await checkScopeKey(vectors);
  const sealedRejections = await checkSealed(vectors, scopeKey);
  const blobRejectionCount = await checkBlobs(vectors, scopeKey);
  await checkOpenFailures(vectors, scopeKey);
  await checkChain(vectors);
  await checkChainFailures(vectors);
  await checkKeyPackages(vectors, scopeKey);
  return {
    numbers: vectors.numbers.length,
    nonCanonicalNumbers: vectors.nonCanonicalNumbers.length,
    padding: vectors.padding.length,
    frames: vectors.frames.length,
    contentKeys: vectors.scopeKey.contentKeys.length,
    members: vectors.members.length,
    sealed: vectors.sealed.length,
    sealedRejections,
    blobs: vectors.blobs.length,
    blobRejections: blobRejectionCount,
    craftedOpenFailures: vectors.craftedOpenFailures.length,
    policyOpenFailures: vectors.policyOpenFailures.length,
    chain: vectors.chain.length,
    chainFailures: vectors.chainFailures.length,
    keyPackages: vectors.keyPackages.length,
  };
}
