/**
 * Steer refusal conformance (wire v7, #2009): the first refusal is the fact.
 *
 * A device replays a `task.steer_refused` until the cloud answers it, and a
 * replay may carry another reason (the task ended in between). The store
 * keeps the first reason and stamp, answers every replay `created: false`,
 * and numbers each task's refusals 1, 2, 3, … in commit order, so the Host
 * feed can resume after any revision it already yielded.
 */
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

const STEER_1 = '10000000-0000-4000-8000-000000002009';
const STEER_2 = '10000000-0000-4000-8000-000000002010';
const STEER_3 = '10000000-0000-4000-8000-000000002011';

function refusal(steerMessageId: string, reason = 'steer_unsupported', taskId = 'task-1') {
  return { taskId, steerMessageId, reason, deviceId: 'device-1' };
}

export function runSteerRefusalConformance(factory: CloudCompositionFactory): void {
  describe('steer refusals', () => {
    it('records a refusal as revision 1 and reads it back by steer and by task', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const { refusal: recorded, created } = await stores.steerRefusals.record(TENANT_A, refusal(STEER_1));
        expect(created).toBe(true);
        expect(recorded).toEqual({ ...refusal(STEER_1), recordedAt: handle.now(), revision: 1 });
        expect(await stores.steerRefusals.get(TENANT_A, 'task-1', STEER_1)).toEqual(recorded);
        expect(await stores.steerRefusals.list(TENANT_A, { taskId: 'task-1', afterRevision: 0, limit: 10 })).toEqual([recorded]);
      });
    });

    it('keeps the first reason and instant for every replay of one steer', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const first = await stores.steerRefusals.record(TENANT_A, refusal(STEER_1, 'input_too_large'));
        await handle.advanceTime(60_000);
        const replay = await stores.steerRefusals.record(TENANT_A, refusal(STEER_1, 'task_not_active'));
        expect(replay).toEqual({ refusal: first.refusal, created: false });
        expect(await stores.steerRefusals.list(TENANT_A, { taskId: 'task-1', afterRevision: 0, limit: 10 })).toEqual([first.refusal]);
      });
    });

    it('resolves one winner when replays of one steer race', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const results = await Promise.all(['input_too_large', 'steer_unsupported', 'task_not_active', 'later_reason']
          .map((reason) => stores.steerRefusals.record(TENANT_A, refusal(STEER_1, reason))));
        const winners = results.filter((result) => result.created);
        expect(winners).toHaveLength(1);
        for (const result of results) expect(result.refusal).toEqual(winners[0]!.refusal);
        expect(winners[0]!.refusal.revision).toBe(1);
      });
    });

    it('numbers a task\'s refusals gaplessly in commit order, per task, and pages after a revision', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const concurrent = await Promise.all([STEER_1, STEER_2, STEER_3]
          .map((steer) => stores.steerRefusals.record(TENANT_A, refusal(steer))));
        expect(concurrent.map((result) => result.refusal.revision).sort()).toEqual([1, 2, 3]);
        const other = await stores.steerRefusals.record(TENANT_A, refusal(STEER_1, 'steer_unsupported', 'task-2'));
        expect(other.refusal.revision).toBe(1);

        const all = await stores.steerRefusals.list(TENANT_A, { taskId: 'task-1', afterRevision: 0, limit: 10 });
        expect(all.map((entry) => entry.revision)).toEqual([1, 2, 3]);
        expect(await stores.steerRefusals.list(TENANT_A, { taskId: 'task-1', afterRevision: 1, limit: 1 })).toEqual([all[1]]);
        expect(await stores.steerRefusals.list(TENANT_A, { taskId: 'task-1', afterRevision: 3, limit: 10 })).toEqual([]);
      });
    });

    it('scopes every read and write to its tenant', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.steerRefusals.record(TENANT_A, refusal(STEER_1, 'input_too_large'));
        expect(await stores.steerRefusals.get(TENANT_B, 'task-1', STEER_1)).toBeUndefined();
        expect(await stores.steerRefusals.list(TENANT_B, { taskId: 'task-1', afterRevision: 0, limit: 10 })).toEqual([]);
        const elsewhere = await stores.steerRefusals.record(TENANT_B, refusal(STEER_1, 'task_not_active'));
        expect(elsewhere).toMatchObject({ created: true, refusal: { reason: 'task_not_active', revision: 1 } });
      });
    });

    it('answers undefined for a steer never refused', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.steerRefusals.get(TENANT_A, 'task-1', STEER_1)).toBeUndefined();
      });
    });
  });
}
