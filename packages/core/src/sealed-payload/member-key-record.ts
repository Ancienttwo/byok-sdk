/**
 * Member key custody (#654 design §7.1, §7.7; owner decisions 10c and §50a D).
 *
 * A member holds two P-256 keys. The ECDSA signing key is its identity: the
 * member id derives from its public key, so it never rotates, and a new
 * enrollment is a new member (§7.5). The ECDH KEM key opens scope key
 * packages and rotates by epoch.
 *
 * `MemberKeyStore` is the port each member's custody implements. The browser
 * keeps non-extractable `CryptoKey`s (10c). A device keeps the private JWKs in
 * its OS credential store and imports them non-extractable for each use
 * (§7.7). The device record below is that stored form: one canonical JSON
 * text, so every read is one coherent snapshot of both keys.
 *
 * `openMemberKeyRecord` proves each private scalar against its stored public
 * point (an ECDSA sign and verify, an ECDH round trip), so a record whose
 * scalar was swapped opens nothing. It never throws for hostile input.
 *
 * KEM rotation has two steps, in the order of §7.5 (#654 E2d-5).
 * `beginMemberKemRotation` stores the next KEM key at `kemEpoch + 1` beside
 * the current one. The member registers its public key and re-wraps its scope
 * keys to it, and only then does `finishMemberKemRotation` make it current
 * and drop the old private key. A crash in between loses nothing, and the
 * next process resumes the same rotation.
 */
import { z } from 'zod';

import { canonicalizeJson } from '../attestation';
import { safeParseTotal } from '../total-parse';
import { webCryptoSubtle, type WebCryptoKey } from '../webcrypto';
import { P256PublicJwkSchema, base64UrlBytes, invalidInput, randomBytes, type P256PublicJwk } from './primitives';

export const MEMBER_KEY_RECORD_VERSION = 1;

/**
 * Whose keys a store holds. A device member's binding names its SDK device
 * id; a client member's has none, as in its bundle.
 */
export interface MemberKeyBinding {
  readonly tenantId: string;
  readonly deviceId?: string;
}

export interface MemberKeys {
  readonly binding: MemberKeyBinding;
  /** Signs chain entries and key packages. The private key is not extractable. */
  readonly signing: { readonly publicJwk: P256PublicJwk; readonly privateKey: WebCryptoKey };
  /** Opens key packages. The private key is not extractable. `epoch` starts at 1. */
  readonly kem: MemberKemKey;
  /** The KEM key of a rotation that has begun and not finished, at `kem.epoch + 1`. */
  readonly nextKem?: MemberKemKey;
}

export interface MemberKemKey {
  readonly epoch: number;
  readonly publicJwk: P256PublicJwk;
  readonly privateKey: WebCryptoKey;
}

/** The custody port of one member's keys. Each store expects one writer. */
export interface MemberKeyStore {
  /** The keys bound to `binding`, or `undefined` when the store holds none for it. A malformed record throws. */
  load(binding: MemberKeyBinding): Promise<MemberKeys | undefined>;
  /** The keys bound to `binding`. A store that holds none for it creates new ones, which replace any other binding's keys. */
  loadOrCreate(binding: MemberKeyBinding): Promise<MemberKeys>;
}

const PrivateJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: base64UrlBytes(32),
  y: base64UrlBytes(32),
  d: base64UrlBytes(32),
});
type PrivateJwk = z.infer<typeof PrivateJwkSchema>;

const KemEpochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const MemberKeyRecordV1Schema = z
  .strictObject({
    v: z.literal(MEMBER_KEY_RECORD_VERSION),
    tenantId: z.string().min(1),
    deviceId: z.string().min(1).optional(),
    signingJwk: PrivateJwkSchema,
    kemEpoch: KemEpochSchema,
    kemJwk: PrivateJwkSchema,
    nextKem: z.strictObject({ epoch: KemEpochSchema, jwk: PrivateJwkSchema }).optional(),
  })
  .refine((record) => record.nextKem === undefined || record.nextKem.epoch === record.kemEpoch + 1);
type MemberKeyRecordV1 = z.infer<typeof MemberKeyRecordV1Schema>;

const BindingSchema = z.object({ tenantId: z.string().min(1), deviceId: z.string().min(1).optional() });

