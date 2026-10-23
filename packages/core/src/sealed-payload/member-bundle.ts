/**
 * The member key bundle (#654 design §7.1, §7.2, E2b).
 *
 * A bundle is the public half of one member: its id, its ECDSA P-256 signing
 * key, its P-256 KEM key and the KEM epoch. A device member also names its SDK
 * device id. A client member does not.
 *
 * An `add` chain entry carries the bundle. The pairing MACs bind it. In a
 * later slice, the device registers it with device proof.
 *
 * This module is internal: the subpath index does not export it.
 */
import { z } from 'zod';

import { deriveMemberId, MEMBER_ID_PATTERN } from './member-chain';
import { P256PublicJwkSchema, p256PublicKeyBytes, type P256PublicJwk } from './primitives';

export const MEMBER_KEY_BUNDLE_VERSION = 1;

export interface MemberKeyBundleV1 {
  readonly v: typeof MEMBER_KEY_BUNDLE_VERSION;
  readonly memberId: string;
  readonly signingPublicJwk: P256PublicJwk;
  readonly kemPublicJwk: P256PublicJwk;
  readonly kemEpoch: number;
  /** The SDK device id of a device member. A client member has none. */
  readonly deviceId?: string;
}

export const KemEpochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const MemberKeyBundleV1Schema = z.strictObject({
  v: z.literal(MEMBER_KEY_BUNDLE_VERSION),
  memberId: z.string().regex(MEMBER_ID_PATTERN),
  signingPublicJwk: P256PublicJwkSchema,
  kemPublicJwk: P256PublicJwkSchema,
  kemEpoch: KemEpochSchema,
  deviceId: z.string().min(1).optional(),
});

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

/**
 * Parse a received bundle. It is valid when its shape is strict, `memberId`
 * is the id of `signingPublicJwk` (which also checks that key is on the
 * curve), and the KEM key is a different point on the curve. Returns
 * `undefined` for anything else; it never throws for hostile input.
 */
export async function parseMemberKeyBundle(value: unknown): Promise<MemberKeyBundleV1 | undefined> {
  const parsed = MemberKeyBundleV1Schema.safeParse(value);
  if (!parsed.success) return undefined;
  const bundle = parsed.data;
  try {
    if ((await deriveMemberId(bundle.signingPublicJwk)) !== bundle.memberId) return undefined;
  } catch {
    return undefined;
  }
  if (!(await isValidMemberKemKey(bundle.kemPublicJwk, bundle.signingPublicJwk))) return undefined;
  return bundle;
}
