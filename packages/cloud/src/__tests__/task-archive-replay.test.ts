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
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { handleInboundEnvelope } from '../inbound';
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
});
