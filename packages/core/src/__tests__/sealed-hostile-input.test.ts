/**
 * Sealed entry points stay typed for hostile JavaScript objects.
 *
 * zod `safeParse` does not catch an error that a getter or a proxy trap throws
 * while it reads a value, and a revoked proxy throws on any read. Each entry
 * point below parses through `safeParseTotal`, so a receiver returns its typed
 * failure (or throws its typed error) instead of a raw `TypeError`.
 *
 * Wire input comes from `JSON.parse`, which never holds getters or proxies.
 * This is the in-process "never throws" contract, not a Host attack.
 */
import { describe, expect, it } from 'vitest';

import { ByokCoreError } from '../errors';
import { createMemberKeyBundle, parseMemberKeyBundle, verifyMemberKem, type MemberKeyBundleV1 } from '../sealed-payload/member-bundle';
import { memberChainEntryHash, signMemberChainEntry, verifyMemberChainEntry, type MemberChainEntryV1 } from '../sealed-payload/member-chain';
import { applyMemberChainEntries, emptyMemberChainState, verifyMemberChainFromAnchor } from '../sealed-payload/member-chain-walk';
import { memberApprovalCode, memberFingerprint } from '../sealed-payload/member-fingerprint';
import {
  computeClientPairingMac,
  computeDevicePairingMac,
  generatePairingVerificationSecret,
  verifyClientPairingMac,
  verifyDevicePairingMac,
} from '../sealed-payload/pairing-verification';
import type { P256PublicJwk } from '../sealed-payload/primitives';
import type { WebCryptoKey } from '../webcrypto';
import { openScopeKeyPackage } from '../sealed-payload/scope-key';
import { openSealedBlob, sealBlob, sealedBlobAad } from '../sealed-payload/sealed-blob';
import {
  openSealedContent,
  sealContent,
  sealedContentAad,
  sealedContentMac,
  type SealedBinding,
  type SealedContentHeaderV1,
} from '../sealed-payload/sealed-content';
import {
  openProviderProvisioningSecret,
  parseProviderProvisioningRequest,
  providerProvisioningConfigDigest,
  providerSecretAadBytes,
  sealingKeyClaimCanonicalBytes,
  sealingPublicKeyBytes,
} from '../sealed-provider-secret';

const trap = (): never => {
  throw new TypeError('hostile trap');
};

/** A throwing getter, each throwing proxy trap that a parse can reach, and a revoked proxy. */
const HOSTILE: Record<string, () => object> = {
  'throwing getter': () => ({
    get value(): string {
      throw new TypeError('hostile getter');
    },
  }),
  'getPrototypeOf trap': () => new Proxy({}, { getPrototypeOf: trap }),
  'ownKeys trap': () => new Proxy({}, { ownKeys: trap }),
  'get trap': () => new Proxy({}, { get: trap }),
  'getOwnPropertyDescriptor trap': () => new Proxy({ value: 1 }, { getOwnPropertyDescriptor: trap }),
  'has trap': () => new Proxy({}, { has: trap }),
  'revoked proxy': () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    return revocable.proxy;
  },
};

const JWK = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) } as const;
const BINDING: SealedBinding = {
  tenantId: 'tenant-1',
  family: 'task.offer_for_agent',
  direction: 'server-to-daemon',
  identity: { taskId: 'task-1' },
  deviceId: 'device-1',
  agentRef: null,
  categories: ['task-input'],
  notAfter: null,
};
const HEADER: SealedContentHeaderV1 = {
  v: 1,
  suite: 'byok-sealed-v1.hkdf-sha256.aes-256-gcm',
  category: 'task-input',
  scope: { id: 'scope-1', epoch: 1, keyId: 'A'.repeat(22) },
  chainHead: { seq: 1, hash: `sha256:${'1'.repeat(64)}` },
  sender: 'M'.repeat(43),
  salt: 'A'.repeat(43),
  nonce: 'A'.repeat(16),
  paddedLength: 256,
  contentMac: `hmac-sha256:${'0'.repeat(64)}`,
};
const SCOPE_KEY = new Uint8Array(32).fill(3);
const SEAL = {
  scopeKey: SCOPE_KEY,
  scope: { id: 'scope-1', epoch: 1 },
  chainHead: { seq: 1, hash: `sha256:${'1'.repeat(64)}` },
  sender: 'M'.repeat(43),
  category: 'task-input',
  binding: BINDING,
} as const;
const ENTRY = { v: 1, tenantId: 'tenant-1', seq: 1, prev: null, op: 'scope-policy', subject: {}, signer: 'M'.repeat(43) } as const;

