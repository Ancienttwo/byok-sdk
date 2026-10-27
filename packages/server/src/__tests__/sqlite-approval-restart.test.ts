import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { createByokServer, createHmacTokenSigner, type TaskEventEntry } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer } from './test-support';
const PRODUCT_ID = 'acme-task-events';
const AGENT = { agentId: 'events-agent', profileRevision: 'rev-1' };
const EXECUTION_CAPABILITIES = [
  'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
];
const EGRESS_POLICY = {
  policyRevision: '1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;
async function take(reader: AsyncIterator<TaskEventEntry>, count: number): Promise<TaskEventEntry[]> {
  const result: TaskEventEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const next = await reader.next();
    if (next.done) throw new Error(`feed ended after ${result.length} of ${count} entries`);
    result.push(next.value);
  }
  return result;
}

describe('ByokServer.tasks.events restoring an approval written before a SQLite restart', () => {
  it.each(['approve', 'reject'] as const)('restores state, stats and request then persists %s', async (decision) => {
    const root = mkdtempSync(join(tmpdir(), 'byok-task-events-seed-'));
    const options = {
      productId: PRODUCT_ID, storage: { kind: 'sqlite' as const, path: join(root, 'sdk.sqlite') }, longPollHoldMs: 20,
      tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }),
    };
    let instance = createByokServer(options);
    let http = await startServer(instance);
    try {
      const daemon = await connectFakeDaemonLongPoll(http.baseUrl, instance, { productId: PRODUCT_ID, capabilities: EXECUTION_CAPABILITIES });
      const post = async (envelope: Envelope) => {
        const response = await fetch(`${http.baseUrl}/byok/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.accessToken}` },
          body: JSON.stringify({ messages: [envelope] }),
        });
        expect(await response.json()).toMatchObject({ accepted: 1 });
      };
      await instance.executions.submit({
        taskId: 'waiting', deviceId: daemon.deviceId,
        payload: { instruction: 'ask first', runtime: 'pi', session: { mode: 'fresh' }, agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
      });
      await post(createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef: AGENT }, { taskId: 'waiting' }));
      await post(createEnvelope('task.started', {}, { taskId: 'waiting' }));

      await post(createEnvelope('task.await_approval', { summary: 'ok to deploy?', approvalId: 'appr-restart' }, { taskId: 'waiting' }));
      await stopServer(http.server);
      await instance.close();
      instance = createByokServer(options);
      http = await startServer(instance);

      const snapshot = (await instance.tasks.get('waiting'))!;
      expect(snapshot).toMatchObject({ state: 'AwaitApproval', pendingApprovalId: 'appr-restart' });
      expect((await instance.stats()).taskCountsByState.AwaitApproval).toBe(1);
      const reader = instance.tasks.events('waiting', { from: 'state' })[Symbol.asyncIterator]();
      const seeded = await take(reader, 2);
      expect(seeded.map((entry) => entry.event)).toEqual([
        { kind: 'await_approval', summary: 'ok to deploy?', approvalId: 'appr-restart' },
        { kind: 'state', state: 'AwaitApproval', at: snapshot.updatedAt },
      ]);
      expect(await take(instance.tasks.events('waiting', { from: 'state' })[Symbol.asyncIterator](), 2)).toEqual(seeded);
      if (decision === 'approve') await instance.tasks.approve('waiting', { approvalId: 'appr-restart' });
      else await instance.tasks.reject('waiting', 'not now', { approvalId: 'appr-restart' });
      expect((await take(reader, 1))[0]!.event).toMatchObject({ kind: 'state', state: 'Running' });
      await reader.return!();
      await stopServer(http.server); await instance.close();
      instance = createByokServer(options); http = await startServer(instance);
      expect(await instance.tasks.get('waiting')).toMatchObject({ state: 'Running' });
      expect((await instance.tasks.get('waiting'))?.pendingApprovalId).toBeUndefined();
      expect((await instance.stats()).taskCountsByState.AwaitApproval).toBe(0);
    } finally {
      await stopServer(http.server);
      await instance.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

