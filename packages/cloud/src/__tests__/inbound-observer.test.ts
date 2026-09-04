/**
 * `ByokCloudOptions.observer.onInboundCommitted` — the post-commit relay
 * `@byok-sdk/server`'s `TaskHandle` fan-out needs from the kernel.
 *
 * Two properties carry the whole design, and both are negative:
 *
 * - **It observes commits, not attempts.** `duplicate` re-ran nothing,
 *   `rejected` and `rate_limited` wrote nothing; none of them may reach it, or
 *   a host counting committed work would over-count exactly the retries the
 *   at-least-once wire is built to produce.
 * - **It cannot change anything.** It returns `void` and its throw is
 *   swallowed, so the route answers identically whether it is present, absent,
 *   or broken. That is what makes it distinct from `agentMessage.consume`,
 *   which runs BEFORE a write and decides whether the write happens.
 */
import { tenantId, type TenantId } from '@byok-sdk/core';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope, type ByokCloudObserver, type InboundCommitted } from '../inbound';
import type { InboundRateLimiter } from '../stores/ports';
import { tenantStoresFor, type TenantStores } from '../tenant-stores';
import { TENANT_A, createHarness, offerPayload, type CloudHarness } from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: 'test-product', deviceId } as const;
}

function claim(taskId: string, deviceId: string): Envelope {
  return createEnvelope('task.claim', { deviceId }, { taskId });
}

function recorder(): { readonly seen: InboundCommitted[]; readonly observer: ByokCloudObserver } {
  const seen: InboundCommitted[] = [];
  return {
    seen,
    observer: {
      onInboundCommitted(input) {
        seen.push(input);
      },
    },
  };
}

function storesFor(harness: CloudHarness, deviceId: string): TenantStores {
  return tenantStoresFor(devicePrincipal(TENANT_A, deviceId), {
    core: harness.core,
    cloud: harness.stores,
  });
}

