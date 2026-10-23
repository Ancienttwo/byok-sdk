/**
 * Member chain walk (#654 design §7.3, §7.4, §7.5, §11.2, E2b; owner
 * decisions 11a and 11b).
 *
 * `applyMemberChainEntries` checks entries forward from a state and returns
 * the new state. Each entry must:
 *
 * - be the next entry: same tenant, `seq = head.seq + 1`, `prev = head.hash`
 *   (from the empty state: `seq = 1`, `prev = null`);
 * - be signed by a current member (an `add`ed member that is not removed), or
 *   be the genesis entry (11a, below);
 * - for `scope-policy` and `shred`, be signed by a member of the scope (below);
 * - have the subject shape and the rule of its op (below).
 *
 * One bad entry rejects the whole batch. The caller's state does not change.
 *
 * Genesis (11a): from the empty state only, the first entry is a self-signed
 * `add`: `subject.member.memberId === signer`, verified with the subject's
 * own signing key. Self-signing proves only that the member holds the key.
 * Trust comes from the anchor (11b, `verifyMemberChainFromAnchor`). An active
 * Host can write a false first entry first; that only denies service.
 *
 * Precondition (D10, #655 D-I2): one tenant is one user. v1 has no per-user
 * permissions, so any current member may sign `add` and `remove`. A Host
 * that maps two users to one tenant breaks this: one user's client could
 * change the other user's devices.
 *
 * Scope signers (owner batch §50f A): a `scope-policy` or `shred` of an
 * existing scope must be signed by a member in that scope's current policy.
 * The first `scope-policy` of a new scope must be signed by a member in its
 * own member list. So a device member cannot add itself to another device's
 * scope or shred it, and the per-device isolation of #655 D-I4 (§7.9) does
 * not depend on the other members being honest. Another signer fails with
 * `member_chain_signer_invalid`.
 *
 * Op rules:
 *
 * - `add` `{ member }`: a valid bundle (`parseMemberKeyBundle`) of a member
 *   that is not current and was never removed. A removed member id is final;
 *   a re-paired device is a new member (§7.5).
 * - `remove` `{ memberId }`: a current member. A member may remove itself,
 *   but the last member may not: the member set never becomes empty after
 *   genesis (owner decision 14A).
 * - `rotate` `{ memberId, kemPublicJwk, kemEpoch, kemSig }`: signed by that
 *   member itself; `kemEpoch` is its current KEM epoch + 1; the KEM key is
 *   not the current one; `kemSig` is the member's signature over the new KEM
 *   key (10a).
 * - `scope-policy` `{ scopeId, categories, members }`: categories in the
 *   order of `SEALED_CATEGORIES`, no repeats; members sorted, no repeats,
 *   each a current member (§7.4); the scope is not shredded.
 * - `shred` `{ scopeId }`: a scope with a policy that is not shredded. After
 *   it, no `scope-policy` for that scope is valid (§11.2).
 */
import { z } from 'zod';

import { canonicalizeJson, type JsonObject } from '../attestation';
import { safeParseTotal } from '../total-parse';
import {
  KemEpochSchema,
  KemSigSchema,
  parseMemberKeyBundle,
  verifyMemberKem,
  type MemberKeyBundleV1,
} from './member-bundle';
import { MEMBER_ID_PATTERN, deriveMemberId, verifyMemberChainEntry, type MemberChainEntryV1 } from './member-chain';
import { P256PublicJwkSchema, type P256PublicJwk } from './primitives';
import { SEALED_CATEGORIES, type SealedCategory } from './sealed-content';

export interface MemberChainScope {
  readonly categories: readonly SealedCategory[];
  /** Member ids from the latest `scope-policy` entry, sorted. Some may be removed since. */
  readonly members: readonly string[];
  /** `seq` of that entry. */
  readonly policySeq: number;
}

export interface MemberChainHead {
  readonly seq: number;
  readonly hash: string;
}

export interface MemberChainState {
  readonly tenantId: string;
  /** `null` before the genesis entry. */
  readonly head: MemberChainHead | null;
  /** Current members by member id, with their current KEM key. */
  readonly members: ReadonlyMap<string, MemberKeyBundleV1>;
  readonly removed: ReadonlySet<string>;
  readonly scopes: ReadonlyMap<string, MemberChainScope>;
  readonly shredded: ReadonlySet<string>;
}

