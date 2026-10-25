/**
 * Sealed-payload v1 test vectors (#654 E1a), Node leg.
 *
 * `golden/sealed-payload-v1.json` pins the v1 bytes: plaintext numbers,
 * padding, frames, scope key derivations, member ids, sealed contents, sealed
 * blobs, crafted receiver failures, member chain entries and key packages of
 * versions 1 and 2.
 * Two checks run against it:
 *
 * 1. `support/sealed-payload-vectors.ts` runs every vector through the core
 *    modules. The Bun leg (`sealed-payload-bun.test.ts`) runs the same checker.
 * 2. An oracle in this file rebuilds the bytes from the vector inputs with
 *    `node:crypto`, `@hpke/core` and its own canonical JSON. It imports nothing
 *    from `sealed-payload/` or from core's canonicalizer, so it is evidence
 *    that the golden bytes follow design §7–§9, not only that the code agrees
 *    with itself.
 *
 * Regenerate with `BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core
 * test`. Any diff in a deterministic field is a breaking change to the v1
 * format. Signatures and key packages are random at generation, so they are
 * verify-only and change on every regeneration.
 */
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { describe, expect, it } from 'vitest';

import { canonicalizeJson, canonicalizeJsonBytes, type JsonObject } from '../attestation';
import { hpkeSealBase } from '../hpke';
import {
  deriveMemberId,
  memberChainEntryHash,
  memberChainSigningInput,
  signMemberChainEntry,
  type MemberChainEntryV1,
  type UnsignedMemberChainEntryV1,
} from '../sealed-payload/member-chain';
import {
  deriveScopeKeyId,
  deriveSealedContentKey,
  deriveSealedMacKey,
  sealScopeKeyPackage,
  type ScopeKeyPackage,
  type ScopeKeyPackageV1,
} from '../sealed-payload/scope-key';
import {
  encodeSealedFrame,
  sealContentWithRandomness,
  sealedContentAad,
  sealedPaddedLength,
  type SealedBinding,
  type SealedCategory,
  type SealedContentHeaderV1,
} from '../sealed-payload/sealed-content';
import { sealBlobWithRandomness, sealedBlobAad } from '../sealed-payload/sealed-blob';
import { canonicalizeSealedJson } from '../sealed-payload/sealed-json';
import {
  checkSealedPayloadVectors,
  fromHex,
  importVectorPrivateKey,
  publicJwk,
  toHex,
  vectorBlobBytes,
  vectorPlaintext,
  type BlobVector,
  type ChainFailureVector,
  type ChainVector,
  type CraftedOpenVector,
  type KeyPackageVector,
  type NumberVector,
  type PlaintextFill,
  type PolicyOpenVector,
  type SealedPayloadVectors,
  type SealedVector,
  type VectorKeyPair,
  type VectorMember,
} from './support/sealed-payload-vectors';

const GOLDEN_URL = new URL('./golden/sealed-payload-v1.json', import.meta.url);

// ---------------------------------------------------------------------------
// Generator (update mode only)
// ---------------------------------------------------------------------------

/** Deterministic test bytes: SHA-256 of a public label. Never a real key. */
function labelBytes(label: string, length = 32): Buffer {
  return createHash('sha256').update(`byok-e1a-vector:${label}`).digest().subarray(0, length);
}

