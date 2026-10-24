/**
 * Member rule vectors (#654 E2b; owner decisions 10a, 11a, 11b), Node leg.
 *
 * `golden/member-rules-v1.json` pins the member fingerprint, the two-way
 * approval code, the KEM statement, the pairing MACs and the chain entry
 * hashes. Two checks run against it:
 *
 * 1. `support/member-rules-vectors.ts` runs every vector through the core
 *    modules. The Bun leg (`member-rules-bun.test.ts`) runs the same checker.
 * 2. An oracle in this file rebuilds the bytes with `node:crypto` and its own
 *    canonical JSON. The oracle code paths call nothing from `sealed-payload/`
 *    (the generator and the property tests in this file do), so they are
 *    evidence that the golden bytes follow the decided format, not only that
 *    the code agrees with itself.
 *
 * The browser engines (Chromium, WebKit, Gecko) run these vectors once the
 * browser matrix (E1c) exists.
 *
 * Regenerate with `BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core
 * test`. Any diff in a deterministic field is a breaking change. `kemSig` and
 * chain signatures are random at generation, so they are verify-only.
 */
import { createECDH, createHash, createHmac, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../attestation';
import { createMemberKeyBundle, memberKemSigningInput } from '../sealed-payload/member-bundle';
import { deriveMemberId, memberChainEntryHash, signMemberChainEntry } from '../sealed-payload/member-chain';
import { memberApprovalCode, memberFingerprint } from '../sealed-payload/member-fingerprint';
import { computeClientPairingMac, computeDevicePairingMac } from '../sealed-payload/pairing-verification';
import {
  buildScopeSignerVectors,
  buildShredVectors,
  checkMemberRulesVectors,
  checkScopeSignerVectors,
  checkShredVectors,
  vectorPublicJwk,
  type MemberRulesVectorMember,
  type MemberRulesVectors,
} from './support/member-rules-vectors';
import { toHex, type VectorKeyPair } from './support/sealed-payload-vectors';

const GOLDEN_URL = new URL('./golden/member-rules-v1.json', import.meta.url);
const TENANT = 'tenant-vector-1';

function labelBytes(label: string): Buffer {
  return createHash('sha256').update(`byok-e2b-vector:${label}`).digest();
}

function keyPair(label: string): VectorKeyPair {
  const ecdh = createECDH('prime256v1');
  const d = labelBytes(label);
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return { d: d.toString('base64url'), x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') };
}

async function signingKey(pair: VectorKeyPair) {
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', ...pair }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildVectors(): Promise<MemberRulesVectors> {
  const members: MemberRulesVectorMember[] = [];
  for (const [name, deviceId] of [['client', undefined], ['device', 'device-vector-1'], ['stranger', undefined]] as const) {
    const signing = keyPair(`${name}-signing`);
    const kem = keyPair(`${name}-kem`);
    const bundle = await createMemberKeyBundle({
      signingPublicJwk: vectorPublicJwk(signing),
      signingPrivateKey: await signingKey(signing),
      kemPublicJwk: vectorPublicJwk(kem),
      kemEpoch: 1,
      ...(deviceId === undefined ? {} : { deviceId }),
    });
    members.push({
      name,
      memberId: bundle.memberId,
      ...(deviceId === undefined ? {} : { deviceId }),
      signing,
      kem,
      kemStatement: toHex(memberKemSigningInput(bundle.memberId, vectorPublicJwk(kem), 1)),
      bundle: JSON.parse(JSON.stringify(bundle)) as JsonObject,
    });
  }
  const [client, device] = members as [MemberRulesVectorMember, MemberRulesVectorMember];

  const fingerprints = [];
  for (const [member, tenantId] of [[client, TENANT], [device, TENANT], [client, 'tenant-vector-2']] as const) {
    fingerprints.push({ member: member.name, tenantId, fingerprint: await memberFingerprint({ tenantId, signingPublicJwk: vectorPublicJwk(member.signing) }) });
  }
  const approvalCodes = [];
  for (const pair of [['client', 'device'], ['device', 'stranger']] as const) {
    const [a, b] = pair.map((name) => members.find((member) => member.name === name)!);
    approvalCodes.push({ tenantId: TENANT, members: pair, code: await memberApprovalCode(TENANT, vectorPublicJwk(a!.signing), vectorPublicJwk(b!.signing)) });
  }

  const sign = async (signer: MemberRulesVectorMember, seq: number, prev: string | null, subject: JsonObject) =>
    signMemberChainEntry(
      { v: 1, tenantId: TENANT, seq, prev, op: 'add', subject, signer: signer.memberId },
      { publicJwk: vectorPublicJwk(signer.signing), privateKey: await signingKey(signer.signing) },
    );
  const genesis = await sign(client, 1, null, { member: client.bundle });
  const { sig: _g, ...genesisUnsigned } = genesis;
  const genesisHash = await memberChainEntryHash(genesisUnsigned);
  const addDevice = await sign(client, 2, genesisHash, { member: device.bundle });
  const { sig: _a, ...addUnsigned } = addDevice;
  const addHash = await memberChainEntryHash(addUnsigned);

  const pv = labelBytes('pv').subarray(0, 16);
  const chainHead = { seq: 2, hash: addHash };
  const deviceBundle = device.bundle as unknown as Parameters<typeof computeDevicePairingMac>[1]['member'];
  const clientBundle = client.bundle as unknown as Parameters<typeof computeClientPairingMac>[1]['member'];
  const vectors = {
    note: 'Member rule vectors (#654 E2b; decisions 10a, 11a, 11b). Regenerate with BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core test. A diff in a deterministic field is a breaking change. kemSig and chain signatures are random at generation, so they are verify-only. All keys derive from public labels and are test values only.',
    tenantId: TENANT,
    members,
    fingerprints,
    approvalCodes,
    pairing: {
      pv: pv.toString('hex'),
      device: 'device',
      client: 'client',
      chainHead,
      deviceMac: await computeDevicePairingMac(pv, { tenantId: TENANT, deviceId: 'device-vector-1', member: deviceBundle }),
      clientMac: await computeClientPairingMac(pv, { member: clientBundle, chainHead }),
    },
    chain: { entries: [genesis, addDevice], hashes: [genesisHash, addHash], anchor: { self: 'device', approver: 'client', anchorSeq: 2 } },
  };
  const withSigners = { ...vectors, scopeSigners: await buildScopeSignerVectors(vectors) };
  return { ...withSigners, shred: await buildShredVectors(withSigners) };
}

if (process.env['BYOK_CORE_UPDATE_GOLDEN'] === '1' || !existsSync(GOLDEN_URL)) {
  if (process.env['BYOK_CORE_UPDATE_GOLDEN'] !== '1') throw new Error('golden/member-rules-v1.json is missing');
  writeFileSync(GOLDEN_URL, `${JSON.stringify(await buildVectors(), null, 2)}\n`, 'utf8');
}

const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as MemberRulesVectors;

// ---------------------------------------------------------------------------
// Independent oracle: node:crypto and its own canonical JSON
// ---------------------------------------------------------------------------

function compareCodeUnits(left: string, right: string): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Canonical JSON for the value kinds these vectors use: objects, arrays, strings, safe integers and null. */
function oracleCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('the oracle handles safe integers only');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(oracleCanonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
  entries.sort(([a], [b]) => compareCodeUnits(a, b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${oracleCanonical(item)}`).join(',')}}`;
}

function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

function oracleMemberId(pair: VectorKeyPair): string {
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pair.x, 'base64url'), Buffer.from(pair.y, 'base64url')]);
  return sha256(Buffer.concat([Buffer.from('byok-member-id-v1\n'), point])).toString('base64url');
}

function oracleFingerprintGroups(tenantId: string, pair: VectorKeyPair): string[] {
  const digest = sha256(`byok-member-fingerprint-v1\n${oracleCanonical({ v: 1, tenantId, signingKey: { x: pair.x, y: pair.y } })}`);
  return [0, 1, 2, 3, 4].map((group) =>
    (BigInt(`0x${digest.subarray(group * 5, group * 5 + 5).toString('hex')}`) % 100000n).toString().padStart(5, '0'));
}

function member(name: string): MemberRulesVectors['members'][number] {
  return golden.members.find((candidate) => candidate.name === name)!;
}

describe('member rule vectors', () => {
  it('pass the shared checker', async () => {
    await expect(checkMemberRulesVectors(golden)).resolves.toEqual({
      members: 3,
      fingerprints: 3,
      approvalCodes: 2,
      pairingMacs: 2,
      chainEntries: 2,
    });
  });

  it('match the oracle for member ids, fingerprints and approval codes', () => {
    for (const vector of golden.members) expect(oracleMemberId(vector.signing)).toBe(vector.memberId);
    for (const vector of golden.fingerprints) {
      expect(vector.fingerprint).toMatch(/^\d{5}( \d{5}){4}$/u);
      expect(oracleFingerprintGroups(vector.tenantId, member(vector.member).signing).join(' ')).toBe(vector.fingerprint);
    }
    for (const vector of golden.approvalCodes) {
      expect(vector.code).toMatch(/^\d{5}( \d{5}){9}$/u);
      const ordered = vector.members.map(member).sort((a, b) => compareCodeUnits(oracleMemberId(a.signing), oracleMemberId(b.signing)));
      expect(ordered.flatMap((item) => oracleFingerprintGroups(vector.tenantId, item.signing)).join(' ')).toBe(vector.code);
    }
  });

  it('match the oracle for the KEM statement and kemSig', () => {
    for (const vector of golden.members) {
      const statement = `byok-member-kem-v1\n${oracleCanonical({ memberId: vector.memberId, kemPublicKey: { x: vector.kem.x, y: vector.kem.y }, kemEpoch: 1 })}`;
      expect(Buffer.from(statement).toString('hex')).toBe(vector.kemStatement);
      const key = { key: { kty: 'EC', crv: 'P-256', x: vector.signing.x, y: vector.signing.y }, format: 'jwk', dsaEncoding: 'ieee-p1363' } as const;
      expect(verify('sha256', Buffer.from(statement), key, Buffer.from(vector.bundle['kemSig'] as string, 'base64url'))).toBe(true);
    }
  });

  it('match the oracle for the pairing MACs and the chain entry hashes', () => {
    const pv = Buffer.from(golden.pairing.pv, 'hex');
    const device = member(golden.pairing.device);
    const client = member(golden.pairing.client);
    const deviceText = `byok-pairing-device-mac-v1\n${oracleCanonical({ tenantId: golden.tenantId, deviceId: device.deviceId, member: device.bundle })}`;
    const clientText = `byok-pairing-client-mac-v1\n${oracleCanonical({ member: client.bundle, chainHead: golden.pairing.chainHead })}`;
    expect(createHmac('sha256', pv).update(deviceText).digest('base64url')).toBe(golden.pairing.deviceMac);
    expect(createHmac('sha256', pv).update(clientText).digest('base64url')).toBe(golden.pairing.clientMac);

    for (const [index, entry] of golden.chain.entries.entries()) {
      const { sig: _sig, ...unsigned } = entry;
      expect(`sha256:${sha256(`byok-member-chain-v1\n${oracleCanonical(unsigned)}`).toString('hex')}`).toBe(golden.chain.hashes[index]);
    }
    expect(golden.pairing.chainHead).toEqual({ seq: 2, hash: golden.chain.hashes[1] });
  });

  it('pin the scope signer rule (§50f A), with hashes and signatures checked by the oracle', async () => {
    await expect(checkScopeSignerVectors(golden)).resolves.toBe(6);
    expect(golden.scopeSigners.cases.map((vector) => [vector.name, vector.outcome])).toEqual([
      ['outsider-adds-itself', 'member_chain_signer_invalid'],
      ['outsider-shreds', 'member_chain_signer_invalid'],
      ['new-scope-unlisted-signer', 'member_chain_signer_invalid'],
      ['policy-member-updates', 'ok'],
      ['policy-member-shreds', 'ok'],
      ['new-scope-listed-signer', 'ok'],
    ]);
    const signed = [
      ...golden.scopeSigners.entries.map((entry, index) => ({ entry, hash: golden.scopeSigners.hashes[index] })),
      ...golden.scopeSigners.cases.map(({ entry, hash }) => ({ entry, hash })),
    ];
    let prev = golden.chain.hashes[1];
    for (const [index, { entry, hash }] of signed.entries()) {
      const { sig, ...unsigned } = entry;
      const text = `byok-member-chain-v1\n${oracleCanonical(unsigned)}`;
      expect(`sha256:${sha256(text).toString('hex')}`).toBe(hash);
      expect(unsigned.prev).toBe(prev);
      const signer = golden.members.find((candidate) => candidate.memberId === unsigned.signer)!;
      const key = { key: { kty: 'EC', crv: 'P-256', x: signer.signing.x, y: signer.signing.y }, format: 'jwk', dsaEncoding: 'ieee-p1363' } as const;
      expect(verify('sha256', Buffer.from(text), key, Buffer.from(sig, 'base64url'))).toBe(true);
      // The two prefix entries chain on; every case continues from the second.
      if (index < golden.scopeSigners.entries.length) prev = hash!;
    }
  });

  it('pin a shredded scope (§11.2), with hashes and signatures checked by the oracle', async () => {
    await expect(checkShredVectors(golden)).resolves.toBe(5);
    expect(golden.shred.cases.map((vector) => [vector.name, vector.outcome])).toEqual([
      ['policy-after-shred', 'member_chain_subject_invalid'],
      ['shred-again', 'member_chain_subject_invalid'],
      ['shred-unknown-scope', 'member_chain_subject_invalid'],
      ['shred-extra-key', 'member_chain_subject_invalid'],
      ['shred-other-scope', 'ok'],
    ]);
    // The shred itself is the pinned scope signer case, not a second signature over the same bytes.
    expect(golden.shred.entries[0]).toEqual(golden.scopeSigners.cases.find((vector) => vector.name === 'policy-member-shreds')!.entry);
    const signed = [
      ...golden.shred.entries.map((entry, index) => ({ entry, hash: golden.shred.hashes[index] })),
      ...golden.shred.cases.map(({ entry, hash }) => ({ entry, hash })),
    ];
    let prev = golden.scopeSigners.hashes[1];
    for (const [index, { entry, hash }] of signed.entries()) {
      const { sig, ...unsigned } = entry;
      const text = `byok-member-chain-v1\n${oracleCanonical(unsigned)}`;
      expect(`sha256:${sha256(text).toString('hex')}`).toBe(hash);
      expect(unsigned.prev).toBe(prev);
      const signer = golden.members.find((candidate) => candidate.memberId === unsigned.signer)!;
      const key = { key: { kty: 'EC', crv: 'P-256', x: signer.signing.x, y: signer.signing.y }, format: 'jwk', dsaEncoding: 'ieee-p1363' } as const;
      expect(verify('sha256', Buffer.from(text), key, Buffer.from(sig, 'base64url'))).toBe(true);
      // The two shred entries chain on; every case continues from the second.
      if (index < golden.shred.entries.length) prev = hash!;
    }
  });
});

describe('member fingerprint properties', () => {
  const client = vectorPublicJwk(keyPair('client-signing'));
  const device = vectorPublicJwk(keyPair('device-signing'));

  it('depends on the tenant and the signing key only', async () => {
    const base = await memberFingerprint({ tenantId: TENANT, signingPublicJwk: client });
    await expect(memberFingerprint({ tenantId: TENANT, signingPublicJwk: { ...client } })).resolves.toBe(base);
    await expect(memberFingerprint({ tenantId: 'tenant-vector-2', signingPublicJwk: client })).resolves.not.toBe(base);
    await expect(memberFingerprint({ tenantId: TENANT, signingPublicJwk: device })).resolves.not.toBe(base);
  });

  it('builds one approval code for both sides, from fingerprints ordered by member id', async () => {
    const code = await memberApprovalCode(TENANT, client, device);
    await expect(memberApprovalCode(TENANT, device, client)).resolves.toBe(code);
    const byId = [client, device].map(async (key) => ({ id: await deriveMemberId(key), fingerprint: await memberFingerprint({ tenantId: TENANT, signingPublicJwk: key }) }));
    const ordered = (await Promise.all(byId)).sort((a, b) => compareCodeUnits(a.id, b.id));
    expect(code).toBe(ordered.map((item) => item.fingerprint).join(' '));
  });

  it('refuses one member twice, an empty tenant and a key off the curve', async () => {
    await expect(memberApprovalCode(TENANT, client, { ...client })).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
    await expect(memberFingerprint({ tenantId: '', signingPublicJwk: client })).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
    await expect(memberFingerprint({ tenantId: TENANT, signingPublicJwk: { ...client, y: client.x } })).rejects.toThrow();
  });
});
