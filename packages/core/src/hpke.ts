/**
 * RFC 9180 HPKE, base mode, exactly one cipher suite:
 * `DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM`
 * (KEM `0x0010`, KDF `0x0001`, AEAD `0x0001`).
 *
 * Why this module exists instead of a dependency: the same bytes must be
 * produced in a browser (the Web seals a provider key), in Node, and in a
 * Bun-compiled device daemon (which opens it). Every primitive used here —
 * P-256 ECDH, HMAC-SHA-256, AES-GCM, SHA-256, random key generation — is a
 * WebCrypto primitive all three runtimes ship, so the suite needs no
 * third-party code and no `node:` import (core must stay Workers/browser
 * safe). There is no algorithm negotiation: one suite, one mode, and anything
 * else is rejected by the envelope schema before this module is reached.
 *
 * Only one-shot seal/open is reachable from the package root. The key
 * schedule and sequence-numbered nonces are exported from this module for the
 * RFC 9180 Appendix A.3 conformance tests only; `index.ts` never re-exports a
 * reusable encryption context.
 *
 * Self-implemented HPKE: RFC vectors and an independent implementation
 * interoperate in the test suite, but passing vectors is not an audit. A
 * dedicated security review is required before a release is published.
 */
import { ByokCoreError } from './errors';
import { webCryptoSubtle, type WebCryptoKey } from './webcrypto';

const KEM_ID = 0x0010;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0001;

/** Encoded P-256 public key and encapsulation length (uncompressed SEC1). */
export const HPKE_P256_PUBLIC_KEY_BYTES = 65;
const N_SECRET = 32;
const N_K = 16;
const N_N = 12;
const N_H = 32;
/** AES-GCM authentication tag length. */
export const HPKE_AEAD_TAG_BYTES = 16;

