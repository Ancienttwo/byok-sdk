/**
 * Member keys, the member chain and scope key packages as the Host stores
 * them (#654 design §7.2–§7.4, E2c).
 *
 * The Host checks shapes only. It never hashes an entry or verifies a
 * signature: members walk the chain themselves (§7.3), so a Host check adds
 * no trust. `@byok-sdk/core/sealed-payload` creates and verifies these values.
 * Protocol does not depend on core, so this module repeats core's shape
 * rules; a cross-package test in `@byok-sdk/cloud` keeps the two equal.
 */
import { z } from 'zod';

import { CONTENT_HASH_RE } from './blob';

/** The most chain entries one append accepts. */
export const E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES = 64;
/** The largest canonical JSON entry, in UTF-8 bytes. */
export const E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES = 65_536;
/** The most chain entries one read returns. */
export const E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES = 256;
/** The most scope key packages one put accepts. */
export const E2EE_SCOPE_KEY_PACKAGE_PUT_MAX = 256;

// Device-proof operations of the three device write routes. Each route binds
// one operation, and the proof's `resource` is the route path.
/** Register the device's member key bundle and its device pairing MAC (§7.2 step 3). */
export const E2EE_MEMBER_KEY_REGISTER_OPERATION = 'e2ee-member-key.register' as const;
/** Append member chain entries. */
export const E2EE_MEMBER_CHAIN_APPEND_OPERATION = 'e2ee-member-chain.append' as const;
/** Put scope key packages. */
export const E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION = 'e2ee-scope-key-package.put' as const;

/**
 * Canonical unpadded base64url of exactly `bytes` bytes: the length is fixed,
 * and the unused low bits of the last character are zero, so one value has
 * one text form.
 */
function base64UrlBytes(bytes: number) {
  const length = Math.ceil((bytes * 4) / 3);
  const last = ['[A-Za-z0-9_-]', '[AQgw]', '[AEIMQUYcgkosw048]'][bytes % 3];
  return z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length - 1}}${last}$`, 'u'));
}

const MemberIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SignatureSchema = base64UrlBytes(64);

const P256PublicJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: base64UrlBytes(32),
  y: base64UrlBytes(32),
});

/** A member's public key bundle. A device member names its SDK device id; a client member has none. */
export const E2eeMemberKeyBundleSchema = z.strictObject({
  v: z.literal(1),
  memberId: MemberIdSchema,
  signingPublicJwk: P256PublicJwkSchema,
  kemPublicJwk: P256PublicJwkSchema,
  kemEpoch: PositiveSafeIntegerSchema,
  kemSig: SignatureSchema,
  deviceId: z.string().min(1).optional(),
});
export type E2eeMemberKeyBundle = z.infer<typeof E2eeMemberKeyBundleSchema>;

export const E2EE_MEMBER_CHAIN_OPS = ['add', 'remove', 'rotate', 'scope-policy', 'shred'] as const;

/**
 * One signed member chain entry. `subject` must be a JSON object; the Host
 * stores the entry as canonical JSON, which refuses any value outside JSON.
 */
export const E2eeMemberChainEntrySchema = z
  .strictObject({
    v: z.literal(1),
    tenantId: z.string().min(1),
    seq: PositiveSafeIntegerSchema,
    prev: z.union([z.null(), z.string().regex(CONTENT_HASH_RE)]),
    op: z.enum(E2EE_MEMBER_CHAIN_OPS),
    subject: z.custom<Readonly<Record<string, unknown>>>(
      value => value !== null && typeof value === 'object' && !Array.isArray(value),
    ),
    signer: MemberIdSchema,
    sig: SignatureSchema,
  })
  .refine(entry => (entry.seq === 1) === (entry.prev === null), {
    path: ['prev'],
    message: 'the first entry, and only the first, has no prev',
  });
export type E2eeMemberChainEntry = z.infer<typeof E2eeMemberChainEntrySchema>;

/** One scope key wrapped to one member (§7.4). */
export const E2eeScopeKeyPackageSchema = z.strictObject({
  v: z.literal(1),
  tenantId: z.string().min(1),
  scopeId: z.string().min(1),
  epoch: PositiveSafeIntegerSchema,
  keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  recipient: MemberIdSchema,
  sender: MemberIdSchema,
  enc: base64UrlBytes(65),
  ciphertext: base64UrlBytes(48),
  sig: SignatureSchema,
});
export type E2eeScopeKeyPackage = z.infer<typeof E2eeScopeKeyPackageSchema>;

/** A pairing MAC (§7.2 steps 3 and 4): HMAC-SHA-256 under `pv`, which the Host never holds. */
export const E2eePairingMacSchema = base64UrlBytes(32);

/**
 * The device registration body. `member` is the device's own bundle, so it
 * names the device id; `mac` is the device pairing MAC over it under `pv`.
 */
export const E2eeMemberKeyRegisterRequestSchema = z.strictObject({
  member: E2eeMemberKeyBundleSchema.refine(member => member.deviceId !== undefined, {
    message: 'a device member names its deviceId',
  }),
  mac: E2eePairingMacSchema,
});
export type E2eeMemberKeyRegisterRequest = z.infer<typeof E2eeMemberKeyRegisterRequestSchema>;

/** What the client relays to the device in pairing step 4. The client member has no device id. */
export const E2eeClientPairingMacSchema = z.strictObject({
  mac: E2eePairingMacSchema,
  member: E2eeMemberKeyBundleSchema.refine(member => member.deviceId === undefined, {
    message: 'a client member has no deviceId',
  }),
  chainHead: z.strictObject({ seq: PositiveSafeIntegerSchema, hash: z.string().regex(CONTENT_HASH_RE) }),
});
export type E2eeClientPairingMac = z.infer<typeof E2eeClientPairingMacSchema>;
