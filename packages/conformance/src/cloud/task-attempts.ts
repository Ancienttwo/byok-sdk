/**
 * Task attempt conformance: first claim wins, ownership never transfers, and a
 * guessed task id leaves no trace.
 *
 * This port is the ownership authority the inbound gate reads, so the claim has
 * to be a compare-and-set: two devices racing the same offer must produce one
 * owner, not the last writer. A durable composition expresses that as a single
 * guarded statement (`UPDATE ... WHERE owner_device_id IS NULL RETURNING ...`)
 * — a read-then-write would let both reads observe no owner.
 *
 * The two no-ops matter as much as the claim. `claim` and `recordStatus` on a
 * task this tenant never offered write NOTHING: a device that guesses a taskId
 * must not be able to conjure a row, and cross-tenant it must not leave a trace
 * in the tenant it guessed into.
 */
import { describe, expect, it } from 'vitest';
import { contentHash } from '@byok-sdk/core';
import { TASK_ATTEMPT_STATUSES } from '@byok-sdk/cloud';
import { TENANT_A, TENANT_B } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

export function runTaskAttemptConformance(factory: CloudCompositionFactory): void {
  describe('task attempts', () => {
    it('aggregates every status, separates cancellation markers, and isolates tenants', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const zeros = Object.fromEntries(TASK_ATTEMPT_STATUSES.map((status) => [status, 0]));
        expect(await stores.tasks.countByStatus(TENANT_A)).toEqual({ byStatus: zeros, cancellationRequested: 0 });
        for (const status of TASK_ATTEMPT_STATUSES) {
          await stores.tasks.open(TENANT_A, { taskId: `status-${status}`, deviceId: 'device-1' });
          await stores.tasks.recordStatus(TENANT_A, { taskId: `status-${status}`, status });
        }
        for (const owned of [false, true]) {
          const taskId = owned ? 'cancel-owned' : 'cancel-unowned';
          await stores.tasks.open(TENANT_A, { taskId, deviceId: 'device-1' });
          if (owned) await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-1' });
          await stores.cancellations.request(TENANT_A, {
            taskId, proposedMessageId: `message-${taskId}`,
            materialize: async () => ({ body: 'cancel', bodyHash: contentHash(`sha256:${'a'.repeat(64)}`), byteSize: 6n }),
          });
          const late = await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete' });
          expect(late?.status).toBe(owned ? 'cancel_requested' : 'cancelled');
        }
        await stores.tasks.open(TENANT_B, { taskId: 'status-complete', deviceId: 'other' });
        expect(await stores.tasks.countByStatus(TENANT_A)).toEqual({
          byStatus: Object.fromEntries(TASK_ATTEMPT_STATUSES.map((status) => [status, 1])), cancellationRequested: 2,
        });
        expect(await stores.tasks.countByStatus(TENANT_B)).toEqual({ byStatus: { ...zeros, offered: 1 }, cancellationRequested: 0 });
      });
    });

    it('walks only active unmarked attempts across exclusive keyset pages', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const statuses = ['offered', 'complete', 'claimed', 'failed', 'running', 'cancelled', 'cancel_requested'] as const;
        for (const [index, status] of statuses.entries()) {
          const taskId = `task-${index}`;
          await stores.tasks.open(TENANT_A, { taskId, deviceId: 'device-1' });
          await stores.tasks.recordStatus(TENANT_A, { taskId, status });
        }
        await stores.tasks.open(TENANT_B, { taskId: 'task-1', deviceId: 'other' });
        await stores.tasks.open(TENANT_A, { taskId: 'task-7', deviceId: 'device-1' });
        await stores.cancellations.request(TENANT_A, {
          taskId: 'task-7', proposedMessageId: 'cancel',
          materialize: async () => ({ body: 'cancel', bodyHash: contentHash(`sha256:${'a'.repeat(64)}`), byteSize: 6n }),
        });
        const walked: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await stores.tasks.list(TENANT_A, { limit: 1, active: true, ...(cursor === undefined ? {} : { cursor }) });
          expect(page.attempts.length).toBeLessThanOrEqual(1);
          walked.push(...page.attempts.map((attempt) => attempt.taskId));
          cursor = page.nextCursor;
          expect(walked.length).toBeLessThanOrEqual(3);
        } while (cursor !== undefined);
        expect(walked).toEqual(['task-0', 'task-2', 'task-4']);
        expect((await stores.tasks.list(TENANT_A, { limit: 10, active: true, cursor: 'task-1' })).attempts.map((a) => a.taskId))
          .toEqual(['task-2', 'task-4']);
        expect((await stores.tasks.list(TENANT_B, { limit: 10, active: true })).attempts.map((a) => a.taskId)).toEqual(['task-1']);
        for (const limit of [0, -1, 2.5, Number.NaN]) {
          await expect(stores.tasks.list(TENANT_A, { limit, active: true })).rejects.toThrow();
        }
        await expect(stores.tasks.list(TENANT_A, { limit: 1, active: false as never })).rejects.toThrow();
      });
    });

    it('opens an unowned attempt and reads it back', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const attempt = await stores.tasks.open(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
        });
        expect(attempt).toMatchObject({
          tenantId: TENANT_A,
          taskId: 'task-1',
          deviceId: 'device-1',
          status: 'offered',
        });
        expect(attempt.ownerDeviceId).toBeUndefined();
        expect(await stores.tasks.get(TENANT_A, 'task-1')).toMatchObject({ status: 'offered' });
      });
    });

    it('is idempotent on re-open: the first offer is the fact', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });
        const again = await stores.tasks.open(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-2',
        });
        expect(again.deviceId).toBe('device-1');
      });
    });

    it('gives ownership to the first claim and never transfers it', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });

        const first = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
        });
        expect(first).toMatchObject({ ownerDeviceId: 'device-1', status: 'claimed' });

        // A different device's claim does not steal ownership...
        const second = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-2',
        });
        expect(second?.ownerDeviceId).toBe('device-1');
        // ...and the owner's own re-claim is idempotent, not a second win.
        const repeat = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
        });
        expect(repeat?.ownerDeviceId).toBe('device-1');
        expect((await stores.tasks.get(TENANT_A, 'task-1'))?.ownerDeviceId).toBe('device-1');
      });
    });

    it('resolves exactly one winner when claims race', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });

        const claimants = ['device-1', 'device-2', 'device-3', 'device-4'];
        const results = await Promise.all(
          claimants.map((deviceId) => stores.tasks.claim(TENANT_A, { taskId: 'task-1', deviceId })),
        );

        const owners = new Set(results.map((result) => result?.ownerDeviceId));
        expect(owners.size).toBe(1);
        const stored = await stores.tasks.get(TENANT_A, 'task-1');
        expect(owners.has(stored?.ownerDeviceId)).toBe(true);
        expect(claimants).toContain(stored?.ownerDeviceId);
      });
    });

    it('records lifecycle transitions', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });
        await stores.tasks.claim(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });

        const running = await stores.tasks.recordStatus(TENANT_A, {
          taskId: 'task-1',
          status: 'running',
        });
        expect(running).toMatchObject({ status: 'running', ownerDeviceId: 'device-1' });

        const complete = await stores.tasks.recordStatus(TENANT_A, {
          taskId: 'task-1',
          status: 'complete',
        });
        expect(complete?.status).toBe('complete');
        expect((await stores.tasks.get(TENANT_A, 'task-1'))?.status).toBe('complete');
      });
    });

    it.each(['complete', 'cancel_requested'] as const)(
      'keeps an exact pending message recoverable after %s while lifecycle-gating every new binding',
      async (status) => {
        await withCloudComposition(factory, async ({ stores }) => {
          const taskId = `task-message-${status}`;
          const exact = {
            taskId,
            deviceId: 'device-1',
            messageId: '10000000-0000-4000-8000-000000001138',
            payloadBody: '{"message":"exact"}',
          };
          await stores.tasks.open(TENANT_A, { taskId, deviceId: exact.deviceId });
          await expect(stores.tasks.reserveAgentMessage(TENANT_A, exact)).resolves.toBe('reserved');
          await stores.tasks.recordStatus(TENANT_A, { taskId, status });

          await expect(stores.tasks.reserveAgentMessage(TENANT_A, exact)).resolves.toBe('pending');
          await expect(stores.tasks.reserveAgentMessage(TENANT_A, {
            ...exact,
            messageId: '10000000-0000-4000-8000-000000001139',
          })).resolves.toBe('rejected');
          await expect(stores.tasks.reserveAgentMessage(TENANT_A, {
            ...exact,
            payloadBody: '{"message":"conflict"}',
          })).resolves.toBe('rejected');
          await expect(stores.tasks.reserveAgentMessage(TENANT_A, {
            ...exact,
            deviceId: 'device-2',
          })).resolves.toBe('rejected');
          await expect(stores.tasks.readAgentMessage(TENANT_A, {
            ...exact,
            deviceId: 'device-2',
          })).resolves.toBeUndefined();
        });
      },
    );

    it('writes nothing for a task that was never offered', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(
          await stores.tasks.claim(TENANT_A, { taskId: 'guessed', deviceId: 'device-1' }),
        ).toBeUndefined();
        expect(
          await stores.tasks.recordStatus(TENANT_A, { taskId: 'guessed', status: 'running' }),
        ).toBeUndefined();
        // No row was conjured by either call.
        expect(await stores.tasks.get(TENANT_A, 'guessed')).toBeUndefined();
      });
    });

    /**
     * The claim-time runtime snapshot is WRITE-ONCE, and this is the assertion
     * that says so across every composition. The steer gate
     * (`ByokCloud.steerTask`) reads nothing else, so a store that let a
     * redelivered claim restamp the snapshot would let a late, stale, or absent
     * self-report reopen or close the gate on an already-running task.
     */
    it('snapshots the claiming runtime once and never lets a re-claim restamp it', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });

        const claimed = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
          runtime: 'pi',
          capabilities: { steer: true },
        });
        expect(claimed).toMatchObject({
          ownerDeviceId: 'device-1',
          claimedRuntime: 'pi',
          claimedRuntimeCapabilities: { steer: true },
        });

        // The owner's own idempotent re-claim, reporting something else: the
        // first claim is the fact.
        const repeat = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
          runtime: 'codex',
          capabilities: { steer: false },
        });
        expect(repeat?.claimedRuntime).toBe('pi');
        expect(repeat?.claimedRuntimeCapabilities).toEqual({ steer: true });

        // ...and a losing claim from another device cannot write it either.
        await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-2',
          runtime: 'claude',
        });

        const stored = await stores.tasks.get(TENANT_A, 'task-1');
        expect(stored?.claimedRuntime).toBe('pi');
        expect(stored?.claimedRuntimeCapabilities).toEqual({ steer: true });
      });
    });

    it('snapshots custom harness identity once with ownership and every read model', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const taskId = 'custom-task';
        const deviceId = 'device-1';
        const expected = { ownerDeviceId: deviceId, claimedHarnessId: 'acme-harness',
          claimedRuntimeCapabilities: { steer: true }, status: 'claimed' };
        await stores.tasks.open(TENANT_A, { taskId, deviceId });
        expect(await stores.tasks.claim(TENANT_A, { taskId, deviceId,
          harnessId: 'acme-harness', capabilities: { steer: true } })).toMatchObject(expected);
        for (const retry of [
          { deviceId, harnessId: 'other', capabilities: { steer: false } },
          { deviceId: 'device-2', harnessId: 'other' },
          { deviceId, runtime: 'pi' as const },
          { deviceId },
        ]) expect(await stores.tasks.claim(TENANT_A, { taskId, ...retry })).toMatchObject(expected);
        expect(await stores.tasks.claim(TENANT_B, { taskId, deviceId, harnessId: 'other' })).toBeUndefined();
        expect(await stores.tasks.get(TENANT_A, taskId)).toMatchObject(expected);
        expect(await stores.tasks.getMany(TENANT_A, [taskId])).toMatchObject([expected]);
        expect((await stores.tasks.list(TENANT_A, { limit: 10 })).attempts).toMatchObject([expected]);
        expect((await stores.tasks.get(TENANT_A, taskId))?.claimedRuntime).toBeUndefined();
      });
    });

    /**
     * `list` is the tenant-level read model the host façade pages over. The
     * property that matters is the WALK: every attempt exactly once, no gaps and
     * no repeats, across page boundaries. Keyset by `taskId` is what buys it —
     * a chronological cursor would re-order rows under an in-flight walk every
     * time a status transition restamped `updatedAt`.
     */
    it('pages the whole tenant exactly once, in taskId order, with no gaps or repeats', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        // Deliberately opened out of order: the page order must come from the
        // key, not from insertion.
        const ids = ['task-3', 'task-1', 'task-5', 'task-2', 'task-4'];
        for (const taskId of ids) {
          await stores.tasks.open(TENANT_A, { taskId, deviceId: 'device-1' });
        }

        const walked: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await stores.tasks.list(TENANT_A, {
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          });
          expect(page.attempts.length).toBeLessThanOrEqual(2);
          walked.push(...page.attempts.map((attempt) => attempt.taskId));
          cursor = page.nextCursor;
          pages += 1;
          expect(pages).toBeLessThan(10);
        } while (cursor !== undefined);

        expect(walked).toEqual([...ids].sort());
      });
    });

    it('ends the walk on an absent cursor, including when the last page exactly fills the limit', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });
        await stores.tasks.open(TENANT_A, { taskId: 'task-2', deviceId: 'device-1' });

        const full = await stores.tasks.list(TENANT_A, { limit: 2 });
        expect(full.attempts.map((attempt) => attempt.taskId)).toEqual(['task-1', 'task-2']);
        expect(full.nextCursor).toBeUndefined();
      });
    });

    it('answers an empty tenant with an empty page and no cursor', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const page = await stores.tasks.list(TENANT_A, { limit: 10 });
        expect(page.attempts).toEqual([]);
        expect(page.nextCursor).toBeUndefined();
      });
    });

    it('never pages one tenant into another', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });
        await stores.tasks.open(TENANT_B, { taskId: 'task-2', deviceId: 'device-2' });

        const a = await stores.tasks.list(TENANT_A, { limit: 10 });
        expect(a.attempts.map((attempt) => attempt.taskId)).toEqual(['task-1']);
        const b = await stores.tasks.list(TENANT_B, { limit: 10 });
        expect(b.attempts.map((attempt) => attempt.taskId)).toEqual(['task-2']);

        // A cursor from one tenant's walk cannot pull the other tenant's rows in.
        const crossed = await stores.tasks.list(TENANT_A, { limit: 10, cursor: 'task-1' });
        expect(crossed.attempts).toEqual([]);
      });
    });

    it('rejects a non-positive or non-integer limit instead of defaulting one', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        for (const limit of [0, -1, 2.5, Number.NaN]) {
          await expect(stores.tasks.list(TENANT_A, { limit })).rejects.toThrow();
        }
      });
    });

    /**
     * The phase instants are write-once (#980). The clock moves between every
     * step, so an instant that a later step rewrote would read differently.
     */
    it('stamps each phase instant at its own transition and never again', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const tick = () => handle.advanceTime(1_000);
        const taskId = 'task-phases';
        const message = { taskId, deviceId: 'device-1', messageId: '10000000-0000-4000-8000-000000000980', payloadBody: '{"m":1}' };

        const offered = await stores.tasks.open(TENANT_A, { taskId, deviceId: 'device-1' });
        const offeredAt = handle.now();
        expect(offered).toMatchObject({ offeredAt, updatedAt: offeredAt });
        for (const field of ['claimedAt', 'firstOutputAt', 'terminalAt']) expect(offered).not.toHaveProperty(field);

        await tick();
        await stores.tasks.open(TENANT_A, { taskId, deviceId: 'device-1' });
        await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-2' });
        expect(await stores.tasks.get(TENANT_A, taskId)).not.toHaveProperty('claimedAt');

        await tick();
        const claimed = await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-1', runtime: 'pi' });
        const claimedAt = handle.now();
        expect(claimed).toMatchObject({ offeredAt, claimedAt, updatedAt: claimedAt });

        await tick();
        await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-1', runtime: 'pi' });
        await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-2', runtime: 'pi' });
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'running' });
        expect(await stores.tasks.get(TENANT_A, taskId)).toMatchObject({ offeredAt, claimedAt });
        expect(await stores.tasks.get(TENANT_A, taskId)).not.toHaveProperty('firstOutputAt');

        await tick();
        await expect(stores.tasks.reserveAgentMessage(TENANT_A, message)).resolves.toBe('reserved');
        const firstOutputAt = handle.now();
        await tick();
        await expect(stores.tasks.reserveAgentMessage(TENANT_A, message)).resolves.toBe('pending');
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'running' });
        expect(await stores.tasks.get(TENANT_A, taskId)).toMatchObject({ firstOutputAt });
        expect(await stores.tasks.get(TENANT_A, taskId)).not.toHaveProperty('terminalAt');

        await tick();
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete' });
        const terminalAt = handle.now();
        await tick();
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete' });
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'failed' });
        const phases = { offeredAt, claimedAt, firstOutputAt, terminalAt };
        expect(await stores.tasks.get(TENANT_A, taskId)).toMatchObject({ ...phases, status: 'complete' });
        expect(await stores.tasks.getMany(TENANT_A, [taskId])).toMatchObject([phases]);
        expect((await stores.tasks.list(TENANT_A, { limit: 10 })).attempts).toMatchObject([phases]);
      });
    });

    it('stamps an Agent offer, and no output before the claim', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const taskId = 'task-agent-phases';
        const agentRef = { agentId: 'agent-1', profileRevision: 'rev-1' };
        const reserved = await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: 'device-1', agentRef });
        const offeredAt = handle.now();
        expect(reserved.attempt).toMatchObject({ offeredAt, updatedAt: offeredAt });
        await handle.advanceTime(1_000);
        expect((await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: 'device-1', agentRef })).attempt)
          .toMatchObject({ offeredAt });
        await expect(stores.tasks.reserveAgentMessage(TENANT_A, {
          taskId, deviceId: 'device-1', messageId: '10000000-0000-4000-8000-000000000981', payloadBody: '{"m":1}',
        })).resolves.toBe('reserved');
        expect(await stores.tasks.get(TENANT_A, taskId)).not.toHaveProperty('firstOutputAt');
      });
    });

    it('records the first draft output once, only for the claiming device after the claim', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const taskId = 'task-draft-output';
        const output = { taskId, deviceId: 'device-1' };
        expect(await stores.tasks.recordFirstOutput(TENANT_A, output)).toBeUndefined();
        expect(await stores.tasks.get(TENANT_A, taskId)).toBeUndefined();

        await stores.tasks.open(TENANT_A, output);
        expect(await stores.tasks.recordFirstOutput(TENANT_A, output)).not.toHaveProperty('firstOutputAt');
        await stores.tasks.claim(TENANT_A, output);
        expect(await stores.tasks.recordFirstOutput(TENANT_A, { taskId, deviceId: 'device-2' })).not.toHaveProperty('firstOutputAt');
        expect(await stores.tasks.recordFirstOutput(TENANT_B, output)).toBeUndefined();

        await handle.advanceTime(1_000);
        const firstOutputAt = handle.now();
        expect(await stores.tasks.recordFirstOutput(TENANT_A, output)).toMatchObject({ firstOutputAt });
        await handle.advanceTime(1_000);
        expect(await stores.tasks.recordFirstOutput(TENANT_A, output)).toMatchObject({ firstOutputAt });
        await expect(stores.tasks.reserveAgentMessage(TENANT_A, {
          ...output, messageId: '10000000-0000-4000-8000-000000000982', payloadBody: '{"m":1}',
        })).resolves.toBe('reserved');
        expect(await stores.tasks.get(TENANT_A, taskId)).toMatchObject({ firstOutputAt });
      });
    });

    it('stamps terminalAt when cancellation ends an unclaimed attempt, and at the terminal of a claimed one', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const cancel = (taskId: string) => stores.cancellations.request(TENANT_A, {
          taskId, proposedMessageId: `cancel-${taskId}`,
          materialize: async () => ({ body: 'cancel', bodyHash: contentHash(`sha256:${'a'.repeat(64)}`), byteSize: 6n }),
        });
        await stores.tasks.open(TENANT_A, { taskId: 'unclaimed', deviceId: 'device-1' });
        await stores.tasks.open(TENANT_A, { taskId: 'claimed', deviceId: 'device-1' });
        await stores.tasks.claim(TENANT_A, { taskId: 'claimed', deviceId: 'device-1' });

        await handle.advanceTime(1_000);
        expect((await cancel('unclaimed'))?.attempt).toMatchObject({ status: 'cancelled', terminalAt: handle.now() });
        expect((await cancel('claimed'))?.attempt).not.toHaveProperty('terminalAt');
        const cancelledAt = handle.now();

        await handle.advanceTime(1_000);
        await cancel('unclaimed');
        await stores.tasks.recordStatus(TENANT_A, { taskId: 'unclaimed', status: 'cancelled' });
        expect(await stores.tasks.get(TENANT_A, 'unclaimed')).toMatchObject({ terminalAt: cancelledAt });
        await stores.tasks.recordStatus(TENANT_A, { taskId: 'claimed', status: 'complete' });
        expect(await stores.tasks.get(TENANT_A, 'claimed')).not.toHaveProperty('terminalAt');
        await stores.tasks.recordStatus(TENANT_A, { taskId: 'claimed', status: 'cancelled' });
        expect(await stores.tasks.get(TENANT_A, 'claimed')).toMatchObject({ status: 'cancelled', terminalAt: handle.now() });
      });
    });

    it('records no snapshot for a claim that carried none: absent, not defaulted', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });
        const claimed = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
        });
        expect(claimed?.claimedRuntime).toBeUndefined();
        expect(claimed?.claimedRuntimeCapabilities).toBeUndefined();
        const stored = await stores.tasks.get(TENANT_A, 'task-1');
        expect(stored?.claimedRuntime).toBeUndefined();
        expect(stored?.claimedRuntimeCapabilities).toBeUndefined();
      });
    });
  });
}
