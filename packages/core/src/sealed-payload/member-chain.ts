/**
 * Member ids and member chain entries (#654 design §7.1, §7.3).
 *
 * A member is one device or one client. It holds an ECDSA P-256 signing key
 * and a P-256 KEM key. Its id derives from the signing public key alone, so a
 * KEM rotation keeps the id, and no SDK device id or product identity enters
 * it. A device member names its SDK device id inside its chain entry instead.
 *
 * This module signs and verifies ONE entry. Walking a chain — the `prev`
 * links, removed signers, the pinned anchor — and the per-op `subject` shapes
 * belong to the chain verifier (E2), which builds on these bytes.
 */
import { z } from 'zod';

import { canonicalizeJson, canonicalizeJsonBytes, type JsonObject } from '../attestation';
import { CONTENT_HASH_PATTERN } from '../blob';
import { safeParseTotal } from '../total-parse';
import type { WebCryptoKey } from '../webcrypto';
import {
  base64UrlBytes,
  concat,
  ecdsaSign,
  ecdsaVerify,
  encodeBase64Url,
  hex,
  invalidInput,
  p256PublicKeyBytes,
  sha256,
  utf8,
  type Bytes,
  type P256PublicJwk,
} from './primitives';

/** Domain separation for {@link deriveMemberId}. */
export const MEMBER_ID_DOMAIN = 'byok-member-id-v1\n';

/** `base64url(sha256(MEMBER_ID_DOMAIN || 0x04 || x || y))`: 43 characters, no padding. */
export const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const MEMBER_CHAIN_VERSION = 1;

/** Prepended to the canonical entry bytes, so a chain signature never verifies as another signed object. */
export const MEMBER_CHAIN_DOMAIN_PREFIX = 'byok-member-chain-v1\n';

export const MEMBER_CHAIN_OPS = ['add', 'remove', 'rotate', 'scope-policy', 'shred'] as const;
export type MemberChainOp = (typeof MEMBER_CHAIN_OPS)[number];

/** One entry before it is signed. `seq` starts at 1; the first entry, and only it, has `prev: null`. */
export interface UnsignedMemberChainEntryV1 {
  readonly v: typeof MEMBER_CHAIN_VERSION;
  readonly tenantId: string;
  readonly seq: number;
  /** `sha256:<hex>` of the previous entry's signing input. */
  readonly prev: string | null;
  readonly op: MemberChainOp;
  readonly subject: JsonObject;
  /** Member id of the signer. */
  readonly signer: string;
}

export interface MemberChainEntryV1 extends UnsignedMemberChainEntryV1 {
  /** ECDSA P-256 / SHA-256 over the signing input, base64url of the 64-byte P1363 form. */
  readonly sig: string;
}

/** A plain JSON object that has exactly one canonical byte form. */
const CanonicalJsonObjectSchema = z.custom<JsonObject>((value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    canonicalizeJson(value as JsonObject);
    return true;
  } catch {
    return false;
  }
}, 'must be a canonical JSON object');

const unsignedEntryShape = {
  v: z.literal(MEMBER_CHAIN_VERSION),
  tenantId: z.string().min(1),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  prev: z.union([z.null(), z.string().regex(CONTENT_HASH_PATTERN)]),
  op: z.enum(MEMBER_CHAIN_OPS),
  subject: CanonicalJsonObjectSchema,
  signer: z.string().regex(MEMBER_ID_PATTERN),
};

function firstEntryHasNoPrev(entry: { readonly seq: number; readonly prev: string | null }, ctx: z.RefinementCtx): void {
  if ((entry.seq === 1) !== (entry.prev === null)) {
    ctx.addIssue({ code: 'custom', path: ['prev'], message: 'the first entry, and only the first, has no prev' });
  }
}

