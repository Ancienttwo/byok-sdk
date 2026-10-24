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
  /** A shredded scope (design §11.2). Signatures are verify-only. */
  readonly shred: ShredVectors;
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

export interface ShredVectors {
  /**
   * After `scopeSigners.entries`: the `policy-member-shreds` case entry (the
   * client shreds `scope-device`), then scope-policy `scope-client` (client)
   * by client.
   */
  readonly entries: readonly MemberChainEntryV1[];
  /** `sha256:<hex>` of each unsigned entry. */
  readonly hashes: readonly string[];
  /** Each case is one entry after `entries`, with the walk's outcome. */
  readonly cases: ScopeSignerVectors['cases'];
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

function findMember(vectors: Pick<MemberRulesVectors, 'members'>, name: string): MemberRulesVectorMember {
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

type VectorSigner = (signer: MemberRulesVectorMember, seq: number, prev: string, op: MemberChainEntryV1['op'], subject: JsonObject) => Promise<MemberChainEntryV1>;

function vectorSigner(tenantId: string): VectorSigner {
  return async (signer, seq, prev, op, subject) =>
    signMemberChainEntry(
      { v: 1, tenantId, seq, prev, op, subject, signer: signer.memberId },
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
}

function vectorMembers(vectors: Pick<MemberRulesVectors, 'members'>): [MemberRulesVectorMember, MemberRulesVectorMember, MemberRulesVectorMember] {
  return (['client', 'device', 'stranger'] as const).map((name) => findMember(vectors, name)) as [
    MemberRulesVectorMember,
    MemberRulesVectorMember,
    MemberRulesVectorMember,
  ];
}

const ids = (...members: MemberRulesVectorMember[]) => members.map((member) => member.memberId).sort();
const policy = (scopeId: string, members: readonly string[]): JsonObject => ({ scopeId, categories: ['task-input'], members: [...members] });

/**
 * Build the scope signer vectors on top of `chain.entries`. Each case shares
 * one seq, so each is a separate one-entry continuation of the same chain.
 */
export async function buildScopeSignerVectors(vectors: Pick<MemberRulesVectors, 'tenantId' | 'members' | 'chain'>): Promise<ScopeSignerVectors> {
  const [client, device, stranger] = vectorMembers(vectors);
  const sign = vectorSigner(vectors.tenantId);

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

/**
 * Build the shred vectors on top of `scopeSigners.entries`. The shred is the
 * `policy-member-shreds` case entry as pinned, so the golden holds one
 * signature for it. Each case shares one seq after `entries`.
 */
export async function buildShredVectors(vectors: Pick<MemberRulesVectors, 'tenantId' | 'members' | 'scopeSigners'>): Promise<ShredVectors> {
  const [client, device] = vectorMembers(vectors);
  const sign = vectorSigner(vectors.tenantId);
  const shred = shredCase(vectors);
  const clientPolicy = await sign(client, 6, shred.hash, 'scope-policy', policy('scope-client', ids(client)));
  const clientPolicyHash = await unsignedHash(clientPolicy);

  const cases: ShredVectors['cases'][number][] = [];
  for (const [name, signer, op, subject, outcome] of [
    ['policy-after-shred', device, 'scope-policy', policy('scope-device', ids(client, device)), 'member_chain_subject_invalid'],
    ['shred-again', client, 'shred', { scopeId: 'scope-device' }, 'member_chain_subject_invalid'],
    ['shred-unknown-scope', client, 'shred', { scopeId: 'scope-unknown' }, 'member_chain_subject_invalid'],
    ['shred-extra-key', client, 'shred', { scopeId: 'scope-client', reason: 'cleanup' }, 'member_chain_subject_invalid'],
    ['shred-other-scope', client, 'shred', { scopeId: 'scope-client' }, 'ok'],
  ] as const) {
    const entry = await sign(signer, 7, clientPolicyHash, op, subject);
    cases.push({ name, entry, hash: await unsignedHash(entry), outcome });
  }
  return { entries: [shred.entry, clientPolicy], hashes: [shred.hash, clientPolicyHash], cases };
}

function shredCase(vectors: Pick<MemberRulesVectors, 'scopeSigners'>): ScopeSignerVectors['cases'][number] {
  const found = vectors.scopeSigners.cases.find((vector) => vector.name === 'policy-member-shreds');
  if (found === undefined) throw new Error('no scope signer case policy-member-shreds');
  return found;
}

/** Walk the scope signer prefix, the shred entries, then each shred case after them. Returns the number of cases. */
export async function checkShredVectors(vectors: MemberRulesVectors): Promise<number> {
  const { entries, hashes, cases } = vectors.shred;
  expectEqual('shred entry 0', entries[0], shredCase(vectors).entry);
  for (const [index, entry] of entries.entries()) expectEqual(`shred entry ${index} hash`, await unsignedHash(entry), hashes[index]);
  const prefix = await applyMemberChainEntries(emptyMemberChainState(vectors.tenantId), [
    ...vectors.chain.entries,
    ...vectors.scopeSigners.entries,
    ...entries,
  ]);
  if (!prefix.ok) throw new Error(`shred prefix: ${prefix.reason} at ${prefix.index}`);
  expectEqual('shred prefix scopes', [[...prefix.state.scopes.keys()], [...prefix.state.shredded]], [['scope-client'], ['scope-device']]);
  for (const vector of cases) {
    expectEqual(`shred case ${vector.name} hash`, await unsignedHash(vector.entry), vector.hash);
    const result = await applyMemberChainEntries(prefix.state, [vector.entry]);
    expectEqual(`shred case ${vector.name}`, result.ok ? 'ok' : result.reason, vector.outcome);
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
  await checkShredVectors(vectors);

  return {
    members: vectors.members.length,
    fingerprints: vectors.fingerprints.length,
    approvalCodes: vectors.approvalCodes.length,
    pairingMacs: 2,
    chainEntries: vectors.chain.entries.length,
  };
}
