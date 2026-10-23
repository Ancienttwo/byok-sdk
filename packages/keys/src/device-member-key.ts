import {
  SealingPublicJwkSchema,
  canonicalizeJson,
  type JsonObject,
  type SealingPublicJwk,
  type WebCryptoKey,
} from '@byok-sdk/core';
import { deriveMemberId } from '@byok-sdk/core/sealed-payload';
import { z } from 'zod';

import type { DeviceSealingEnrollment } from './device-sealing-key';
import { ByokKeysError } from './errors';
import { assertSecretName } from './secret-name';
import type { SecretStore } from './secret-store';

/**
 * Device member keys for hosted wire end-to-end encryption (#654 design §7.1).
 *
 * A device member holds two P-256 keys. Each key is a separate credential
 * entry, because each key has its own lifetime:
 *
 * - The signing key (ECDSA) is the member identity. The member id derives
 *   from its public key, so it never rotates. A new enrollment is a new
 *   member with a new signing key (§7.5).
 * - The KEM key (ECDH) receives scope key packages. It rotates by epoch
 *   without a change to the member id (§7.5). It is a new entry, separate from
 *   the provider sealing key (D12), because the two keys have different uses
 *   and rotation cycles.
 *
 * This module is internal until the daemon slice uses it. It is not exported
 * from the package root.
 */
export const DEVICE_MEMBER_SIGNING_SECRET_NAME = 'device-member-signing-p256-v1';
export const DEVICE_MEMBER_KEM_SECRET_NAME = 'device-member-kem-p256-v1';
export type DeviceMemberSecretName = typeof DEVICE_MEMBER_SIGNING_SECRET_NAME | typeof DEVICE_MEMBER_KEM_SECRET_NAME;

export interface DeviceMemberKeys {
  /** `deriveMemberId(signing.publicJwk)`. It stays the same across KEM rotations. */
  readonly memberId: string;
  readonly enrollment: DeviceSealingEnrollment;
  /** Signs member chain entries and scope key packages. `privateKey` is non-extractable. */
  readonly signing: { readonly publicJwk: SealingPublicJwk; readonly privateKey: WebCryptoKey };
  /** Opens scope key packages. `privateKey` is non-extractable. `epoch` starts at 1 for each member. */
  readonly kem: { readonly epoch: number; readonly publicJwk: SealingPublicJwk; readonly privateKey: WebCryptoKey };
}

const Base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const PrivateJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: Base64Url32,
  y: Base64Url32,
  d: Base64Url32,
});
const enrollmentShape = { tenantId: z.string().min(1).max(200), deviceId: z.string().min(1).max(200) };

const StoredSigningKeySchema = z.strictObject({ v: z.literal(1), ...enrollmentShape, jwk: PrivateJwkSchema });
const StoredKemKeySchema = z.strictObject({
  v: z.literal(1),
  ...enrollmentShape,
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  jwk: PrivateJwkSchema,
});
type StoredSigningKey = z.infer<typeof StoredSigningKeySchema>;
type StoredKemKey = z.infer<typeof StoredKemKeySchema>;
type PrivateJwk = z.infer<typeof PrivateJwkSchema>;

interface Subtle {
  generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<{ publicKey: WebCryptoKey; privateKey: WebCryptoKey }>;
  exportKey(format: 'jwk', key: WebCryptoKey): Promise<{ kty?: string; crv?: string; x?: string; y?: string; d?: string }>;
  importKey(format: 'jwk', keyData: object, algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
  deriveBits(algorithm: object, baseKey: WebCryptoKey, length: number): Promise<ArrayBuffer>;
  sign(algorithm: object, key: WebCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: object, key: WebCryptoKey, signature: ArrayBuffer, data: Uint8Array): Promise<boolean>;
}

function subtle(): Subtle {
  const value = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (value === undefined) {
    throw new ByokKeysError('DEVICE_MEMBER_KEY_INVALID', 'WebCrypto is unavailable; the device member keys cannot be used');
  }
  return value;
}

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

function invalidStoredKey(): ByokKeysError {
  return new ByokKeysError(
    'DEVICE_MEMBER_KEY_INVALID',
    'A stored device member key is malformed; it is not replaced automatically — re-pair or rotate it explicitly',
  );
}

function sameEnrollment(stored: { tenantId: string; deviceId: string } | undefined, enrollment: DeviceSealingEnrollment): boolean {
  return stored !== undefined && stored.tenantId === enrollment.tenantId && stored.deviceId === enrollment.deviceId;
}

/**
 * Loads, creates, and rotates the device member keys in the OS credential
 * store (through {@link SecretStore}; never a plain file).
 *
 * - `loadOrCreate` returns the stored keys when they belong to the current
 *   enrollment. A missing key, or a key bound to a different enrollment, is
 *   replaced by a new key. A new signing key means a new member, and its KEM
 *   epoch starts at 1.
 * - `rotateKem` replaces only the KEM key, at the next epoch. The previous KEM
 *   private key is overwritten, and so deleted. The member id stays the same.
 * - A malformed stored record fails closed. It is never silently regenerated,
 *   because a new signing key would silently create a new member.
 */
export class DeviceMemberKeyStore {
  readonly #secrets: SecretStore<DeviceMemberSecretName>;

  constructor(options: { secretStore: SecretStore<DeviceMemberSecretName> }) {
    assertSecretName(DEVICE_MEMBER_SIGNING_SECRET_NAME);
    assertSecretName(DEVICE_MEMBER_KEM_SECRET_NAME);
    this.#secrets = options.secretStore;
  }

