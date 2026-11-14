/**
 * Replays across the terminal-task archive (#1120), on the in-memory stores.
 *
 * The archive tombstones the offer. A claim and a `daemon_interrupted`
 * recovery report are the reports that read the offer, so each is replayed
 * before and after the archive and must get the same answer: the claimed
 * task's immutable claim snapshot, or the unclaimed task's terminal receipt,
 * answers in the offer's place. A report the fence cannot match stays refused.
 * Redaction runs on Postgres only; its interplay is in cloud-dataplane's
 * task-archive test.
 */
import { describe, expect, it } from 'vitest';
import { createEnvelope, encodeEnvelope, type Envelope } from '@byok-sdk/protocol';
import { handleInboundEnvelope, terminalReceiptKey } from '../inbound';
import { taskRedactionCodec } from '../task-redaction';
import { archiveTerminalTasks } from '../task-archive';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, grantAgentHome, offerPayload, TENANT_A, TEST_AGENT_REF } from './support/harness';

type Scenario = 'claimed' | 'claimed-recovery' | 'unclaimed-recovery';

async function setUp(scenario: Scenario) {
  const h = createHarness();
  const { deviceId } = await h.pairDevice(TENANT_A);
  await grantAgentHome(h, TENANT_A, deviceId);
  const stores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
    { core: h.core, cloud: h.stores, mailboxWake: h.mailboxWake });
  const send = (envelope: Envelope) => handleInboundEnvelope(stores, deviceId, envelope);
  const offer = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: offerPayload() });
  const taskId = offer.taskId;
  const claim = createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, runtime: 'pi' }, { taskId });
  const recovery = createEnvelope('task.fail', { reason: 'daemon_interrupted', retryable: false, agentRef: TEST_AGENT_REF,
    recovery: { kind: 'daemon_interrupted', offerId: offer.envelope.id } }, { taskId });
  if (scenario !== 'unclaimed-recovery') expect(await send(claim)).toEqual({ outcome: 'accepted' });
  if (scenario === 'claimed') {
    expect(await send(createEnvelope('task.fail', { reason: 'ordinary_failure', retryable: false, agentRef: TEST_AGENT_REF }, { taskId })))
      .toEqual({ outcome: 'accepted' });
  } else {
    expect(await send(recovery)).toEqual({ outcome: 'accepted' });
  }
  // The offer delivery expires, so the archive may run.
  await h.core.mailbox.collectExpired(TENANT_A, { now: '2099-01-01T00:00:00.000Z', limit: 1000, ackedBefore: '2000-01-01T00:00:00.000Z',
    expireUnackedBefore: '2099-01-01T00:00:00.000Z', reapDeadLettersBefore: '2000-01-01T00:00:00.000Z' });
  const archive = async () => {
    expect(await archiveTerminalTasks({ core: h.core, cloud: h.stores, clock: h.clock, crypto: h.crypto }, TENANT_A,
      { archiveBefore: '2099-01-01T00:00:00.000Z', limit: 10, now: h.clock.now().toISOString() }))
      .toEqual({ archived: 1, settled: 1, refused: 0, more: false });
    expect(await h.stores.tasks.get(TENANT_A, taskId)).toMatchObject({ archivedAt: expect.any(String) });
  };
  return { send, archive, claim, recovery, deviceId, taskId };
}

