/**
 * The checker for `golden/member-rules-v1.json` (#654 E2b; owner decisions
 * 10a, 11a, 11b). The Node leg (`member-rules-vectors.test.ts`) and the Bun
 * leg (`member-rules-bun.test.ts`) run this same function, so both runtimes
 * must produce the same bytes.
 */
import type { JsonObject } from '../../attestation';
import { memberKemSigningInput, parseMemberKeyBundle, type MemberKeyBundleV1 } from '../../sealed-payload/member-bundle';
import { deriveMemberId, memberChainEntryHash, type MemberChainEntryV1 } from '../../sealed-payload/member-chain';
import { verifyMemberChainFromAnchor } from '../../sealed-payload/member-chain-walk';
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

  return {
    members: vectors.members.length,
    fingerprints: vectors.fingerprints.length,
    approvalCodes: vectors.approvalCodes.length,
    pairingMacs: 2,
    chainEntries: vectors.chain.entries.length,
  };
}