function keyPair(label: string): VectorKeyPair {
  const ecdh = createECDH('prime256v1');
  const d = labelBytes(label);
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return { d: d.toString('base64url'), x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') };
}

async function vectorMember(name: string): Promise<VectorMember> {
  const signing = keyPair(`${name}-signing`);
  return { name, memberId: await deriveMemberId(publicJwk(signing)), signing, kem: keyPair(`${name}-kem`) };
}

const TENANT = 'tenant-1';
const SCOPE = { id: 'scope-1', epoch: 1 } as const;
const SEALING = { scopeId: SCOPE.id, epoch: SCOPE.epoch } as const;
/** Key package signing prefix and HPKE info, by package version (#654 E5b-2 adds version 2). */
const PACKAGE_DOMAIN = { 1: 'byok-scope-key-package-v1\n', 2: 'byok-scope-key-package-v2\n' } as const;
const PACKAGE_INFO = { 1: 'byok-sdk.scope-key.v1', 2: 'byok-sdk.scope-key.v2' } as const;

/**
 * RFC 8785 Appendix B, Table 1, row by row: IEEE 754 bits and the canonical
 * text. `null` marks NaN and Infinity, which have no JSON form (#786).
 */
const RFC8785_NUMBER_SAMPLES: readonly NumberVector[] = [
  { ieee: '0000000000000000', json: '0' },
  { ieee: '8000000000000000', json: '0' },
  { ieee: '0000000000000001', json: '5e-324' },
  { ieee: '8000000000000001', json: '-5e-324' },
  { ieee: '7fefffffffffffff', json: '1.7976931348623157e+308' },
  { ieee: 'ffefffffffffffff', json: '-1.7976931348623157e+308' },
  { ieee: '4340000000000000', json: '9007199254740992' },
  { ieee: 'c340000000000000', json: '-9007199254740992' },
  { ieee: '4430000000000000', json: '295147905179352830000' },
  { ieee: '7fffffffffffffff', json: null },
  { ieee: '7ff0000000000000', json: null },
  { ieee: '44b52d02c7e14af5', json: '9.999999999999997e+22' },
  { ieee: '44b52d02c7e14af6', json: '1e+23' },
  { ieee: '44b52d02c7e14af7', json: '1.0000000000000001e+23' },
  { ieee: '444b1ae4d6e2ef4e', json: '999999999999999700000' },
  { ieee: '444b1ae4d6e2ef4f', json: '999999999999999900000' },
  { ieee: '444b1ae4d6e2ef50', json: '1e+21' },
  { ieee: '3eb0c6f7a0b5ed8c', json: '9.999999999999997e-7' },
  { ieee: '3eb0c6f7a0b5ed8d', json: '0.000001' },
  { ieee: '41b3de4355555553', json: '333333333.3333332' },
  { ieee: '41b3de4355555554', json: '333333333.33333325' },
  { ieee: '41b3de4355555555', json: '333333333.3333333' },
  { ieee: '41b3de4355555556', json: '333333333.3333334' },
  { ieee: '41b3de4355555557', json: '333333333.33333343' },
  { ieee: 'becbf647612f3696', json: '-0.0000033333333333333333' },
  { ieee: '43143ff3c1cb0959', json: '1424953923781206.2' },
];

/** Texts that parse to a number whose canonical text differs. */
const NON_CANONICAL_NUMBERS: readonly string[] = ['1.0', '1e0', '1E3', '-0', '0.10', '10e-1', '1e-07', '100000000000000000000000', '5E-324', '1.000000000000000000001'];

function frameContents(): string[] {
  return [0, 1, 252, 253].map((length) => toHex(Uint8Array.from({ length }, (_, index) => (index * 7 + 1) & 0xff)));
}

interface SealedInput {
  readonly name: string;
  readonly sender: VectorMember;
  readonly category: SealedCategory;
  readonly binding: SealedBinding;
  readonly plaintext?: JsonObject;
  readonly plaintextFill?: PlaintextFill;
  readonly maxContentLength: number;
}

function sealedInputs(client: VectorMember, device: VectorMember): SealedInput[] {
  const deviceBinding = {
    tenantId: TENANT,
    deviceId: 'device-1',
    agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
    categories: ['task-input', 'agent-message', 'task-output'],
    notAfter: null,
  } as const;
  return [
    {
      name: 'c1-task-offer',
      sender: client,
      category: 'task-input',
      binding: { ...deviceBinding, family: 'task.offer_for_agent', direction: 'server-to-daemon', identity: { taskId: 'task-1' } },
      // The two last keys sort differently by UTF-16 code unit and by code point; RFC 8785 uses code units.
      plaintext: {
        input: { prompt: 'Summarize the attached notes.', title: 'Notes ✓ café' },
        '': 'private-use key',
        '😀': 'astral key',
      },
      maxContentLength: 64 * 1024,
    },
    {
      name: 'c2-agent-message',
      sender: device,
      category: 'agent-message',
      binding: { ...deviceBinding, family: 'task.agent_message', direction: 'daemon-to-server', identity: { taskId: 'task-1', messageId: 'message-1' } },
      plaintext: { body: 'Done. 結果を添付しました。', kind: 'text', parts: [1, 2, 3] },
      maxContentLength: 64 * 1024,
    },
    {
      name: 'c3-task-output-padme',
      sender: device,
      category: 'task-output',
      binding: { ...deviceBinding, family: 'task.result', direction: 'daemon-to-server', identity: { taskId: 'task-1' } },
      plaintextFill: { key: 'output', unit: '0123456789abcdef', count: 1250 },
      maxContentLength: 1024 * 1024,
    },
    {
      name: 'c4-memory-projection',
      sender: device,
      category: 'memory-projection',
      binding: {
        tenantId: TENANT,
        family: 'memory.projection_put',
        direction: 'daemon-to-server',
        identity: { projectionId: 'projection-1', revision: 2 },
        deviceId: 'device-1',
        agentRef: null,
        categories: ['memory-projection'],
        notAfter: null,
      },
      plaintext: { text: 'The user prefers metric units.' },
      maxContentLength: 64 * 1024,
    },
    {
      name: 'routine-template',
      sender: client,
      category: 'task-input',
      binding: {
        tenantId: TENANT,
        family: 'routine.template',
        direction: 'server-to-daemon',
        identity: { routineId: 'routine-1', definitionVersion: 4 },
        deviceId: null,
        agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
        categories: ['task-input'],
        notAfter: '2026-12-31T00:00:00.000Z',
      },
      plaintext: { input: { prompt: 'Write the daily digest.' } },
      maxContentLength: 64 * 1024,
    },
    {
      // #786: numbers the safe-integer rule refused, in the RFC 8785 number form.
      name: 'c3-task-output-numbers',
      sender: device,
      category: 'task-output',
      binding: { ...deviceBinding, family: 'task.result', direction: 'daemon-to-server', identity: { taskId: 'task-3' } },
      plaintext: {
        usage: { costUsd: 0.0123, ratio: -1.5 },
        values: [0.1, 1e-7, 1e21, 1e23, 2 ** 53, 5e-324, 1.7976931348623157e308, -0.0000033333333333333333, 333333333.3333333],
      },
      maxContentLength: 64 * 1024,
    },
  ];
}

/** #654 E1c: one blob per field shape, each sealed under the header and binding of an outer vector. */
const BLOB_INPUTS: readonly Pick<BlobVector, 'name' | 'outer' | 'fieldPath' | 'bytes' | 'bytesLength' | 'maxContentLength'>[] = [
  { name: 'instruction-blob', outer: 'c1-task-offer', fieldPath: '/instruction/blobRef', bytes: `${Buffer.from('Attached notes ✓\n').toString('hex')}00ff`, maxContentLength: 1024 },
  { name: 'progress-spill-blob-empty', outer: 'c3-task-output-padme', fieldPath: '/events/2/spill/blob', bytes: '', maxContentLength: 1024 },
  { name: 'artifact-blob-padme', outer: 'c3-task-output-numbers', fieldPath: '/artifactRefs/1', bytesLength: 20_000, maxContentLength: 2 * 1024 * 1024 },
  { name: 'routine-template-blob', outer: 'routine-template', fieldPath: '/input/blobRef', bytes: '0102030405', maxContentLength: 1024 },
];

async function blobVectors(scopeKey: Uint8Array, sealed: readonly SealedVector[]): Promise<BlobVector[]> {
  const out: BlobVector[] = [];
  for (const input of BLOB_INPUTS) {
    const outer = sealed.find((vector) => vector.name === input.outer)!;
    const salt = labelBytes(`${input.name}-salt`);
    const nonce = labelBytes(`${input.name}-nonce`, 12);
    const result = await sealBlobWithRandomness(
      {
        scopeKey,
        scope: outer.scope,
        chainHead: outer.chainHead,
        sender: outer.sender,
        category: outer.category,
        binding: outer.binding,
        fieldPath: input.fieldPath,
        bytes: vectorBlobBytes(input),
        maxContentLength: input.maxContentLength,
      },
      { salt, nonce },
    );
    out.push({
      ...input,
      salt: salt.toString('hex'),
      nonce: nonce.toString('hex'),
      params: result.params,
      aad: toHex(sealedBlobAad(outer.header, outer.binding, result.params.paddedLength, input.fieldPath)),
      ...(input.bytesLength === undefined
        ? { ciphertext: toHex(result.ciphertext) }
        : { ciphertextSha256: createHash('sha256').update(result.ciphertext).digest('hex') }),
    });
  }
  return out;
}

function macInputHex(category: SealedCategory, binding: SealedBinding, plaintext: JsonObject): string {
  const text = `byok-content-mac-v1\n${category}\n${binding.family}\n${canonicalizeJson(binding.identity)}\n${canonicalizeSealedJson(plaintext)}`;
  return Buffer.from(text, 'utf8').toString('hex');
}

function nodeAesGcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]).toString('hex');
}

