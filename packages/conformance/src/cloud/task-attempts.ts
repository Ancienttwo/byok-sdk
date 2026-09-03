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
import { TENANT_A } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

export function runTaskAttemptConformance(factory: CloudCompositionFactory): void {
  describe('task attempts', () => {
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
