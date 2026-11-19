import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION, HarnessIdSchema, HarnessInventorySchema, type ClaimedExecutor, type HarnessInfo, type HarnessSelection } from '@byok-sdk/protocol';
import { projectTerminalResult } from '../terminal-result';
import { handleInboundEnvelope } from '../inbound';
import { AGENT_HOME_CONTRACT_CAPABILITY } from '../cloud';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, grantAgentHome, TENANT_A, TEST_AGENT_REF, offerPayload } from './support/harness';

const capabilities = { steer: true, resume: true, approvalInteractive: false };
const defaultCapabilities = { ...capabilities, selectionModes: ['device-default'], effort: false } satisfies HarnessInfo['capabilities'];
const inventory = [{ id: 'acme-harness', version: '1.2.3', capabilities: defaultCapabilities }];
const mixedInventory = [
  ...inventory,
  { id: 'other', capabilities: defaultCapabilities },
  { id: 'claude', capabilities: defaultCapabilities },
  { id: 'codex', capabilities: defaultCapabilities },
];
const CLAUDE = { id: 'claude' } as const;
const ACME = { id: 'acme-harness' } as const;
const OTHER = { id: 'other' } as const;

async function setup() {
  const h = createHarness();
  const device = await h.pairDevice(TENANT_A);
  const stores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId: device.deviceId }, { core: h.core, cloud: h.stores, mailboxWake: h.mailboxWake });
  await stores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY], harnesses: mixedInventory });
  return { h, stores, deviceId: device.deviceId };
}

