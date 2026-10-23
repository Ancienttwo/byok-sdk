/**
 * #654 E3a: this daemon does not open sealed content, and it does not
 * advertise `sealed-payload-v1`. A Host that skips the gate can still send it
 * a sealed offer or steer, whose moved fields are only placeholders. The
 * daemon must never run or inject a placeholder: it declines the offer
 * non-retryably and drops the steer. The payloads are the golden corpus lines.
 */
import { testScratchOwner } from './fixtures/execution-scratch';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope, type TaskOfferPayload, type TaskSteerPayload } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
const sealedOffer = corpus.find((line) => line.type === 'task.offer' && line.payload.sealed !== undefined)!.payload as TaskOfferPayload;
const outputOnlySealing = corpus.find((line) => line.payload.sealing !== undefined && line.payload.sealed === undefined)!.payload.sealing;
const sealedSteer = corpus.find((line) => line.type === 'task.steer' && line.payload.sealed !== undefined)!.payload as TaskSteerPayload;

const dirs: Array<{ dir: string; store: SessionWorkspaceStore }> = [];
afterEach(async () => {
  for (const { dir, store } of dirs.splice(0)) {
    await store.get('cleanup-barrier');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function runnerWith(adapter: StubRuntimeAdapter, sent: Envelope[]): Promise<TaskRunner> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-refusal-'));
  const store = new SessionWorkspaceStore(path.join(dir, 'sessions'));
  dirs.push({ dir, store });
  return new TaskRunner({
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
  });
}

describe('sealed payload refusal on a daemon without sealed-payload-v1 (#654)', () => {
  it.each([
    ['a sealed offer', sealedOffer],
    ['an offer that seals only task output', { instruction: 'Run the watchlist routine', runtime: 'pi', sealing: outputOnlySealing } as TaskOfferPayload],
  ])('declines %s non-retryably and never starts a session', async (_label, payload) => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = await runnerWith(adapter, sent);

    await runner.handleEnvelope(createEnvelope('task.offer', payload, { taskId: 'sealed-task', seq: 1 }));

    const declines = sent.filter((envelope) => envelope.type === 'task.decline');
    expect(declines).toHaveLength(1);
    expect(declines[0]).toMatchObject({
      type: 'task.decline',
      payload: { reason: expect.stringMatching(/^sealed_payload_unsupported:/u), retryable: false },
    });
    expect(declines[0]!.payload).not.toHaveProperty('code');
    expect(sent.filter((envelope) => envelope.type === 'task.claim')).toHaveLength(0);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('drops a sealed steer and never injects its placeholder', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = await runnerWith(adapter, sent);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runner.handleEnvelope(createEnvelope('task.offer', { instruction: 'plain task', runtime: 'pi' }, { taskId: 'plain-task', seq: 1 }));
      const session = adapter.sessions[0]!;

      await runner.handleEnvelope(createEnvelope('task.steer', sealedSteer, { taskId: 'plain-task', seq: 2 }));
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
