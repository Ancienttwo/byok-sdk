import { readFileSync } from 'node:fs';

import type { WebCryptoKey } from '../webcrypto';
import { describe, expect, it } from 'vitest';

import {
  PROVIDER_SECRET_MAX_BYTES,
  PROVIDER_SECRET_HPKE_SUITE,
  deriveSealingKeyId,
  encodeBase64Url,
  decodeBase64Url,
  openProviderProvisioningSecret,
  padProviderSecret,
  parseProviderProvisioningRequest,
  providerProvisioningConfigDigest,
  providerProvisioningRequestDigest,
  providerSecretAadBytes,
  sealProviderProvisioningRequest,
  sealingKeyClaimCanonicalBytes,
  unpadProviderSecret,
  type ProviderProvisioningConfigV1,
  type ProviderProvisioningHeaderV1,
  type ProviderProvisioningRequestV1,
  type SealingPublicJwk,
} from '../sealed-provider-secret';

const CANARY = 'sk-sealed-canary-7f3a1c';
const PI_MODEL = {
  contextWindow: 200000,
  maxTokens: 32000,
  reasoning: true,
  thinkingLevel: 'medium',
  thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
  compat: { supportsDeveloperRole: false },
};

interface Recipient {
  keyId: string;
  publicJwk: SealingPublicJwk;
  privateKey: WebCryptoKey;
}

async function newRecipient(): Promise<Recipient> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as SealingPublicJwk;
  return { keyId: await deriveSealingKeyId(publicJwk), publicJwk, privateKey: pair.privateKey };
}

const baseHeader = {
  tenantId: 'tenant-1',
  deviceId: 'device-1',
  agentId: 'agent-1',
  requestId: 'request-1',
  operation: 'configure' as const,
  operationGeneration: 7,
  expectedProfile: null,
  expectedEnrollmentRevision: 'enrollment-3',
  expectedPlacementRevision: 'placement-9',
  issuedAt: '2026-09-28T00:00:00.000Z',
  expiresAt: '2026-09-28T00:15:00.000Z',
};

const configureConfig: ProviderProvisioningConfigV1 = {
  operation: 'configure',
  agentId: 'agent-1',
  providerKind: 'zai',
  modelId: 'glm-5.3-flash',
  piModel: PI_MODEL,
  capabilities: [],
};

async function sealedConfigure(recipient: Recipient, secret = CANARY): Promise<ProviderProvisioningRequestV1> {
  return sealProviderProvisioningRequest({ header: baseHeader, config: configureConfig, recipient, secret });
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message, String((current as { code?: string }).code));
    current = current.cause;
  }
  return parts.join('\n');
}

describe('sealed provider provisioning round trip', () => {
  it('seals once and opens to the exact secret', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    expect(request.sealed?.suite).toBe(PROVIDER_SECRET_HPKE_SUITE);
    expect(request.header.configDigest).toBe(await providerProvisioningConfigDigest(configureConfig));
    expect(JSON.stringify(request)).not.toContain(CANARY);
    await expect(openProviderProvisioningSecret({ request, recipient })).resolves.toBe(CANARY);
  });

  it('hides the secret length inside 256-byte blocks', async () => {
    const recipient = await newRecipient();
    const short = await sealedConfigure(recipient, 'a');
    const longer = await sealedConfigure(recipient, 'a'.repeat(200));
    expect(decodeBase64Url(short.sealed!.ciphertext, 'ct').byteLength).toBe(256 + 16);
    expect(decodeBase64Url(longer.sealed!.ciphertext, 'ct').byteLength).toBe(256 + 16);
  });

  it('builds secret-free requests for update_model and delete', async () => {
    const update = await sealProviderProvisioningRequest({
      header: { ...baseHeader, operation: 'update_model' },
      config: { ...configureConfig, operation: 'update_model' },
    });
    expect(update.sealed).toBeUndefined();
    const del = await sealProviderProvisioningRequest({
      header: { ...baseHeader, operation: 'delete' },
      config: { operation: 'delete', agentId: 'agent-1' },
    });
    expect(del.sealed).toBeUndefined();
    await expect(sealProviderProvisioningRequest({
      header: { ...baseHeader, operation: 'delete' },
      config: { operation: 'delete', agentId: 'agent-1' },
      secret: CANARY,
    })).rejects.toMatchObject({ code: 'provider_provisioning_request_invalid' });
  });

  it('refuses a recipient whose key id does not match its public key', async () => {
    const recipient = await newRecipient();
    const other = await newRecipient();
    await expect(sealProviderProvisioningRequest({
      header: baseHeader, config: configureConfig, recipient: { keyId: other.keyId, publicJwk: recipient.publicJwk }, secret: CANARY,
    })).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
  });
});