/**
 * `typed` when the call returns or throws a `ByokCoreError`; otherwise the
 * raw error. A proxy with only a `get` or `has` trap has no own keys, so it
 * can read as a valid `{}`; a return is then correct.
 */
async function outcome(call: () => unknown): Promise<string> {
  try {
    await call();
    return 'typed';
  } catch (error) {
    return error instanceof ByokCoreError ? 'typed' : `raw: ${String(error)}`;
  }
}

/** Each entry point, with the hostile object in one untrusted parameter. */
const ENTRY_POINTS: Record<string, (hostile: object) => unknown> = {
  'openSealedContent header': (h) => openSealedContent({ header: h, ciphertext: new Uint8Array(272), scopeKey: SCOPE_KEY, binding: BINDING, sealing: { scopeId: 'scope-1', epoch: 1 }, maxContentLength: 1024 }),
  'openSealedContent binding': (h) => openSealedContent({ header: HEADER, ciphertext: new Uint8Array(272), scopeKey: SCOPE_KEY, binding: h as never, sealing: { scopeId: 'scope-1', epoch: 1 }, maxContentLength: 1024 }),
  'openSealedContent binding identity': (h) => openSealedContent({ header: HEADER, ciphertext: new Uint8Array(272), scopeKey: SCOPE_KEY, binding: { ...BINDING, identity: h as never }, sealing: { scopeId: 'scope-1', epoch: 1 }, maxContentLength: 1024 }),
  'openSealedContent sealing': (h) => openSealedContent({ header: HEADER, ciphertext: new Uint8Array(272), scopeKey: SCOPE_KEY, binding: BINDING, sealing: h as never, maxContentLength: 1024 }),
  'openSealedBlob header': (h) => openSealedBlob({ header: h as never, binding: BINDING, scopeKey: SCOPE_KEY, fieldPath: '/instruction/blobRef', params: {}, ciphertext: new Uint8Array(272), maxContentLength: 1024 }),
  'openSealedBlob binding': (h) => openSealedBlob({ header: HEADER, binding: h as never, scopeKey: SCOPE_KEY, fieldPath: '/instruction/blobRef', params: {}, ciphertext: new Uint8Array(272), maxContentLength: 1024 }),
  'openSealedBlob params': (h) => openSealedBlob({ header: HEADER, binding: BINDING, scopeKey: SCOPE_KEY, fieldPath: '/instruction/blobRef', params: h, ciphertext: new Uint8Array(272), maxContentLength: 1024 }),
  'openScopeKeyPackage package': (h) => openScopeKeyPackage({ package: h, expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 }, recipient: { memberId: 'M'.repeat(43), kemPublicJwk: JWK, kemPrivateKey: {} as never, kemEpoch: 1 }, senderSigningPublicJwk: JWK }),
  'verifyMemberChainEntry entry': (h) => verifyMemberChainEntry(h, JWK),
  'verifyMemberChainEntry subject': (h) => verifyMemberChainEntry({ ...ENTRY, subject: h, sig: 'A'.repeat(86) }, JWK),
  'sealContent binding': (h) => sealContent({ ...SEAL, binding: h as never, plaintext: { input: 'hello' }, maxContentLength: 1024 }),
  'sealContent plaintext': (h) => sealContent({ ...SEAL, plaintext: h as never, maxContentLength: 1024 }),
  'sealedContentMac binding': (h) => sealedContentMac({ scopeKey: SCOPE_KEY, category: 'task-input', binding: h as never, plaintext: { input: 'hello' } }),
  'sealedContentAad header': (h) => sealedContentAad(h as never, BINDING),
  'sealedContentAad binding': (h) => sealedContentAad(HEADER, h as never),
  'sealBlob binding': (h) => sealBlob({ ...SEAL, binding: h as never, fieldPath: '/instruction/blobRef', bytes: new Uint8Array(1), maxContentLength: 1024 }),
  'sealedBlobAad header': (h) => sealedBlobAad(h as never, BINDING, 256, '/instruction/blobRef'),
  'memberChainEntryHash entry': (h) => memberChainEntryHash(h as never),
  'memberChainEntryHash subject': (h) => memberChainEntryHash({ ...ENTRY, subject: h as never }),
  'signMemberChainEntry entry': (h) => signMemberChainEntry(h as never, { publicJwk: JWK, privateKey: {} as never }),
  'parseProviderProvisioningRequest input': (h) => parseProviderProvisioningRequest(h),
  'openProviderProvisioningSecret request': (h) => openProviderProvisioningSecret({ request: h as never, recipient: { keyId: 'A'.repeat(22), publicJwk: JWK, privateKey: {} as never } }),
  'providerProvisioningConfigDigest config': (h) => providerProvisioningConfigDigest(h as never),
  'providerSecretAadBytes header': (h) => providerSecretAadBytes(h as never, 'A'.repeat(22)),
  'sealingKeyClaimCanonicalBytes claim': (h) => sealingKeyClaimCanonicalBytes(h as never),
  'sealingPublicKeyBytes publicJwk': (h) => sealingPublicKeyBytes(h as never),
};

