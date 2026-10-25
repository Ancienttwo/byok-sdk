/**
 * Scope keys and key packages (#654 design §7.4, §8.1, §9.1).
 *
 * A scope key `SK(scope, epoch)` is 32 random bytes one member generates.
 * Three values derive from it:
 *
 * - `keyId`: `base64url(HMAC-SHA-256(SK, "byok-scope-key-id-v1"))[0..22]`. It
 *   commits to the key, and the Host cannot derive the key from it.
 * - the content key of one sealed content: `HKDF-SHA-256(SK, salt,
 *   "byok-sdk.sealed.v1.enc")`, with a fresh 32-byte salt per content;
 * - the MAC key of the scope epoch: `HKDF-SHA-256(SK, empty salt,
 *   "byok-sdk.sealed.v1.mac")`.
 *
 * A key package carries SK to one member: HPKE base mode with core's one suite
 * (`hpke.ts`), info `byok-sdk.scope-key.v<version>`, AAD the canonical JSON of
 * the package's identity fields. HPKE base mode does not authenticate the
 * sender, so the sender member also signs the package.
 *
 * Version 2 (#654 E5b-2, owner batch §77a) adds `recipientKemEpoch`, the KEM
 * epoch of the recipient key the package is wrapped to, to the identity
 * fields, so the Host can refuse a package wrapped to a retired KEM key.
 * Packages are sealed as version 2; version 1 packages stored before it
 * still open.
 */
import { z } from 'zod';

import { canonicalizeJsonBytes } from '../attestation';
import { ByokCoreError } from '../errors';
import { hpkeOpenBase, hpkeSealBase } from '../hpke';
import { safeParseTotal } from '../total-parse';
import type { WebCryptoKey } from '../webcrypto';
import { KemEpochSchema } from './member-bundle';
import { MEMBER_ID_PATTERN, deriveMemberId } from './member-chain';
import {
  base64UrlBytes,
  concat,
  decodeBase64Url,
  ecdsaSign,
  ecdsaVerify,
  encodeBase64Url,
  hkdfSha256,
  hmacSha256,
  invalidInput,
  p256PublicKeyBytes,
  randomBytes,
  utf8,
  type Bytes,
  type P256PublicJwk,
} from './primitives';

export const SCOPE_KEY_BYTES = 32;

/** 16 bytes of the key-id HMAC, as unpadded base64url. */
export const SCOPE_KEY_ID_LENGTH = 22;
export const SCOPE_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

const KEY_ID_MESSAGE = 'byok-scope-key-id-v1';
const CONTENT_KEY_INFO = 'byok-sdk.sealed.v1.enc';
const MAC_KEY_INFO = 'byok-sdk.sealed.v1.mac';

/** Byte length of the per-content HKDF salt. */
export const SEALED_SALT_BYTES = 32;

export const SCOPE_KEY_PACKAGE_VERSION = 1;
export const SCOPE_KEY_HPKE_INFO = 'byok-sdk.scope-key.v1';

/** Prepended to the canonical package bytes the sender signs. */
export const SCOPE_KEY_PACKAGE_DOMAIN_PREFIX = 'byok-scope-key-package-v1\n';

export const SCOPE_KEY_PACKAGE_V2 = 2;
export const SCOPE_KEY_HPKE_INFO_V2 = 'byok-sdk.scope-key.v2';
export const SCOPE_KEY_PACKAGE_V2_DOMAIN_PREFIX = 'byok-scope-key-package-v2\n';

const P256_POINT_BYTES = 65;
const AEAD_TAG_BYTES = 16;

function assertScopeKey(scopeKey: Uint8Array): void {
  if (scopeKey.byteLength !== SCOPE_KEY_BYTES) throw invalidInput(`Scope key must be ${SCOPE_KEY_BYTES} bytes`);
}

/** A fresh scope key from the platform CSPRNG. */
export function generateScopeKey(): Bytes {
  return randomBytes(SCOPE_KEY_BYTES);
}

export async function deriveScopeKeyId(scopeKey: Uint8Array): Promise<string> {
  assertScopeKey(scopeKey);
  const mac = await hmacSha256(scopeKey, utf8(KEY_ID_MESSAGE));
  return encodeBase64Url(mac.subarray(0, 16));
}

/** The AES-256-GCM key of one sealed content. Each content has its own salt, so each key encrypts once. */
export async function deriveSealedContentKey(scopeKey: Uint8Array, salt: Uint8Array): Promise<Bytes> {
  assertScopeKey(scopeKey);
  if (salt.byteLength !== SEALED_SALT_BYTES) throw invalidInput(`Sealed content salt must be ${SEALED_SALT_BYTES} bytes`);
  return hkdfSha256(scopeKey, salt, CONTENT_KEY_INFO, 32);
}