const MODE_BASE = 0x00;
const HPKE_V1 = utf8('HPKE-v1');
const KEM_SUITE_ID = concat(utf8('KEM'), i2osp(KEM_ID, 2));
const HPKE_SUITE_ID = concat(utf8('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
const EMPTY = new Uint8Array(0);
/** HMAC pads its key with zeros to the block size, so an empty salt equals HashLen zeros. */
const ZERO_SALT = new Uint8Array(N_H);

type Bytes = Uint8Array<ArrayBuffer>;

function utf8(value: string): Bytes {
  return new TextEncoder().encode(value) as Bytes;
}

function concat(...parts: readonly Uint8Array[]): Bytes {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function i2osp(value: number, length: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ByokCoreError('sealed_secret_invalid', 'HPKE integer encoding requires a non-negative safe integer');
  }
  const out = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining !== 0) {
    throw new ByokCoreError('sealed_secret_invalid', 'HPKE integer does not fit the requested width');
  }
  return out;
}

function copy(bytes: Uint8Array): Bytes {
  return new Uint8Array(bytes) as Bytes;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const subtle = webCryptoSubtle();
  const hmacKey = await subtle.importKey('raw', copy(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', hmacKey, copy(data))) as Bytes;
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  if (length > 255 * N_H) {
    throw new ByokCoreError('sealed_secret_invalid', 'HKDF output length exceeds its limit');
  }
  const out = new Uint8Array(length);
  let previous: Uint8Array = EMPTY;
  let offset = 0;
  for (let counter = 1; offset < length; counter += 1) {
    previous = await hmacSha256(prk, concat(previous, info, Uint8Array.of(counter)));
    const take = Math.min(previous.byteLength, length - offset);
    out.set(previous.subarray(0, take), offset);
    offset += take;
  }
  return out as Bytes;
}

async function labeledExtract(suiteId: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Promise<Bytes> {
  return hmacSha256(salt.byteLength === 0 ? ZERO_SALT : salt, concat(HPKE_V1, suiteId, utf8(label), ikm));
}

async function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Promise<Bytes> {
  return hkdfExpand(prk, concat(i2osp(length, 2), HPKE_V1, suiteId, utf8(label), info), length);
}

/**
 * Import an uncompressed SEC1 P-256 public key for ECDH.
 *
 * The length and `0x04` prefix are checked here; the on-curve check is the
 * WebCrypto import itself, which rejects a point that is not on P-256.
 */
export async function importP256PublicKey(raw: Uint8Array): Promise<WebCryptoKey> {
  if (raw.byteLength !== HPKE_P256_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new ByokCoreError('sealed_secret_invalid', 'P-256 public key must be a 65-byte uncompressed point');
  }
  try {
    return await webCryptoSubtle().importKey('raw', copy(raw), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  } catch (cause) {
    throw new ByokCoreError('sealed_secret_invalid', 'P-256 public key is not a valid curve point', { cause });
  }
}

async function ecdhP256(privateKey: WebCryptoKey, publicKey: WebCryptoKey): Promise<Bytes> {
  const bits = await webCryptoSubtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, N_SECRET * 8);
  return new Uint8Array(bits) as Bytes;
}

async function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Promise<Bytes> {
  const eaePrk = await labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dh);
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, N_SECRET);
}

/** Key schedule output for base mode. Exported for the RFC 9180 conformance tests only. */
export interface HpkeBaseKeySchedule {
  readonly sharedSecret: Uint8Array;
  readonly key: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly exporterSecret: Uint8Array;
}

async function keyScheduleBase(sharedSecret: Uint8Array, info: Uint8Array): Promise<HpkeBaseKeySchedule> {
  const pskIdHash = await labeledExtract(HPKE_SUITE_ID, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = await labeledExtract(HPKE_SUITE_ID, EMPTY, 'info_hash', info);
  const context = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', EMPTY);
  return {
    sharedSecret,
    key: await labeledExpand(HPKE_SUITE_ID, secret, 'key', context, N_K),
    baseNonce: await labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', context, N_N),
    exporterSecret: await labeledExpand(HPKE_SUITE_ID, secret, 'exp', context, N_H),
  };
}

/** A caller-fixed ephemeral key pair. Conformance tests only; production always generates one. */
export interface HpkeEphemeralKeyPair {
  readonly privateKey: WebCryptoKey;
  readonly publicKey: Uint8Array;
}

/** `SetupBaseS`. Exported for the RFC 9180 conformance tests only. */
export async function setupBaseSender(
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  ephemeral?: HpkeEphemeralKeyPair,
): Promise<{ enc: Uint8Array; schedule: HpkeBaseKeySchedule }> {
  const pkR = await importP256PublicKey(recipientPublicKey);
  let pair = ephemeral;
  if (pair === undefined) {
    const subtle = webCryptoSubtle();
    const generated = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    pair = {
      privateKey: generated.privateKey,
      publicKey: new Uint8Array(await subtle.exportKey('raw', generated.publicKey)),
    };
  }
  const enc = copy(pair.publicKey);
  const dh = await ecdhP256(pair.privateKey, pkR);
  const sharedSecret = await extractAndExpand(dh, concat(enc, recipientPublicKey));
  return { enc, schedule: await keyScheduleBase(sharedSecret, info) };
}

/** `SetupBaseR`. Exported for the RFC 9180 conformance tests only. */
export async function setupBaseRecipient(
  enc: Uint8Array,
  recipientPrivateKey: WebCryptoKey,
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
): Promise<HpkeBaseKeySchedule> {
  if (recipientPublicKey.byteLength !== HPKE_P256_PUBLIC_KEY_BYTES || recipientPublicKey[0] !== 0x04) {
    throw new ByokCoreError('sealed_secret_invalid', 'P-256 recipient public key must be a 65-byte uncompressed point');
  }
  const pkE = await importP256PublicKey(enc);
  let dh: Bytes;
  try {
    dh = await ecdhP256(recipientPrivateKey, pkE);
  } catch (cause) {
    throw new ByokCoreError('sealed_secret_open_failed', 'HPKE decapsulation failed', { cause });
  }
  const sharedSecret = await extractAndExpand(dh, concat(enc, recipientPublicKey));
  return keyScheduleBase(sharedSecret, info);
}

/** `ComputeNonce(seq)`. Exported for the RFC 9180 conformance tests only. */
export function hpkeNonce(baseNonce: Uint8Array, sequence: number): Bytes {
  const seq = i2osp(sequence, N_N);
  const out = new Uint8Array(N_N);
  for (let index = 0; index < N_N; index += 1) out[index] = baseNonce[index]! ^ seq[index]!;
  return out as Bytes;
}

async function aesGcmKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<WebCryptoKey> {
  return webCryptoSubtle().importKey('raw', copy(key), { name: 'AES-GCM' }, false, [usage]);
}

/** AEAD seal at an explicit sequence number. Exported for the RFC 9180 conformance tests only. */
export async function hpkeAeadSeal(
  schedule: HpkeBaseKeySchedule,
  sequence: number,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Bytes> {
  const ciphertext = await webCryptoSubtle().encrypt(
    { name: 'AES-GCM', iv: hpkeNonce(schedule.baseNonce, sequence), additionalData: copy(aad), tagLength: 128 },
    await aesGcmKey(schedule.key, 'encrypt'),
    copy(plaintext),
  );
  return new Uint8Array(ciphertext) as Bytes;
}

/** AEAD open at an explicit sequence number. Exported for the RFC 9180 conformance tests only. */
export async function hpkeAeadOpen(
  schedule: HpkeBaseKeySchedule,
  sequence: number,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Bytes> {
  if (ciphertext.byteLength < HPKE_AEAD_TAG_BYTES) {
    throw new ByokCoreError('sealed_secret_invalid', 'HPKE ciphertext is shorter than its authentication tag');
  }
  try {
    const plaintext = await webCryptoSubtle().decrypt(
      { name: 'AES-GCM', iv: hpkeNonce(schedule.baseNonce, sequence), additionalData: copy(aad), tagLength: 128 },
      await aesGcmKey(schedule.key, 'decrypt'),
      copy(ciphertext),
    );
    return new Uint8Array(plaintext) as Bytes;
  } catch (cause) {
    throw new ByokCoreError('sealed_secret_open_failed', 'HPKE ciphertext failed authentication', { cause });
  }
}

/** One-shot `SealBase`: a fresh ephemeral key, sequence 0, never reused. */
export async function hpkeSealBase(input: {
  readonly recipientPublicKey: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly plaintext: Uint8Array;
}): Promise<{ enc: Uint8Array; ciphertext: Uint8Array }> {
  const { enc, schedule } = await setupBaseSender(input.recipientPublicKey, input.info);
  return { enc, ciphertext: await hpkeAeadSeal(schedule, 0, input.aad, input.plaintext) };
}

/** One-shot `OpenBase`, sequence 0. */
export async function hpkeOpenBase(input: {
  readonly recipientPrivateKey: WebCryptoKey;
  readonly recipientPublicKey: Uint8Array;
  readonly enc: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
}): Promise<Uint8Array> {
  const schedule = await setupBaseRecipient(input.enc, input.recipientPrivateKey, input.recipientPublicKey, input.info);
  return hpkeAeadOpen(schedule, 0, input.aad, input.ciphertext);
}