/** Real members and a real chain for the E2 entry points: a client genesis, then the client adds a device. */
async function p256Pair(name: 'ECDSA' | 'ECDH'): Promise<{ publicJwk: P256PublicJwk; privateKey: WebCryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name, namedCurve: 'P-256' }, true, name === 'ECDSA' ? ['sign', 'verify'] : ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, privateKey: pair.privateKey };
}

async function newMember(deviceId?: string): Promise<{ bundle: MemberKeyBundleV1; signing: { publicJwk: P256PublicJwk; privateKey: WebCryptoKey } }> {
  const signing = await p256Pair('ECDSA');
  const bundle = await createMemberKeyBundle({
    signingPublicJwk: signing.publicJwk,
    signingPrivateKey: signing.privateKey,
    kemPublicJwk: (await p256Pair('ECDH')).publicJwk,
    kemEpoch: 1,
    ...(deviceId === undefined ? {} : { deviceId }),
  });
  return { bundle, signing };
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const client = await newMember();
const device = await newMember('device-1');
const genesis = await signMemberChainEntry(
  { v: 1, tenantId: 'tenant-1', seq: 1, prev: null, op: 'add', subject: { member: json(client.bundle) as never }, signer: client.bundle.memberId },
  client.signing,
);
const addDevice = await signMemberChainEntry(
  {
    v: 1,
    tenantId: 'tenant-1',
    seq: 2,
    prev: await memberChainEntryHash((({ sig: _sig, ...unsigned }) => unsigned)(genesis)),
    op: 'add',
    subject: { member: json(device.bundle) as never },
    signer: client.bundle.memberId,
  },
  client.signing,
);
const CHAIN: readonly MemberChainEntryV1[] = [genesis, addDevice];
const PV = generatePairingVerificationSecret();
const HEAD = { seq: 2, hash: `sha256:${'1'.repeat(64)}` };
const MAC = 'A'.repeat(43);
const anchorInput = { tenantId: 'tenant-1', entries: CHAIN, self: device.bundle, approverSigningPublicJwk: client.signing.publicJwk };
const genesisWith = (subject: object) => ({ ...ENTRY, op: 'add', subject, sig: 'A'.repeat(86) });

/** E2 builders: each returns or throws a `ByokCoreError`. */
const E2_BUILDERS: Record<string, (hostile: object) => unknown> = {
  'createMemberKeyBundle signingPublicJwk': (h) => createMemberKeyBundle({ signingPublicJwk: h as never, signingPrivateKey: client.signing.privateKey, kemPublicJwk: JWK, kemEpoch: 1 }),
  'createMemberKeyBundle kemPublicJwk': (h) => createMemberKeyBundle({ signingPublicJwk: client.signing.publicJwk, signingPrivateKey: client.signing.privateKey, kemPublicJwk: h as never, kemEpoch: 1 }),
  'memberFingerprint signingPublicJwk': (h) => memberFingerprint({ tenantId: 'tenant-1', signingPublicJwk: h as never }),
  'memberApprovalCode first': (h) => memberApprovalCode('tenant-1', h as never, client.signing.publicJwk),
  'computeDevicePairingMac member': (h) => computeDevicePairingMac(PV, { tenantId: 'tenant-1', deviceId: 'device-1', member: h as never }),
  'computeDevicePairingMac member signingPublicJwk': (h) => computeDevicePairingMac(PV, { tenantId: 'tenant-1', deviceId: 'device-1', member: { ...device.bundle, signingPublicJwk: h as never } }),
  'computeClientPairingMac member': (h) => computeClientPairingMac(PV, { member: h as never, chainHead: HEAD }),
  'computeClientPairingMac chainHead': (h) => computeClientPairingMac(PV, { member: client.bundle, chainHead: h as never }),
};

/** E2 receivers that never throw: each returns its failure value for every hostile object. */
const E2_RECEIVERS: Record<string, readonly [(hostile: object) => Promise<unknown>, (result: unknown) => boolean]> = {
  'parseMemberKeyBundle value': [(h) => parseMemberKeyBundle(h), (r) => r === undefined],
  'parseMemberKeyBundle signingPublicJwk': [(h) => parseMemberKeyBundle({ ...device.bundle, signingPublicJwk: h }), (r) => r === undefined],
  'verifyMemberKem member': [(h) => verifyMemberKem(h as never, device.bundle), (r) => r === false],
  'verifyMemberKem kem': [(h) => verifyMemberKem(device.bundle, h as never), (r) => r === false],
  'verifyMemberKem kemPublicJwk': [(h) => verifyMemberKem(device.bundle, { ...device.bundle, kemPublicJwk: h as never }), (r) => r === false],
  'verifyDevicePairingMac member': [(h) => verifyDevicePairingMac(PV, { tenantId: 'tenant-1', deviceId: 'device-1', member: h as never }, MAC), (r) => r === false],
  'verifyDevicePairingMac mac': [(h) => verifyDevicePairingMac(PV, { tenantId: 'tenant-1', deviceId: 'device-1', member: device.bundle }, h), (r) => r === false],
  'verifyClientPairingMac member': [(h) => verifyClientPairingMac(PV, { member: h as never, chainHead: HEAD }, MAC), (r) => r === false],
  'verifyClientPairingMac chainHead': [(h) => verifyClientPairingMac(PV, { member: client.bundle, chainHead: h as never }, MAC), (r) => r === false],
  'verifyClientPairingMac mac': [(h) => verifyClientPairingMac(PV, { member: client.bundle, chainHead: HEAD }, h), (r) => r === false],
  'applyMemberChainEntries entries': [(h) => applyMemberChainEntries(emptyMemberChainState('tenant-1'), h as never), (r) => (r as { ok: boolean }).ok === false],
  'applyMemberChainEntries entry': [(h) => applyMemberChainEntries(emptyMemberChainState('tenant-1'), [h]), (r) => (r as { ok: boolean }).ok === false],
  'applyMemberChainEntries genesis subject': [(h) => applyMemberChainEntries(emptyMemberChainState('tenant-1'), [genesisWith(h)]), (r) => (r as { ok: boolean }).ok === false],
  'applyMemberChainEntries genesis member': [(h) => applyMemberChainEntries(emptyMemberChainState('tenant-1'), [genesisWith({ member: h })]), (r) => (r as { ok: boolean }).ok === false],
  'verifyMemberChainFromAnchor entry': [(h) => verifyMemberChainFromAnchor({ ...anchorInput, entries: [genesis, h] }), (r) => (r as { ok: boolean }).ok === false],
  'verifyMemberChainFromAnchor genesis subject': [(h) => verifyMemberChainFromAnchor({ ...anchorInput, entries: [genesisWith(h)] }), (r) => (r as { ok: boolean }).ok === false],
  'verifyMemberChainFromAnchor self': [(h) => verifyMemberChainFromAnchor({ ...anchorInput, self: h as never }), (r) => (r as { ok: boolean }).ok === false],
  'verifyMemberChainFromAnchor approverSigningPublicJwk': [(h) => verifyMemberChainFromAnchor({ ...anchorInput, approverSigningPublicJwk: h as never }), (r) => (r as { ok: boolean }).ok === false],
  'verifyMemberChainFromAnchor authenticatedHead': [(h) => verifyMemberChainFromAnchor({ ...anchorInput, authenticatedHead: h as never }), (r) => (r as { ok: boolean }).ok === false],
};

/**
 * One field of an otherwise valid input made hostile. The second-read getter
 * returns the real value once and then throws: it catches a field that is
 * read again after the total parse instead of from the parsed copy.
 */
function hostileField(base: object, field: string): Record<string, () => object> {
  const value = (base as Record<string, unknown>)[field];
  const withGetter = (get: () => unknown) => Object.defineProperty({ ...base }, field, { get, enumerable: true, configurable: true });
  return {
    'throwing getter': () => withGetter(trap),
    'get trap on the field': () => new Proxy({ ...base }, { get: (target, key) => (key === field ? trap() : Reflect.get(target, key)) }),
    'second-read getter': () => {
      let reads = 0;
      return withGetter(() => (reads++ === 0 ? value : trap()));
    },
    'revoked proxy value': () => ({ ...base, [field]: HOSTILE['revoked proxy']!() }),
  };
}

const createInput = { signingPublicJwk: client.signing.publicJwk, signingPrivateKey: client.signing.privateKey, kemPublicJwk: device.bundle.kemPublicJwk, kemEpoch: 1, deviceId: 'device-9' };
const fingerprintInput = { tenantId: 'tenant-1', signingPublicJwk: client.signing.publicJwk };
const deviceMacInput = { tenantId: 'tenant-1', deviceId: 'device-1', member: device.bundle };
const clientMacInput = { member: client.bundle, chainHead: HEAD };

/** Each E2 export, its valid input, and the fields to make hostile. Receivers must not throw at all. */
const E2_FIELDS: readonly { readonly name: string; readonly base: object; readonly fields: readonly string[]; readonly receiver: boolean; readonly call: (input: object) => unknown }[] = [
  { name: 'createMemberKeyBundle', base: createInput, fields: Object.keys(createInput), receiver: false, call: (i) => createMemberKeyBundle(i as never) },
  { name: 'memberFingerprint', base: fingerprintInput, fields: Object.keys(fingerprintInput), receiver: false, call: (i) => memberFingerprint(i as never) },
  { name: 'memberFingerprint signingPublicJwk', base: client.signing.publicJwk, fields: ['x', 'y'], receiver: false, call: (i) => memberFingerprint({ tenantId: 'tenant-1', signingPublicJwk: i as never }) },
  { name: 'memberApprovalCode first', base: client.signing.publicJwk, fields: ['x', 'y'], receiver: false, call: (i) => memberApprovalCode('tenant-1', i as never, device.signing.publicJwk) },
  { name: 'computeDevicePairingMac', base: deviceMacInput, fields: Object.keys(deviceMacInput), receiver: false, call: (i) => computeDevicePairingMac(PV, i as never) },
  { name: 'computeClientPairingMac', base: clientMacInput, fields: Object.keys(clientMacInput), receiver: false, call: (i) => computeClientPairingMac(PV, i as never) },
  { name: 'verifyDevicePairingMac', base: deviceMacInput, fields: Object.keys(deviceMacInput), receiver: true, call: (i) => verifyDevicePairingMac(PV, i as never, MAC) },
  { name: 'verifyClientPairingMac', base: clientMacInput, fields: Object.keys(clientMacInput), receiver: true, call: (i) => verifyClientPairingMac(PV, i as never, MAC) },
  { name: 'verifyMemberChainFromAnchor', base: { ...anchorInput, authenticatedHead: HEAD }, fields: [...Object.keys(anchorInput), 'authenticatedHead'], receiver: true, call: (i) => verifyMemberChainFromAnchor(i as never) },
  { name: 'verifyMemberChainFromAnchor approverSigningPublicJwk', base: client.signing.publicJwk, fields: ['x', 'y'], receiver: true, call: (i) => verifyMemberChainFromAnchor({ ...anchorInput, approverSigningPublicJwk: i as never }) },
];

/**
 * A subject that passes its first inspection and throws on the next one: the
 * second `ownKeys` call, and every trap after it, throws. It catches a parse
 * that checks the caller's object and then reads that object again.
 */
function secondInspectionThrows(): object {
  let inspections = 0;
  let armed = false;
  const guard = <T>(read: () => T): T => {
    if (armed) trap();
    return read();
  };
  return new Proxy({ scopeId: 'scope-1' }, {
    ownKeys: (target) => {
      inspections += 1;
      if (inspections > 1) armed = true;
      return guard(() => Reflect.ownKeys(target));
    },
    get: (target, key) => guard(() => Reflect.get(target, key)),
    getOwnPropertyDescriptor: (target, key) => guard(() => Reflect.getOwnPropertyDescriptor(target, key)),
    getPrototypeOf: (target) => guard(() => Reflect.getPrototypeOf(target)),
    has: (target, key) => guard(() => Reflect.has(target, key)),
  });
}

describe('member chain entries whose subject throws on the second inspection', () => {
  const unsigned = (subject: object): Record<string, unknown> => ({ ...ENTRY, op: 'shred', subject, signer: client.bundle.memberId });
  const typedCalls: Record<string, (subject: object) => unknown> = {
    memberChainEntryHash: (subject) => memberChainEntryHash(unsigned(subject) as never),
    signMemberChainEntry: (subject) => signMemberChainEntry(unsigned(subject) as never, client.signing),
  };
  for (const [name, call] of Object.entries(typedCalls)) {
    it(`${name}: returns or throws a ByokCoreError`, async () => {
      await expect(outcome(() => call(secondInspectionThrows()))).resolves.toBe('typed');
    });
  }

  const receivers: Record<string, (subject: object) => Promise<{ readonly ok: boolean }>> = {
    verifyMemberChainEntry: (subject) => verifyMemberChainEntry({ ...unsigned(subject), sig: 'A'.repeat(86) }, client.signing.publicJwk),
    applyMemberChainEntries: (subject) => applyMemberChainEntries(emptyMemberChainState('tenant-1'), [{ ...genesisWith(subject), signer: client.bundle.memberId }]),
    verifyMemberChainFromAnchor: (subject) => verifyMemberChainFromAnchor({ ...anchorInput, entries: [genesis, { ...addDevice, subject }] }),
  };
  for (const [name, call] of Object.entries(receivers)) {
    it(`${name}: returns a failure and does not throw`, async () => {
      await expect(call(secondInspectionThrows())).resolves.toMatchObject({ ok: false });
    });
  }

  // A signed non-genesis entry whose `subject` getter returns the signed value once, then throws.
  const subjectReadOnce = (entry: MemberChainEntryV1): object => {
    let reads = 0;
    return Object.defineProperty({ ...entry }, 'subject', { get: () => (reads++ === 0 ? entry.subject : trap()), enumerable: true });
  };
  it('applyMemberChainEntries: reads a signed subject once', async () => {
    const afterGenesis = await applyMemberChainEntries(emptyMemberChainState('tenant-1'), [genesis]);
    if (!afterGenesis.ok) throw new Error('the genesis fixture must apply');
    await expect(applyMemberChainEntries(afterGenesis.state, [subjectReadOnce(addDevice)])).resolves.toMatchObject({ ok: true });
  });
  it('verifyMemberChainFromAnchor: reads a signed subject once', async () => {
    await expect(verifyMemberChainFromAnchor({ ...anchorInput, entries: [genesis, subjectReadOnce(addDevice)] })).resolves.toMatchObject({ ok: true, anchorSeq: 2 });
  });
});

describe('E2 member entry points with one hostile field', () => {
  for (const { name, base, fields, receiver, call } of E2_FIELDS) {
    for (const field of fields) {
      it(`${name} ${field}: ${receiver ? 'never throws' : 'typed'} for every hostile field`, async () => {
        const outcomes: Record<string, string> = {};
        for (const [variant, make] of Object.entries(hostileField(base, field))) {
          try {
            await call(make());
            outcomes[variant] = 'ok';
          } catch (error) {
            outcomes[variant] = !receiver && error instanceof ByokCoreError ? 'ok' : `threw: ${String(error)}`;
          }
        }
        expect(outcomes).toEqual({ 'throwing getter': 'ok', 'get trap on the field': 'ok', 'second-read getter': 'ok', 'revoked proxy value': 'ok' });
      });
    }
  }
});

describe('E2 member entry points with hostile JavaScript objects', () => {
  it('the fixtures are valid: the anchor check accepts the real chain', async () => {
    await expect(verifyMemberChainFromAnchor(anchorInput)).resolves.toMatchObject({ ok: true, anchorSeq: 2 });
  });

  for (const [entryPoint, call] of Object.entries(E2_BUILDERS)) {
    it(`${entryPoint}: typed for every hostile object`, async () => {
      const outcomes: Record<string, string> = {};
      for (const [name, make] of Object.entries(HOSTILE)) outcomes[name] = await outcome(() => call(make()));
      expect(outcomes).toEqual(Object.fromEntries(Object.keys(HOSTILE).map((name) => [name, 'typed'])));
    });
  }

  for (const [entryPoint, [call, isFailure]] of Object.entries(E2_RECEIVERS)) {
    it(`${entryPoint}: returns its failure value for every hostile object`, async () => {
      const outcomes: Record<string, string> = {};
      for (const [name, make] of Object.entries(HOSTILE)) {
        try {
          outcomes[name] = isFailure(await call(make())) ? 'failure value' : 'accepted';
        } catch (error) {
          outcomes[name] = `threw: ${String(error)}`;
        }
      }
      expect(outcomes).toEqual(Object.fromEntries(Object.keys(HOSTILE).map((name) => [name, 'failure value'])));
    });
  }
});

describe('sealed entry points with hostile JavaScript objects', () => {
  for (const [entryPoint, call] of Object.entries(ENTRY_POINTS)) {
    it(`${entryPoint}: typed for every hostile object`, async () => {
      const outcomes: Record<string, string> = {};
      for (const [name, make] of Object.entries(HOSTILE)) outcomes[name] = await outcome(() => call(make()));
      expect(outcomes).toEqual(Object.fromEntries(Object.keys(HOSTILE).map((name) => [name, 'typed'])));
    });
  }
});
