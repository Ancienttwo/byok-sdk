import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
/**
 * #654 E3a: this daemon does not open sealed content, and it does not
 * advertise `sealed-payload-v1`. A Host that skips the gate can still send it
 * a sealed offer type or a sealed steer. The daemon never runs such an offer,
 * even when the task seals only its output and the instruction is plaintext:
 * it declines non-retryably. It drops the steer. The payloads are the golden
 * corpus lines.
 */
import { testScratchOwner } from './fixtures/execution-scratch';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope, type MessageType } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; task_id: string; payload: Record<string, unknown> });
const SEALED_OFFER_TYPES = [
  'task.offer_for_agent_sealed',
  'task.offer_for_agent_with_egress_sealed',
  'task.offer_for_agent_with_egress_fresh_sealed',
] as const;
const sealedOffers = SEALED_OFFER_TYPES.flatMap((type) => [
  ['sealed input', corpus.find((line) => line.type === type && line.payload.sealed !== undefined)!],
  ['sealed output only', corpus.find((line) => line.type === type && line.payload.sealed === undefined)!],
] as const);
const sealedSteer = corpus.find((line) => line.type === 'task.steer_sealed')!.payload;

const dirs: Array<{ dir: string; store: SessionWorkspaceStore }> = [];
afterEach(async () => {
  for (const { dir, store } of dirs.splice(0)) {
    await store.get('cleanup-barrier');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function runnerWith(adapter: StubRuntimeAdapter, sent: Envelope[], serverCapabilities: readonly string[] = []): Promise<TaskRunner> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-refusal-'));
  const store = new SessionWorkspaceStore(path.join(dir, 'sessions'));
  dirs.push({ dir, store });
  return new TaskRunner({...testAgentHomeDeps(), 
    getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter], workspaceRoot: path.join(dir, 'workspace'),
    deviceId: 'sealed-refusal-device', send: (event) => { sent.push(event); },
    blobClient: {
      resolveInstruction: async () => { throw new Error('unexpected blob resolution'); },
      uploadArtifact: async () => { throw new Error('unexpected upload'); },
    },
    sessionWorkspaces: store,
    approvalRegistry: new ApprovalRegistry(), storeDir: dir, productId: 'sealed-refusal',
    localAgentRelease: Object.freeze({ version: '0.24.0-rc.1' }),
    getServerCapabilities: () => serverCapabilities,
  });
}

describe('sealed payload refusal on a daemon without sealed-payload-v1 (#654)', () => {
  it.each(sealedOffers.map(([label, line]) => [line.type, label, line] as const))(
    'declines %s (%s) non-retryably and never starts a session',
    async (_type, _label, line) => {
      const adapter = new StubRuntimeAdapter('pi');
      const sent: Envelope[] = [];
      const runner = await runnerWith(adapter, sent);
      const offer = createEnvelope(line.type as (typeof SEALED_OFFER_TYPES)[number], line.payload as never, { taskId: 'sealed-task', seq: 1 });

      await runner.handleEnvelope(offer);
      await runner.handleEnvelope(offer);

      const declines = sent.filter((envelope) => envelope.type === 'task.decline');
      expect(declines, 'one decline, also for a redelivered offer').toHaveLength(1);
      expect(declines[0]).toMatchObject({
        type: 'task.decline',
        task_id: 'sealed-task',
        payload: { reason: expect.stringMatching(/^sealed_payload_unsupported:/u), retryable: false },
      });
      expect(declines[0]!.payload).not.toHaveProperty('code');
      expect(declines[0]!.payload).toMatchObject({ agentRef: line.payload.agentRef });
      expect(sent.filter((envelope) => envelope.type === 'task.claim')).toHaveLength(0);
      expect(adapter.startCalls).toHaveLength(0);
    },
  );

  it.each(sealedOffers.map(([label, line]) => [line.type, label, line] as const))(
    'declines %s (%s) with the closed code sealed_key_unavailable to a server with sealed-payload-v1',
    async (_type, _label, line) => {
      const adapter = new StubRuntimeAdapter('pi');
      const sent: Envelope[] = [];
      const runner = await runnerWith(adapter, sent, ['sealed-payload-v1']);

      await runner.handleEnvelope(createEnvelope(line.type as (typeof SEALED_OFFER_TYPES)[number], line.payload as never, { taskId: 'sealed-task', seq: 1 }));

      const declines = sent.filter((envelope) => envelope.type === 'task.decline');
      expect(declines.map((envelope) => envelope.payload)).toEqual([{
        reason: 'sealed_key_unavailable',
        code: 'sealed_key_unavailable',
        retryable: false,
        agentRef: line.payload.agentRef,
      }]);
      expect(adapter.startCalls).toHaveLength(0);
    },
  );

  it('drops a sealed steer and keeps steering the task in plaintext', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = await runnerWith(adapter, sent);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runner.handleEnvelope(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'plain task', runtime: 'pi' }, { taskId: 'plain-task', seq: 1 }));
      const session = adapter.sessions[0]!;

      await runner.handleEnvelope(createEnvelope('task.steer_sealed', sealedSteer as never, { taskId: 'plain-task', seq: 2 }));
      expect(session.steerCalls).toEqual([]);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('sealed task.steer'));

      await runner.handleEnvelope(createEnvelope('task.steer', { text: 'go left' }, { taskId: 'plain-task', seq: 3 }));
      expect(session.steerCalls).toEqual(['go left']);
    } finally {
      diagnostic.mockRestore();
      await runner.shutdownActiveTasks('test cleanup');
    }
  });
});
