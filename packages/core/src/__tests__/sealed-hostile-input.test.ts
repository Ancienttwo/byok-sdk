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
import { memberChainEntryHash, signMemberChainEntry, verifyMemberChainEntry } from '../sealed-payload/member-chain';
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
  'openScopeKeyPackage package': (h) => openScopeKeyPackage({ package: h, expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 }, recipient: { memberId: 'M'.repeat(43), kemPublicJwk: JWK, kemPrivateKey: {} as never }, senderSigningPublicJwk: JWK }),
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

describe('sealed entry points with hostile JavaScript objects', () => {
  for (const [entryPoint, call] of Object.entries(ENTRY_POINTS)) {
    it(`${entryPoint}: typed for every hostile object`, async () => {
      const outcomes: Record<string, string> = {};
      for (const [name, make] of Object.entries(HOSTILE)) outcomes[name] = await outcome(() => call(make()));
      expect(outcomes).toEqual(Object.fromEntries(Object.keys(HOSTILE).map((name) => [name, 'typed'])));
    });
  }
});
