/**
 * The Worker's submitter lanes (#953): a sealed routine occurrence goes to the SDK's sealed lane, and an intent that the
 * submitter concludes with no SDK call settles its Turn in the same pass. Notifications are dropped and the clock is not
 * armed, so each pass is one `/host/passes` call.
 *
 * The device process has no E2EE member keyring, so it does not declare `sealed-payload-v1`, and the SDK's sealed lane
 * refuses the offer before its mailbox append. That refusal is the sealed lane's own admission check: the plain lane
 * would refuse the sealed fields instead, naming `submitSealedAgentExecution`. A sealed run on a device needs the hosted
 * E2EE member setup (#654), which this example does not have.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sealRoutineTemplate } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { ROUTINE_LATE_AFTER_MS, sealedRoutineInstruction, type SealedRoutineAction } from '@byok-sdk/example-bot-collaboration/routines';
import { storedKey } from '@byok-sdk/example-hosted-bot-collaboration/src/layout';
import { openHome, RUN, until, type Home } from './worker.test-support';

/** The slot is at least this far from the create, so the setup is done before it. */
const LEAD_MS = 20_000;
const SLOT_WAIT_MS = LEAD_MS + 60_000 + ROUTINE_LATE_AFTER_MS;

let h: Home | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

/** The next whole UTC minute at least `LEAD_MS` away, as a daily schedule and its epoch time. */
function nextSlot() {
  const at = Math.ceil((Date.now() + LEAD_MS) / 60_000) * 60_000, date = new Date(at);
  return { at, schedule: { minute: date.getUTCMinutes(), hour: date.getUTCHours(), tz: 'UTC' } };
}

/** The member endpoint's action: version 1 of a sealed routine of the Main Bot, sealed for its current Agent. */
async function sealedAction(deviceId: string, agentId: string, schedule: SealedRoutineAction['schedule']): Promise<SealedRoutineAction> {
  const routineId = randomUUID(), notAfter = '2099-01-01T00:00:00.000Z';
  const sealing = { scopeId: 'scope-1', epoch: 1, categories: ['task-input' as const] };
  const agentRef = template(deviceId, agentId).payload.agentRef;
  const sealed = await sealRoutineTemplate({ tenantId: 'tenant', scopeKey: Uint8Array.from({ length: 32 }, (_, index) => index), sealing,
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` }, sender: 'A'.repeat(43), routineRef: { routineId, definitionVersion: 1, notAfter },
    agentRef, instruction: sealedRoutineInstruction('Check the watchlist.') });
  return { routineId, definitionVersion: 1, schedule,
    sealed: { sealing, template: sealed, agentRef: { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision }, notAfter } };
}

describe.skipIf(!RUN)('the Worker submitter lanes (#953)', () => {
  it('sends a sealed routine occurrence to submitSealedAgentExecution, not submit', async () => {
    h = await openHome({ fault: 'drop-notify' });
    const { token, agentId } = await h.bot();
    const slot = nextSlot(), action = await sealedAction(h.device.deviceId, agentId, slot.schedule);
    const response = await fetch(`${h.worker.base}/host/sealed-routine`, { method: 'POST', body: JSON.stringify({ botId: 'main', action }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    expect([response.status, await response.json()]).toEqual([200, { routineId: action.routineId }]);
    expect(await h.routines()).toEqual([{ nextAt: slot.at }]);
    const tried = await until(async () => {
      await h!.worker.passes();
      const [row] = (await h!.substrate.pool.query<{ task: string; tries: number; last_error: string | null; conclusion: string | null }>(
        `SELECT task_id AS task, tries, last_error, conclusion FROM "${h!.substrate.hSchema}".intent WHERE scope = $1 AND source = 'routine'`,
        [storedKey(h!.home)])).rows;
      return row && row.tries > 0 ? row : undefined;
    }, SLOT_WAIT_MS);
    expect(tried).toMatchObject({ tries: 1, conclusion: null });
    expect(tried.last_error).toMatch(/lacks durable Agent capabilities \(sealed-payload-v1\); refusing before mailbox append/u);
    // Refused before the append, on either lane: the mailbox has no row for this task.
    expect(await h.mailbox(tried.task)).toEqual([]);
  }, SLOT_WAIT_MS + 120_000);

  it('an untried intent that reaches its wait time ends in the submitter, and its Turn ends in the same pass', async () => {
    h = await openHome({ fault: 'drop-notify' });
    const { token } = await h.bot();
    const { turnId } = await h.input(token, 'Never offered');
    expect(await h.intent(turnId)).toMatchObject({ tries: 0, conclusion: null });
    // The K8 offer wait is 5 min: the test moves the frozen wait time to now instead of waiting for it.
    await h.substrate.pool.query(`UPDATE "${h.substrate.hSchema}".intent SET wait_until = $3 WHERE scope = $1 AND key = $2`,
      [storedKey(h.home), storedKey(turnId), Date.now()]);
    const report = await h.worker.passes();
    expect(report.submit.synced).toEqual([{ scope: h.home }]);
    expect(await h.intent(turnId)).toMatchObject({ tries: 0, conclusion: 'expired' });
    expect(await h.turn(turnId)).toMatchObject({ conclusion: 'expired' });
  });
});
