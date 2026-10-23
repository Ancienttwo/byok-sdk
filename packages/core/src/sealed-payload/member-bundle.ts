/**
 * The member key bundle (#654 design §7.1, §7.2, E2b; owner decision 10a).
 *
 * A bundle is the public half of one member: its id, its ECDSA P-256 signing
 * key, its P-256 KEM key, the KEM epoch, and `kemSig`. A device member also
 * names its SDK device id. A client member does not.
 *
 * `kemSig` is the member's own signature over its KEM key and epoch. The
 * fingerprint covers only the signing key, so a KEM rotation keeps the member
 * id and the fingerprint. The self-signature binds the KEM key to the member:
 * a Host that swaps the KEM key breaks the signature.
 *
 * An `add` chain entry carries the bundle. The pairing MACs bind it. In a
 * later slice, the device registers it with device proof.
 */
import { z } from 'zod';

import { canonicalizeJsonBytes } from '../attestation';
import type { WebCryptoKey } from '../webcrypto';
import { safeParseTotal } from '../total-parse';
import { deriveMemberId, MEMBER_ID_PATTERN } from './member-chain';
import {
  P256PublicJwkSchema,
  base64UrlBytes,
  concat,
  ecdsaSign,
  ecdsaVerify,
  invalidInput,
  p256PublicKeyBytes,
  utf8,
  type Bytes,
  type P256PublicJwk,
} from './primitives';

export const MEMBER_KEY_BUNDLE_VERSION = 1;

/** Prepended to the canonical KEM statement, so `kemSig` never verifies as another signed object. */
export const MEMBER_KEM_DOMAIN_PREFIX = 'byok-member-kem-v1\n';

export interface MemberKeyBundleV1 {
  readonly v: typeof MEMBER_KEY_BUNDLE_VERSION;
  readonly memberId: string;
  readonly signingPublicJwk: P256PublicJwk;
  readonly kemPublicJwk: P256PublicJwk;
  readonly kemEpoch: number;
  /** ECDSA P-256 / SHA-256 by the signing key over the KEM statement, base64url of the 64-byte P1363 form. */
  readonly kemSig: string;
  /** The SDK device id of a device member. A client member has none. */
  readonly deviceId?: string;
}

export const KemEpochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const KemSigSchema = base64UrlBytes(64);

/** @internal The strict bundle shape. Shared with `pairing-verification.ts`. */
export const MemberKeyBundleV1Schema = z.strictObject({
  v: z.literal(MEMBER_KEY_BUNDLE_VERSION),
  memberId: z.string().regex(MEMBER_ID_PATTERN),
  signingPublicJwk: P256PublicJwkSchema,
  kemPublicJwk: P256PublicJwkSchema,
  kemEpoch: KemEpochSchema,
  kemSig: KemSigSchema,
  deviceId: z.string().min(1).optional(),
});

/** The caller data of `createMemberKeyBundle`, read once. The private key is kept as given; `ecdsaSign` checks it. */
const CreateInputSchema = z.object({
  signingPublicJwk: P256PublicJwkSchema,
  signingPrivateKey: z.custom<WebCryptoKey>(),
  kemPublicJwk: P256PublicJwkSchema,
  kemEpoch: KemEpochSchema,
  deviceId: z.string().min(1).optional(),
});

/** The fields `verifyMemberKem` reads, as plain values. Other fields, such as the rest of a bundle, are ignored. */
const KemSignerSchema = z.object({ memberId: z.string().regex(MEMBER_ID_PATTERN), signingPublicJwk: P256PublicJwkSchema });
const KemStatementSchema = z.object({ kemPublicJwk: P256PublicJwkSchema, kemEpoch: KemEpochSchema, kemSig: KemSigSchema });