describe('AAD binding: tampering any header field fails authentication', () => {
  const mutations: Array<[keyof ProviderProvisioningHeaderV1, unknown]> = [
    ['tenantId', 'tenant-2'],
    ['deviceId', 'device-2'],
    ['requestId', 'request-2'],
    ['operationGeneration', 8],
    ['expectedProfile', { profileRef: 'salesko-agent1', profileRevision: '1', profileHash: `sha256:${'0'.repeat(64)}` }],
    ['expectedEnrollmentRevision', 'enrollment-4'],
    ['expectedPlacementRevision', 'placement-10'],
    ['issuedAt', '2026-09-28T00:00:01.000Z'],
    ['expiresAt', '2026-09-28T00:14:59.000Z'],
  ];

  it.each(mutations)('%s', async (field, value) => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    const tampered = { ...request, header: { ...request.header, [field]: value } };
    await expect(openProviderProvisioningSecret({ request: tampered, recipient }))
      .rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
  });

  it('agentId (header and config together) fails authentication', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    const config = { ...request.config, agentId: 'agent-2' };
    const tampered = {
      ...request,
      config,
      header: { ...request.header, agentId: 'agent-2', configDigest: await providerProvisioningConfigDigest(config) },
    };
    await expect(openProviderProvisioningSecret({ request: tampered, recipient }))
      .rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
  });

  it('operation (header and config together, same secret-bearing shape) fails authentication', async () => {
    const recipient = await newRecipient();
    const request = await sealProviderProvisioningRequest({
      header: { ...baseHeader, operation: 'replace_secret' },
      config: { operation: 'replace_secret', agentId: 'agent-1', providerKind: 'zai' },
      recipient,
      secret: CANARY,
    });
    const config = configureConfig;
    const tampered = {
      ...request,
      config,
      header: { ...request.header, operation: 'configure' as const, configDigest: await providerProvisioningConfigDigest(config) },
    };
    await expect(openProviderProvisioningSecret({ request: tampered, recipient }))
      .rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
  });

  it('a config change with a recomputed digest fails authentication', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    const config = { ...configureConfig, providerKind: 'openai' };
    const tampered = { ...request, config, header: { ...request.header, configDigest: await providerProvisioningConfigDigest(config) } };
    await expect(openProviderProvisioningSecret({ request: tampered, recipient }))
      .rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
  });

  it('a config change without a new digest fails the digest check', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    const tampered = { ...request, config: { ...configureConfig, modelId: 'glm-5.3' } };
    await expect(openProviderProvisioningSecret({ request: tampered, recipient }))
      .rejects.toMatchObject({ code: 'provider_provisioning_request_invalid' });
  });

  it('a swapped key id or a different recipient key is refused', async () => {
    const recipient = await newRecipient();
    const other = await newRecipient();
    const request = await sealedConfigure(recipient);
    await expect(openProviderProvisioningSecret({ request, recipient: other }))
      .rejects.toMatchObject({ code: 'sealed_secret_invalid' });
    const relabeled = { ...request, sealed: { ...request.sealed!, keyId: other.keyId } };
    await expect(openProviderProvisioningSecret({ request: relabeled, recipient: other }))
      .rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
  });

  it('tampered, truncated, or re-blocked ciphertext is refused', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    const ct = decodeBase64Url(request.sealed!.ciphertext, 'ct');
    const flipped = new Uint8Array(ct);
    flipped[3]! ^= 1;
    await expect(openProviderProvisioningSecret({ request: { ...request, sealed: { ...request.sealed!, ciphertext: encodeBase64Url(flipped) } }, recipient }))
      .rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
    await expect(openProviderProvisioningSecret({ request: { ...request, sealed: { ...request.sealed!, ciphertext: encodeBase64Url(ct.subarray(0, ct.length - 1)) } }, recipient }))
      .rejects.toMatchObject({ code: 'sealed_secret_invalid' });
  });
});

describe('request schema', () => {
  it('rejects an unknown suite, version, or extra field', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    for (const bad of [
      { ...request, sealed: { ...request.sealed!, suite: 'hpke-base.dhkem-x25519-hkdf-sha256.hkdf-sha256.aes-128-gcm' } },
      { ...request, version: 2 },
      { ...request, extra: true },
      { ...request, header: { ...request.header, info: 'byok-sdk.provider-secret.v2' } },
    ]) {
      expect(() => parseProviderProvisioningRequest(bad)).toThrow(expect.objectContaining({ code: 'provider_provisioning_request_invalid' }));
    }
  });

  it('requires a sealed secret exactly for configure and replace_secret', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    const { sealed, ...withoutSealed } = request;
    expect(() => parseProviderProvisioningRequest(withoutSealed)).toThrow(expect.objectContaining({ code: 'provider_provisioning_request_invalid' }));
    const update = await sealProviderProvisioningRequest({
      header: { ...baseHeader, operation: 'update_model' },
      config: { ...configureConfig, operation: 'update_model' },
    });
    expect(() => parseProviderProvisioningRequest({ ...update, sealed })).toThrow(expect.objectContaining({ code: 'provider_provisioning_request_invalid' }));
  });

  it('rejects mismatched header/config operation or agent', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    expect(() => parseProviderProvisioningRequest({ ...request, config: { ...request.config, agentId: 'agent-9' } }))
      .toThrow(expect.objectContaining({ code: 'provider_provisioning_request_invalid' }));
    expect(() => parseProviderProvisioningRequest({ ...request, header: { ...request.header, operation: 'replace_secret' } }))
      .toThrow(expect.objectContaining({ code: 'provider_provisioning_request_invalid' }));
  });

  it('rejects fields an operation does not act on', () => {
    expect(() => parseProviderProvisioningRequest({
      version: 1,
      header: { ...baseHeader, operation: 'delete', configDigest: `sha256:${'0'.repeat(64)}` },
      config: { operation: 'delete', agentId: 'agent-1', modelId: 'glm-5.3-flash' },
    })).toThrow(expect.objectContaining({ code: 'provider_provisioning_request_invalid' }));
  });

  it('digests the complete request deterministically', async () => {
    const recipient = await newRecipient();
    const request = await sealedConfigure(recipient);
    const reordered = JSON.parse(JSON.stringify({ sealed: request.sealed, config: request.config, header: request.header, version: 1 }));
    expect(await providerProvisioningRequestDigest(reordered)).toBe(await providerProvisioningRequestDigest(request));
    const other = await sealedConfigure(recipient);
    expect(await providerProvisioningRequestDigest(other)).not.toBe(await providerProvisioningRequestDigest(request));
  });
});