const UnsignedMemberChainEntryV1Schema = z.strictObject(unsignedEntryShape).superRefine(firstEntryHasNoPrev);
const MemberChainEntryV1Schema = z
  .strictObject({ ...unsignedEntryShape, sig: base64UrlBytes(64) })
  .superRefine(firstEntryHasNoPrev);

/** The member id of a signing public key. The key must be a point on P-256. */
export async function deriveMemberId(signingPublicJwk: P256PublicJwk): Promise<string> {
  const raw = await p256PublicKeyBytes(signingPublicJwk);
  return encodeBase64Url(await sha256(concat(utf8(MEMBER_ID_DOMAIN), raw)));
}

function parseUnsignedEntry(entry: UnsignedMemberChainEntryV1): UnsignedMemberChainEntryV1 {
  const parsed = safeParseTotal(UnsignedMemberChainEntryV1Schema, entry);
  if (!parsed.success) throw invalidInput('Member chain entry is invalid');
  return parsed.data;
}

function signingInput(entry: UnsignedMemberChainEntryV1): Bytes {
  return concat(
    utf8(MEMBER_CHAIN_DOMAIN_PREFIX),
    canonicalizeJsonBytes({
      v: entry.v,
      tenantId: entry.tenantId,
      seq: entry.seq,
      prev: entry.prev,
      op: entry.op,
      subject: entry.subject,
      signer: entry.signer,
    }),
  );
}

/** `MEMBER_CHAIN_DOMAIN_PREFIX || canonicalJson(entry without sig)`. */
export function memberChainSigningInput(entry: UnsignedMemberChainEntryV1): Bytes {
  return signingInput(parseUnsignedEntry(entry));
}

/** `sha256:<hex>` of the signing input. The signature is not hashed, so the hash names the entry's content. */
export async function memberChainEntryHash(entry: UnsignedMemberChainEntryV1): Promise<string> {
  return `sha256:${hex(await sha256(memberChainSigningInput(entry)))}`;
}

/**
 * Sign one entry. The signer's public key is required so an entry is never
 * signed under a member id that is not the signer's own. A private key that
 * does not pair with that public key throws `sealed_secret_invalid`.
 */
export async function signMemberChainEntry(
  entry: UnsignedMemberChainEntryV1,
  signer: { readonly publicJwk: P256PublicJwk; readonly privateKey: WebCryptoKey },
): Promise<MemberChainEntryV1> {
  const unsigned = parseUnsignedEntry(entry);
  if ((await deriveMemberId(signer.publicJwk)) !== unsigned.signer) {
    throw invalidInput('Member chain entry signer does not match the signing key');
  }
  return { ...unsigned, sig: await ecdsaSign(signer.publicJwk, signer.privateKey, signingInput(unsigned)) };
}

export type MemberChainEntryVerifyResult =
  | { readonly ok: true; readonly entry: MemberChainEntryV1; readonly hash: string }
  | { readonly ok: false; readonly reason: 'member_chain_entry_invalid' | 'member_chain_signature_invalid' };

/**
 * Verify one received entry against the signing key the verifier already
 * pins for `entry.signer`. A malformed entry, or a key whose member id is not
 * the entry's signer, is `member_chain_entry_invalid`; a bad signature is
 * `member_chain_signature_invalid`. Nothing here throws for hostile input.
 */
export async function verifyMemberChainEntry(
  entry: unknown,
  signerPublicJwk: P256PublicJwk,
): Promise<MemberChainEntryVerifyResult> {
  const parsed = safeParseTotal(MemberChainEntryV1Schema, entry);
  if (!parsed.success || (await deriveMemberId(signerPublicJwk)) !== parsed.data.signer) {
    return { ok: false, reason: 'member_chain_entry_invalid' };
  }
  const input = signingInput(parsed.data);
  if (!(await ecdsaVerify(signerPublicJwk, parsed.data.sig, input))) {
    return { ok: false, reason: 'member_chain_signature_invalid' };
  }
  return { ok: true, entry: parsed.data, hash: `sha256:${hex(await sha256(input))}` };
}
