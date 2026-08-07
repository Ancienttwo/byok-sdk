/**
 * Test support for the cloud handler suites.
 *
 * Two things this file is allowed to do that the shipped source is not: import
 * `node:crypto` (a device's private key lives on a real machine, and the tests
 * play that role) and read the source tree. The shipped source's freedom from
 * both is what `constraints.test.ts` asserts.
 *
 * Requests go straight through `cloud.fetch` — no HTTP server. The handlers
 * are WHATWG fetch handlers, so a `Request` in and a `Response` out is the
 * whole contract; the end-to-end proof that a REAL daemon over a REAL socket
 * cannot tell this from `@byok/server` lives in
 * `packages/client/src/__tests__/real-cloud-longpoll.test.ts`.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { tenantId, type Clock, type TenantId } from '@byok/core';
import type { PairResponse } from '@byok/protocol';
import { NONCE_SIGNING_DOMAIN } from '../../auth/verify';
import { createInMemoryByokCloud, type InMemoryByokCloud, type InMemoryByokCloudOptions } from '../../composition/in-memory';

export const TENANT_A = tenantId('tenant-a');
export const TENANT_B = tenantId('tenant-b');
export const PRODUCT_ID = 'test-product';

export const CLOUD_ORIGIN = 'http://cloud.test';

export interface DeviceKeys {
  readonly publicKeyBase64Url: string;
  /** Signs `byok-nonce-v1\n` + nonce, exactly as the daemon does. */
  signNonce(nonce: string): string;
  /** Signs the BARE nonce — the pre-domain-separation encoding, which must never verify. */
  signRawNonce(nonce: string): string;
}

export function createDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const x = jwk.x;
  if (x === undefined) throw new Error('ed25519 public key has no JWK x coordinate');
  return {
    publicKeyBase64Url: x,
    signNonce: (nonce) =>
      sign(null, Buffer.from(NONCE_SIGNING_DOMAIN + nonce, 'utf8'), privateKey).toString('base64url'),
    signRawNonce: (nonce) => sign(null, Buffer.from(nonce, 'utf8'), privateKey).toString('base64url'),
  };
}

export interface PairedDevice {
  readonly tenant: TenantId;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly keys: DeviceKeys;
  readonly authorization: { readonly authorization: string };
}

export interface CloudHarness extends InMemoryByokCloud {
  readonly clock: Clock;
  request(path: string, init?: RequestInit): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: unknown }>;
  pairDevice(tenant: TenantId, productId?: string): Promise<PairedDevice>;
}

export function createHarness(options: InMemoryByokCloudOptions = {}): CloudHarness {
  const composition = createInMemoryByokCloud({ longPollHoldMs: 20, longPollIntervalMs: 5, ...options });

  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    Promise.resolve(composition.cloud.fetch(new Request(`${CLOUD_ORIGIN}${path}`, init)));

  return {
    ...composition,
    request,
    async json(path, init) {
      const response = await request(path, init);
      const text = await response.text();
      return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
    },
    async pairDevice(tenant, productId = PRODUCT_ID) {
      const keys = createDeviceKeys();
      const pairing = await composition.cloud.createPairingCode(tenant, { productId });
      const response = await request('/byok/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairingCode: pairing.code,
          deviceName: 'test-device',
          devicePublicKey: keys.publicKeyBase64Url,
        }),
      });
      if (response.status !== 200) throw new Error(`pairing failed: HTTP ${response.status}`);
      const body = (await response.json()) as PairResponse;
      return {
        tenant,
        deviceId: body.deviceId,
        accessToken: body.accessToken,
        keys,
        authorization: { authorization: `Bearer ${body.accessToken}` },
      };
    },
  };
}

/** The minimal valid `task.offer` payload — an instruction plus an auto policy. */
export function offerPayload(instruction = 'do the thing') {
  return { instruction, policy: { mode: 'auto' as const } };
}
