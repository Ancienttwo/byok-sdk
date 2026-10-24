/**
 * The checker for `golden/member-rules-v1.json` (#654 E2b; owner decisions
 * 10a, 11a, 11b). The Node leg (`member-rules-vectors.test.ts`) and the Bun
 * leg (`member-rules-bun.test.ts`) run this same function, so both runtimes
 * must produce the same bytes.
 */
import type { JsonObject } from '../../attestation';
import { memberKemSigningInput, parseMemberKeyBundle, type MemberKeyBundleV1 } from '../../sealed-payload/member-bundle';
import { deriveMemberId, memberChainEntryHash, signMemberChainEntry, type MemberChainEntryV1 } from '../../sealed-payload/member-chain';
import {
  applyMemberChainEntries,
  emptyMemberChainState,
  verifyMemberChainFromAnchor,
  type MemberChainWalkFailure,
} from '../../sealed-payload/member-chain-walk';
import { memberApprovalCode, memberFingerprint } from '../../sealed-payload/member-fingerprint';
import {
  computeClientPairingMac,
  computeDevicePairingMac,
  verifyClientPairingMac,
  verifyDevicePairingMac,
} from '../../sealed-payload/pairing-verification';
import type { P256PublicJwk } from '../../sealed-payload/primitives';
import { fromHex, toHex, type VectorKeyPair } from './sealed-payload-vectors';

export interface MemberRulesVectorMember {
  readonly name: string;
  readonly memberId: string;
  readonly deviceId?: string;
  readonly signing: VectorKeyPair;
  readonly kem: VectorKeyPair;
  /** Hex of `memberKemSigningInput(memberId, kem, 1)`. Deterministic. */
  readonly kemStatement: string;
  /** The bundle. `kemSig` is random at generation, so it is verify-only. */
  readonly bundle: JsonObject;
}

export interface MemberRulesVectors {
  readonly note: string;
  readonly tenantId: string;
  readonly members: readonly MemberRulesVectorMember[];
  readonly fingerprints: readonly { readonly member: string; readonly tenantId: string; readonly fingerprint: string }[];
  readonly approvalCodes: readonly { readonly tenantId: string; readonly members: readonly [string, string]; readonly code: string }[];
  readonly pairing: {
    readonly pv: string;
    readonly device: string;
    readonly client: string;
    readonly chainHead: { readonly seq: number; readonly hash: string };
    readonly deviceMac: string;
    readonly clientMac: string;
  };
  readonly chain: {
    /** genesis(client), add(device) by client. Signatures are verify-only. */
    readonly entries: readonly MemberChainEntryV1[];
    /** `sha256:<hex>` of each unsigned entry. Deterministic given the entries. */
    readonly hashes: readonly string[];
    readonly anchor: { readonly self: string; readonly approver: string; readonly anchorSeq: number };
  };
  /** Scope signers (owner batch §50f A). Signatures are verify-only. */
  readonly scopeSigners: ScopeSignerVectors;
}

export interface ScopeSignerVectors {
  /** After `chain.entries`: add(stranger) by client, then scope-policy `scope-device` (client, device) by device. */
  readonly entries: readonly MemberChainEntryV1[];
  /** `sha256:<hex>` of each unsigned entry. */
  readonly hashes: readonly string[];
  /** Each case is one entry after `entries`, with the walk's outcome. */
  readonly cases: readonly {
    readonly name: string;
    readonly entry: MemberChainEntryV1;
    readonly hash: string;
    readonly outcome: 'ok' | MemberChainWalkFailure;
  }[];
}

export interface MemberRulesCheckCounts {
  readonly members: number;
  readonly fingerprints: number;
  readonly approvalCodes: number;
  readonly pairingMacs: number;
  readonly chainEntries: number;
}

export function vectorPublicJwk(pair: VectorKeyPair): P256PublicJwk {
  return { kty: 'EC', crv: 'P-256', x: pair.x, y: pair.y };
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected).slice(0, 200)}, got ${JSON.stringify(actual).slice(0, 200)}`);
  }
}

function findMember(vectors: MemberRulesVectors, name: string): MemberRulesVectorMember {
  const found = vectors.members.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no vector member ${name}`);
  return found;
}

