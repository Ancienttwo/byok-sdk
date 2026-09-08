import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, HarnessIdSchema, HarnessInventorySchema, type TaskClaimPayload } from '@byok-sdk/protocol';
import { projectTerminalResult } from '../terminal-result';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, TENANT_A, offerPayload } from './support/harness';

const capabilities = { steer: true, resume: true, approvalInteractive: false, permissionModes: ['auto' as const] };
const inventory = [{ id: 'acme-harness', version: '1.2.3', capabilities }];

async function setup() {
  const h = createHarness();
  const device = await h.pairDevice(TENANT_A);
  const stores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId: device.deviceId }, { core: h.core, cloud: h.stores });
  return { h, stores, deviceId: device.deviceId };
}

describe('custom harness protocol authority', () => {
  it.each([
    [{ harnessId: 'acme-harness' }, { harnessId: 'other' }],
    [{ harnessId: 'acme-harness' }, { runtime: 'pi' }],
    [{ runtime: 'pi' }, { harnessId: 'acme-harness' }],
    [{ runtime: 'pi' }, { runtime: 'codex' }],
    [{ runtime: 'pi' }, {}],
    [{ harnessId: 'acme-harness' }, { harnessId: 'acme-harness' }],
    [{ runtime: 'pi' }, { runtime: 'pi' }],
    [{}, {}],
  ] satisfies Array<[Omit<TaskClaimPayload, 'deviceId'>, Omit<TaskClaimPayload, 'deviceId'>]>) (
    'admits concurrent claims only for the atomic winner: %j / %j', async (first: Omit<TaskClaimPayload, 'deviceId'>, second: Omit<TaskClaimPayload, 'deviceId'>) => {
      const { h, stores, deviceId } = await setup();
      await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: [...inventory, { ...inventory[0]!, id: 'other' }] });
      const { taskId } = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
      const claim = stores.tasks.claim.bind(stores.tasks);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let arrivals = 0;
      // Both handlers finish their stale pre-read before either performs the CAS.
      const spy = vi.spyOn(stores.tasks, 'claim').mockImplementation(async (input) => {
        if (++arrivals === 2) release();
        await gate;
        return claim(input);
      });
      const complete = vi.spyOn(stores.dedup, 'checkAndRecord');
      const envelopes = [first, second].map((identity) => createEnvelope('task.claim', { deviceId, ...identity }, { taskId }));
      const results = await Promise.all(envelopes.map((envelope) => handleInboundEnvelope(stores, deviceId, envelope)));
      spy.mockRestore();
      const winner = (await stores.tasks.get(taskId))!;
      const expected = [first, second].map((identity) =>
        identity.harnessId === winner.claimedHarnessId && identity.runtime === winner.claimedRuntime ? 'accepted' : 'rejected');
      expect(results).toEqual(expected);
      expect(complete).toHaveBeenCalledTimes(expected.filter((result) => result === 'accepted').length);
      expect(winner.ownerDeviceId).toBe(deviceId);
      const winnerIndex = expected.indexOf('accepted');
      expect(await handleInboundEnvelope(stores, deviceId, envelopes[winnerIndex]!)).toBe('duplicate');
      // New-envelope, same-identity replay is also idempotent and cannot restamp ownership.
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', {
        deviceId, ...[first, second][winnerIndex],
      }, { taskId }))).toBe('accepted');
      const loserIndex = expected.indexOf('rejected');
      if (loserIndex !== -1) expect(await handleInboundEnvelope(stores, deviceId, envelopes[loserIndex]!)).toBe('rejected');
      expect(await stores.tasks.get(taskId)).toEqual(winner);
    },
  );

  it('rejects reserved, malformed and duplicate inventory identities', () => {
    for (const id of ['pi', 'claude', 'codex', '', '../secret', 'x'.repeat(129)]) expect(HarnessIdSchema.safeParse(id).success).toBe(false);
    expect(HarnessInventorySchema.safeParse([...inventory, ...inventory]).success).toBe(false);
  });

  it('requires the capability and advertised inventory before reserving an offer', async () => {
    const { h, stores, deviceId } = await setup();
    await expect(h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness' } })).rejects.toThrow('custom-harness');
    await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: inventory });
    await expect(h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'other' } })).rejects.toThrow();
    await expect(h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness', runtime: 'pi' } })).rejects.toThrow();
    const hello = createEnvelope('conn.hello', { deviceId, productId: 'test-product', protocolVersions: [1], capabilities: [], runtimes: [], harnesses: inventory });
    expect(await handleInboundEnvelope(stores, deviceId, hello)).toBe('rejected');
  });

  it('seals explicit selection, claim CAS and terminal echo for the actual device', async () => {
    const { h, stores, deviceId } = await setup();
    await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: [...inventory, { ...inventory[0]!, id: 'other' }] });
    const { taskId } = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness' } });
    for (const payload of [{ deviceId }, { deviceId, harnessId: 'other' }, { deviceId, harnessId: 'acme-harness', runtime: 'pi' as const }]) {
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', payload, { taskId }))).toBe('rejected');
    }
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, harnessId: 'acme-harness', capabilities }, { taskId }))).toBe('accepted');
    expect((await stores.tasks.get(taskId))?.claimedHarnessId).toBe('acme-harness');
    for (const harnessId of [undefined, 'other']) {
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.complete', { summary: 'done', sessionRef: 's', ...(harnessId ? { harnessId } : {}) }, { taskId }))).toBe('rejected');
    }
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.complete', { summary: 'done', sessionRef: 's', harnessId: 'acme-harness' }, { taskId }))).toBe('accepted');
  });

  it('keeps two device inventories and actual claims isolated, including implicit selection', async () => {
    const { h, stores, deviceId } = await setup();
    const other = await h.pairDevice(TENANT_A);
    const otherStores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId: other.deviceId }, { core: h.core, cloud: h.stores });
    await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: inventory });
    await otherStores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: [{ ...inventory[0]!, id: 'other' }] });
    await expect(h.cloud.enqueueOffer(TENANT_A, other.deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness' } })).rejects.toThrow();
    const { taskId } = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    expect(await handleInboundEnvelope(otherStores, other.deviceId, createEnvelope('task.claim', { deviceId: other.deviceId, harnessId: 'other' }, { taskId }))).toBe('rejected');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, harnessId: 'acme-harness' }, { taskId }))).toBe('accepted');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, runtime: 'pi' }, { taskId }))).toBe('rejected');
    expect((await stores.tasks.get(taskId))?.claimedHarnessId).toBe('acme-harness');
    const builtin = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), runtime: 'pi' } });
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, harnessId: 'acme-harness' }, { taskId: builtin.taskId }))).toBe('rejected');
  });

  it('does not permit a custom terminal identity on a built-in claim', async () => {
    const { h, stores, deviceId } = await setup();
    const { taskId } = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, runtime: 'pi' }, { taskId }))).toBe('accepted');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', { reason: 'x', retryable: false, harnessId: 'acme-harness' }, { taskId }))).toBe('rejected');
  });
  it('accepts only offer-bound interruption observations without inventing a claim', async () => {
    const { h, stores, deviceId } = await setup();
    await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: inventory });
    const offer = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness' } });
    const valid = { reason: 'daemon_interrupted', retryable: false, harnessId: 'acme-harness',
      recovery: { kind: 'daemon_interrupted' as const, offerId: offer.envelope.id } };
    for (const payload of [
      { ...valid, recovery: undefined },
      { ...valid, recovery: { ...valid.recovery, offerId: crypto.randomUUID() } },
      { ...valid, harnessId: 'other' },
      { ...valid, harnessId: undefined },
      { ...valid, reason: 'ordinary_failure' },
      { ...valid, retryable: true },
      { ...valid, retryable: undefined },
    ]) {
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', payload, { taskId: offer.taskId }))).toBe('rejected');
    }
    const other = await h.pairDevice(TENANT_A);
    expect(await handleInboundEnvelope(stores, other.deviceId, createEnvelope('task.fail', valid, { taskId: offer.taskId }))).toBe('rejected');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', valid, { taskId: offer.taskId }))).toBe('accepted');
    expect(await stores.tasks.get(offer.taskId)).toMatchObject({ status: 'failed' });
    expect((await stores.tasks.get(offer.taskId))?.ownerDeviceId).toBeUndefined();
    expect((await stores.tasks.get(offer.taskId))?.claimedHarnessId).toBeUndefined();
    const receipt = (await h.cloud.readTerminalReceipt(TENANT_A, offer.taskId))!;
    expect(projectTerminalResult(offer.taskId, receipt)).toMatchObject({ recovery: valid.recovery, harnessId: 'acme-harness', state: 'failed' });
    // Recovery never fabricates an execution claim, including on replay.
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, harnessId: 'acme-harness' }, { taskId: offer.taskId }))).toBe('rejected');
    expect((await stores.tasks.get(offer.taskId))?.ownerDeviceId).toBeUndefined();
  });

  it('does not use recovery to bypass a built-in selection or an existing claim', async () => {
    const { h, stores, deviceId } = await setup();
    await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: [...inventory, { ...inventory[0]!, id: 'other' }] });
    for (const builtin of [false, true]) {
      const offer = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), ...(builtin ? { runtime: 'pi' as const } : {}) } });
      const payload = { reason: 'daemon_interrupted', retryable: false, harnessId: 'acme-harness',
        recovery: { kind: 'daemon_interrupted' as const, offerId: offer.envelope.id } };
      if (!builtin) expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, harnessId: 'other' }, { taskId: offer.taskId }))).toBe('accepted');
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', payload, { taskId: offer.taskId }))).toBe('rejected');
      expect(await h.cloud.readTerminalReceipt(TENANT_A, offer.taskId)).toBeUndefined();
    }
  });

});
