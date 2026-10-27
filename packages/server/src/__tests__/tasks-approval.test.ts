import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isCloudError } from '@byok-sdk/cloud';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { createByokServer, StaleApprovalError, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, sendOne, startServer, stopServer, type FakeLongPollDaemon } from './test-support';

const PRODUCT_ID = 'acme-approvals';
const AGENT = { agentId: 'approval-agent', profileRevision: 'rev-1' };
const EXECUTION_CAPABILITIES = [
  'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
];
const EGRESS_POLICY = {
  policyRevision: '1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;

/**
 * `ByokServer.tasks.approve`/`reject` decide a pending approval by taskId, so
 * a task that `executions.submit` created (and that has no TaskHandle) can be
 * approved. They share `TaskHandle.approve`/`reject`'s one code path, so they
 * refuse in the same cases.
 */
describe('ByokServer.tasks.approve/reject', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(): Promise<{ byok: ByokServer; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 150 });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID, capabilities: EXECUTION_CAPABILITIES });
    return { byok: instance, daemon };
  }

  /** A submitted execution, claimed and started by the fake device. */
  async function runningExecution(instance: ByokServer, daemon: FakeLongPollDaemon, taskId: string): Promise<void> {
    await instance.executions.submit({
      taskId,
      deviceId: daemon.deviceId,
      payload: { instruction: 'needs a human ok', runtime: 'pi', agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
    });
    expect(await sendOne(daemon, createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef: AGENT }, { taskId })))
      .toMatchObject({ status: 200, body: { accepted: 1 } });
    expect(await sendOne(daemon, createEnvelope('task.started', {}, { taskId }))).toMatchObject({ status: 200, body: { accepted: 1 } });
    expect((await instance.tasks.get(taskId))?.state).toBe('Running');
  }

  async function awaitApproval(instance: ByokServer, daemon: FakeLongPollDaemon, taskId: string, approvalId: string): Promise<void> {
    expect(await sendOne(daemon, createEnvelope('task.await_approval', { summary: 'ok?', approvalId }, { taskId })))
      .toMatchObject({ status: 200, body: { accepted: 1 } });
    expect((await instance.tasks.get(taskId))?.state).toBe('AwaitApproval');
  }

  /** Every decision the device received since its last poll, with the approval it names. */
  async function decisions(daemon: FakeLongPollDaemon): Promise<Array<{ type: string; approvalId?: unknown; reason?: unknown }>> {
    return (await daemon.next())
      .filter((envelope: Envelope) => envelope.type === 'task.approve' || envelope.type === 'task.reject')
      .map((envelope: Envelope) => {
        const payload = envelope.payload as { approvalId?: unknown; reason?: unknown };
        return { type: envelope.type, approvalId: payload.approvalId, ...(payload.reason === undefined ? {} : { reason: payload.reason }) };
      });
  }

  it('approves and then rejects the pending approvals of a submitted execution', async () => {
    const { byok: instance, daemon } = await start();
    await runningExecution(instance, daemon, 'submitted-1');

    await awaitApproval(instance, daemon, 'submitted-1', 'appr-1');
    await instance.tasks.approve('submitted-1');
    expect((await instance.tasks.get('submitted-1'))?.state).toBe('Running');
    expect(await decisions(daemon)).toEqual([{ type: 'task.approve', approvalId: 'appr-1' }]);

    await awaitApproval(instance, daemon, 'submitted-1', 'appr-2');
    await instance.tasks.reject('submitted-1', 'looked risky', { approvalId: 'appr-2' });
    expect((await instance.tasks.get('submitted-1'))?.state).toBe('Running');
    expect(await decisions(daemon)).toEqual([{ type: 'task.reject', approvalId: 'appr-2', reason: 'looked risky' }]);
  });

  it('refuses an unknown task with task_not_found', async () => {
    const { byok: instance } = await start();
    for (const decide of [() => instance.tasks.approve('no-such-task'), () => instance.tasks.reject('no-such-task', 'no')]) {
      const refused = await decide().catch((error: unknown) => error);
      expect(isCloudError(refused, 'task_not_found')).toBe(true);
    }
  });

  it('refuses a task with no pending approval with task_not_awaiting_approval and changes nothing', async () => {
    const { byok: instance, daemon } = await start();
    await runningExecution(instance, daemon, 'submitted-2');
    for (const decide of [() => instance.tasks.approve('submitted-2'), () => instance.tasks.reject('submitted-2', 'too late')]) {
      const refused = await decide().catch((error: unknown) => error);
      expect(isCloudError(refused, 'task_not_awaiting_approval')).toBe(true);
      expect((await instance.tasks.get('submitted-2'))?.state).toBe('Running');
    }
    expect(await decisions(daemon)).toEqual([]);
  });

  it('refuses an approvalId that is not the pending one with StaleApprovalError and changes nothing', async () => {
    const { byok: instance, daemon } = await start();
    await runningExecution(instance, daemon, 'submitted-3');
    await awaitApproval(instance, daemon, 'submitted-3', 'appr-current');
    for (const decide of [
      () => instance.tasks.approve('submitted-3', { approvalId: 'appr-other' }),
      () => instance.tasks.reject('submitted-3', 'no', { approvalId: 'appr-other' }),
    ]) {
      const refused = await decide().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(StaleApprovalError);
      expect(refused).toMatchObject({ taskId: 'submitted-3', requestedApprovalId: 'appr-other', currentApprovalId: 'appr-current' });
      expect((await instance.tasks.get('submitted-3'))?.state).toBe('AwaitApproval');
    }
    expect(await decisions(daemon)).toEqual([]);
  });
});