describe('replays across the terminal-task archive', () => {
  it.each(['claimed', 'claimed-recovery', 'unclaimed-recovery'] as const)('answers the %s replays as before the archive', async (scenario) => {
    const { send, archive, claim, recovery, deviceId, taskId } = await setUp(scenario);
    const replays = [
      ...(scenario === 'unclaimed-recovery' ? [] : [
        claim,
        // A claim that does not match the claim snapshot.
        createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, runtime: 'codex' }, { taskId }),
      ]),
      ...(scenario === 'claimed' ? [] : [recovery]),
    ];
    const answers = async () => {
      const result = [];
      for (const envelope of replays) result.push(await send(envelope));
      return result;
    };
    const before = await answers();
    expect(before[0]).toEqual({ outcome: 'duplicate' });
    await archive();
    expect(await answers()).toEqual(before);
  });

  it('refuses an unclaimed recovery report that is not the recorded one, and any claim on an unclaimed task', async () => {
    const { send, archive, claim, recovery, taskId } = await setUp('unclaimed-recovery');
    await archive();
    // Same report, new envelope: before the archive it was a no-op retry; now the offer it names is gone.
    const retried = createEnvelope('task.fail', recovery.payload, { taskId });
    expect(await send(retried)).toEqual({ outcome: 'rejected', reason: 'recovery_offer_mismatch' });
    expect(await send(claim)).toEqual({ outcome: 'rejected', reason: 'claim_offer_mismatch' });
  });

  it.each([
    ['task.claim', 'missing', false, 'h1', 'claim_offer_mismatch'],
    ['task.claim', 'missing', false, undefined, undefined],
    ['task.fail', 'missing', false, undefined, 'recovery_offer_mismatch'],
    ['task.claim', 'tombstone', false, undefined, 'claim_offer_mismatch'],
    ['task.fail', 'tombstone', false, undefined, 'recovery_offer_mismatch'],
    ['task.fail', 'tombstone', true, undefined, 'recovery_offer_mismatch'],
  ] as const)('checks %s with a %s offer (archived=%s, harness=%s)', async (type, state, archived, harnessId, reason) => {
    const h = createHarness();
    const { deviceId } = await h.pairDevice(TENANT_A);
    await grantAgentHome(h, TENANT_A, deviceId);
    const stores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
      { core: h.core, cloud: h.stores, mailboxWake: h.mailboxWake });
    await stores.devices.recordCapabilities({ capabilities: ['agent-home-contract'], harnesses: [
      { id: 'h1', version: '1.0.0', capabilities: { steer: false, resume: false, approvalInteractive: false } },
    ] });
    const offer = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: offerPayload() });
    const originalAttempt = await stores.tasks.get(offer.taskId);
    const tombstone = await taskRedactionCodec(h.crypto).tombstone(encodeEnvelope(offer.envelope));
    const guardedStores = {
      ...stores,
      tasks: { ...stores.tasks, get: async (taskId: string) => {
        const attempt = await stores.tasks.get(taskId);
        return attempt === undefined || !archived ? attempt : { ...attempt, archivedAt: h.clock.now().toISOString() };
      } },
      receipts: { ...stores.receipts, get: async (key: string) => {
        if (key === `task-offer:${offer.envelope.id}`) {
          const receipt = await stores.receipts.get(key);
          return state === 'missing' || receipt === undefined ? undefined : { ...receipt, body: tombstone.body };
        }
        return stores.receipts.get(key);
      } },
    };
    // The last row reaches the unclaimed archive's missing-terminal guard;
    // keep the attempt offered so the cloud-settled guard does not preempt it.
    expect(await stores.receipts.get(terminalReceiptKey(offer.taskId))).toBeUndefined();
    const envelope = type === 'task.claim'
      ? createEnvelope(type, { deviceId, agentRef: TEST_AGENT_REF, ...(harnessId === undefined ? {} : { harnessId }) }, { taskId: offer.taskId })
      : createEnvelope(type, { reason: 'daemon_interrupted', retryable: false, agentRef: TEST_AGENT_REF,
        recovery: { kind: 'daemon_interrupted', offerId: offer.envelope.id } }, { taskId: offer.taskId });
    expect(await handleInboundEnvelope(guardedStores, deviceId, envelope)).toEqual(
      reason === undefined ? { outcome: 'accepted' } : { outcome: 'rejected', reason });
    if (reason !== undefined) {
      expect(await stores.tasks.get(offer.taskId)).toEqual(originalAttempt);
      expect(await stores.receipts.get(terminalReceiptKey(offer.taskId))).toBeUndefined();
    }
  });

  it.each(['task.claim', 'task.fail'] as const)('refuses %s when a harness contradicts a sealed dispatch selection', async (type) => {
    const h = createHarness();
    const { deviceId } = await h.pairDevice(TENANT_A);
    await grantAgentHome(h, TENANT_A, deviceId);
    const stores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
      { core: h.core, cloud: h.stores, mailboxWake: h.mailboxWake });
    await stores.devices.recordCapabilities({ capabilities: ['agent-home-contract', 'dispatch-selection'], harnesses: [
      { id: 'h1', version: '1.0.0', capabilities: { steer: false, resume: false, approvalInteractive: false } },
    ] });
    const offer = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(),
      dispatchSelection: { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'test-model' } } });
    const envelope = type === 'task.claim'
      ? createEnvelope(type, { deviceId, agentRef: TEST_AGENT_REF, harnessId: 'h1' }, { taskId: offer.taskId })
      : createEnvelope(type, { reason: 'daemon_interrupted', retryable: false, agentRef: TEST_AGENT_REF, harnessId: 'h1',
        recovery: { kind: 'daemon_interrupted', offerId: offer.envelope.id } }, { taskId: offer.taskId });
    expect(await handleInboundEnvelope(stores, deviceId, envelope)).toEqual({ outcome: 'rejected',
      reason: type === 'task.claim' ? 'claim_offer_mismatch' : 'recovery_offer_mismatch' });
  });

  it('refuses a recovery report whose harness binding contradicts a live offer that pins a runtime', async () => {
    const h = createHarness();
    const { deviceId } = await h.pairDevice(TENANT_A);
    await grantAgentHome(h, TENANT_A, deviceId);
    const stores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
      { core: h.core, cloud: h.stores, mailboxWake: h.mailboxWake });
    const offer = await h.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), runtime: 'pi' } });
    const report = createEnvelope('task.fail', { reason: 'daemon_interrupted', retryable: false, agentRef: TEST_AGENT_REF, harnessId: 'h1',
      recovery: { kind: 'daemon_interrupted', offerId: offer.envelope.id } }, { taskId: offer.taskId });
    expect(await handleInboundEnvelope(stores, deviceId, report)).toEqual({ outcome: 'rejected', reason: 'recovery_offer_mismatch' });
  });
});