/** `MEMBER_KEM_DOMAIN_PREFIX || canonicalJson({ memberId, kemPublicKey: { x, y }, kemEpoch })`. */
export function memberKemSigningInput(memberId: string, kemPublicJwk: P256PublicJwk, kemEpoch: number): Bytes {
  return concat(
    utf8(MEMBER_KEM_DOMAIN_PREFIX),
    canonicalizeJsonBytes({ memberId, kemPublicKey: { x: kemPublicJwk.x, y: kemPublicJwk.y }, kemEpoch }),
  );
}

export interface CreateMemberKeyBundleInput {
  readonly signingPublicJwk: P256PublicJwk;
  readonly signingPrivateKey: WebCryptoKey;
  readonly kemPublicJwk: P256PublicJwk;
  readonly kemEpoch: number;
  readonly deviceId?: string;
}

/** Build a bundle: derive the member id and sign the KEM statement. Bad input throws `sealed_secret_invalid`. */
export async function createMemberKeyBundle(input: CreateMemberKeyBundleInput): Promise<MemberKeyBundleV1> {
  const parsed = safeParseTotal(CreateInputSchema, input);
  if (!parsed.success) throw invalidInput('Member key bundle input is invalid');
  const { signingPublicJwk, signingPrivateKey, kemPublicJwk, kemEpoch, deviceId } = parsed.data;
  const memberId = await deriveMemberId(signingPublicJwk);
  if (!(await isValidMemberKemKey(kemPublicJwk, signingPublicJwk))) throw invalidInput('Member KEM key is invalid');
  const kemSig = await ecdsaSign(signingPublicJwk, signingPrivateKey, memberKemSigningInput(memberId, kemPublicJwk, kemEpoch));
  return {
    v: MEMBER_KEY_BUNDLE_VERSION,
    memberId,
    signingPublicJwk,
    kemPublicJwk,
    kemEpoch,
    kemSig,
    ...(deviceId === undefined ? {} : { deviceId }),
  };
}

/** Both keys are points on P-256, and the KEM key is not the signing key. */
export async function isValidMemberKemKey(kemPublicJwk: P256PublicJwk, signingPublicJwk: P256PublicJwk): Promise<boolean> {
  if (kemPublicJwk.x === signingPublicJwk.x && kemPublicJwk.y === signingPublicJwk.y) return false;
  try {
    await p256PublicKeyBytes(kemPublicJwk);
    return true;
  } catch {
    return false;
  }
}

/** The KEM key is valid for the member, and `kemSig` is the member's signature over it. Never throws. */
export async function verifyMemberKem(
  member: { readonly memberId: string; readonly signingPublicJwk: P256PublicJwk },
  kem: { readonly kemPublicJwk: P256PublicJwk; readonly kemEpoch: number; readonly kemSig: string },
): Promise<boolean> {
  const signer = safeParseTotal(KemSignerSchema, member);
  const statement = safeParseTotal(KemStatementSchema, kem);
  if (!signer.success || !statement.success) return false;
  const { memberId, signingPublicJwk } = signer.data;
  const { kemPublicJwk, kemEpoch, kemSig } = statement.data;
  if (!(await isValidMemberKemKey(kemPublicJwk, signingPublicJwk))) return false;
  try {
    return await ecdsaVerify(signingPublicJwk, kemSig, memberKemSigningInput(memberId, kemPublicJwk, kemEpoch));
  } catch {
    return false;
  }
}

/**
 * Parse a received bundle. It is valid when its shape is strict, `memberId`
 * is the id of `signingPublicJwk` (which also checks that key is on the
 * curve), the KEM key is a different point on the curve, and `kemSig`
 * verifies. Returns `undefined` for anything else; it never throws for
 * hostile input.
 */
export async function parseMemberKeyBundle(value: unknown): Promise<MemberKeyBundleV1 | undefined> {
  const parsed = safeParseTotal(MemberKeyBundleV1Schema, value);
  if (!parsed.success) return undefined;
  const bundle = parsed.data;
  try {
    if ((await deriveMemberId(bundle.signingPublicJwk)) !== bundle.memberId) return undefined;
  } catch {
    return undefined;
  }
  if (!(await verifyMemberKem(bundle, bundle))) return undefined;
  return bundle;
}
