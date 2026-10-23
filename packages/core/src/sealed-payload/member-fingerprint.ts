/**
 * Member fingerprints and the two-way approval code (#654 design §7.2, §7.8;
 * owner decision 10a).
 *
 * Fingerprint of one member:
 *
 * 1. `digest = SHA-256(MEMBER_FINGERPRINT_DOMAIN || canonicalJson({ v: 1, tenantId, signingKey: { x, y } }))`.
 * 2. Take the first 25 bytes as 5 groups of 5 bytes.
 * 3. Read each group as a big-endian integer, take it modulo 100000, and pad
 *    it to 5 decimal digits.
 *
 * The result is 25 digits in 5 groups, about 83 bits. The KEM key is not in
 * the fingerprint; the bundle's `kemSig` binds it. So a KEM rotation keeps the
 * fingerprint.
 *
 * Approval code: approval is two-way. Both screens show the same 50 digits:
 * the two members' fingerprints, ordered by member id, in 10 groups of 5. The
 * approver signs `add` only after both sides confirm the same code, and the
 * new member pins the approver's signing key only after it confirms (11b).
 * A device's local approval command shows the same code.
 */
import { z } from 'zod';

import { canonicalizeJsonBytes } from '../attestation';
import { safeParseTotal } from '../total-parse';
import { deriveMemberId } from './member-chain';
import { P256PublicJwkSchema, concat, invalidInput, sha256, utf8, type P256PublicJwk } from './primitives';

export const MEMBER_FINGERPRINT_DOMAIN = 'byok-member-fingerprint-v1\n';

const FINGERPRINT_GROUPS = 5;
const GROUP_BYTES = 5;
const GROUP_MODULUS = 100000n;

/** The caller data, read once into plain values. */
const FingerprintInputSchema = z.object({ tenantId: z.string().min(1), signingPublicJwk: P256PublicJwkSchema });

export interface MemberFingerprintInput {
  readonly tenantId: string;
  readonly signingPublicJwk: P256PublicJwk;
}

/** The 25-digit fingerprint of one member, as 5 groups of 5 digits joined by single spaces. */
export async function memberFingerprint(input: MemberFingerprintInput): Promise<string> {
  return (await fingerprintGroups(input)).groups.join(' ');
}

/**
 * The 50-digit two-way approval code of two members of one tenant: their
 * fingerprints ordered by member id, as 10 groups of 5 digits joined by
 * single spaces. The order of the arguments does not matter.
 */
export async function memberApprovalCode(
  tenantId: string,
  first: P256PublicJwk,
  second: P256PublicJwk,
): Promise<string> {
  const members = await Promise.all([first, second].map((signingPublicJwk) => fingerprintGroups({ tenantId, signingPublicJwk })));
  if (members[0]!.memberId === members[1]!.memberId) throw invalidInput('An approval code needs two different members');
  members.sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  return members.flatMap((member) => member.groups).join(' ');
}

/** The member id and the 5 fingerprint groups of one member. */
async function fingerprintGroups(input: MemberFingerprintInput): Promise<{ memberId: string; groups: string[] }> {
  const parsed = safeParseTotal(FingerprintInputSchema, input);
  if (!parsed.success) throw invalidInput('Member fingerprint needs a tenant id and a P-256 signing key');
  const { tenantId, signingPublicJwk } = parsed.data;
  // deriveMemberId checks that the key is a point on P-256.
  const memberId = await deriveMemberId(signingPublicJwk);
  const digest = await sha256(
    concat(
      utf8(MEMBER_FINGERPRINT_DOMAIN),
      canonicalizeJsonBytes({ v: 1, tenantId, signingKey: { x: signingPublicJwk.x, y: signingPublicJwk.y } }),
    ),
  );
  const groups: string[] = [];
  for (let group = 0; group < FINGERPRINT_GROUPS; group += 1) {
    let value = 0n;
    for (const byte of digest.subarray(group * GROUP_BYTES, (group + 1) * GROUP_BYTES)) value = (value << 8n) | BigInt(byte);
    groups.push((value % GROUP_MODULUS).toString().padStart(5, '0'));
  }
  return { memberId, groups };
}
