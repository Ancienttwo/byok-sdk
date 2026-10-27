import { createInProcessMailboxWake } from '@byok-sdk/cloud';
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
 * cannot tell this from `@byok-sdk/server` lives in
 * `packages/client/src/__tests__/real-cloud-longpoll.test.ts`.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { tenantId, type Clock, type TenantId } from '@byok-sdk/core';
import { EventsPollResponseSchema, parseMessage, type Envelope, type EventsPollResponse, type PairResponse } from '@byok-sdk/protocol';
import { NONCE_SIGNING_DOMAIN } from '../../auth/verify';
import { AGENT_HOME_CONTRACT_CAPABILITY } from '../../cloud';
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
  /** `machineId` is the optional client-hashed physical machine identity (protocol §6.1) — omitted from the body entirely when not supplied. */
  pairDevice(tenant: TenantId, productId?: string, machineId?: string): Promise<PairedDevice>;
}

export function createHarness(options: InMemoryByokCloudOptions = {}): CloudHarness {
  const composition = createInMemoryByokCloud({ longPollHoldMs: 20, mailboxWake: createInProcessMailboxWake({ fallbackMs: 5 }), ...options });

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
    async pairDevice(tenant, productId = PRODUCT_ID, machineId?: string) {
      if ((await composition.core.quota.readEntitlement(tenant)) === undefined) {
        await composition.core.quota.writeEntitlement(tenant, {
          version: 1n,
          hardLimitBytes: 1_000_000_000n,
          maxObjectBytes: 100_000_000n,
          maxInlineBytes: 1_000_000n,
          mailboxLimitBytes: 100_000_000n,
          retentionPolicyId: 'test',
        });
      }
      const keys = createDeviceKeys();
      const pairing = await composition.cloud.createPairingCode(tenant, { productId });
      const response = await request('/byok/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairingCode: pairing.code,
          deviceName: 'test-device',
          devicePublicKey: keys.publicKeyBase64Url,
          ...(machineId === undefined ? {} : { machineId }),
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

/** The Agent of {@link offerPayload}. Wire v4 offers are Agent-bound. */
export const TEST_AGENT_REF = { agentId: 'test-agent', profileRevision: 'rev-1' } as const;

/**
 * The minimal Host Agent resume payload for `enqueueAgentOffer`. Cloud admits
 * any `sessionRef`; only a daemon checks that the session exists.
 */
export function offerPayload(instruction = 'do the thing') {
  return { instruction, agentRef: TEST_AGENT_REF, sessionRef: 'test-session' };
}

/** Adds the Agent-home capability to the device's recorded capabilities, which `enqueueAgentOffer` admits on. */
export async function grantAgentHome(harness: CloudHarness, tenant: TenantId, deviceId: string): Promise<void> {
  const current = (await harness.stores.devices.get(tenant, deviceId))?.capabilities ?? [];
  if (current.includes(AGENT_HOME_CONTRACT_CAPABILITY)) return;
  await harness.stores.devices.recordCapabilities(tenant, { deviceId, capabilities: [...current, AGENT_HOME_CONTRACT_CAPABILITY] });
}

/** An events page whose entries were each decoded on their own, as the daemon does (#386). */
export type DecodedEventsPage = Omit<EventsPollResponse, 'events'> & { readonly events: Envelope[] };

/**
 * Decode a `GET /byok/events` body: the page with `EventsPollResponseSchema`,
 * each entry with `parseMessage`. An entry must decode to exactly its wire
 * value, so a field the decoder would strip still fails the suite instead of
 * disappearing before a byte-level assertion sees it.
 */
export function decodeEventsPage(body: unknown): DecodedEventsPage {
  const page = EventsPollResponseSchema.parse(body);
  const events = page.events.map((entry, index) => {
    const envelope = parseMessage(entry);
    if (!isDeepStrictEqual(envelope, entry)) throw new Error(`events page entry ${index} does not decode to its wire value`);
    return envelope;
  });
  return { ...page, events };
}
