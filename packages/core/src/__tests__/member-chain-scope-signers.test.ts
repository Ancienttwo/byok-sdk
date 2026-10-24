/**
 * Scope signers (#654 E2b, owner batch §50f A): only a member in a scope's
 * current policy may sign its `scope-policy` or `shred`, and the first
 * `scope-policy` of a new scope must be signed by a member it lists.
 */
import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../attestation';
import { createMemberKeyBundle, type MemberKeyBundleV1 } from '../sealed-payload/member-bundle';
import { memberChainEntryHash, signMemberChainEntry, type MemberChainEntryV1, type MemberChainOp } from '../sealed-payload/member-chain';
import { applyMemberChainEntries, emptyMemberChainState, type MemberChainState } from '../sealed-payload/member-chain-walk';
import type { P256PublicJwk } from '../sealed-payload/primitives';
import type { WebCryptoKey } from '../webcrypto';

const TENANT = 'tenant-1';

interface Member {
  readonly bundle: MemberKeyBundleV1;
  readonly signingPrivateKey: WebCryptoKey;
}

async function p256Pair(use: 'sign' | 'kem'): Promise<{ publicJwk: P256PublicJwk; privateKey: WebCryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: use === 'sign' ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' },
    true,
    use === 'sign' ? ['sign', 'verify'] : ['deriveBits'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, privateKey: pair.privateKey };
}

async function newMember(deviceId?: string): Promise<Member> {
  const signing = await p256Pair('sign');
  const bundle = await createMemberKeyBundle({
    signingPublicJwk: signing.publicJwk,
    signingPrivateKey: signing.privateKey,
    kemPublicJwk: (await p256Pair('kem')).publicJwk,
    kemEpoch: 1,
    ...(deviceId === undefined ? {} : { deviceId }),
  });
  return { bundle, signingPrivateKey: signing.privateKey };
}

function bundleJson(bundle: MemberKeyBundleV1): JsonObject {
  return JSON.parse(JSON.stringify(bundle)) as JsonObject;
}

/** Sign the entry that follows `state`'s head. */
async function next(state: MemberChainState, signer: Member, op: MemberChainOp, subject: JsonObject): Promise<MemberChainEntryV1> {
  return signMemberChainEntry(
    {
      v: 1,
      tenantId: TENANT,
      seq: (state.head?.seq ?? 0) + 1,
      prev: state.head?.hash ?? null,
      op,
      subject,
      signer: signer.bundle.memberId,
    },
    { publicJwk: signer.bundle.signingPublicJwk, privateKey: signer.signingPrivateKey },
  );
}

async function applied(state: MemberChainState, entry: MemberChainEntryV1): Promise<MemberChainState> {
  const result = await applyMemberChainEntries(state, [entry]);
  if (!result.ok) throw new Error(`entry ${entry.seq} (${entry.op}) was refused: ${result.reason}`);
  return result.state;
}

async function outcome(state: MemberChainState, signer: Member, op: MemberChainOp, subject: JsonObject) {
  const result = await applyMemberChainEntries(state, [await next(state, signer, op, subject)]);
  return result.ok ? 'ok' : result.reason;
}

const ids = (...members: Member[]) => members.map((member) => member.bundle.memberId).sort();
const policy = (scopeId: string, members: readonly string[]): JsonObject => ({ scopeId, categories: ['task-input'], members: [...members] });

/** A tenant with a client, two devices and a scope per device: `scope-a` for (client, a), `scope-b` for (client, b). */
async function tenant() {
  const client = await newMember();
  const deviceA = await newMember('device-a');
  const deviceB = await newMember('device-b');
  let state = await applied(emptyMemberChainState(TENANT), await next(emptyMemberChainState(TENANT), client, 'add', { member: bundleJson(client.bundle) }));
  for (const device of [deviceA, deviceB]) state = await applied(state, await next(state, client, 'add', { member: bundleJson(device.bundle) }));
  state = await applied(state, await next(state, deviceA, 'scope-policy', policy('scope-a', ids(client, deviceA))));
  state = await applied(state, await next(state, deviceB, 'scope-policy', policy('scope-b', ids(client, deviceB))));
  return { client, deviceA, deviceB, state };
}