export type MemberChainWalkFailure =
  | 'member_chain_entry_invalid'
  | 'member_chain_link_invalid'
  | 'member_chain_signer_invalid'
  | 'member_chain_signature_invalid'
  | 'member_chain_subject_invalid';

export type MemberChainWalkResult =
  | { readonly ok: true; readonly state: MemberChainState }
  | { readonly ok: false; readonly reason: MemberChainWalkFailure; readonly index: number };

const MemberIdSchema = z.string().regex(MEMBER_ID_PATTERN);
const ScopeIdSchema = z.string().min(1);

const AddSubjectSchema = z.strictObject({ member: z.unknown() });
const RemoveSubjectSchema = z.strictObject({ memberId: MemberIdSchema });
const RotateSubjectSchema = z.strictObject({
  memberId: MemberIdSchema,
  kemPublicJwk: P256PublicJwkSchema,
  kemEpoch: KemEpochSchema,
  kemSig: KemSigSchema,
});
const ScopePolicySubjectSchema = z.strictObject({
  scopeId: ScopeIdSchema,
  categories: z.array(z.enum(SEALED_CATEGORIES)).min(1),
  members: z.array(MemberIdSchema).min(1),
});
const ShredSubjectSchema = z.strictObject({ scopeId: ScopeIdSchema });
const SignerSchema = z.object({ signer: MemberIdSchema });
const GenesisSchema = z.object({ op: z.literal('add'), subject: AddSubjectSchema });
const HeadSchema = z.object({ seq: z.number(), hash: z.string() });
const EntriesSchema = z.array(z.unknown());
/** The caller data of the anchor check, read once. `self` and `authenticatedHead` are parsed after this read. */
const AnchorInputSchema = z.object({
  tenantId: z.string(),
  entries: EntriesSchema,
  self: z.unknown(),
  approverSigningPublicJwk: P256PublicJwkSchema,
  authenticatedHead: z.unknown().optional(),
});

/** The state before the genesis entry of `tenantId`'s chain. */
export function emptyMemberChainState(tenantId: string): MemberChainState {
  return { tenantId, head: null, members: new Map(), removed: new Set(), scopes: new Map(), shredded: new Set() };
}

/** The latest policy's members that are still current: the members that get key packages for the scope. */
export function memberChainScopeRecipients(state: MemberChainState, scopeId: string): readonly MemberKeyBundleV1[] {
  const scope = state.scopes.get(scopeId);
  if (scope === undefined) return [];
  return scope.members.flatMap((memberId) => {
    const member = state.members.get(memberId);
    return member === undefined ? [] : [member];
  });
}

/** Apply `entries` in order after `state`. Never throws for hostile entries. */
export async function applyMemberChainEntries(state: MemberChainState, entries: readonly unknown[]): Promise<MemberChainWalkResult> {
  const list = safeParseTotal(EntriesSchema, entries);
  if (!list.success) return { ok: false, reason: 'member_chain_entry_invalid', index: 0 };
  const result = await walk(state, list.data, () => false);
  return result.ok ? { ok: true, state: result.state } : result;
}

/** The genesis signer: the subject of a self-signed `add`, only from the empty state (11a). */
async function genesisSigner(state: WalkState, raw: unknown, signer: string): Promise<MemberKeyBundleV1 | undefined> {
  if (state.head !== null || state.members.size > 0) return undefined;
  const entry = safeParseTotal(GenesisSchema, raw);
  const member = entry.success ? await parseMemberKeyBundle(entry.data.subject.member) : undefined;
  return member !== undefined && member.memberId === signer ? member : undefined;
}

interface WalkState {
  tenantId: string;
  head: MemberChainHead | null;
  members: Map<string, MemberKeyBundleV1>;
  removed: Set<string>;
  scopes: Map<string, MemberChainScope>;
  shredded: Set<string>;
}

/** The first entry that `mark` accepted: its index in the batch, its `seq` and its entry hash. */
interface MarkedEntry {
  readonly index: number;
  readonly seq: number;
  readonly hash: string;
}

type WalkOutcome =
  | { readonly ok: true; readonly state: MemberChainState; readonly marked: MarkedEntry | undefined }
  | { readonly ok: false; readonly reason: MemberChainWalkFailure; readonly index: number };

/**
 * The walk. `mark` sees each verified entry before it applies, with the
 * signer's key; the outcome reports the first index it marked.
 */