async function craftedVectors(scopeKey: Uint8Array, client: VectorMember, chainHead: SealedVector['chainHead']): Promise<CraftedOpenVector[]> {
  const binding: SealedBinding = {
    tenantId: TENANT,
    family: 'task.offer_for_agent',
    direction: 'server-to-daemon',
    identity: { taskId: 'task-2' },
    deviceId: 'device-1',
    agentRef: null,
    categories: ['task-input'],
    notAfter: null,
  };
  const content = canonicalizeJsonBytes({ note: 'crafted' });
  const craft = async (
    defect: CraftedOpenVector['defect'],
    expectReason: CraftedOpenVector['expect'],
    change: (header: SealedContentHeaderV1, frame: Uint8Array) => { header: SealedContentHeaderV1; frame: Uint8Array },
  ): Promise<CraftedOpenVector> => {
    const salt = labelBytes(`crafted-${defect}-salt`);
    const nonce = labelBytes(`crafted-${defect}-nonce`, 12);
    const sealed = await sealContentWithRandomness(
      { scopeKey, scope: SCOPE, chainHead, sender: client.memberId, category: 'task-input', binding, plaintext: { note: 'crafted' }, maxContentLength: 1024 },
      { salt, nonce },
    );
    const { header, frame } = change(sealed.header, encodeSealedFrame(content));
    const contentKey = await deriveSealedContentKey(scopeKey, salt);
    return {
      name: `crafted-${defect}`,
      defect,
      header,
      binding,
      sealing: SEALING,
      ciphertext: nodeAesGcm(contentKey, nonce, sealedContentAad(header, binding), frame),
      maxContentLength: 1024,
      expect: expectReason,
    };
  };
  return [
    await craft('content-mac', 'sealed_content_mac_mismatch', (header, frame) => ({
      header: { ...header, contentMac: `hmac-sha256:${'ab'.repeat(32)}` },
      frame,
    })),
    await craft('padding-byte', 'sealed_open_failed', (header, frame) => {
      frame[frame.length - 1] = 1;
      return { header, frame };
    }),
    await craft('padded-length', 'sealed_open_failed', (header) => {
      const frame = new Uint8Array(512);
      new DataView(frame.buffer).setUint32(0, content.byteLength, false);
      frame.set(content, 4);
      return { header: { ...header, paddedLength: 512 }, frame };
    }),
    await craft('length-overflow', 'sealed_open_failed', (header, frame) => {
      new DataView(frame.buffer).setUint32(0, frame.byteLength - 3, false);
      return { header, frame };
    }),
    await craft('non-canonical-json', 'sealed_open_failed', (header) => ({
      header,
      frame: encodeSealedFrame(new TextEncoder().encode('{"note": "crafted"}')),
    })),
  ];
}

async function chainVectors(client: VectorMember, device: VectorMember): Promise<ChainVector[]> {
  const signer = { publicJwk: publicJwk(client.signing), privateKey: await importVectorPrivateKey(client.signing, 'sign') };
  // Subjects are illustrative. The per-op subject shapes are E2's; these bytes pin only the entry rules.
  const subjects: readonly Pick<UnsignedMemberChainEntryV1, 'op' | 'subject'>[] = [
    { op: 'add', subject: { member: client.memberId, kind: 'client', signingKey: { ...publicJwk(client.signing) }, kemKey: { ...publicJwk(client.kem) } } },
    { op: 'add', subject: { member: device.memberId, kind: 'device', deviceId: 'device-1', signingKey: { ...publicJwk(device.signing) }, kemKey: { ...publicJwk(device.kem) } } },
    { op: 'scope-policy', subject: { scopeId: SCOPE.id, epoch: SCOPE.epoch, members: [client.memberId, device.memberId] } },
  ];
  const out: ChainVector[] = [];
  let prev: string | null = null;
  for (const [index, { op, subject }] of subjects.entries()) {
    const unsigned: UnsignedMemberChainEntryV1 = { v: 1, tenantId: TENANT, seq: index + 1, prev, op, subject, signer: client.memberId };
    const hash = await memberChainEntryHash(unsigned);
    const entry: MemberChainEntryV1 = await signMemberChainEntry(unsigned, signer);
    out.push({ signer: client.name, entry, signingInput: toHex(memberChainSigningInput(unsigned)), hash });
    prev = hash;
  }
  return out;
}

async function policyVectors(sealed: readonly SealedVector[]): Promise<PolicyOpenVector[]> {
  const offer = sealed.find((vector) => vector.name === 'c1-task-offer')!;
  const routine = sealed.find((vector) => vector.name === 'routine-template')!;
  const vector = (
    source: SealedVector,
    defect: PolicyOpenVector['defect'],
    expectReason: PolicyOpenVector['expect'],
    change: Partial<Pick<PolicyOpenVector, 'header' | 'binding' | 'sealing'>>,
  ): PolicyOpenVector => ({
    name: `policy-${defect}`,
    defect,
    header: source.header,
    binding: source.binding,
    sealing: source.sealing,
    ciphertext: source.ciphertext!,
    maxContentLength: source.maxContentLength,
    expect: expectReason,
    ...change,
  });
  const otherKeyId = await deriveScopeKeyId(labelBytes('other-scope-key'));
  return [
    vector(offer, 'key-id', 'sealed_key_unavailable', { header: { ...offer.header, scope: { ...offer.header.scope, keyId: otherKeyId } } }),
    vector(offer, 'category-not-sealed', 'sealing_policy_mismatch', { binding: { ...offer.binding, categories: ['task-output'] } }),
    vector(offer, 'scope-id', 'sealing_policy_mismatch', { sealing: { ...offer.sealing, scopeId: 'scope-2' } }),
    vector(offer, 'epoch-below', 'sealing_policy_mismatch', { sealing: { ...offer.sealing, epoch: offer.header.scope.epoch + 1 } }),
    vector(offer, 'categories-order', 'sealing_policy_mismatch', { binding: { ...offer.binding, categories: ['task-output', 'agent-message', 'task-input'] } }),
    vector(routine, 'not-after-format', 'sealing_policy_mismatch', { binding: { ...routine.binding, notAfter: '2026-12-31T00:00:00Z' } }),
  ];
}