describe('custom harness protocol authority', () => {
  it.each([
    [ACME, OTHER],
    [ACME, CLAUDE],
    [CLAUDE, ACME],
    [CLAUDE, { id: 'codex' }],
    [ACME, ACME],
    [CLAUDE, CLAUDE],
  ] satisfies Array<[ClaimedExecutor, ClaimedExecutor]>) (
    'admits concurrent claims only for the atomic winner: %j / %j', async (first: ClaimedExecutor, second: ClaimedExecutor) => {
      const { h, stores, deviceId } = await setup();
      const { taskId } = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: offerPayload() });
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
      const complete = vi.spyOn(stores.dedup, 'checkAndRecordAgent');
      const envelopes = [first, second].map((executor) => createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor }, { taskId }));
      const results = await Promise.all(envelopes.map((envelope) => handleInboundEnvelope(stores, deviceId, envelope).then((result) => result.outcome)));
      spy.mockRestore();
      const winner = (await stores.tasks.get(taskId))!;
      const expected = [first, second].map((executor) => executor.id === winner.claimedExecutor?.id ? 'accepted' : 'rejected');
      expect(results).toEqual(expected);
      expect(complete).toHaveBeenCalledTimes(expected.filter((result) => result === 'accepted').length);
      expect(winner.ownerDeviceId).toBe(deviceId);
      const winnerIndex = expected.indexOf('accepted');
      expect(await handleInboundEnvelope(stores, deviceId, envelopes[winnerIndex]!).then((result) => result.outcome)).toBe('duplicate');
      // New-envelope, same-identity replay is also idempotent and cannot restamp ownership.
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', {
        deviceId, agentRef: TEST_AGENT_REF, executor: [first, second][winnerIndex]!,
      }, { taskId })).then((result) => result.outcome)).toBe('accepted');
      const loserIndex = expected.indexOf('rejected');
      if (loserIndex !== -1) expect(await handleInboundEnvelope(stores, deviceId, envelopes[loserIndex]!).then((result) => result.outcome)).toBe('rejected');
      expect(await stores.tasks.get(taskId)).toEqual(winner);
    },
  );

  it('accepts vendor identities and rejects malformed and duplicate inventory identities', () => {
    for (const id of ['pi', 'claude', 'codex']) expect(HarnessIdSchema.safeParse(id).success).toBe(true);
    for (const id of ['', '../secret', 'x'.repeat(129)]) expect(HarnessIdSchema.safeParse(id).success).toBe(false);
    expect(HarnessInventorySchema.safeParse([...inventory, ...inventory]).success).toBe(false);
  });

  it('requires the advertised inventory before reserving an offer, and takes a hello inventory with no flag', async () => {
    const { h, stores, deviceId } = await setup();
    await stores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY], harnesses: [] });
    await expect(h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), target: { lane: 'harness', harnessId: 'acme-harness', selection: { mode: 'device-default' } } } })).rejects.toMatchObject({ code: 'agent_capability_missing' });
    await stores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY], harnesses: inventory });
    await expect(h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), target: { lane: 'harness', harnessId: 'other', selection: { mode: 'device-default' } } } })).rejects.toThrow();
    const hello = createEnvelope('conn.hello', { deviceId, productId: 'test-product', protocolVersions: [PROTOCOL_VERSION], capabilities: [], harnesses: inventory });
    expect(await handleInboundEnvelope(stores, deviceId, hello).then((result) => result.outcome)).toBe('accepted');
  });

  it.each([
    { mode: 'byok', providerId: 'google' }, { mode: 'adapter-model' },
    { mode: 'byok-profile', providerProfile: { profileRef: 'local', profileRevision: '1',
      profileHash: `sha256:${'a'.repeat(64)}`, requiredCapabilities: [] } },
  ] satisfies HarnessSelection[])('gates missing $mode model on its advertised default at offer and first claim', async selection => {
    const { h, stores, deviceId } = await setup();
    const target = { lane: 'harness', harnessId: 'acme-harness', selection } as const;
    const caps = { ...defaultCapabilities, selectionModes: [selection.mode],
      ...(selection.mode === 'byok' ? { byokProviderId: selection.providerId } : {}) };
    const advertise = (withDefault: boolean) => stores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
      harnesses: [{ id: ACME.id, capabilities: { ...caps, ...(withDefault ? { defaultModelModes: [selection.mode] } : {}) } }] });
    const submit = () => h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), target } });
    await advertise(false);
    await expect(submit()).rejects.toMatchObject({ code: 'invalid_request' });
    await advertise(true);
    const { taskId } = await submit();
    const claim = () => handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: ACME }, { taskId }));
    await advertise(false);
    await expect(claim()).resolves.toMatchObject({ outcome: 'rejected', reason: 'claim_harness_unavailable' });
    await advertise(true);
    await expect(claim()).resolves.toMatchObject({ outcome: 'accepted' });
    await advertise(false);
    await expect(claim()).resolves.toMatchObject({ outcome: 'accepted' });
  });

  it.each(['--flag', '  ', 'model\tname', 'model\u0085name', 'x'.repeat(161)])('rejects a malformed profile model before enqueue (%j)', async modelId => {
    const { h, stores, deviceId } = await setup();
    const taskId = 'invalid-profile-model';
    await expect(h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { taskId, payload: { ...offerPayload(), target: {
      lane: 'harness', harnessId: 'pi', selection: { mode: 'byok-profile', modelId, providerProfile: {
        profileRef: 'local', profileRevision: '1', profileHash: `sha256:${'a'.repeat(64)}`, requiredCapabilities: [],
      } },
    } } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await stores.tasks.get(taskId)).toBeUndefined();
  });

  it('seals explicit selection, claim CAS and terminal echo for the actual device', async () => {
    const { h, stores, deviceId } = await setup();
    await stores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY], harnesses: [...inventory, { ...inventory[0]!, id: 'other' }] });
    const { taskId } = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), target: { lane: 'harness', harnessId: 'acme-harness', selection: { mode: 'device-default' } } } });
    for (const executor of [CLAUDE, OTHER]) {
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor }, { taskId })).then((result) => result.outcome)).toBe('rejected');
    }
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: ACME, capabilities }, { taskId })).then((result) => result.outcome)).toBe('accepted');
    expect((await stores.tasks.get(taskId))?.claimedExecutor).toEqual(ACME);
    for (const executor of [CLAUDE, OTHER]) {
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.complete', { summary: 'done', sessionRef: 's', agentRef: TEST_AGENT_REF, executor }, { taskId })).then((result) => result.outcome)).toBe('rejected');
    }
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.complete', { summary: 'done', sessionRef: 's', agentRef: TEST_AGENT_REF, executor: ACME }, { taskId })).then((result) => result.outcome)).toBe('accepted');
  });

  it('keeps two device inventories and actual claims isolated, including implicit selection', async () => {
    const { h, stores, deviceId } = await setup();
    const other = await h.pairDevice(TENANT_A);
    const otherStores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId: other.deviceId }, { core: h.core, cloud: h.stores, mailboxWake: h.mailboxWake });
    await stores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY], harnesses: inventory });
    await otherStores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY], harnesses: [{ ...inventory[0]!, id: 'other' }] });
    await expect(h.cloud.enqueueAgentOffer(TENANT_A, other.deviceId, { payload: { ...offerPayload(), target: { lane: 'harness', harnessId: 'acme-harness', selection: { mode: 'device-default' } } } })).rejects.toThrow();
    const { taskId } = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: offerPayload() });
    expect(await handleInboundEnvelope(otherStores, other.deviceId, createEnvelope('task.claim', { deviceId: other.deviceId, agentRef: TEST_AGENT_REF, executor: OTHER }, { taskId })).then((result) => result.outcome)).toBe('rejected');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: ACME }, { taskId })).then((result) => result.outcome)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: CLAUDE }, { taskId })).then((result) => result.outcome)).toBe('rejected');
    expect((await stores.tasks.get(taskId))?.claimedExecutor).toEqual(ACME);
    await stores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY], harnesses: mixedInventory });
    const builtin = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), target: { lane: 'harness', harnessId: 'claude', selection: { mode: 'device-default' } } } });
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: ACME }, { taskId: builtin.taskId })).then((result) => result.outcome)).toBe('rejected');
  });

  it('does not permit a custom terminal identity on a built-in claim', async () => {
    const { h, stores, deviceId } = await setup();
    await grantAgentHome(h, TENANT_A, deviceId);
    const { taskId } = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: offerPayload() });
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: CLAUDE }, { taskId })).then((result) => result.outcome)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', { reason: 'x', retryable: false, agentRef: TEST_AGENT_REF, executor: ACME }, { taskId })).then((result) => result.outcome)).toBe('rejected');
  });
  it('accepts only offer-bound interruption observations without inventing a claim', async () => {
    const { h, stores, deviceId } = await setup();
    await stores.devices.recordCapabilities({ capabilities: [AGENT_HOME_CONTRACT_CAPABILITY], harnesses: inventory });
    const offer = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), target: { lane: 'harness', harnessId: 'acme-harness', selection: { mode: 'device-default' } } } });
    // Before any claim the recovery may name an executor the offer allows.
    const valid = { reason: 'daemon_interrupted', retryable: false, agentRef: TEST_AGENT_REF,
      recovery: { kind: 'daemon_interrupted' as const, offerId: offer.envelope.id } };
    for (const payload of [
      { ...valid, recovery: undefined, executor: ACME },
      { ...valid, recovery: { ...valid.recovery, offerId: crypto.randomUUID() } },
      { ...valid, executor: OTHER },
      { ...valid, reason: 'ordinary_failure' },
      { ...valid, retryable: true },
      { ...valid, retryable: undefined },
    ]) {
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', payload, { taskId: offer.taskId })).then((result) => result.outcome)).toBe('rejected');
    }
    const other = await h.pairDevice(TENANT_A);
    expect(await handleInboundEnvelope(stores, other.deviceId, createEnvelope('task.fail', valid, { taskId: offer.taskId })).then((result) => result.outcome)).toBe('rejected');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', { ...valid, executor: ACME }, { taskId: offer.taskId })).then((result) => result.outcome)).toBe('accepted');
    expect(await stores.tasks.get(offer.taskId)).toMatchObject({ status: 'failed' });
    expect((await stores.tasks.get(offer.taskId))?.ownerDeviceId).toBeUndefined();
    expect((await stores.tasks.get(offer.taskId))?.claimedExecutor).toBeUndefined();
    const receipt = (await h.cloud.readTerminalReceipt(TENANT_A, offer.taskId))!;
    const projected = projectTerminalResult(offer.taskId, receipt, undefined);
    expect(projected).toMatchObject({ recovery: valid.recovery, state: 'failed' });
    expect(projected).not.toHaveProperty('executor');
    // Recovery never fabricates an execution claim, including on replay.
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: ACME }, { taskId: offer.taskId })).then((result) => result.outcome)).toBe('rejected');
    expect((await stores.tasks.get(offer.taskId))?.ownerDeviceId).toBeUndefined();
  });

  it('does not use recovery to bypass a built-in selection or an existing claim', async () => {
    const { h, stores, deviceId } = await setup();
    for (const builtin of [false, true]) {
      const offer = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), ...(builtin ? { target: { lane: 'harness', harnessId: 'claude', selection: { mode: 'device-default' } } as const } : {}) } });
      const payload = { reason: 'daemon_interrupted', retryable: false, agentRef: TEST_AGENT_REF, executor: ACME,
        recovery: { kind: 'daemon_interrupted' as const, offerId: offer.envelope.id } };
      if (!builtin) expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: OTHER }, { taskId: offer.taskId })).then((result) => result.outcome)).toBe('accepted');
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', payload, { taskId: offer.taskId })).then((result) => result.outcome)).toBe('rejected');
      expect(await h.cloud.readTerminalReceipt(TENANT_A, offer.taskId)).toBeUndefined();
    }
  });

});