async function walk(
  state: MemberChainState,
  entries: readonly unknown[],
  mark: (entry: MemberChainEntryV1, signerKey: P256PublicJwk) => boolean,
): Promise<WalkOutcome> {
  const next: WalkState = {
    tenantId: state.tenantId,
    head: state.head,
    members: new Map(state.members),
    removed: new Set(state.removed),
    scopes: new Map(state.scopes),
    shredded: new Set(state.shredded),
  };
  let marked: MarkedEntry | undefined;
  for (const [index, raw] of entries.entries()) {
    const signer = safeParseTotal(SignerSchema, raw);
    if (!signer.success) return { ok: false, reason: 'member_chain_entry_invalid', index };
    const signerBundle = next.members.get(signer.data.signer) ?? (await genesisSigner(next, raw, signer.data.signer));
    if (signerBundle === undefined) return { ok: false, reason: 'member_chain_signer_invalid', index };
    const verified = await verifyMemberChainEntry(raw, signerBundle.signingPublicJwk);
    if (!verified.ok) return { ok: false, reason: verified.reason, index };
    const entry = verified.entry;
    const expected = next.head === null ? { seq: 1, prev: null } : { seq: next.head.seq + 1, prev: next.head.hash };
    if (entry.tenantId !== next.tenantId || entry.seq !== expected.seq || entry.prev !== expected.prev) {
      return { ok: false, reason: 'member_chain_link_invalid', index };
    }
    if (marked === undefined && mark(entry, signerBundle.signingPublicJwk)) marked = { index, seq: entry.seq, hash: verified.hash };
    const applied = await applySubject(next, entry);
    if (applied !== true) return { ok: false, reason: applied === false ? 'member_chain_subject_invalid' : applied, index };
    next.head = { seq: entry.seq, hash: verified.hash };
  }
  return { ok: true, state: next, marked };
}

/**
 * `true` when the entry applied, `false` when its subject breaks the op rule.
 * A scope change with a valid subject from a member outside the scope (§50f
 * A) is `member_chain_signer_invalid`; the subject rules are checked first.
 */
async function applySubject(state: WalkState, entry: MemberChainEntryV1): Promise<boolean | 'member_chain_signer_invalid'> {
  switch (entry.op) {
    case 'add': {
      const subject = safeParseTotal(AddSubjectSchema, entry.subject);
      const member = subject.success ? await parseMemberKeyBundle(subject.data.member) : undefined;
      if (member === undefined || state.members.has(member.memberId) || state.removed.has(member.memberId)) return false;
      state.members.set(member.memberId, member);
      return true;
    }
    case 'remove': {
      const subject = safeParseTotal(RemoveSubjectSchema, entry.subject);
      if (!subject.success || !state.members.has(subject.data.memberId) || state.members.size === 1) return false;
      state.members.delete(subject.data.memberId);
      state.removed.add(subject.data.memberId);
      return true;
    }
    case 'rotate': {
      const subject = safeParseTotal(RotateSubjectSchema, entry.subject);
      if (!subject.success || subject.data.memberId !== entry.signer) return false;
      const member = state.members.get(subject.data.memberId);
      if (member === undefined || subject.data.kemEpoch !== member.kemEpoch + 1) return false;
      // A rotation to the current key keeps the old private key valid for new packages.
      const { kemPublicJwk } = subject.data;
      if (kemPublicJwk.x === member.kemPublicJwk.x && kemPublicJwk.y === member.kemPublicJwk.y) return false;
      if (!(await verifyMemberKem(member, subject.data))) return false;
      state.members.set(member.memberId, {
        ...member,
        kemPublicJwk: subject.data.kemPublicJwk,
        kemEpoch: subject.data.kemEpoch,
        kemSig: subject.data.kemSig,
      });
      return true;
    }
    case 'scope-policy': {
      const subject = safeParseTotal(ScopePolicySubjectSchema, entry.subject);
      if (!subject.success || state.shredded.has(subject.data.scopeId)) return false;
      const { categories, members } = subject.data;
      if (!strictlyIncreasing(categories.map((category) => SEALED_CATEGORIES.indexOf(category)))) return false;
      if (!strictlyIncreasing(members) || !members.every((memberId) => state.members.has(memberId))) return false;
      // An existing scope's current policy names who may change it; a new scope's own list names who may create it.
      if (!(state.scopes.get(subject.data.scopeId)?.members ?? members).includes(entry.signer)) return 'member_chain_signer_invalid';
      state.scopes.set(subject.data.scopeId, { categories, members, policySeq: entry.seq });
      return true;
    }
    case 'shred': {
      const subject = safeParseTotal(ShredSubjectSchema, entry.subject);
      if (!subject.success) return false;
      const scope = state.scopes.get(subject.data.scopeId);
      if (scope === undefined) return false;
      if (!scope.members.includes(entry.signer)) return 'member_chain_signer_invalid';
      state.scopes.delete(subject.data.scopeId);
      state.shredded.add(subject.data.scopeId);
      return true;
    }
  }
}