  async loadOrCreate(enrollment: DeviceSealingEnrollment): Promise<DeviceMemberKeys> {
    const { signing, kem } = await this.#current(enrollment);
    return materialize(signing, kem ?? (await this.#writeKem(enrollment, 1)));
  }

  async rotateKem(enrollment: DeviceSealingEnrollment): Promise<DeviceMemberKeys> {
    const { signing, kem } = await this.#current(enrollment);
    return materialize(signing, await this.#writeKem(enrollment, (kem?.epoch ?? 0) + 1));
  }

  /**
   * The member's signing key, created when absent, and its current KEM key.
   * The KEM key counts only when it belongs to the same enrollment and the
   * signing key was not just created: a new member never inherits a KEM key.
   */
  async #current(enrollment: DeviceSealingEnrollment): Promise<{ signing: StoredSigningKey; kem: StoredKemKey | undefined }> {
    const storedSigning = await this.#read(DEVICE_MEMBER_SIGNING_SECRET_NAME, StoredSigningKeySchema);
    const storedKem = await this.#read(DEVICE_MEMBER_KEM_SECRET_NAME, StoredKemKeySchema);
    if (sameEnrollment(storedSigning, enrollment)) {
      return { signing: storedSigning!, kem: sameEnrollment(storedKem, enrollment) ? storedKem : undefined };
    }
    const jwk = await generatePrivateJwk(ECDSA_P256, ['sign', 'verify']);
    const signing = await this.#write(DEVICE_MEMBER_SIGNING_SECRET_NAME, StoredSigningKeySchema, { v: 1 as const, ...enrollment, jwk });
    return { signing, kem: undefined };
  }

  async #writeKem(enrollment: DeviceSealingEnrollment, epoch: number): Promise<StoredKemKey> {
    const jwk = await generatePrivateJwk(ECDH_P256, ['deriveBits']);
    return this.#write(DEVICE_MEMBER_KEM_SECRET_NAME, StoredKemKeySchema, { v: 1 as const, ...enrollment, epoch, jwk });
  }

  async #read<T>(name: DeviceMemberSecretName, schema: z.ZodType<T>): Promise<T | undefined> {
    const raw = await this.#secrets.get(name);
    if (raw === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw invalidStoredKey();
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw invalidStoredKey();
    return parsed.data;
  }

  async #write<T extends JsonObject>(name: DeviceMemberSecretName, schema: z.ZodType<T>, value: T): Promise<T> {
    const record = schema.safeParse(value);
    if (!record.success) throw invalidStoredKey();
    await this.#secrets.set(name, canonicalizeJson(record.data));
    // Read back: if another process replaced the entry concurrently, the
    // stored key — not the one generated here — is the device's key.
    const stored = await this.#read(name, schema);
    if (stored === undefined) throw invalidStoredKey();
    return stored;
  }
}

async function generatePrivateJwk(algorithm: object, usages: string[]): Promise<PrivateJwk> {
  const pair = await subtle().generateKey(algorithm, true, usages);
  const jwk = await subtle().exportKey('jwk', pair.privateKey);
  const parsed = PrivateJwkSchema.safeParse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });
  if (!parsed.success) throw invalidStoredKey();
  return parsed.data;
}

function publicJwkOf(jwk: PrivateJwk): SealingPublicJwk {
  const parsed = SealingPublicJwkSchema.safeParse({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
  if (!parsed.success) throw invalidStoredKey();
  return parsed.data;
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Import the signing key as non-extractable, and prove that the private
 * scalar matches the stored public point with a sign and verify round trip.
 */
async function importSigningKey(jwk: PrivateJwk): Promise<DeviceMemberKeys['signing']> {
  const publicJwk = publicJwkOf(jwk);
  try {
    const privateKey = await subtle().importKey('jwk', { ...jwk, ext: false }, ECDSA_P256, false, ['sign']);
    const publicKey = await subtle().importKey('jwk', publicJwk, ECDSA_P256, true, ['verify']);
    const probe = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const signature = await subtle().sign(ECDSA_SHA256, privateKey, probe);
    if (!(await subtle().verify(ECDSA_SHA256, publicKey, signature, probe))) throw invalidStoredKey();
    return { publicJwk, privateKey };
  } catch {
    throw invalidStoredKey();
  }
}

/**
 * Import the KEM key as non-extractable, and prove that the private scalar
 * matches the stored public point with an ECDH round trip against a fresh
 * ephemeral key.
 */
async function importKemKey(jwk: PrivateJwk): Promise<{ publicJwk: SealingPublicJwk; privateKey: WebCryptoKey }> {
  const publicJwk = publicJwkOf(jwk);
  try {
    const privateKey = await subtle().importKey('jwk', { ...jwk, ext: false }, ECDH_P256, false, ['deriveBits']);
    const publicKey = await subtle().importKey('jwk', publicJwk, ECDH_P256, true, []);
    const probe = await subtle().generateKey(ECDH_P256, false, ['deriveBits']);
    const viaMember = await subtle().deriveBits({ name: 'ECDH', public: probe.publicKey }, privateKey, 256);
    const viaProbe = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, probe.privateKey, 256);
    if (!bytesEqual(viaMember, viaProbe)) throw invalidStoredKey();
    return { publicJwk, privateKey };
  } catch {
    throw invalidStoredKey();
  }
}

async function materialize(signing: StoredSigningKey, kem: StoredKemKey): Promise<DeviceMemberKeys> {
  const signingKey = await importSigningKey(signing.jwk);
  const kemKey = await importKemKey(kem.jwk);
  return {
    memberId: await deriveMemberId(signingKey.publicJwk),
    enrollment: { tenantId: signing.tenantId, deviceId: signing.deviceId },
    signing: signingKey,
    kem: { epoch: kem.epoch, ...kemKey },
  };
}