/**
 * The content-MAC key of one scope epoch. The design's salt is empty; HMAC
 * pads its key with zeros, so 32 zero bytes give the same output, and no
 * runtime has to accept a zero-length HKDF salt.
 */
export async function deriveSealedMacKey(scopeKey: Uint8Array): Promise<Bytes> {
  assertScopeKey(scopeKey);
  return hkdfSha256(scopeKey, new Uint8Array(32), MAC_KEY_INFO, 32);
}

export interface ScopeKeyPackageV1 {
  readonly v: typeof SCOPE_KEY_PACKAGE_VERSION;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly epoch: number;
  readonly keyId: string;
  /** Member id of the member that can open the package. */
  readonly recipient: string;
  /** Member id of the member that sealed and signed the package. */
  readonly sender: string;
  /** HPKE encapsulated key: base64url of a 65-byte uncompressed P-256 point. */
  readonly enc: string;
  /** HPKE ciphertext of the scope key: base64url of 48 bytes. */
  readonly ciphertext: string;
  /** Sender's ECDSA P-256 / SHA-256 signature, base64url of the 64-byte P1363 form. */
  readonly sig: string;
}

const ScopeKeyPackageV1Schema = z.strictObject({
  v: z.literal(SCOPE_KEY_PACKAGE_VERSION),
  tenantId: z.string().min(1),
  scopeId: z.string().min(1),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  keyId: z.string().regex(SCOPE_KEY_ID_PATTERN),
  recipient: z.string().regex(MEMBER_ID_PATTERN),
  sender: z.string().regex(MEMBER_ID_PATTERN),
  enc: base64UrlBytes(P256_POINT_BYTES),
  ciphertext: base64UrlBytes(SCOPE_KEY_BYTES + AEAD_TAG_BYTES),
  sig: base64UrlBytes(64),
});

export interface ScopeKeyPackageV2 extends Omit<ScopeKeyPackageV1, 'v'> {
  readonly v: typeof SCOPE_KEY_PACKAGE_V2;
  /** The KEM epoch of the recipient key the package is wrapped to. */
  readonly recipientKemEpoch: number;
}

export type ScopeKeyPackage = ScopeKeyPackageV1 | ScopeKeyPackageV2;

const ScopeKeyPackageV2Schema = z.strictObject({
  ...ScopeKeyPackageV1Schema.shape,
  v: z.literal(SCOPE_KEY_PACKAGE_V2),
  recipientKemEpoch: KemEpochSchema,
});

const ScopeKeyPackageSchema = z.union([ScopeKeyPackageV1Schema, ScopeKeyPackageV2Schema]);

type PackageIdentity = Omit<ScopeKeyPackage, 'enc' | 'ciphertext' | 'sig'>;

/** HPKE AAD: the canonical JSON of the package's identity fields. */
function packageAad({ enc: _enc, ciphertext: _ciphertext, sig: _sig, ...identity }: PackageIdentity & Partial<ScopeKeyPackage>): Uint8Array {
  return canonicalizeJsonBytes(identity);
}

/** The bytes the sender signs: every field except `sig`, after the prefix of its version. */
function packageSigningInput({ sig: _sig, ...pkg }: Omit<ScopeKeyPackage, 'sig'> & { readonly sig?: string }): Bytes {
  return concat(utf8(pkg.v === SCOPE_KEY_PACKAGE_V2 ? SCOPE_KEY_PACKAGE_V2_DOMAIN_PREFIX : SCOPE_KEY_PACKAGE_DOMAIN_PREFIX), canonicalizeJsonBytes(pkg));
}

export interface SealScopeKeyPackageInput {
  readonly scopeKey: Uint8Array;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly epoch: number;
  /** The recipient's current KEM key, with its epoch from the verified member chain. */
  readonly recipient: { readonly memberId: string; readonly kemPublicJwk: P256PublicJwk; readonly kemEpoch: number };
  readonly sender: { readonly signingPublicJwk: P256PublicJwk; readonly signingPrivateKey: WebCryptoKey };
}

const PackageIdentitySchema = ScopeKeyPackageV2Schema.omit({ enc: true, ciphertext: true, sig: true });

/**
 * Wrap one scope key to one member's KEM key of `recipient.kemEpoch` and sign
 * the version 2 package. A signing private key that does not pair with
 * `sender.signingPublicJwk` throws `sealed_secret_invalid`.
 */