/** Sorted with no repeats. Member ids are ASCII, so `<` is code-point order. */
function strictlyIncreasing<T extends number | string>(values: readonly T[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export type MemberChainAnchorFailure = MemberChainWalkFailure | 'member_chain_anchor_missing' | 'member_chain_head_mismatch';

export type MemberChainAnchorResult =
  | {
    readonly ok: true;
    readonly state: MemberChainState;
    /** `seq` of the anchor entry: the `add` of this member, signed by the pinned approver. */
    readonly anchorSeq: number;
  }
  | { readonly ok: false; readonly reason: MemberChainAnchorFailure; readonly index?: number };

export interface VerifyMemberChainFromAnchorInput {
  readonly tenantId: string;
  /** The whole chain, from the genesis entry (seq 1). */
  readonly entries: readonly unknown[];
  /** This member's own bundle, exactly as it was approved. */
  readonly self: MemberKeyBundleV1;
  /** The approver's signing key, pinned out of band: by the pv MAC or by the two-way fingerprint (10a). */
  readonly approverSigningPublicJwk: P256PublicJwk;
  /**
   * A chain head the approver authenticated out of band, for example the
   * head in the client pairing MAC. When given, it must be the anchor entry.
   */
  readonly authenticatedHead?: MemberChainHead;
}

/**
 * Verify a chain as a member that joined after the genesis entry (11b):
 *
 * 1. The member pins the approver's signing key K out of band.
 * 2. Entry E is an `add` whose `member` is byte-identical to `self` (KEM key
 *    included) and whose signer is `memberId(K)`, verified with K.
 * 3. The walk from genesis reaches E, so E is on the chain path.
 * 4. The entries after E verify forward by signature.
 *
 * The first E counts; `self` can be added only once. Never throws for
 * hostile entries.
 */
export async function verifyMemberChainFromAnchor(input: VerifyMemberChainFromAnchorInput): Promise<MemberChainAnchorResult> {
  const parsed = safeParseTotal(AnchorInputSchema, input);
  if (!parsed.success) return { ok: false, reason: 'member_chain_anchor_missing' };
  const { tenantId, entries, self, approverSigningPublicJwk: approver, authenticatedHead } = parsed.data;
  let approverId: string;
  let selfText: string;
  try {
    approverId = await deriveMemberId(approver);
    selfText = canonicalizeJson(self as JsonObject);
  } catch {
    return { ok: false, reason: 'member_chain_anchor_missing' };
  }
  // The walk verified each entry with `signerKey`, so an entry that matches here verifies with the approver's key.
  const isAnchor = (entry: MemberChainEntryV1, signerKey: P256PublicJwk): boolean => {
    if (entry.op !== 'add' || entry.signer !== approverId || signerKey.x !== approver.x || signerKey.y !== approver.y) return false;
    try {
      return canonicalizeJson((entry.subject as { member?: unknown }).member as JsonObject) === selfText;
    } catch {
      return false;
    }
  };
  const outcome = await walk(emptyMemberChainState(tenantId), entries, isAnchor);
  if (!outcome.ok) return outcome;
  const anchor = outcome.marked;
  if (anchor === undefined) return { ok: false, reason: 'member_chain_anchor_missing' };
  if (authenticatedHead !== undefined) {
    const head = safeParseTotal(HeadSchema, authenticatedHead);
    if (!head.success || head.data.seq !== anchor.seq || head.data.hash !== anchor.hash) {
      return { ok: false, reason: 'member_chain_head_mismatch', index: anchor.index };
    }
  }
  return { ok: true, state: outcome.state, anchorSeq: anchor.seq };
}
