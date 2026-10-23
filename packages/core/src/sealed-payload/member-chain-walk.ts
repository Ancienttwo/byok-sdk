/**
 * Member chain walk (#654 design §7.3, §7.4, §7.5, §11.2, E2b).
 *
 * `applyMemberChainEntries` checks entries forward from a state the caller
 * already trusts, and returns the new state. Each entry must:
 *
 * - be the next entry: same tenant, `seq = head.seq + 1`, `prev = head.hash`;
 * - be signed by a current member (an `add`ed member that is not removed);
 * - have the subject shape and the rule of its op (below).
 *
 * One bad entry rejects the whole batch. The caller's state does not change.
 *
 * How a member gets its first trusted state is not decided yet: what the
 * first entry of a chain is, and what a member that joins later pins. So this
 * module starts only from a state the caller supplies, and it has no genesis
 * rule. With an empty member set, no entry can apply.
 *
 * Precondition (D10, #655 D-I2): one tenant is one user. v1 has no per-user
 * permissions, so any current member may sign `add`, `remove`,
 * `scope-policy` and `shred`. A Host that maps two users to one tenant breaks
 * this: one user's client could change the other user's devices and scopes.
 *
 * Op rules:
 *
 * - `add` `{ member }`: a valid bundle (`parseMemberKeyBundle`) of a member
 *   that is not current and was never removed. A removed member id is final;
 *   a re-paired device is a new member (§7.5).
 * - `remove` `{ memberId }`: a current member.
 * - `rotate` `{ memberId, kemPublicJwk, kemEpoch }`: signed by that member
 *   itself; `kemEpoch` is its current KEM epoch + 1.
 * - `scope-policy` `{ scopeId, categories, members }`: categories in the
 *   order of `SEALED_CATEGORIES`, no repeats; members sorted, no repeats,
 *   each a current member (§7.4); the scope is not shredded.
 * - `shred` `{ scopeId }`: a scope with a policy that is not shredded. After
 *   it, no `scope-policy` for that scope is valid (§11.2).
 *
 * This module is internal: the subpath index does not export it.
 */
import { z } from 'zod';

import { KemEpochSchema, isValidMemberKemKey, parseMemberKeyBundle, type MemberKeyBundleV1 } from './member-bundle';
import { MEMBER_ID_PATTERN, verifyMemberChainEntry, type MemberChainEntryV1 } from './member-chain';
import { P256PublicJwkSchema } from './primitives';
import { SEALED_CATEGORIES, type SealedCategory } from './sealed-content';

export interface MemberChainScope {
  readonly categories: readonly SealedCategory[];
  /** Member ids from the latest `scope-policy` entry, sorted. Some may be removed since. */
  readonly members: readonly string[];
  /** `seq` of that entry. */
  readonly policySeq: number;
}

export interface MemberChainState {
  readonly tenantId: string;
  readonly head: { readonly seq: number; readonly hash: string };
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
const RotateSubjectSchema = z.strictObject({ memberId: MemberIdSchema, kemPublicJwk: P256PublicJwkSchema, kemEpoch: KemEpochSchema });
const ScopePolicySubjectSchema = z.strictObject({
  scopeId: ScopeIdSchema,
  categories: z.array(z.enum(SEALED_CATEGORIES)).min(1),
  members: z.array(MemberIdSchema).min(1),
});
const ShredSubjectSchema = z.strictObject({ scopeId: ScopeIdSchema });
const SignerSchema = z.object({ signer: MemberIdSchema });

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
  const next = {
    tenantId: state.tenantId,
    head: state.head,
    members: new Map(state.members),
    removed: new Set(state.removed),
    scopes: new Map(state.scopes),
    shredded: new Set(state.shredded),
  };
  for (const [index, raw] of entries.entries()) {
    const signer = SignerSchema.safeParse(raw);
    if (!signer.success) return { ok: false, reason: 'member_chain_entry_invalid', index };
    const signerBundle = next.members.get(signer.data.signer);
    if (signerBundle === undefined) return { ok: false, reason: 'member_chain_signer_invalid', index };
    const verified = await verifyMemberChainEntry(raw, signerBundle.signingPublicJwk);
    if (!verified.ok) return { ok: false, reason: verified.reason, index };
    const entry = verified.entry;
    if (entry.tenantId !== next.tenantId || entry.seq !== next.head.seq + 1 || entry.prev !== next.head.hash) {
      return { ok: false, reason: 'member_chain_link_invalid', index };
    }
    if (!(await applySubject(next, entry))) return { ok: false, reason: 'member_chain_subject_invalid', index };
    next.head = { seq: entry.seq, hash: verified.hash };
  }
  return { ok: true, state: next };
}

interface MutableState {
  members: Map<string, MemberKeyBundleV1>;
  removed: Set<string>;
  scopes: Map<string, MemberChainScope>;
  shredded: Set<string>;
}

async function applySubject(state: MutableState, entry: MemberChainEntryV1): Promise<boolean> {
  switch (entry.op) {
    case 'add': {
      const subject = AddSubjectSchema.safeParse(entry.subject);
      const member = subject.success ? await parseMemberKeyBundle(subject.data.member) : undefined;
      if (member === undefined || state.members.has(member.memberId) || state.removed.has(member.memberId)) return false;
      state.members.set(member.memberId, member);
      return true;
    }
    case 'remove': {
      const subject = RemoveSubjectSchema.safeParse(entry.subject);
      if (!subject.success || !state.members.has(subject.data.memberId)) return false;
      state.members.delete(subject.data.memberId);
      state.removed.add(subject.data.memberId);
      return true;
    }
    case 'rotate': {
      const subject = RotateSubjectSchema.safeParse(entry.subject);
      if (!subject.success || subject.data.memberId !== entry.signer) return false;
      const member = state.members.get(subject.data.memberId);
      if (member === undefined || subject.data.kemEpoch !== member.kemEpoch + 1) return false;
      if (!(await isValidMemberKemKey(subject.data.kemPublicJwk, member.signingPublicJwk))) return false;
      state.members.set(member.memberId, { ...member, kemPublicJwk: subject.data.kemPublicJwk, kemEpoch: subject.data.kemEpoch });
      return true;
    }
    case 'scope-policy': {
      const subject = ScopePolicySubjectSchema.safeParse(entry.subject);
      if (!subject.success || state.shredded.has(subject.data.scopeId)) return false;
      const { categories, members } = subject.data;
      if (!strictlyIncreasing(categories.map((category) => SEALED_CATEGORIES.indexOf(category)))) return false;
      if (!strictlyIncreasing(members) || !members.every((memberId) => state.members.has(memberId))) return false;
      state.scopes.set(subject.data.scopeId, { categories, members, policySeq: entry.seq });
      return true;
    }
    case 'shred': {
      const subject = ShredSubjectSchema.safeParse(entry.subject);
      if (!subject.success || !state.scopes.has(subject.data.scopeId)) return false;
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