describe('observer.onInboundCommitted', () => {
  it('fires exactly once per committed envelope, with that envelope and tenant', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const { seen, observer } = recorder();

    const first = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('one'),
    });
    const second = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('two'),
    });
    const claimFirst = claim(first.taskId, device.deviceId);
    const claimSecond = claim(second.taskId, device.deviceId);

    expect(
      await handleInboundEnvelope(stores, device.deviceId, claimFirst, undefined, undefined, observer),
    ).toBe('accepted');
    expect(
      await handleInboundEnvelope(stores, device.deviceId, claimSecond, undefined, undefined, observer),
    ).toBe('accepted');

    expect(seen).toEqual([
      { tenantId: TENANT_A, deviceId: device.deviceId, envelope: claimFirst, outcome: 'accepted' },
      { tenantId: TENANT_A, deviceId: device.deviceId, envelope: claimSecond, outcome: 'accepted' },
    ]);
  });

  it('stays silent for a duplicate, which committed nothing the first delivery had not', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const { seen, observer } = recorder();
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload(),
    });
    const envelope = claim(taskId, device.deviceId);

    expect(
      await handleInboundEnvelope(stores, device.deviceId, envelope, undefined, undefined, observer),
    ).toBe('accepted');
    expect(
      await handleInboundEnvelope(stores, device.deviceId, envelope, undefined, undefined, observer),
    ).toBe('duplicate');

    // The redelivery is a wire-level success that re-ran nothing. Firing here
    // would make the relay count retries as work.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.envelope).toBe(envelope);
  });

  it('stays silent for a rejected envelope', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const { seen, observer } = recorder();

    // A server -> daemon type arriving inbound: refused before any write.
    const wrongDirection = createEnvelope('task.cancel', {}, { taskId: 'task-1', seq: 1 });
    expect(
      await handleInboundEnvelope(stores, device.deviceId, wrongDirection, undefined, undefined, observer),
    ).toBe('rejected');
    expect(seen).toEqual([]);
  });

  it('stays silent for a rate-limited envelope', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const limiter: InboundRateLimiter = { async consume() { return false; } };
    const limited = tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
      core: harness.core,
      cloud: { ...harness.stores, rateLimiter: limiter },
    });
    const { seen, observer } = recorder();

    expect(
      await handleInboundEnvelope(
        limited,
        device.deviceId,
        claim('task-rate-limited', device.deviceId),
        undefined,
        undefined,
        observer,
      ),
    ).toBe('rate_limited');
    expect(seen).toEqual([]);
  });

  it('swallows a throwing observer and leaves the outcome untouched', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    let calls = 0;
    const thrower: ByokCloudObserver = {
      onInboundCommitted() {
        calls += 1;
        throw new Error('observer blew up');
      },
    };
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload(),
    });

    const outcome = await handleInboundEnvelope(
      stores,
      device.deviceId,
      claim(taskId, device.deviceId),
      undefined,
      undefined,
      thrower,
    );

    expect(calls).toBe(1);
    expect(outcome).toBe('accepted');
    // The write it observed is still there: a relay cannot retract a fact.
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.ownerDeviceId).toBe(device.deviceId);
  });

  it('notifies in batch order over POST /byok/messages', async () => {
    const { seen, observer } = recorder();
    const harness = createHarness({ observer });
    const device = await harness.pairDevice(TENANT_A);
    const offers = [];
    for (const instruction of ['one', 'two', 'three']) {
      offers.push(
        await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
          payload: offerPayload(instruction),
        }),
      );
    }
    const messages = offers.map((offer) => claim(offer.taskId, device.deviceId));

    const response = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    });

    expect(await response.json()).toEqual({
      outcomes: messages.map((message) => ({ id: message.id, outcome: 'accepted' })),
    });
    expect(seen.map((input) => input.envelope.id)).toEqual(messages.map((message) => message.id));
    expect(seen.map((input) => input.tenantId)).toEqual([TENANT_A, TENANT_A, TENANT_A]);
    expect(seen.map((input) => input.deviceId)).toEqual(Array(3).fill(device.deviceId));
  });

  it('answers a batch identically with a throwing observer and with none', async () => {
    const thrower: ByokCloudObserver = {
      onInboundCommitted() {
        throw new Error('observer blew up');
      },
    };

    async function runBatch(observed: ByokCloudObserver | undefined) {
      const harness =
        observed === undefined ? createHarness() : createHarness({ observer: observed });
      const device = await harness.pairDevice(TENANT_A);
      const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
        payload: offerPayload(),
      });
      // One envelope that commits and one the gate refuses, so the comparison
      // covers both halves of the response body.
      const messages = [
        createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId, id: '10000000-0000-4000-8000-000000000200' }),
        createEnvelope('task.cancel', {}, { taskId, seq: 9, id: '10000000-0000-4000-8000-000000000201' }),
      ];
      const response = await harness.request('/byok/messages', {
        method: 'POST',
        headers: { ...device.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      return { status: response.status, body: await response.json() };
    }

    expect(await runBatch(thrower)).toEqual(await runBatch(undefined));
    expect(await runBatch(thrower)).toEqual({
      status: 200,
      body: {
        outcomes: [
          { id: '10000000-0000-4000-8000-000000000200', outcome: 'accepted' },
          { id: '10000000-0000-4000-8000-000000000201', outcome: 'rejected', reason: 'inbound_rejected' },
        ],
      },
    });
  });

  it('is absent by default: nothing observes and nothing changes', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload(),
    });

    expect(await handleInboundEnvelope(stores, device.deviceId, claim(taskId, device.deviceId))).toBe(
      'accepted',
    );
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.ownerDeviceId).toBe(device.deviceId);
  });

  it('does not reach across tenants: each notification carries its own closure', async () => {
    const harness = createHarness();
    const other = tenantId('tenant-observer-b');
    const deviceA = await harness.pairDevice(TENANT_A);
    const deviceB = await harness.pairDevice(other);
    const { seen, observer } = recorder();

    const offerA = await harness.cloud.enqueueOffer(TENANT_A, deviceA.deviceId, {
      payload: offerPayload('a'),
    });
    const offerB = await harness.cloud.enqueueOffer(other, deviceB.deviceId, {
      payload: offerPayload('b'),
    });

    await handleInboundEnvelope(
      storesFor(harness, deviceA.deviceId),
      deviceA.deviceId,
      claim(offerA.taskId, deviceA.deviceId),
      undefined,
      undefined,
      observer,
    );
    await handleInboundEnvelope(
      tenantStoresFor(devicePrincipal(other, deviceB.deviceId), {
        core: harness.core,
        cloud: harness.stores,
      }),
      deviceB.deviceId,
      claim(offerB.taskId, deviceB.deviceId),
      undefined,
      undefined,
      observer,
    );

    expect(seen.map((input) => input.tenantId)).toEqual([TENANT_A, other]);
  });
});