/** JWK export and ECDSA verify, which core's public `WebCryptoSubtle` does not declare; the same runtime object. */
interface KeySubtle {
  generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<{ publicKey: WebCryptoKey; privateKey: WebCryptoKey }>;
  exportKey(format: 'jwk', key: WebCryptoKey): Promise<{ readonly [field: string]: unknown }>;
  importKey(format: 'jwk', keyData: object, algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
  sign(algorithm: object, key: WebCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: object, key: WebCryptoKey, signature: ArrayBuffer, data: Uint8Array): Promise<boolean>;
  deriveBits(algorithm: object, baseKey: WebCryptoKey, length: number): Promise<ArrayBuffer>;
}

function keySubtle(): KeySubtle {
  return webCryptoSubtle() as unknown as KeySubtle;
}

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function generatePrivateJwk(algorithm: object, usages: string[]): Promise<PrivateJwk> {
  const pair = await keySubtle().generateKey(algorithm, true, usages);
  const { kty, crv, x, y, d } = await keySubtle().exportKey('jwk', pair.privateKey);
  return PrivateJwkSchema.parse({ kty, crv, x, y, d });
}

/**
 * A new member's record for `binding`: a fresh signing key and a fresh KEM
 * key at epoch 1, as one canonical JSON text. The text holds both private
 * scalars; only the member's own custody stores it.
 */
export async function generateMemberKeyRecord(binding: MemberKeyBinding): Promise<string> {
  const parsed = safeParseTotal(BindingSchema, binding);
  if (!parsed.success) throw invalidInput('Member key binding is invalid');
  const { tenantId, deviceId } = parsed.data;
  return canonicalizeJson({
    v: MEMBER_KEY_RECORD_VERSION,
    tenantId,
    ...(deviceId === undefined ? {} : { deviceId }),
    signingJwk: await generatePrivateJwk(ECDSA_P256, ['sign', 'verify']),
    kemEpoch: 1,
    kemJwk: await generatePrivateJwk(ECDH_P256, ['deriveBits']),
  });
}

function publicJwkOf(jwk: PrivateJwk): P256PublicJwk {
  return P256PublicJwkSchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function importSigningKey(jwk: PrivateJwk): Promise<MemberKeys['signing']> {
  const subtle = keySubtle();
  const publicJwk = publicJwkOf(jwk);
  const privateKey = await subtle.importKey('jwk', { ...jwk, ext: false }, ECDSA_P256, false, ['sign']);
  const publicKey = await subtle.importKey('jwk', publicJwk, ECDSA_P256, true, ['verify']);
  const probe = randomBytes(32);
  if (!(await subtle.verify(ECDSA_SHA256, publicKey, await subtle.sign(ECDSA_SHA256, privateKey, probe), probe))) {
    throw new TypeError('signing scalar does not match its public point');
  }
  return { publicJwk, privateKey };
}

async function importKemKey(jwk: PrivateJwk): Promise<Omit<MemberKemKey, 'epoch'>> {
  const subtle = keySubtle();
  const publicJwk = publicJwkOf(jwk);
  const privateKey = await subtle.importKey('jwk', { ...jwk, ext: false }, ECDH_P256, false, ['deriveBits']);
  const publicKey = await subtle.importKey('jwk', publicJwk, ECDH_P256, true, []);
  const probe = await subtle.generateKey(ECDH_P256, false, ['deriveBits']);
  const viaMember = await subtle.deriveBits({ name: 'ECDH', public: probe.publicKey }, privateKey, 256);
  const viaProbe = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, probe.privateKey, 256);
  if (!bytesEqual(viaMember, viaProbe)) throw new TypeError('KEM scalar does not match its public point');
  return { publicJwk, privateKey };
}

/**
 * The keys of a stored record, imported non-extractable, or `undefined` when
 * the text is not a canonical v1 record, or a private scalar does not match
 * its public point. Never throws for hostile input.
 */
export async function openMemberKeyRecord(text: unknown): Promise<MemberKeys | undefined> {
  const record = parseRecord(text);
  if (record === undefined) return undefined;
  try {
    const signing = await importSigningKey(record.signingJwk);
    const kem = { epoch: record.kemEpoch, ...(await importKemKey(record.kemJwk)) };
    const binding = record.deviceId === undefined ? { tenantId: record.tenantId } : { tenantId: record.tenantId, deviceId: record.deviceId };
    if (record.nextKem === undefined) return { binding, signing, kem };
    return { binding, signing, kem, nextKem: { epoch: record.nextKem.epoch, ...(await importKemKey(record.nextKem.jwk)) } };
  } catch {
    return undefined;
  }
}

/**
 * Begin a KEM rotation: the record with a new KEM key at `kemEpoch + 1`
 * beside the current one. A record whose rotation has begun comes back
 * unchanged, so a resumed rotation keeps its key. A record that is not
 * canonical v1 text throws.
 */
export async function beginMemberKemRotation(text: string): Promise<string> {
  const record = parseRecord(text);
  if (record === undefined) throw invalidInput('Member key record is invalid');
  if (record.nextKem !== undefined) return text;
  return canonicalizeJson({ ...record, nextKem: { epoch: record.kemEpoch + 1, jwk: await generatePrivateJwk(ECDH_P256, ['deriveBits']) } });
}

/**
 * Finish the KEM rotation to `epoch`: the next key becomes current, and the
 * old private key is gone from the record. A repeat after the rotation
 * finished comes back unchanged. Any other `epoch` returns `undefined`. A
 * record that is not canonical v1 text throws.
 */
export function finishMemberKemRotation(text: string, epoch: number): string | undefined {
  const record = parseRecord(text);
  if (record === undefined) throw invalidInput('Member key record is invalid');
  if (record.nextKem === undefined) return record.kemEpoch === epoch ? text : undefined;
  if (record.nextKem.epoch !== epoch) return undefined;
  const { nextKem, ...rest } = record;
  return canonicalizeJson({ ...rest, kemEpoch: nextKem.epoch, kemJwk: nextKem.jwk });
}

/** The record of canonical v1 text, or `undefined`. Never throws. */
function parseRecord(text: unknown): MemberKeyRecordV1 | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    const parsed = safeParseTotal(MemberKeyRecordV1Schema, JSON.parse(text));
    return parsed.success && canonicalizeJson(parsed.data) === text ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
