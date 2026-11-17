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
import {
  AGENT_HOME_CONTRACT_CAPABILITY, capabilityDeclarationForPorts, createByokCloud, createHmacTokenSigner, createInMemoryByokCloud,
  handleInboundEnvelope, tenantStoresFor, terminalReceiptKey, TASK_ATTEMPT_STATUSES,
} from '@byok-sdk/cloud';
import { AGENT_MESSAGE_EGRESS_CAPABILITY, createEnvelope } from '@byok-sdk/protocol';
import { PI_EXECUTOR, registration, TENANT_A, TENANT_B } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

const AGENT_REF = { agentId: 'agent-1', profileRevision: 'rev-1' } as const;

export function runTaskAttemptConformance(factory: CloudCompositionFactory): void {
  describe('task attempts', () => {
    it('aggregates every status, separates cancellation markers, and isolates tenants', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const zeros = Object.fromEntries(TASK_ATTEMPT_STATUSES.map((status) => [status, 0]));
        expect(await stores.tasks.countByStatus(TENANT_A)).toEqual({ byStatus: zeros, cancellationRequested: 0 });
        for (const status of TASK_ATTEMPT_STATUSES) {
          await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: `status-${status}`, deviceId: 'device-1', agentRef: AGENT_REF });
          await stores.tasks.recordStatus(TENANT_A, { taskId: `status-${status}`, status, agentRef: AGENT_REF });
        }
        for (const owned of [false, true]) {
          const taskId = owned ? 'cancel-owned' : 'cancel-unowned';
          await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: 'device-1', agentRef: AGENT_REF });
          if (owned) await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-1', executor: PI_EXECUTOR });
          await stores.cancellations.request(TENANT_A, {
            taskId, proposedMessageId: `message-${taskId}`,
            materialize: async () => ({ body: 'cancel', bodyHash: contentHash(`sha256:${'a'.repeat(64)}`), byteSize: 6n }),
          });
          const late = await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete', agentRef: AGENT_REF });
          expect(late?.status).toBe(owned ? 'cancel_requested' : 'cancelled');
        }
        await stores.tasks.reserveAgentOffer(TENANT_B, { taskId: 'status-complete', deviceId: 'other', agentRef: AGENT_REF });
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
          await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: 'device-1', agentRef: AGENT_REF });
          await stores.tasks.recordStatus(TENANT_A, { taskId, status, agentRef: AGENT_REF });
        }
        await stores.tasks.reserveAgentOffer(TENANT_B, { taskId: 'task-1', deviceId: 'other', agentRef: AGENT_REF });
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-7', deviceId: 'device-1', agentRef: AGENT_REF });
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

    it('reserves an unowned attempt and reads it back', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const { attempt } = await stores.tasks.reserveAgentOffer(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
          agentRef: AGENT_REF,
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

    it('is idempotent on re-reserve: the first offer is the fact', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', agentRef: AGENT_REF });
        const again = await stores.tasks.reserveAgentOffer(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-2',
          agentRef: AGENT_REF,
        });
        expect(again.attempt.deviceId).toBe('device-1');
      });
    });

    it('gives ownership to the first claim and never transfers it', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', agentRef: AGENT_REF });

        const first = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
          executor: PI_EXECUTOR,
        });
        expect(first).toMatchObject({ ownerDeviceId: 'device-1', status: 'claimed' });

        // A different device's claim does not steal ownership...
        const second = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-2',
          executor: PI_EXECUTOR,
        });
        expect(second?.ownerDeviceId).toBe('device-1');
        // ...and the owner's own re-claim is idempotent, not a second win.
        const repeat = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
          executor: PI_EXECUTOR,
        });
        expect(repeat?.ownerDeviceId).toBe('device-1');
        expect((await stores.tasks.get(TENANT_A, 'task-1'))?.ownerDeviceId).toBe('device-1');
      });
    });

    it('resolves exactly one winner when claims race', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', agentRef: AGENT_REF });

        const claimants = ['device-1', 'device-2', 'device-3', 'device-4'];
        const results = await Promise.all(
          claimants.map((deviceId) => stores.tasks.claim(TENANT_A, { taskId: 'task-1', deviceId, executor: PI_EXECUTOR })),
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
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', agentRef: AGENT_REF });
        await stores.tasks.claim(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', executor: PI_EXECUTOR });

        const running = await stores.tasks.recordStatus(TENANT_A, {
          taskId: 'task-1',
          status: 'running',
          agentRef: AGENT_REF,
        });
        expect(running).toMatchObject({ status: 'running', ownerDeviceId: 'device-1' });

        const complete = await stores.tasks.recordStatus(TENANT_A, {
          taskId: 'task-1',
          status: 'complete',
          agentRef: AGENT_REF,
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
          await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: exact.deviceId, agentRef: AGENT_REF });
          await expect(stores.tasks.reserveAgentMessage(TENANT_A, exact)).resolves.toBe('reserved');
          await stores.tasks.recordStatus(TENANT_A, { taskId, status, agentRef: AGENT_REF });

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
          await stores.tasks.claim(TENANT_A, { taskId: 'guessed', deviceId: 'device-1', executor: PI_EXECUTOR }),
        ).toBeUndefined();
        expect(
          await stores.tasks.recordStatus(TENANT_A, { taskId: 'guessed', status: 'running', agentRef: AGENT_REF }),
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
    it('snapshots the claiming executor once and never lets a re-claim restamp it', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', agentRef: AGENT_REF });

        const claimed = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
          executor: PI_EXECUTOR,
          capabilities: { steer: true },
        });
        expect(claimed).toMatchObject({
          ownerDeviceId: 'device-1',
          claimedExecutor: PI_EXECUTOR,
          claimedRuntimeCapabilities: { steer: true },
        });

        // The owner's own idempotent re-claim, reporting something else: the
        // first claim is the fact.
        const repeat = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
          executor: { kind: 'runtime', runtimeId: 'codex' },
          capabilities: { steer: false },
        });
        expect(repeat?.claimedExecutor).toEqual(PI_EXECUTOR);
        expect(repeat?.claimedRuntimeCapabilities).toEqual({ steer: true });

        // ...and a losing claim from another device cannot write it either.
        await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-2',
          executor: { kind: 'harness', harnessId: 'acme-harness' },
        });

        const stored = await stores.tasks.get(TENANT_A, 'task-1');
        expect(stored?.claimedExecutor).toEqual(PI_EXECUTOR);
        expect(stored?.claimedRuntimeCapabilities).toEqual({ steer: true });
      });
    });

    it('snapshots custom harness identity once with ownership and every read model', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const taskId = 'custom-task';
        const deviceId = 'device-1';
        const harness = { kind: 'harness', harnessId: 'acme-harness' } as const;
        const other = { kind: 'harness', harnessId: 'other' } as const;
        const expected = { ownerDeviceId: deviceId, claimedExecutor: harness,
          claimedRuntimeCapabilities: { steer: true }, status: 'claimed' };
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId, agentRef: AGENT_REF });
        expect(await stores.tasks.claim(TENANT_A, { taskId, deviceId,
          executor: harness, capabilities: { steer: true } })).toMatchObject(expected);
        for (const retry of [
          { deviceId, executor: other, capabilities: { steer: false } },
          { deviceId: 'device-2', executor: other },
          { deviceId, executor: PI_EXECUTOR },
        ]) expect(await stores.tasks.claim(TENANT_A, { taskId, ...retry })).toMatchObject(expected);
        expect(await stores.tasks.claim(TENANT_B, { taskId, deviceId, executor: other })).toBeUndefined();
        expect(await stores.tasks.get(TENANT_A, taskId)).toMatchObject(expected);
        expect(await stores.tasks.getMany(TENANT_A, [taskId])).toMatchObject([expected]);
        expect((await stores.tasks.list(TENANT_A, { limit: 10 })).attempts).toMatchObject([expected]);
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
          await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: 'device-1', agentRef: AGENT_REF });
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
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', agentRef: AGENT_REF });
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-2', deviceId: 'device-1', agentRef: AGENT_REF });

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
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', agentRef: AGENT_REF });
        await stores.tasks.reserveAgentOffer(TENANT_B, { taskId: 'task-2', deviceId: 'device-2', agentRef: AGENT_REF });

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

        const { attempt: offered } = await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: 'device-1', agentRef: AGENT_REF });
        const offeredAt = handle.now();
        expect(offered).toMatchObject({ offeredAt, updatedAt: offeredAt });
        for (const field of ['claimedAt', 'firstOutputAt', 'terminalAt']) expect(offered).not.toHaveProperty(field);

        await tick();
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: 'device-1', agentRef: AGENT_REF });
        await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-2', executor: PI_EXECUTOR });
        expect(await stores.tasks.get(TENANT_A, taskId)).not.toHaveProperty('claimedAt');

        await tick();
        const claimed = await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-1', executor: PI_EXECUTOR });
        const claimedAt = handle.now();
        expect(claimed).toMatchObject({ offeredAt, claimedAt, updatedAt: claimedAt });

        await tick();
        await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-1', executor: PI_EXECUTOR });
        await stores.tasks.claim(TENANT_A, { taskId, deviceId: 'device-2', executor: PI_EXECUTOR });
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'running', agentRef: AGENT_REF });
        expect(await stores.tasks.get(TENANT_A, taskId)).toMatchObject({ offeredAt, claimedAt });
        expect(await stores.tasks.get(TENANT_A, taskId)).not.toHaveProperty('firstOutputAt');

        await tick();
        await expect(stores.tasks.reserveAgentMessage(TENANT_A, message)).resolves.toBe('reserved');
        const firstOutputAt = handle.now();
        await tick();
        await expect(stores.tasks.reserveAgentMessage(TENANT_A, message)).resolves.toBe('pending');
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'running', agentRef: AGENT_REF });
        expect(await stores.tasks.get(TENANT_A, taskId)).toMatchObject({ firstOutputAt });
        expect(await stores.tasks.get(TENANT_A, taskId)).not.toHaveProperty('terminalAt');

        await tick();
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete', agentRef: AGENT_REF });
        const terminalAt = handle.now();
        await tick();
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete', agentRef: AGENT_REF });
        await stores.tasks.recordStatus(TENANT_A, { taskId, status: 'failed', agentRef: AGENT_REF });
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

        await stores.tasks.reserveAgentOffer(TENANT_A, { ...output, agentRef: AGENT_REF });
        expect(await stores.tasks.recordFirstOutput(TENANT_A, output)).not.toHaveProperty('firstOutputAt');
        await stores.tasks.claim(TENANT_A, { ...output, executor: PI_EXECUTOR });
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

    it.each(['complete', 'failed', 'cancelled'] as const)('records no draft output once a claimed attempt is %s', async (status) => {
      await withCloudComposition(factory, async ({ stores }) => {
        const output = { taskId: `task-late-draft-${status}`, deviceId: 'device-1' };
        await stores.tasks.reserveAgentOffer(TENANT_A, { ...output, agentRef: AGENT_REF });
        await stores.tasks.claim(TENANT_A, { ...output, executor: PI_EXECUTOR });
        await stores.tasks.recordStatus(TENANT_A, { taskId: output.taskId, status, agentRef: AGENT_REF });
        expect(await stores.tasks.recordFirstOutput(TENANT_A, output)).toMatchObject({ status });
        expect(await stores.tasks.get(TENANT_A, output.taskId)).not.toHaveProperty('firstOutputAt');
      });
    });

    it('stamps terminalAt when cancellation ends an unclaimed attempt, and at the terminal of a claimed one', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const cancel = (taskId: string) => stores.cancellations.request(TENANT_A, {
          taskId, proposedMessageId: `cancel-${taskId}`,
          materialize: async () => ({ body: 'cancel', bodyHash: contentHash(`sha256:${'a'.repeat(64)}`), byteSize: 6n }),
        });
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'unclaimed', deviceId: 'device-1', agentRef: AGENT_REF });
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'claimed', deviceId: 'device-1', agentRef: AGENT_REF });
        await stores.tasks.claim(TENANT_A, { taskId: 'claimed', deviceId: 'device-1', executor: PI_EXECUTOR });

        await handle.advanceTime(1_000);
        expect((await cancel('unclaimed'))?.attempt).toMatchObject({ status: 'cancelled', terminalAt: handle.now() });
        expect((await cancel('claimed'))?.attempt).not.toHaveProperty('terminalAt');
        const cancelledAt = handle.now();

        await handle.advanceTime(1_000);
        await cancel('unclaimed');
        await stores.tasks.recordStatus(TENANT_A, { taskId: 'unclaimed', status: 'cancelled', agentRef: AGENT_REF });
        expect(await stores.tasks.get(TENANT_A, 'unclaimed')).toMatchObject({ terminalAt: cancelledAt });
        await stores.tasks.recordStatus(TENANT_A, { taskId: 'claimed', status: 'complete', agentRef: AGENT_REF });
        expect(await stores.tasks.get(TENANT_A, 'claimed')).not.toHaveProperty('terminalAt');
        await stores.tasks.recordStatus(TENANT_A, { taskId: 'claimed', status: 'cancelled', agentRef: AGENT_REF });
        expect(await stores.tasks.get(TENANT_A, 'claimed')).toMatchObject({ status: 'cancelled', terminalAt: handle.now() });
      });
    });

    it('before a claim, refuses execution reports from the offered device and every report from another device (#2289)', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        // The inbound gate reads this composition's tasks, devices and receipts.
        const base = createInMemoryByokCloud();
        const inbound = tenantStoresFor({ kind: 'control-plane', tenantId: TENANT_A, operatorId: 'unclaimed' },
          { core: base.core, cloud: { ...base.stores, ...stores }, mailboxWake: base.mailboxWake });
        const taskId = 'unclaimed';
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: 'device-a', agentRef: AGENT_REF });
        for (const deviceId of ['device-a', 'device-b']) {
          await stores.devices.register(TENANT_A, registration(deviceId));
          await stores.devices.recordCapabilities(TENANT_A, { deviceId, capabilities: [AGENT_MESSAGE_EGRESS_CAPABILITY] });
        }
        const execution = [
          createEnvelope('task.started', {}, { taskId }),
          createEnvelope('task.progress', { seq: 1, events: [] }, { taskId }),
          createEnvelope('task.artifact', { name: 'a.txt', contentType: 'text/plain', inline: 'aGk=' }, { taskId }),
          createEnvelope('task.await_approval', { summary: 'ok?', approvalId: 'approval-1' }, { taskId }),
          createEnvelope('task.approval_resolved', { approvalId: 'approval-1', decision: 'approve', resolvedBy: 'local', at: '2026-11-16T00:00:00.000Z' }, { taskId }),
          createEnvelope('task.steer_refused', { steerMessageId: '10000000-0000-4000-8000-000000000003', reason: 'task_not_active' }, { taskId }),
          createEnvelope('task.complete', { agentRef: AGENT_REF, executor: PI_EXECUTOR, summary: 'done', sessionRef: 'session' }, { taskId }),
          createEnvelope('task.fail', { agentRef: AGENT_REF, reason: 'boom' }, { taskId }),
        ];
        for (const report of execution) {
          expect(await handleInboundEnvelope(inbound, 'device-a', report)).toMatchObject({ outcome: 'rejected', reason: 'task_not_claimed' });
        }
        const preClaim = [
          createEnvelope('task.claim', { deviceId: 'device-b', agentRef: AGENT_REF, executor: PI_EXECUTOR }, { taskId }),
          createEnvelope('task.decline', { agentRef: AGENT_REF, reason: 'busy' }, { taskId }),
          createEnvelope('task.cancelled', { agentRef: AGENT_REF }, { taskId }),
          createEnvelope('task.fail', { agentRef: AGENT_REF, reason: 'daemon_interrupted', retryable: false,
            recovery: { kind: 'daemon_interrupted', offerId: '10000000-0000-4000-8000-000000000001' } }, { taskId }),
        ];
        for (const report of [...execution, ...preClaim]) {
          expect(await handleInboundEnvelope(inbound, 'device-b', report)).toMatchObject({ outcome: 'rejected', reason: 'task_not_found_for_device' });
        }
        expect(await handleInboundEnvelope(inbound, 'device-b',
          createEnvelope('agent.message.draft', { agentRef: AGENT_REF, revision: 1, offset: 0, text: 'hi' }, { taskId })))
          .toMatchObject({ outcome: 'rejected', reason: 'agent_message_draft_invalid' });
        expect(await handleInboundEnvelope(inbound, 'device-b', createEnvelope('agent.message.publish', {
          agentRef: AGENT_REF, sessionRef: 'session', contract: 'example.chat.v1', messageId: '10000000-0000-4000-8000-000000000002',
          cursor: 1, contentType: 'text/markdown', body: 'hello', byteCount: 5,
          contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        }, { taskId }))).toMatchObject({ outcome: 'rejected', reason: 'task_not_found_for_device' });
        const attempt = await stores.tasks.get(TENANT_A, taskId);
        expect(attempt).toMatchObject({ status: 'offered' });
        expect(attempt?.ownerDeviceId).toBeUndefined();
        expect(await stores.agentMessageDraft.read(TENANT_A, taskId)).toBeUndefined();
        expect(await stores.activity.read(TENANT_A, taskId)).toBeUndefined();
        expect(await stores.approvals.read(TENANT_A, taskId)).toBeUndefined();
        expect(await stores.receipts.get(TENANT_A, terminalReceiptKey(taskId))).toBeUndefined();
      });
    });

    it('holds an executor to the offer target, and an unclaimed interruption records no claim (wire v7 §3.1)', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const base = createInMemoryByokCloud();
        const cloud = createByokCloud({
          core: base.core, cloud: { ...base.stores, ...stores }, clock: base.clock, crypto: base.crypto,
          tokenSigner: createHmacTokenSigner(globalThis.crypto.getRandomValues(new Uint8Array(32)), { now: () => new Date() }),
          mailboxWake: base.mailboxWake, proofReceiptRetention: base.proofReceiptRetention,
          capabilities: capabilityDeclarationForPorts({ blobContentProxy: base.blobContentProxy }), blobContentProxy: base.blobContentProxy,
        });
        const inbound = tenantStoresFor({ kind: 'control-plane', tenantId: TENANT_A, operatorId: 'executor' },
          { core: base.core, cloud: { ...base.stores, ...stores }, mailboxWake: base.mailboxWake });
        await base.core.quota.writeEntitlement(TENANT_A, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
          maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
        await stores.devices.register(TENANT_A, registration('device-a'));
        await stores.devices.recordCapabilities(TENANT_A, { deviceId: 'device-a', capabilities: [AGENT_HOME_CONTRACT_CAPABILITY] });
        const offer = (taskId: string) => cloud.enqueueAgentOffer(TENANT_A, 'device-a', { taskId, payload: {
          instruction: 'work', agentRef: AGENT_REF, session: { mode: 'resume', sessionRef: 'session' }, target: { lane: 'runtime', runtimeId: 'pi' },
        } });
        const CODEX = { kind: 'runtime', runtimeId: 'codex' } as const;
        const interrupted = (taskId: string, offerId: string, executor: typeof PI_EXECUTOR) => createEnvelope('task.fail', {
          agentRef: AGENT_REF, executor, reason: 'daemon_interrupted', retryable: false, recovery: { kind: 'daemon_interrupted', offerId },
        }, { taskId });
        const claim = (taskId: string, executor: typeof PI_EXECUTOR) =>
          createEnvelope('task.claim', { deviceId: 'device-a', agentRef: AGENT_REF, executor }, { taskId });

        // Unclaimed, an executor the offer allows: failed, with no owner or claimed executor.
        const allowed = await offer('allowed');
        expect(await handleInboundEnvelope(inbound, 'device-a', interrupted('allowed', allowed.envelope.id, PI_EXECUTOR))).toEqual({ outcome: 'accepted' });
        const settled = await stores.tasks.get(TENANT_A, 'allowed');
        expect(settled).toMatchObject({ status: 'failed' });
        expect(settled?.ownerDeviceId).toBeUndefined();
        expect(settled?.claimedExecutor).toBeUndefined();
        const result = await cloud.readTaskResult(TENANT_A, 'allowed');
        expect(result).toMatchObject({ state: 'failed', recovery: { kind: 'daemon_interrupted' } });
        expect(result).not.toHaveProperty('executor');

        // Unclaimed, an executor the offer does not allow: refused, still offered.
        const refused = await offer('refused');
        expect(await handleInboundEnvelope(inbound, 'device-a', interrupted('refused', refused.envelope.id, CODEX)))
          .toMatchObject({ outcome: 'rejected', reason: 'terminal_executor_mismatch' });
        expect(await stores.tasks.get(TENANT_A, 'refused')).toMatchObject({ status: 'offered' });
        // A claim is held to the same rule.
        expect(await handleInboundEnvelope(inbound, 'device-a', claim('refused', CODEX)))
          .toMatchObject({ outcome: 'rejected', reason: 'claim_offer_mismatch' });
        expect((await stores.tasks.get(TENANT_A, 'refused'))?.ownerDeviceId).toBeUndefined();

        // Claimed, a different executor: refused, still claimed.
        const claimed = await offer('claimed');
        expect(await handleInboundEnvelope(inbound, 'device-a', claim('claimed', PI_EXECUTOR))).toEqual({ outcome: 'accepted' });
        expect(await handleInboundEnvelope(inbound, 'device-a', interrupted('claimed', claimed.envelope.id, CODEX)))
          .toMatchObject({ outcome: 'rejected', reason: 'terminal_executor_mismatch' });
        expect(await stores.tasks.get(TENANT_A, 'claimed')).toMatchObject({ status: 'claimed', ownerDeviceId: 'device-a', claimedExecutor: PI_EXECUTOR });
      });
    });

    it('records no capability snapshot for a claim that carried none: absent, not defaulted', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.reserveAgentOffer(TENANT_A, { taskId: 'task-1', deviceId: 'device-1', agentRef: AGENT_REF });
        const claimed = await stores.tasks.claim(TENANT_A, {
          taskId: 'task-1',
          deviceId: 'device-1',
          executor: PI_EXECUTOR,
        });
        expect(claimed?.claimedRuntimeCapabilities).toBeUndefined();
        const stored = await stores.tasks.get(TENANT_A, 'task-1');
        expect(stored?.claimedExecutor).toEqual(PI_EXECUTOR);
        expect(stored?.claimedRuntimeCapabilities).toBeUndefined();
      });
    });
  });
}