describe('scope signers (§50f A)', () => {
  it('refuses a scope-policy or shred of an existing scope from a current member outside its policy', async () => {
    const { client, deviceA, deviceB, state } = await tenant();
    // deviceB cannot add itself to deviceA's scope, rewrite it, or shred it.
    expect(await outcome(state, deviceB, 'scope-policy', policy('scope-a', ids(client, deviceA, deviceB)))).toBe('member_chain_signer_invalid');
    expect(await outcome(state, deviceB, 'scope-policy', policy('scope-a', ids(deviceB)))).toBe('member_chain_signer_invalid');
    expect(await outcome(state, deviceB, 'shred', { scopeId: 'scope-a' })).toBe('member_chain_signer_invalid');
    const result = await applyMemberChainEntries(state, [await next(state, deviceB, 'shred', { scopeId: 'scope-a' })]);
    expect(result).toEqual({ ok: false, reason: 'member_chain_signer_invalid', index: 0 });
    expect(state.scopes.get('scope-a')?.members).toEqual(ids(client, deviceA));
  });

  it('accepts a scope-policy and a shred from a member in the current policy', async () => {
    const { client, deviceA, deviceB, state } = await tenant();
    expect(await outcome(state, client, 'scope-policy', policy('scope-a', ids(client, deviceA, deviceB)))).toBe('ok');
    expect(await outcome(state, deviceA, 'scope-policy', policy('scope-a', ids(deviceA)))).toBe('ok');
    expect(await outcome(state, client, 'shred', { scopeId: 'scope-a' })).toBe('ok');
    expect(await outcome(state, deviceA, 'shred', { scopeId: 'scope-a' })).toBe('ok');
  });

  it('checks the current policy, not an earlier one or the new list', async () => {
    const { client, deviceA, deviceB, state } = await tenant();
    const narrowed = await applied(state, await next(state, deviceA, 'scope-policy', policy('scope-a', ids(deviceA))));
    // The client was in the earlier policy and is in the proposed list, but not in the current policy.
    expect(await outcome(narrowed, client, 'scope-policy', policy('scope-a', ids(client, deviceA)))).toBe('member_chain_signer_invalid');
    expect(await outcome(narrowed, client, 'shred', { scopeId: 'scope-a' })).toBe('member_chain_signer_invalid');
    // A member of the current policy may hand the scope to others, leaving itself out.
    expect(await outcome(narrowed, deviceA, 'scope-policy', policy('scope-a', ids(client, deviceB)))).toBe('ok');
  });

  it('accepts the first scope-policy of a new scope only from a member it lists', async () => {
    const { client, deviceA, deviceB, state } = await tenant();
    expect(await outcome(state, deviceB, 'scope-policy', policy('scope-new', ids(client, deviceA)))).toBe('member_chain_signer_invalid');
    expect(await outcome(state, client, 'scope-policy', policy('scope-new', ids(deviceA)))).toBe('member_chain_signer_invalid');
    expect(await outcome(state, deviceA, 'scope-policy', policy('scope-new', ids(client, deviceA)))).toBe('ok');
    expect(await outcome(state, client, 'scope-policy', policy('scope-new', ids(client, deviceA)))).toBe('ok');
  });

  it('refuses a policy member that was removed from the tenant', async () => {
    const { client, deviceA, state } = await tenant();
    const removed = await applied(state, await next(state, client, 'remove', { memberId: deviceA.bundle.memberId }));
    // scope-a still lists deviceA, but deviceA is no longer a current member.
    expect(removed.scopes.get('scope-a')?.members).toContain(deviceA.bundle.memberId);
    expect(await outcome(removed, deviceA, 'shred', { scopeId: 'scope-a' })).toBe('member_chain_signer_invalid');
    expect(await outcome(removed, client, 'shred', { scopeId: 'scope-a' })).toBe('ok');
  });

  it('checks the subject rules first, so a bad subject from an outside signer is still a subject failure', async () => {
    const { client, deviceA, deviceB, state } = await tenant();
    expect(await outcome(state, deviceB, 'scope-policy', policy('scope-a', [...ids(client, deviceA)].reverse()))).toBe('member_chain_subject_invalid');
    expect(await outcome(state, deviceB, 'shred', { scopeId: 'scope-none' })).toBe('member_chain_subject_invalid');
    const shredded = await applied(state, await next(state, deviceA, 'shred', { scopeId: 'scope-a' }));
    expect(await outcome(shredded, deviceB, 'scope-policy', policy('scope-a', ids(deviceB)))).toBe('member_chain_subject_invalid');
  });
});
