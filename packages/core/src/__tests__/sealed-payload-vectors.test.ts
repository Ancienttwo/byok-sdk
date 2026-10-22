/**
 * Sealed-payload v1 test vectors (#654 E1a), Node leg.
 *
 * `golden/sealed-payload-v1.json` pins the v1 bytes: padding, frames, scope
 * key derivations, member ids, sealed contents, crafted receiver failures,
 * member chain entries and key packages. Two checks run against it:
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
  type ScopeKeyPackageV1,
} from '../sealed-payload/scope-key';
import {
  encodeSealedFrame,
  sealContent,
  sealedContentAad,
  sealedPaddedLength,
  type SealedBinding,
  type SealedCategory,
  type SealedContentHeaderV1,
} from '../sealed-payload/sealed-content';
import {
  checkSealedPayloadVectors,
  fromHex,
  importVectorPrivateKey,
  publicJwk,
  toHex,
  vectorPlaintext,
  type ChainVector,
  type CraftedOpenVector,
  type KeyPackageVector,
  type PlaintextFill,
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
const PACKAGE_DOMAIN = 'byok-scope-key-package-v1\n';

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
  ];
}

function macInputHex(category: SealedCategory, binding: SealedBinding, plaintext: JsonObject): string {
  const text = `byok-content-mac-v1\n${category}\n${binding.family}\n${canonicalizeJson(binding.identity)}\n${canonicalizeJson(plaintext)}`;
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
    const sealed = await sealContent(
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

function rawPoint(pair: VectorKeyPair): Uint8Array {
  return Buffer.concat([Buffer.from([4]), Buffer.from(pair.x, 'base64url'), Buffer.from(pair.y, 'base64url')]);
}

function signedPackage(unsigned: Omit<ScopeKeyPackageV1, 'sig'>, signer: VectorMember): ScopeKeyPackageV1 {
  const input = Buffer.concat([Buffer.from(PACKAGE_DOMAIN), canonicalizeJsonBytes({ ...unsigned })]);
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
  const clientSigningKey = await importVectorPrivateKey(client.signing, 'sign');
  const seal = (kem: VectorKeyPair) => sealScopeKeyPackage({
    scopeKey,
    tenantId: TENANT,
    scopeId: SCOPE.id,
    epoch: SCOPE.epoch,
    recipient: { memberId: device.memberId, kemPublicJwk: publicJwk(kem) },
    sender: { signingPublicJwk: publicJwk(client.signing), signingPrivateKey: clientSigningKey },
  });
  const valid = await seal(device.kem);
  const wrongKem = await seal(stranger.kem);

  // A package signed by its sender whose key id names another key.
  const otherKeyId = await deriveScopeKeyId(labelBytes('other-scope-key'));
  const identity = { v: 1 as const, tenantId: TENANT, scopeId: SCOPE.id, epoch: SCOPE.epoch, keyId: otherKeyId, recipient: device.memberId, sender: client.memberId };
  const hpke = await hpkeSealBase({
    recipientPublicKey: rawPoint(device.kem),
    info: new TextEncoder().encode('byok-sdk.scope-key.v1'),
    aad: canonicalizeJsonBytes(identity),
    plaintext: scopeKey,
  });
  const keyIdMismatch = signedPackage(
    { ...identity, enc: Buffer.from(hpke.enc).toString('base64url'), ciphertext: Buffer.from(hpke.ciphertext).toString('base64url') },
    client,
  );
  const sigBytes = Buffer.from(valid.sig, 'base64url');
  sigBytes[0]! ^= 0x01;

  const vector = (name: string, pkg: ScopeKeyPackageV1, expect: KeyPackageVector['expect'], overrides: Partial<KeyPackageVector> = {}): KeyPackageVector => ({
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
    const result = await sealContent(
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
    note: 'Sealed-payload v1 vectors (#654 E1a). Regenerate with BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core test. A diff in a deterministic field is a breaking change to the v1 format. Chain signatures and key packages are random at generation, so they are verify-only and change on every regeneration. All keys derive from public labels and are test values only.',
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
    craftedOpenFailures: await craftedVectors(scopeKey, client, chainHead),
    chain,
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

/** RFC 8785 for the v1 value space: keys sorted by UTF-16 code unit, safe integers only. */
function oracleCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`oracle: ${value} is outside the v1 number space`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(oracleCanonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodeUnits);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${oracleCanonical(record[key])}`).join(',')}}`;
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

const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;

async function hpkeOpenWith(pair: VectorKeyPair, pkg: ScopeKeyPackageV1): Promise<Buffer> {
  const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
  const { sig: _sig, enc, ciphertext, ...identity } = pkg;
  const context = await suite.createRecipientContext({
    // @hpke/core derives the recipient public key from the private key, so this import is extractable.
    recipientKey: await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', ...pair }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    enc: arrayBuffer(Buffer.from(enc, 'base64url')),
    info: arrayBuffer(Buffer.from('byok-sdk.scope-key.v1')),
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
      padding: golden.padding.length,
      frames: golden.frames.length,
      contentKeys: golden.scopeKey.contentKeys.length,
      members: golden.members.length,
      sealed: golden.sealed.length,
      craftedOpenFailures: golden.craftedOpenFailures.length,
      chain: golden.chain.length,
      keyPackages: golden.keyPackages.length,
    });
    expect(counts.sealedRejections).toBeGreaterThanOrEqual(golden.sealed.length * 30);
  });

  it('cover every category, the routine template, each crafted defect and each key package outcome', () => {
    expect(new Set(golden.sealed.map((vector) => vector.category))).toEqual(new Set(['task-input', 'agent-message', 'task-output', 'memory-projection']));
    expect(golden.sealed.some((vector) => vector.binding.deviceId === null && vector.binding.notAfter !== null)).toBe(true);
    expect(golden.sealed.some((vector) => vector.header.paddedLength > 16_384)).toBe(true);
    expect(golden.craftedOpenFailures.map((vector) => vector.defect)).toEqual(['content-mac', 'padding-byte', 'padded-length', 'length-overflow', 'non-canonical-json']);
    expect(new Set(golden.keyPackages.map((vector) => vector.expect))).toEqual(
      new Set(['ok', 'key_package_open_failed', 'key_package_signature_invalid', 'key_package_invalid']),
    );
  });
});

describe('sealed-payload v1 vectors against an independent oracle', () => {
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
      const plaintextText = oracleCanonical(vectorPlaintext(vector));
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
        if (oracleCanonical(JSON.parse(text)) !== text) defects.add('non-canonical-json');
        else if (oracleContentMac(oracleMacInput(vector.header.category, vector.binding, text)) !== vector.header.contentMac) defects.add('content-mac');
      }
      expect([...defects]).toEqual([vector.defect]);
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
    for (const vector of golden.keyPackages) {
      const { sig, ...unsigned } = vector.package;
      const input = Buffer.concat([Buffer.from(PACKAGE_DOMAIN), Buffer.from(oracleCanonical(unsigned), 'utf8')]);
      expect(oracleVerify(memberById(vector.package.sender).signing, input, sig)).toBe(vector.name !== 'signature-flipped');
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
        default: {
          const opened = await hpkeOpenWith(device.kem, vector.package);
          expect(opened.toString('hex')).toBe(golden.scopeKey.key);
          expect(vector.package.keyId).toBe(oracleKeyId(opened));
        }
      }
    }
  });
});