async function parsedBundle(member: MemberRulesVectorMember): Promise<MemberKeyBundleV1> {
  const bundle = await parseMemberKeyBundle(member.bundle);
  if (bundle === undefined) throw new Error(`${member.name}: the vector bundle does not parse`);
  return bundle;
}

async function unsignedHash(entry: MemberChainEntryV1): Promise<string> {
  const { sig: _sig, ...unsigned } = entry;
  return memberChainEntryHash(unsigned);
}

/**
 * Build the scope signer vectors on top of `chain.entries`. Each case shares
 * one seq, so each is a separate one-entry continuation of the same chain.
 */
export async function buildScopeSignerVectors(vectors: Pick<MemberRulesVectors, 'tenantId' | 'members' | 'chain'>): Promise<ScopeSignerVectors> {
  const [client, device, stranger] = (['client', 'device', 'stranger'] as const).map((name) => {
    const found = vectors.members.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no vector member ${name}`);
    return found;
  }) as [MemberRulesVectorMember, MemberRulesVectorMember, MemberRulesVectorMember];
  const sign = async (signer: MemberRulesVectorMember, seq: number, prev: string, op: MemberChainEntryV1['op'], subject: JsonObject) =>
    signMemberChainEntry(
      { v: 1, tenantId: vectors.tenantId, seq, prev, op, subject, signer: signer.memberId },
      {
        publicJwk: vectorPublicJwk(signer.signing),
        privateKey: await crypto.subtle.importKey(
          'jwk',
          { kty: 'EC', crv: 'P-256', ...signer.signing },
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['sign'],
        ),
      },
    );
  const ids = (...members: MemberRulesVectorMember[]) => members.map((member) => member.memberId).sort();
  const policy = (scopeId: string, members: readonly string[]): JsonObject => ({ scopeId, categories: ['task-input'], members: [...members] });

  const addStranger = await sign(client, 3, vectors.chain.hashes[1]!, 'add', { member: stranger.bundle });
  const addHash = await unsignedHash(addStranger);
  const devicePolicy = await sign(device, 4, addHash, 'scope-policy', policy('scope-device', ids(client, device)));
  const policyHash = await unsignedHash(devicePolicy);

  const cases: ScopeSignerVectors['cases'][number][] = [];
  for (const [name, signer, op, subject, outcome] of [
    ['outsider-adds-itself', stranger, 'scope-policy', policy('scope-device', ids(client, device, stranger)), 'member_chain_signer_invalid'],
    ['outsider-shreds', stranger, 'shred', { scopeId: 'scope-device' }, 'member_chain_signer_invalid'],
    ['new-scope-unlisted-signer', device, 'scope-policy', policy('scope-stranger', ids(client, stranger)), 'member_chain_signer_invalid'],
    ['policy-member-updates', device, 'scope-policy', policy('scope-device', ids(client, device, stranger)), 'ok'],
    ['policy-member-shreds', client, 'shred', { scopeId: 'scope-device' }, 'ok'],
    ['new-scope-listed-signer', stranger, 'scope-policy', policy('scope-stranger', ids(client, stranger)), 'ok'],
  ] as const) {
    const entry = await sign(signer, 5, policyHash, op, subject);
    cases.push({ name, entry, hash: await unsignedHash(entry), outcome });
  }
  return { entries: [addStranger, devicePolicy], hashes: [addHash, policyHash], cases };
}

/** Walk the vector chain, then each scope signer case after it. Returns the number of cases. */
export async function checkScopeSignerVectors(vectors: MemberRulesVectors): Promise<number> {
  const { entries, hashes, cases } = vectors.scopeSigners;
  for (const [index, entry] of entries.entries()) expectEqual(`scope signer entry ${index} hash`, await unsignedHash(entry), hashes[index]);
  const prefix = await applyMemberChainEntries(emptyMemberChainState(vectors.tenantId), [...vectors.chain.entries, ...entries]);
  if (!prefix.ok) throw new Error(`scope signer prefix: ${prefix.reason} at ${prefix.index}`);
  for (const vector of cases) {
    expectEqual(`scope signer case ${vector.name} hash`, await unsignedHash(vector.entry), vector.hash);
    const result = await applyMemberChainEntries(prefix.state, [vector.entry]);
    expectEqual(`scope signer case ${vector.name}`, result.ok ? 'ok' : result.reason, vector.outcome);
  }
  return cases.length;
}

export async function checkMemberRulesVectors(vectors: MemberRulesVectors): Promise<MemberRulesCheckCounts> {
  for (const member of vectors.members) {
    const signing = vectorPublicJwk(member.signing);
    const kem = vectorPublicJwk(member.kem);
    expectEqual(`${member.name} memberId`, await deriveMemberId(signing), member.memberId);
    expectEqual(`${member.name} kemStatement`, toHex(memberKemSigningInput(member.memberId, kem, 1)), member.kemStatement);
    const bundle = await parsedBundle(member);
    expectEqual(`${member.name} bundle keys`, [bundle.memberId, bundle.signingPublicJwk, bundle.kemPublicJwk, bundle.deviceId], [
      member.memberId,
      signing,
      kem,
      member.deviceId,
    ]);
  }

  for (const vector of vectors.fingerprints) {
    const signingPublicJwk = vectorPublicJwk(findMember(vectors, vector.member).signing);
    expectEqual(`fingerprint ${vector.member} ${vector.tenantId}`, await memberFingerprint({ tenantId: vector.tenantId, signingPublicJwk }), vector.fingerprint);
  }

  for (const vector of vectors.approvalCodes) {
    const [first, second] = vector.members.map((name) => vectorPublicJwk(findMember(vectors, name).signing)) as [P256PublicJwk, P256PublicJwk];
    expectEqual(`approval code ${vector.members.join('+')}`, await memberApprovalCode(vector.tenantId, first, second), vector.code);
    expectEqual(`approval code ${vector.members.join('+')} reversed`, await memberApprovalCode(vector.tenantId, second, first), vector.code);
  }

  const pv = fromHex(vectors.pairing.pv);
  const device = await parsedBundle(findMember(vectors, vectors.pairing.device));
  const client = await parsedBundle(findMember(vectors, vectors.pairing.client));
  const deviceInput = { tenantId: vectors.tenantId, deviceId: device.deviceId!, member: device };
  const clientInput = { member: client, chainHead: vectors.pairing.chainHead };
  expectEqual('device pairing MAC', await computeDevicePairingMac(pv, deviceInput), vectors.pairing.deviceMac);
  expectEqual('client pairing MAC', await computeClientPairingMac(pv, clientInput), vectors.pairing.clientMac);
  expectEqual('device pairing MAC verify', await verifyDevicePairingMac(pv, deviceInput, vectors.pairing.deviceMac), true);
  expectEqual('client pairing MAC verify', await verifyClientPairingMac(pv, clientInput, vectors.pairing.clientMac), true);

  for (const [index, entry] of vectors.chain.entries.entries()) {
    const { sig: _sig, ...unsigned } = entry;
    expectEqual(`chain entry ${index} hash`, await memberChainEntryHash(unsigned), vectors.chain.hashes[index]);
  }
  const anchor = vectors.chain.anchor;
  const result = await verifyMemberChainFromAnchor({
    tenantId: vectors.tenantId,
    entries: vectors.chain.entries,
    self: await parsedBundle(findMember(vectors, anchor.self)),
    approverSigningPublicJwk: vectorPublicJwk(findMember(vectors, anchor.approver).signing),
    authenticatedHead: vectors.pairing.chainHead,
  });
  expectEqual('chain anchor', result.ok ? result.anchorSeq : result, anchor.anchorSeq);
  await checkScopeSignerVectors(vectors);

  return {
    members: vectors.members.length,
    fingerprints: vectors.fingerprints.length,
    approvalCodes: vectors.approvalCodes.length,
    pairingMacs: 2,
    chainEntries: vectors.chain.entries.length,
  };
}