function chainFailureVectors(chain: readonly ChainVector[], other: VectorMember): ChainFailureVector[] {
  const [first, second] = chain as [ChainVector, ChainVector];
  const sig = Buffer.from(second.entry.sig, 'base64url');
  sig[63]! ^= 0x01;
  return [
    { name: 'chain-signature', defect: 'signature', signer: second.signer, entry: { ...second.entry, sig: sig.toString('base64url') }, expect: 'member_chain_signature_invalid' },
    { name: 'chain-tenant', defect: 'tenant', signer: second.signer, entry: { ...second.entry, tenantId: 'tenant-2' }, expect: 'member_chain_signature_invalid' },
    { name: 'chain-prev-rule', defect: 'prev-rule', signer: first.signer, entry: { ...first.entry, prev: second.hash }, expect: 'member_chain_entry_invalid' },
    { name: 'chain-signer-key', defect: 'signer-key', signer: other.name, entry: second.entry, expect: 'member_chain_entry_invalid' },
  ];
}

function rawPoint(pair: VectorKeyPair): Uint8Array {
  return Buffer.concat([Buffer.from([4]), Buffer.from(pair.x, 'base64url'), Buffer.from(pair.y, 'base64url')]);
}

function signedPackage(unsigned: Omit<ScopeKeyPackageV1, 'sig'>, signer: VectorMember): ScopeKeyPackageV1 {
  const input = Buffer.concat([Buffer.from(PACKAGE_DOMAIN[1]), canonicalizeJsonBytes({ ...unsigned })]);
  const key = { key: { kty: 'EC', crv: 'P-256', ...signer.signing }, format: 'jwk', dsaEncoding: 'ieee-p1363' } as const;
  return { ...unsigned, sig: sign('sha256', input, key).toString('base64url') };
}

async function keyPackageVectors(
  scopeKey: Uint8Array,
  client: VectorMember,
  device: VectorMember,
  stranger: VectorMember,
): Promise<KeyPackageVector[]> {
  const expected = { tenantId: TENANT, scopeId: SCOPE.id, epoch: SCOPE.epoch };

  // Version 1 packages, as members sealed them before version 2: core now seals only version 2.
  const sealV1 = async (kem: VectorKeyPair, keyId: string): Promise<ScopeKeyPackageV1> => {
    const identity = { v: 1 as const, tenantId: TENANT, scopeId: SCOPE.id, epoch: SCOPE.epoch, keyId, recipient: device.memberId, sender: client.memberId };
    const hpke = await hpkeSealBase({
      recipientPublicKey: rawPoint(kem),
      info: new TextEncoder().encode(PACKAGE_INFO[1]),
      aad: canonicalizeJsonBytes(identity),
      plaintext: scopeKey,
    });
    return signedPackage(
      { ...identity, enc: Buffer.from(hpke.enc).toString('base64url'), ciphertext: Buffer.from(hpke.ciphertext).toString('base64url') },
      client,
    );
  };
  const keyId = await deriveScopeKeyId(scopeKey);
  const valid = await sealV1(device.kem, keyId);
  const wrongKem = await sealV1(stranger.kem, keyId);
  // A package signed by its sender whose key id names another key.
  const keyIdMismatch = await sealV1(device.kem, await deriveScopeKeyId(labelBytes('other-scope-key')));

  // A version 2 package wrapped to the device's KEM key of epoch 1.
  const validV2 = await sealScopeKeyPackage({
    scopeKey,
    tenantId: TENANT,
    scopeId: SCOPE.id,
    epoch: SCOPE.epoch,
    recipient: { memberId: device.memberId, kemPublicJwk: publicJwk(device.kem), kemEpoch: 1 },
    sender: { signingPublicJwk: publicJwk(client.signing), signingPrivateKey: await importVectorPrivateKey(client.signing, 'sign') },
  });
  const sigBytes = Buffer.from(valid.sig, 'base64url');
  sigBytes[0]! ^= 0x01;

  const vector = (name: string, pkg: ScopeKeyPackage, expect: KeyPackageVector['expect'], overrides: Partial<KeyPackageVector> = {}): KeyPackageVector => ({
    name, sender: client.name, recipient: device.name, expected, package: pkg, expect, ...overrides,
  });
  return [
    vector('client-to-device', valid, 'ok'),
    vector('sealed-to-another-kem-key', wrongKem, 'key_package_open_failed'),
    vector('key-id-of-another-key', keyIdMismatch, 'key_package_open_failed'),
    vector('signature-flipped', { ...valid, sig: sigBytes.toString('base64url') }, 'key_package_signature_invalid'),
    vector('unexpected-epoch', valid, 'key_package_invalid', { expected: { ...expected, epoch: 2 } }),
    vector('sender-key-of-another-member', valid, 'key_package_invalid', { sender: device.name }),
    vector('opened-by-another-member', valid, 'key_package_invalid', { recipient: stranger.name }),
    vector('v2-client-to-device', validV2, 'ok'),
    vector('v2-opened-with-another-kem-epoch', validV2, 'key_package_invalid', { recipientKemEpoch: 2 }),
    vector('v2-kem-epoch-changed', { ...validV2, recipientKemEpoch: 2 }, 'key_package_signature_invalid', { recipientKemEpoch: 2 }),
  ];
}

