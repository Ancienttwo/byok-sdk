/**
 * Replays across the terminal-task archive on the embedded SQLite server
 * (#1120). The archive tombstones the offer; a replayed winning claim and a
 * replayed `daemon_interrupted` recovery report still get the answer they got
 * before, from the claim snapshot and the terminal receipt the task keeps.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { createByokServer, createHmacTokenSigner } from '../index';
import { isSqliteAvailable } from '../sqlite-support';
import { connectFakeDaemonLongPoll, startServer, stopServer } from './test-support';

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
const PRODUCT_ID = 'acme-task-archive';
const AGENT = { agentId: 'archive-agent', profileRevision: 'rev-1' };
const CAPABILITIES = [
  'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
];
const EGRESS_POLICY = {
  policyRevision: '1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;

describeSqlite('SQLite terminal-task archive replays (#1120)', () => {
  it('answers a winning claim and a recovery report as before the archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'byok-sqlite-archive-replay-'));
    // Windows of milliseconds, so the archive runs within the test.
    const instance = createByokServer({
      productId: PRODUCT_ID, storage: { kind: 'sqlite', path: join(root, 'sdk.sqlite') }, longPollHoldMs: 20,
      tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }),
      maintenance: { policy: { mailboxUnackedRetentionMs: 1n, mailboxDeadLetterRetentionMs: 1n, terminalTaskArchiveMs: 2n } },
    });
    const http = await startServer(instance);
    try {
      const daemon = await connectFakeDaemonLongPoll(http.baseUrl, instance, { productId: PRODUCT_ID, capabilities: CAPABILITIES });
      const send = async (envelope: Envelope) => (await daemon.send(envelope)).json() as Promise<unknown>;
      const submit = async (taskId: string) => {
        await instance.executions.submit({
          taskId, deviceId: daemon.deviceId,
          payload: { instruction: 'archive me', runtime: 'pi', session: { mode: 'fresh' }, agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
        });
        return (await daemon.next()).find((event) => event.type === 'task.offer' && event.task_id === taskId)!;
      };

      await submit('claimed');
      const claim = createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef: AGENT }, { taskId: 'claimed' });
      expect(await send(claim)).toMatchObject({ accepted: 1 });
      expect(await send(createEnvelope('task.fail', { reason: 'boom', retryable: false, agentRef: AGENT }, { taskId: 'claimed' })))
        .toMatchObject({ accepted: 1 });
      const offer = await submit('interrupted');
      const recovery = createEnvelope('task.fail', { reason: 'daemon_interrupted', retryable: false, agentRef: AGENT,
        recovery: { kind: 'daemon_interrupted', offerId: offer.id } }, { taskId: 'interrupted' });
      expect(await send(recovery)).toMatchObject({ accepted: 1 });
      await daemon.next();

      const replays = async () => [await send(claim), await send(recovery)];
      const before = await replays();
      expect(before).toEqual([
        expect.objectContaining({ outcomes: [{ id: claim.id, outcome: 'duplicate' }] }),
        expect.objectContaining({ outcomes: [{ id: recovery.id, outcome: 'duplicate' }] }),
      ]);

      await delay(10);
      const report = await instance.maintenance.runNow();
      expect(report.steps.find((step) => step.step === 'tasks')).toEqual({ step: 'tasks', status: 'ok', archived: 2, settled: 2, refused: 0, more: false });
      expect(await replays()).toEqual(before);
    } finally {
      await stopServer(http.server);
      await instance.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
