import {
  SealingPublicJwkSchema,
  canonicalizeJson,
  type SealingPublicJwk,
  type WebCryptoKey,
} from '@byok-sdk/core';
import { z } from 'zod';

import { CanonicalBase64Url32 } from './canonical-base64url';
import type { DeviceSealingEnrollment } from './device-sealing-key';
import { ByokKeysError } from './errors';
import { assertSecretName } from './secret-name';
import type { SecretStore } from './secret-store';

/**
 * Device member keys for hosted wire end-to-end encryption (#654 design §7.1).
 *
 * A device member holds two P-256 keys:
 *
 * - The signing key (ECDSA) is the member identity. The member id derives
 *   from its public key, so it never rotates. A new enrollment is a new
 *   member with a new signing key (§7.5). This store does not compute the
 *   id: the one rule is `deriveMemberId` in `@byok-sdk/core/sealed-payload`,
 *   and the daemon calls it. So this package does not import that subpath.
 * - The KEM key (ECDH) receives scope key packages. It rotates by epoch
 *   without a change to the member id (§7.5).
 *
 * KEM rotation has two steps, in the order of §7.5: register the new public
 * key, re-wrap the held scope keys to it, then delete the old private key.
 * `beginKemRotation` stores the next KEM key beside the current one. The old
 * key stays until `finishKemRotation`, so a crash in between loses nothing,
 * and the next process resumes the same rotation.
 *
 * Both keys live in ONE new credential entry, separate from the provider
 * sealing key (D12), because the two uses and rotation cycles differ. One
 * entry makes every write and every read one coherent snapshot: a caller never
 * gets the signing key of one write and the KEM key of another.
 *
 * The store expects one writer. Like `DeviceSealingKeyStore`, it has no
 * cross-process lock: the daemon that uses it holds the daemon owner lock for
 * its store directory. With two concurrent writers, the last write wins, and
 * an earlier caller can hold keys that the credential store no longer has.
 *
 * This module is internal until the daemon slice uses it. It is not exported
 * from the package root.
 */
export const DEVICE_MEMBER_SECRET_NAME = 'device-member-p256-v1';
export type DeviceMemberSecretName = typeof DEVICE_MEMBER_SECRET_NAME;

export interface DeviceMemberKeys {
  readonly enrollment: DeviceSealingEnrollment;
  /**
   * Signs member chain entries and scope key packages. `privateKey` is
   * non-extractable. The member id is `deriveMemberId(signing.publicJwk)`; it
   * stays the same across KEM rotations.
   */
  readonly signing: { readonly publicJwk: SealingPublicJwk; readonly privateKey: WebCryptoKey };
  /** Opens scope key packages. `privateKey` is non-extractable. `epoch` starts at 1 for each member. */
  readonly kem: DeviceMemberKemKey;
  /** The KEM key of a rotation that has begun and not finished, at `kem.epoch + 1`. */
  readonly nextKem?: DeviceMemberKemKey;
}

export interface DeviceMemberKemKey {
  readonly epoch: number;
  readonly publicJwk: SealingPublicJwk;
  readonly privateKey: WebCryptoKey;
}

const PrivateJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: CanonicalBase64Url32,
  y: CanonicalBase64Url32,
  d: CanonicalBase64Url32,
});

const KemEpochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The stored record: one canonical JSON line, holding every private scalar. */
const StoredMemberKeysSchema = z
  .strictObject({
    v: z.literal(1),
    tenantId: z.string().min(1).max(200),
    deviceId: z.string().min(1).max(200),
    signingJwk: PrivateJwkSchema,
    kemEpoch: KemEpochSchema,
    kemJwk: PrivateJwkSchema,
    nextKem: z.strictObject({ epoch: KemEpochSchema, jwk: PrivateJwkSchema }).optional(),
  })
  .refine((record) => record.nextKem === undefined || record.nextKem.epoch === record.kemEpoch + 1, {
    message: 'nextKem.epoch must be kemEpoch + 1',
  });
type StoredMemberKeys = z.infer<typeof StoredMemberKeysSchema>;
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

function rotationMismatch(epoch: number): ByokKeysError {
  return new ByokKeysError(
    'DEVICE_MEMBER_KEY_ROTATION_MISMATCH',
    `No KEM rotation to epoch ${epoch} is pending for this enrollment`,
  );
}

function invalidStoredKey(): ByokKeysError {
  return new ByokKeysError(
    'DEVICE_MEMBER_KEY_INVALID',
    'The stored device member keys are malformed; they are not replaced automatically — re-pair or rotate them explicitly',
  );
}

/**
 * Loads, creates, and rotates the device member keys in the OS credential
 * store (through {@link SecretStore}; never a plain file).
 *
 * - `loadOrCreate` returns the stored keys when they belong to the current
 *   enrollment. Missing keys, or keys bound to a different enrollment, are
 *   replaced by a new member: a new signing key and a new KEM key at epoch 1.
 * - `beginKemRotation` stores a new KEM key at the next epoch beside the
 *   current one. When a rotation is already pending, it returns that rotation
 *   and generates nothing.
 * - `finishKemRotation(epoch)` makes the pending key current and deletes the
 *   old private key. The caller calls it only after the `rotate` entry is
 *   registered and every held scope key is re-wrapped to the new key.
 * - A malformed stored record fails closed. It is never silently regenerated,
 *   because a new signing key would silently create a new member.
 */