async function buildVectors(): Promise<SealedPayloadVectors> {
  const client = await vectorMember('client');
  const device = await vectorMember('device');
  const stranger = await vectorMember('stranger');
  const scopeKey = labelBytes('scope-key');
  const chain = await chainVectors(client, device);
  const chainHead = { seq: chain.length, hash: chain[chain.length - 1]!.hash };

  const sealed: SealedVector[] = [];
  for (const input of sealedInputs(client, device)) {
    const salt = labelBytes(`${input.name}-salt`);
    const nonce = labelBytes(`${input.name}-nonce`, 12);
    const plaintext = vectorPlaintext(input);
    const result = await sealContentWithRandomness(
      { scopeKey, scope: SCOPE, chainHead, sender: input.sender.memberId, category: input.category, binding: input.binding, plaintext, maxContentLength: input.maxContentLength },
      { salt, nonce },
    );
    const ciphertextHex = toHex(result.ciphertext);
    sealed.push({
      name: input.name,
      scope: SCOPE,
      chainHead,
      sender: input.sender.memberId,
      category: input.category,
      binding: input.binding,
      sealing: SEALING,
      ...(input.plaintext === undefined ? {} : { plaintext: input.plaintext }),
      ...(input.plaintextFill === undefined ? {} : { plaintextFill: input.plaintextFill }),
      maxContentLength: input.maxContentLength,
      salt: salt.toString('hex'),
      nonce: nonce.toString('hex'),
      header: result.header,
      aad: toHex(sealedContentAad(result.header, input.binding)),
      macInput: macInputHex(input.category, input.binding, plaintext),
      ...(input.plaintextFill === undefined
        ? { ciphertext: ciphertextHex }
        : { ciphertextSha256: createHash('sha256').update(result.ciphertext).digest('hex') }),
    });
  }

  return {
    note: 'Sealed-payload v1 vectors (#654 E1a, E1b; #786 numbers). Regenerate with BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core test. A diff in a deterministic field is a breaking change to the v1 format. Chain signatures and key packages are random at generation, so they are verify-only and change on every regeneration. All keys derive from public labels and are test values only.',
    numbers: RFC8785_NUMBER_SAMPLES,
    nonCanonicalNumbers: NON_CANONICAL_NUMBERS,
    padding: [4, 5, 256, 257, 512, 16383, 16384, 16385, 17408, 17409, 20017, 32768, 32769, 65536, 65537, 1_000_000, 4 + 0xffff_ffff]
      .map((frameLength) => ({ frameLength, paddedLength: sealedPaddedLength(frameLength) })),
    frames: frameContents().map((content) => ({ content, frame: toHex(encodeSealedFrame(fromHex(content))) })),
    scopeKey: {
      key: scopeKey.toString('hex'),
      keyId: await deriveScopeKeyId(scopeKey),
      macKey: toHex(await deriveSealedMacKey(scopeKey)),
      contentKeys: await Promise.all(['content-key-a', 'content-key-b'].map(async (label) => {
        const salt = labelBytes(label);
        return { salt: salt.toString('hex'), contentKey: toHex(await deriveSealedContentKey(scopeKey, salt)) };
      })),
    },
    members: [client, device, stranger],
    sealed,
    blobs: await blobVectors(scopeKey, sealed),
    craftedOpenFailures: await craftedVectors(scopeKey, client, chainHead),
    policyOpenFailures: await policyVectors(sealed),
    chain,
    chainFailures: chainFailureVectors(chain, device),
    keyPackages: await keyPackageVectors(scopeKey, client, device, stranger),
  };
}

if (process.env['BYOK_CORE_UPDATE_GOLDEN'] === '1' || !existsSync(GOLDEN_URL)) {
  if (process.env['BYOK_CORE_UPDATE_GOLDEN'] !== '1') throw new Error('golden/sealed-payload-v1.json is missing');
  writeFileSync(GOLDEN_URL, `${JSON.stringify(await buildVectors(), null, 2)}\n`, 'utf8');
}

const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as SealedPayloadVectors;

// ---------------------------------------------------------------------------
// Independent oracle: node:crypto, @hpke/core and its own canonical JSON
// ---------------------------------------------------------------------------

function compareCodeUnits(left: string, right: string): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * RFC 8785: keys sorted by UTF-16 code unit. `numbers: 'safe-integer'` is the
 * attestation value space (AAD, MAC identity, chain, key packages);
 * `'finite'` is the sealed plaintext rule (#786), whose number text the RFC
 * 8785 test below pins to the RFC table.
 */
function oracleCanonical(value: unknown, numbers: 'safe-integer' | 'finite' = 'safe-integer'): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    const admitted = numbers === 'finite' ? Number.isFinite(value) : Number.isSafeInteger(value);
    if (!admitted) throw new Error(`oracle: ${value} is outside the ${numbers} number space`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => oracleCanonical(entry, numbers)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodeUnits);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${oracleCanonical(record[key], numbers)}`).join(',')}}`;
}

function oraclePaddedLength(frameLength: number): number {
  const length = BigInt(frameLength);
  const round = (step: bigint) => Number(((length + step - 1n) / step) * step);
  if (length <= 16_384n) return round(256n);
  const exponent = BigInt(length.toString(2).length - 1);
  return round(1n << (exponent - BigInt(exponent.toString(2).length)));
}

function oracleFrame(content: Buffer): Buffer {
  const frame = Buffer.alloc(oraclePaddedLength(4 + content.length));
  frame.writeUInt32BE(content.length, 0);
  content.copy(frame, 4);
  return frame;
}

const scopeKeyBytes = Buffer.from(golden.scopeKey.key, 'hex');
const oracleKeyId = (key: Buffer) => createHmac('sha256', key).update('byok-scope-key-id-v1').digest().subarray(0, 16).toString('base64url');
const oracleMacKey = Buffer.from(hkdfSync('sha256', scopeKeyBytes, Buffer.alloc(0), 'byok-sdk.sealed.v1.mac', 32));
const oracleContentKey = (salt: Buffer) => Buffer.from(hkdfSync('sha256', scopeKeyBytes, salt, 'byok-sdk.sealed.v1.enc', 32));

