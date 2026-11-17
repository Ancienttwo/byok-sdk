import { fingerprintGroups, type MemberFingerprintInput } from '../../sealed-payload/member-fingerprint';

/** Render the live approval-code primitive for the single-member golden vectors. */
export async function memberFingerprint(input: MemberFingerprintInput): Promise<string> {
  return (await fingerprintGroups(input)).groups.join(' ');
}