export class DeviceMemberKeyStore {
  readonly #secrets: SecretStore<DeviceMemberSecretName>;

  constructor(options: { secretStore: SecretStore<DeviceMemberSecretName> }) {
    assertSecretName(DEVICE_MEMBER_SECRET_NAME);
    this.#secrets = options.secretStore;
  }

  async loadOrCreate(enrollment: DeviceSealingEnrollment): Promise<DeviceMemberKeys> {
    const stored = await this.#readForEnrollment(enrollment);
    return materialize(stored ?? (await this.#write(enrollment, await generateSigningJwk(), 1)));
  }

  async beginKemRotation(enrollment: DeviceSealingEnrollment): Promise<DeviceMemberKeys> {
    const stored = (await this.#readForEnrollment(enrollment)) ?? (await this.#write(enrollment, await generateSigningJwk(), 1));
    if (stored.nextKem !== undefined) return materialize(stored);
    return materialize(
      await this.#store({
        ...stored,
        nextKem: { epoch: stored.kemEpoch + 1, jwk: await generatePrivateJwk(ECDH_P256, ['deriveBits']) },
      }),
    );
  }

  /**
   * Finish the rotation to `epoch`. A repeat call after the rotation finished
   * returns the current keys. Any other epoch throws
   * `DEVICE_MEMBER_KEY_ROTATION_MISMATCH` and changes nothing.
   */
  async finishKemRotation(enrollment: DeviceSealingEnrollment, epoch: number): Promise<DeviceMemberKeys> {
    const stored = await this.#readForEnrollment(enrollment);
    if (stored === undefined) throw rotationMismatch(epoch);
    if (stored.nextKem === undefined) {
      if (stored.kemEpoch === epoch) return materialize(stored);
      throw rotationMismatch(epoch);
    }
    if (stored.nextKem.epoch !== epoch) throw rotationMismatch(epoch);
    const { nextKem, ...rest } = stored;
    return materialize(await this.#store({ ...rest, kemEpoch: nextKem.epoch, kemJwk: nextKem.jwk }));
  }

  /** The stored record when it belongs to `enrollment`. A malformed record throws. */
  async #readForEnrollment(enrollment: DeviceSealingEnrollment): Promise<StoredMemberKeys | undefined> {
    const stored = await this.#read();
    return stored !== undefined && stored.tenantId === enrollment.tenantId && stored.deviceId === enrollment.deviceId
      ? stored
      : undefined;
  }

  async #read(): Promise<StoredMemberKeys | undefined> {
    const raw = await this.#secrets.get(DEVICE_MEMBER_SECRET_NAME);
    if (raw === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw invalidStoredKey();
    }
    const parsed = StoredMemberKeysSchema.safeParse(json);
    if (!parsed.success) throw invalidStoredKey();
    return parsed.data;
  }

  /** Write a new member: `signingJwk` and a fresh KEM key at `kemEpoch`, with no pending rotation. */
  async #write(enrollment: DeviceSealingEnrollment, signingJwk: PrivateJwk, kemEpoch: number): Promise<StoredMemberKeys> {
    return this.#store({
      v: 1,
      tenantId: enrollment.tenantId,
      deviceId: enrollment.deviceId,
      signingJwk,
      kemEpoch,
      kemJwk: await generatePrivateJwk(ECDH_P256, ['deriveBits']),
    });
  }

  async #store(value: StoredMemberKeys): Promise<StoredMemberKeys> {
    const record = StoredMemberKeysSchema.safeParse(value);
    if (!record.success) throw invalidStoredKey();
    await this.#secrets.set(DEVICE_MEMBER_SECRET_NAME, canonicalizeJson(record.data));
    // Read back: if another process replaced the entry concurrently, the
    // stored keys — not the ones generated here — are the device's keys.
    const stored = await this.#read();
    if (stored === undefined) throw invalidStoredKey();
    return stored;
  }
}

function generateSigningJwk(): Promise<PrivateJwk> {
  return generatePrivateJwk(ECDSA_P256, ['sign', 'verify']);
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
async function importKemKey(jwk: PrivateJwk): Promise<Omit<DeviceMemberKemKey, 'epoch'>> {
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

async function materialize(stored: StoredMemberKeys): Promise<DeviceMemberKeys> {
  const signing = await importSigningKey(stored.signingJwk);
  const kem = { epoch: stored.kemEpoch, ...(await importKemKey(stored.kemJwk)) };
  const base = {
    enrollment: { tenantId: stored.tenantId, deviceId: stored.deviceId },
    signing,
    kem,
  };
  if (stored.nextKem === undefined) return base;
  return { ...base, nextKem: { epoch: stored.nextKem.epoch, ...(await importKemKey(stored.nextKem.jwk)) } };
}