function oracleAad(header: SealedContentHeaderV1, binding: SealedBinding): Buffer {
  return Buffer.from(oracleCanonical({
    v: header.v,
    suite: header.suite,
    category: header.category,
    tenantId: binding.tenantId,
    scopeId: header.scope.id,
    epoch: header.scope.epoch,
    keyId: header.scope.keyId,
    chainHead: header.chainHead,
    sender: header.sender,
    family: binding.family,
    direction: binding.direction,
    identity: binding.identity,
    deviceId: binding.deviceId,
    agentRef: binding.agentRef,
    categories: binding.categories,
    notAfter: binding.notAfter,
    paddedLength: header.paddedLength,
    contentMac: header.contentMac,
  }), 'utf8');
}

/** §8.1, E1c: the outer AAD members without `paddedLength` and `contentMac`, plus the blob's own `paddedLength` and `fieldPath`. */
function oracleBlobAad(header: SealedContentHeaderV1, binding: SealedBinding, paddedLength: number, fieldPath: string): Buffer {
  const outer = JSON.parse(oracleAad(header, binding).toString('utf8')) as Record<string, unknown>;
  delete outer['paddedLength'];
  delete outer['contentMac'];
  return Buffer.from(oracleCanonical({ ...outer, paddedLength, fieldPath }), 'utf8');
}

function oracleMacInput(category: string, binding: SealedBinding, plaintextText: string): string {
  return `byok-content-mac-v1\n${category}\n${binding.family}\n${oracleCanonical(binding.identity)}\n${plaintextText}`;
}

function oracleContentMac(input: string): string {
  return `hmac-sha256:${createHmac('sha256', oracleMacKey).update(input, 'utf8').digest('hex')}`;
}

function oracleDecrypt(header: SealedContentHeaderV1, binding: SealedBinding, ciphertextHex: string): Buffer {
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', oracleContentKey(Buffer.from(header.salt, 'base64url')), Buffer.from(header.nonce, 'base64url'));
  decipher.setAAD(oracleAad(header, binding));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
}