describe('padding', () => {
  it('pads to 256-byte multiples with a 2-byte length prefix', () => {
    expect(padProviderSecret('a').byteLength).toBe(256);
    expect(padProviderSecret('a'.repeat(254)).byteLength).toBe(256);
    expect(padProviderSecret('a'.repeat(255)).byteLength).toBe(512);
    expect(padProviderSecret('a'.repeat(PROVIDER_SECRET_MAX_BYTES)).byteLength).toBe(4096);
    for (const value of ['a', 'é中文', 'x'.repeat(1000)]) expect(unpadProviderSecret(padProviderSecret(value))).toBe(value);
  });

  it('rejects empty and oversize secrets', () => {
    expect(() => padProviderSecret('')).toThrow(expect.objectContaining({ code: 'sealed_secret_invalid' }));
    expect(() => padProviderSecret('a'.repeat(PROVIDER_SECRET_MAX_BYTES + 1))).toThrow(expect.objectContaining({ code: 'sealed_secret_invalid' }));
  });

  it('rejects malformed padding strictly', () => {
    const good = padProviderSecret('abc');
    const nonZero = new Uint8Array(good);
    nonZero[200] = 1;
    const zeroLength = new Uint8Array(good);
    zeroLength[1] = 0;
    const overlong = new Uint8Array(good);
    overlong[0] = 0xff;
    const extraBlock = new Uint8Array(512);
    extraBlock.set(good);
    const badUtf8 = new Uint8Array(good);
    badUtf8[2] = 0xff;
    for (const bad of [nonZero, zeroLength, overlong, extraBlock, badUtf8, good.subarray(0, 255)]) {
      expect(() => unpadProviderSecret(bad)).toThrow(expect.objectContaining({ code: 'sealed_secret_invalid' }));
    }
  });
});

describe('golden canonical bytes', () => {
  const golden = JSON.parse(readFileSync(new URL('./golden/provider-secret-v1.canonical.json', import.meta.url), 'utf8')) as {
    header: ProviderProvisioningHeaderV1;
    keyId: string;
    aad: string;
    config: ProviderProvisioningConfigV1;
    configDigest: string;
    claim: Parameters<typeof sealingKeyClaimCanonicalBytes>[0];
    claimBytes: string;
    derivedKeyId: string;
  };

  it('freezes the AAD bytes', () => {
    expect(new TextDecoder().decode(providerSecretAadBytes(golden.header, golden.keyId))).toBe(golden.aad);
  });

  it('freezes the config digest', async () => {
    expect(await providerProvisioningConfigDigest(golden.config)).toBe(golden.configDigest);
  });

  it('freezes the sealing-key claim bytes and key id rule', async () => {
    expect(new TextDecoder().decode(sealingKeyClaimCanonicalBytes(golden.claim))).toBe(golden.claimBytes);
    expect(await deriveSealingKeyId(golden.claim.publicJwk)).toBe(golden.derivedKeyId);
    expect(golden.claim.keyId).toBe(golden.derivedKeyId);
  });
});

describe('no plaintext in errors', () => {
  it('keeps the secret out of every failure message and cause', async () => {
    const recipient = await newRecipient();
    const other = await newRecipient();
    const request = await sealedConfigure(recipient);
    const failures: unknown[] = [];
    for (const attempt of [
      () => openProviderProvisioningSecret({ request, recipient: other }),
      () => openProviderProvisioningSecret({ request: { ...request, header: { ...request.header, requestId: 'x' } }, recipient }),
      () => sealProviderProvisioningRequest({ header: baseHeader, config: { ...configureConfig, modelId: '' }, recipient, secret: CANARY }),
      () => sealProviderProvisioningRequest({ header: { ...baseHeader, operation: 'delete' }, config: { operation: 'delete', agentId: 'agent-1' }, secret: CANARY }),
    ]) {
      await attempt().then(() => failures.push(new Error('unexpected success')), (error: unknown) => failures.push(error));
    }
    expect(failures).toHaveLength(4);
    for (const failure of failures) expect(errorText(failure)).not.toContain(CANARY);
  });
});