export async function sealScopeKeyPackage(input: SealScopeKeyPackageInput): Promise<ScopeKeyPackageV2> {
  const parsed = safeParseTotal(PackageIdentitySchema, {
    v: SCOPE_KEY_PACKAGE_V2,
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    epoch: input.epoch,
    keyId: await deriveScopeKeyId(input.scopeKey),
    recipient: input.recipient.memberId,
    recipientKemEpoch: input.recipient.kemEpoch,
    sender: await deriveMemberId(input.sender.signingPublicJwk),
  });
  if (!parsed.success) throw invalidInput('Scope key package input is invalid');
  const identity = parsed.data;
  const { enc, ciphertext } = await hpkeSealBase({
    recipientPublicKey: await p256PublicKeyBytes(input.recipient.kemPublicJwk),
    info: utf8(SCOPE_KEY_HPKE_INFO_V2),
    aad: packageAad(identity),
    plaintext: input.scopeKey,
  });
  const unsigned = { ...identity, enc: encodeBase64Url(enc), ciphertext: encodeBase64Url(ciphertext) };
  return { ...unsigned, sig: await ecdsaSign(input.sender.signingPublicJwk, input.sender.signingPrivateKey, packageSigningInput(unsigned)) };
}

export interface OpenScopeKeyPackageInput {
  readonly package: unknown;
  /** What the caller asked the Host for. A package for anything else is refused. */
  readonly expected: { readonly tenantId: string; readonly scopeId: string; readonly epoch: number };
  readonly recipient: {
    readonly memberId: string;
    readonly kemPublicJwk: P256PublicJwk;
    readonly kemPrivateKey: WebCryptoKey;
    /** The KEM epoch of this key pair. A version 2 package must name it. */
    readonly kemEpoch: number;
  };
  /** The signing key the caller's verified chain holds for `package.sender`. */
  readonly senderSigningPublicJwk: P256PublicJwk;
}

export type ScopeKeyPackageOpenResult =
  | { readonly ok: true; readonly scopeKey: Uint8Array; readonly keyId: string }
  | {
    readonly ok: false;
    readonly reason: 'key_package_invalid' | 'key_package_signature_invalid' | 'key_package_open_failed';
  };

/**
 * Verify and open one key package, in this order: shape; addressed to this
 * recipient (and, for version 2, its KEM epoch) for the expected tenant,
 * scope and epoch; sender key matches the
 * sender id; sender signature; HPKE open; key length; and `keyId` equal to
 * the opened key's own id. Nothing here throws for hostile input.
 */
export async function openScopeKeyPackage(input: OpenScopeKeyPackageInput): Promise<ScopeKeyPackageOpenResult> {
  const parsed = safeParseTotal(ScopeKeyPackageSchema, input.package);
  if (!parsed.success) return { ok: false, reason: 'key_package_invalid' };
  const pkg = parsed.data;
  if (
    pkg.recipient !== input.recipient.memberId
    || (pkg.v === SCOPE_KEY_PACKAGE_V2 && pkg.recipientKemEpoch !== input.recipient.kemEpoch)
    || pkg.tenantId !== input.expected.tenantId
    || pkg.scopeId !== input.expected.scopeId
    || pkg.epoch !== input.expected.epoch
    || pkg.sender !== (await deriveMemberId(input.senderSigningPublicJwk))
  ) {
    return { ok: false, reason: 'key_package_invalid' };
  }
  if (!(await ecdsaVerify(input.senderSigningPublicJwk, pkg.sig, packageSigningInput(pkg)))) {
    return { ok: false, reason: 'key_package_signature_invalid' };
  }
  let scopeKey: Uint8Array;
  try {
    scopeKey = await hpkeOpenBase({
      recipientPrivateKey: input.recipient.kemPrivateKey,
      recipientPublicKey: await p256PublicKeyBytes(input.recipient.kemPublicJwk),
      enc: decodeBase64Url(pkg.enc, 'enc'),
      info: utf8(pkg.v === SCOPE_KEY_PACKAGE_V2 ? SCOPE_KEY_HPKE_INFO_V2 : SCOPE_KEY_HPKE_INFO),
      aad: packageAad(pkg),
      ciphertext: decodeBase64Url(pkg.ciphertext, 'ciphertext'),
    });
  } catch (error) {
    if (error instanceof ByokCoreError) return { ok: false, reason: 'key_package_open_failed' };
    throw error;
  }
  // A signed package whose key does not match its own key id came from a
  // faulty or hostile member; it opens nothing.
  if (scopeKey.byteLength !== SCOPE_KEY_BYTES || (await deriveScopeKeyId(scopeKey)) !== pkg.keyId) {
    scopeKey.fill(0);
    return { ok: false, reason: 'key_package_open_failed' };
  }
  return { ok: true, scopeKey, keyId: pkg.keyId };
}