function oracleVerify(pair: VectorKeyPair, data: Buffer, signature: string): boolean {
  return verify('sha256', data, { key: { kty: 'EC', crv: 'P-256', x: pair.x, y: pair.y }, format: 'jwk', dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
}

function memberById(memberId: string): VectorMember {
  const found = golden.members.find((entry) => entry.memberId === memberId);
  if (found === undefined) throw new Error(`no member ${memberId}`);
  return found;
}

const CATEGORY_ORDER = ['task-input', 'agent-message', 'task-output', 'memory-projection'];

const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;

async function hpkeOpenWith(pair: VectorKeyPair, pkg: ScopeKeyPackage): Promise<Buffer> {
  const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
  const { sig: _sig, enc, ciphertext, ...identity } = pkg;
  const context = await suite.createRecipientContext({
    // @hpke/core derives the recipient public key from the private key, so this import is extractable.
    recipientKey: await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', ...pair }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    enc: arrayBuffer(Buffer.from(enc, 'base64url')),
    info: arrayBuffer(Buffer.from(PACKAGE_INFO[pkg.v])),
  });
  return Buffer.from(await context.open(arrayBuffer(Buffer.from(ciphertext, 'base64url')), arrayBuffer(Buffer.from(oracleCanonical(identity)))));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sealed-payload v1 vectors', () => {
  it('pass every check in the core modules', async () => {
    const counts = await checkSealedPayloadVectors(golden);
    expect(counts).toMatchObject({
      numbers: golden.numbers.length,
      nonCanonicalNumbers: golden.nonCanonicalNumbers.length,
      padding: golden.padding.length,
      frames: golden.frames.length,
      contentKeys: golden.scopeKey.contentKeys.length,
      members: golden.members.length,
      sealed: golden.sealed.length,
      craftedOpenFailures: golden.craftedOpenFailures.length,
      policyOpenFailures: golden.policyOpenFailures.length,
      chain: golden.chain.length,
      chainFailures: golden.chainFailures.length,
      keyPackages: golden.keyPackages.length,
    });
    expect(counts.sealedRejections).toBeGreaterThanOrEqual(golden.sealed.length * 30);
    expect(counts.blobs).toBe(golden.blobs.length);
    expect(counts.blobRejections).toBeGreaterThanOrEqual(golden.blobs.length * 35);
  });

  it('cover every category, the routine template, each crafted defect and each key package outcome', () => {
    expect(new Set(golden.sealed.map((vector) => vector.category))).toEqual(new Set(['task-input', 'agent-message', 'task-output', 'memory-projection']));
    expect(golden.sealed.some((vector) => vector.binding.deviceId === null && vector.binding.notAfter !== null)).toBe(true);
    expect(golden.sealed.some((vector) => vector.header.paddedLength > 16_384)).toBe(true);
    expect(golden.sealed.find((vector) => vector.name === 'c3-task-output-numbers')?.plaintext).toBeDefined();
    expect(golden.blobs.map((vector) => vector.fieldPath)).toEqual(['/instruction/blobRef', '/events/2/spill/blob', '/artifactRefs/1', '/input/blobRef']);
    expect(golden.blobs.some((vector) => vector.params.paddedLength > 16_384)).toBe(true);
    expect(golden.blobs.some((vector) => vector.bytes === '')).toBe(true);
    expect(golden.craftedOpenFailures.map((vector) => vector.defect)).toEqual(['content-mac', 'padding-byte', 'padded-length', 'length-overflow', 'non-canonical-json']);
    expect(golden.policyOpenFailures.map((vector) => vector.defect)).toEqual(['key-id', 'category-not-sealed', 'scope-id', 'epoch-below', 'categories-order', 'not-after-format']);
    expect(new Set(golden.policyOpenFailures.map((vector) => vector.expect))).toEqual(new Set(['sealed_key_unavailable', 'sealing_policy_mismatch']));
    expect(new Set(golden.chainFailures.map((vector) => vector.expect))).toEqual(new Set(['member_chain_entry_invalid', 'member_chain_signature_invalid']));
    expect(new Set(golden.keyPackages.map((vector) => vector.expect))).toEqual(
      new Set(['ok', 'key_package_open_failed', 'key_package_signature_invalid', 'key_package_invalid']),
    );
    expect(new Set(golden.keyPackages.map((vector) => vector.package.v))).toEqual(new Set([1, 2]));
  });
});

describe('sealed-payload v1 vectors against an independent oracle', () => {
  it('plaintext numbers: every RFC 8785 Appendix B sample, and refusal of other number texts (#786)', () => {
    expect(golden.numbers).toEqual(RFC8785_NUMBER_SAMPLES);
    expect(golden.nonCanonicalNumbers).toEqual(NON_CANONICAL_NUMBERS);
    for (const { ieee, json } of golden.numbers) {
      const value = Buffer.from(ieee, 'hex').readDoubleBE(0);
      if (json === null) {
        expect(Number.isFinite(value)).toBe(false);
        expect(() => oracleCanonical(value, 'finite')).toThrow();
        continue;
      }
      expect(oracleCanonical(value, 'finite')).toBe(json);
      // The RFC text parses back to the same double; JSON has no -0, so only zero may lose its sign.
      expect(JSON.parse(json)).toBe(value === 0 ? 0 : value);
    }
    for (const text of golden.nonCanonicalNumbers) {
      expect(Number.isFinite(JSON.parse(text))).toBe(true);
      expect(oracleCanonical(JSON.parse(text), 'finite')).not.toBe(text);
    }
  });

  it('padding lengths and frames', () => {
    for (const { frameLength, paddedLength } of golden.padding) expect(oraclePaddedLength(frameLength)).toBe(paddedLength);
    for (const { content, frame } of golden.frames) expect(oracleFrame(Buffer.from(content, 'hex')).toString('hex')).toBe(frame);
  });

  it('key id, MAC key with an empty HKDF salt, and content keys', () => {
    expect(oracleKeyId(scopeKeyBytes)).toBe(golden.scopeKey.keyId);
    expect(oracleMacKey.toString('hex')).toBe(golden.scopeKey.macKey);
    for (const { salt, contentKey } of golden.scopeKey.contentKeys) {
      expect(oracleContentKey(Buffer.from(salt, 'hex')).toString('hex')).toBe(contentKey);
    }
  });

  it('member ids from the signing key alone', () => {
    for (const entry of golden.members) {
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(entry.signing.x, 'base64url'), Buffer.from(entry.signing.y, 'base64url')]);
      expect(createHash('sha256').update('byok-member-id-v1\n').update(raw).digest('base64url')).toBe(entry.memberId);
    }
  });

  it('sealed contents: header, AAD, content MAC and ciphertext', () => {
    for (const vector of golden.sealed) {
      const plaintextText = oracleCanonical(vectorPlaintext(vector), 'finite');
      const frame = oracleFrame(Buffer.from(plaintextText, 'utf8'));
      const salt = Buffer.from(vector.salt, 'hex');
      const nonce = Buffer.from(vector.nonce, 'hex');
      const macInput = oracleMacInput(vector.category, vector.binding, plaintextText);
      expect(vector.header).toEqual({
        v: 1,
        suite: 'byok-sealed-v1.hkdf-sha256.aes-256-gcm',
        category: vector.category,
        scope: { ...vector.scope, keyId: oracleKeyId(scopeKeyBytes) },
        chainHead: vector.chainHead,
        sender: vector.sender,
        salt: salt.toString('base64url'),
        nonce: nonce.toString('base64url'),
        paddedLength: frame.length,
        contentMac: oracleContentMac(macInput),
      });
      expect(Buffer.from(macInput, 'utf8').toString('hex')).toBe(vector.macInput);
      const aad = oracleAad(vector.header, vector.binding);
      expect(aad.toString('hex')).toBe(vector.aad);
      const ciphertext = nodeAesGcm(oracleContentKey(salt), nonce, aad, frame);
      if (vector.ciphertext === undefined) expect(createHash('sha256').update(Buffer.from(ciphertext, 'hex')).digest('hex')).toBe(vector.ciphertextSha256);
      else expect(ciphertext).toBe(vector.ciphertext);
    }
  });

  it('sealed blobs: params, AAD and ciphertext (#654 E1c)', () => {
    for (const vector of golden.blobs) {
      const outer = golden.sealed.find((entry) => entry.name === vector.outer)!;
      const bytes = Buffer.from(vectorBlobBytes(vector));
      const frame = oracleFrame(bytes);
      const salt = Buffer.from(vector.salt, 'hex');
      const nonce = Buffer.from(vector.nonce, 'hex');
      expect(vector.params).toEqual({ salt: salt.toString('base64url'), nonce: nonce.toString('base64url'), paddedLength: frame.length });
      expect(vector.fieldPath).toMatch(/^(?:\/(?:[A-Za-z][A-Za-z0-9]*|0|[1-9][0-9]*))+$/u);
      const aad = oracleBlobAad(outer.header, outer.binding, frame.length, vector.fieldPath);
      expect(aad.toString('hex')).toBe(vector.aad);
      const members = Object.keys(JSON.parse(aad.toString('utf8')) as object);
      expect(members).toHaveLength(18);
      expect(members).toContain('fieldPath');
      expect(members).not.toContain('contentMac');
      const ciphertext = nodeAesGcm(oracleContentKey(salt), nonce, aad, frame);
      if (vector.ciphertext === undefined) expect(createHash('sha256').update(Buffer.from(ciphertext, 'hex')).digest('hex')).toBe(vector.ciphertextSha256);
      else expect(ciphertext).toBe(vector.ciphertext);
    }
  });

  it('orders canonical object keys by UTF-16 code unit, not by code point', () => {
    const vector = golden.sealed.find((entry) => entry.name === 'c1-task-offer')!;
    const macInput = Buffer.from(vector.macInput, 'hex').toString('utf8');
    expect(macInput.indexOf('"😀"')).toBeGreaterThan(0);
    expect(macInput.indexOf('"😀"')).toBeLessThan(macInput.indexOf('""'));
  });

  it('crafted failures decrypt and carry exactly their defect', () => {
    for (const vector of golden.craftedOpenFailures) {
      const frame = oracleDecrypt(vector.header, vector.binding, vector.ciphertext);
      expect(frame.length).toBe(vector.header.paddedLength);
      const length = frame.readUInt32BE(0);
      const defects = new Set<string>();
      if (length > frame.length - 4) {
        defects.add('length-overflow');
      } else {
        const text = frame.subarray(4, 4 + length).toString('utf8');
        if (oraclePaddedLength(4 + length) !== frame.length) defects.add('padded-length');
        if (frame.subarray(4 + length).some((byte) => byte !== 0)) defects.add('padding-byte');
        if (oracleCanonical(JSON.parse(text), 'finite') !== text) defects.add('non-canonical-json');
        else if (oracleContentMac(oracleMacInput(vector.header.category, vector.binding, text)) !== vector.header.contentMac) defects.add('content-mac');
      }
      expect([...defects]).toEqual([vector.defect]);
    }
  });

  it('policy failures carry exactly their defect', () => {
    for (const vector of golden.policyOpenFailures) {
      const categories: readonly string[] = vector.binding.categories;
      const defects = new Set<string>();
      if (vector.header.scope.keyId !== oracleKeyId(scopeKeyBytes)) defects.add('key-id');
      if (!categories.includes(vector.header.category)) defects.add('category-not-sealed');
      if (categories.some((category, index) => index > 0 && CATEGORY_ORDER.indexOf(categories[index - 1]!) >= CATEGORY_ORDER.indexOf(category))) {
        defects.add('categories-order');
      }
      if (vector.sealing.scopeId !== vector.header.scope.id) defects.add('scope-id');
      if (vector.header.scope.epoch < vector.sealing.epoch) defects.add('epoch-below');
      if (vector.binding.notAfter !== null && new Date(vector.binding.notAfter).toISOString() !== vector.binding.notAfter) defects.add('not-after-format');
      expect([...defects]).toEqual([vector.defect]);
    }
  });

  it('chain failures carry exactly their defect', () => {
    for (const vector of golden.chainFailures) {
      const { sig, ...unsigned } = vector.entry;
      const signer = golden.members.find((entry) => entry.name === vector.signer)!;
      const input = Buffer.concat([Buffer.from('byok-member-chain-v1\n'), Buffer.from(oracleCanonical(unsigned), 'utf8')]);
      let defect: string;
      if ((unsigned.seq === 1) !== (unsigned.prev === null)) defect = 'prev-rule';
      else if (signer.memberId !== unsigned.signer) defect = 'signer-key';
      else if (oracleVerify(signer.signing, input, sig)) defect = 'none';
      else defect = unsigned.tenantId === golden.chain[0]!.entry.tenantId ? 'signature' : 'tenant';
      expect(defect).toBe(vector.defect);
    }
  });

  it('member chain entries: signing input, hash, prev link and P1363 signature', () => {
    for (const [index, vector] of golden.chain.entries()) {
      const { sig, ...unsigned } = vector.entry;
      const input = Buffer.concat([Buffer.from('byok-member-chain-v1\n'), Buffer.from(oracleCanonical(unsigned), 'utf8')]);
      expect(input.toString('hex')).toBe(vector.signingInput);
      expect(`sha256:${createHash('sha256').update(input).digest('hex')}`).toBe(vector.hash);
      expect(vector.entry.prev).toBe(index === 0 ? null : golden.chain[index - 1]!.hash);
      expect(oracleVerify(memberById(vector.entry.signer).signing, input, sig)).toBe(true);
    }
  });

  it('key packages: sender signature and HPKE open with @hpke/core', async () => {
    const device = golden.members.find((entry) => entry.name === 'device')!;
    const stranger = golden.members.find((entry) => entry.name === 'stranger')!;
    const expectOpensToScopeKey = async (pkg: ScopeKeyPackage) => {
      const opened = await hpkeOpenWith(device.kem, pkg);
      expect(opened.toString('hex')).toBe(golden.scopeKey.key);
      expect(pkg.keyId).toBe(oracleKeyId(opened));
    };
    const signatureVerifies = (pkg: ScopeKeyPackage) => {
      const { sig, ...unsigned } = pkg;
      const input = Buffer.concat([Buffer.from(PACKAGE_DOMAIN[pkg.v]), Buffer.from(oracleCanonical(unsigned), 'utf8')]);
      return oracleVerify(memberById(pkg.sender).signing, input, sig);
    };
    for (const vector of golden.keyPackages) {
      expect(vector.package.v).toBe(vector.name.startsWith('v2-') ? 2 : 1);
      expect(signatureVerifies(vector.package)).toBe(vector.name !== 'signature-flipped' && vector.name !== 'v2-kem-epoch-changed');
      switch (vector.name) {
        case 'sealed-to-another-kem-key':
          await expect(hpkeOpenWith(device.kem, vector.package)).rejects.toThrow();
          expect((await hpkeOpenWith(stranger.kem, vector.package)).toString('hex')).toBe(golden.scopeKey.key);
          break;
        case 'key-id-of-another-key': {
          const opened = await hpkeOpenWith(device.kem, vector.package);
          expect(opened.toString('hex')).toBe(golden.scopeKey.key);
          expect(oracleKeyId(opened)).not.toBe(vector.package.keyId);
          break;
        }
        case 'v2-opened-with-another-kem-epoch': {
          const pkg = vector.package;
          if (pkg.v !== 2) throw new Error(`${vector.name} is not a version 2 package`);
          expect(pkg.recipientKemEpoch).toBe(1);
          expect(vector.recipientKemEpoch).toBe(2);
          await expectOpensToScopeKey(pkg);
          break;
        }
        case 'v2-kem-epoch-changed': {
          const pkg = vector.package;
          if (pkg.v !== 2) throw new Error(`${vector.name} is not a version 2 package`);
          // The epoch is in the HPKE AAD and under the signature; restoring it is the only fix the package needs.
          expect(pkg.recipientKemEpoch).toBe(vector.recipientKemEpoch);
          await expect(hpkeOpenWith(device.kem, pkg)).rejects.toThrow();
          const restored = { ...pkg, recipientKemEpoch: 1 };
          expect(signatureVerifies(restored)).toBe(true);
          await expectOpensToScopeKey(restored);
          break;
        }
        default:
          await expectOpensToScopeKey(vector.package);
      }
    }
  });
});
