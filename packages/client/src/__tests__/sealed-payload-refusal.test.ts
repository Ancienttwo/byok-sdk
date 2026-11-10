import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
/**
 * #654 E3a: this daemon does not open sealed content, and it does not
 * advertise `sealed-payload-v1`. A Host that skips the gate can still send it
 * a sealed offer or a sealed steer. The daemon never runs such an offer,
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
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';
import { FRESH_OFFER, freshOfferEgressDeps } from './fixtures/fresh-offer';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v6.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; task_id: string; payload: Record<string, unknown> });
const SEALED_OFFER_FORMS = [
  ['sealed resume', (payload: Record<string, unknown>) => (payload.session as { mode: string }).mode === 'resume' && payload.egressPolicy === undefined],
  ['sealed resume+egress', (payload: Record<string, unknown>) => (payload.session as { mode: string }).mode === 'resume' && payload.egressPolicy !== undefined],
  ['sealed fresh', (payload: Record<string, unknown>) => (payload.session as { mode: string }).mode === 'fresh'],
] as const;
const sealedOffers = SEALED_OFFER_FORMS.flatMap(([form, matches]) => [
  [form, 'sealed input', corpus.find((line) => line.type === 'task.offer' && line.payload.sealing !== undefined && line.payload.sealed !== undefined && matches(line.payload))!],
  [form, 'sealed output only', corpus.find((line) => line.type === 'task.offer' && line.payload.sealing !== undefined && line.payload.sealed === undefined && matches(line.payload))!],
] as const);
const sealedSteer = corpus.find((line) => line.type === 'task.steer' && line.payload.sealed !== undefined)!.payload;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function runnerWith(adapter: StubRuntimeAdapter, sent: Envelope[], missingFlag?: string): Promise<TaskRunner> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-refusal-'));
  dirs.push(dir);
  // The Host skipped the gate in these tests, and the daemon's own advertised-flag
  // check is not the subject: advertise every flag so the offer reaches the sealed decline.
  return new TaskRunner({...testAgentHomeDeps(), ...freshOfferEgressDeps(),
    advertisedCapabilities: () => advertiseEveryDeviceFlag().filter((flag) => flag !== missingFlag),
    getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    deviceId: 'sealed-refusal-device', send: (event) => { sent.push(event); },
    blobClient: {
      resolveInstruction: async () => { throw new Error('unexpected blob resolution'); },
      uploadArtifact: async () => { throw new Error('unexpected upload'); },
    },
    approvalRegistry: new ApprovalRegistry(), storeDir: dir, productId: 'sealed-refusal',
    localAgentRelease: Object.freeze({ version: '0.24.0-rc.1' }),
  });
}

describe('strict offer decline redelivery', () => {
  it('declines a redelivered plaintext offer with a missing capability only once', async () => {
    const sent: Envelope[] = [];
    const runner = await runnerWith(new StubRuntimeAdapter('pi'), sent, 'agent-egress-policy');
    const payload = { agentRef: freshTestAgentRef(), session: { mode: 'resume' as const, sessionRef: 'session-1' }, instruction: 'x', runtime: 'pi' as const, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };
    await runner.handleEnvelope(createEnvelope('task.offer', payload, { taskId: 'plain-decline', seq: 1 }));
    await runner.handleEnvelope(createEnvelope('task.offer', payload, { taskId: 'plain-decline', seq: 2 }));
    const declines = sent.filter((envelope) => envelope.type === 'task.decline');
    expect(declines).toHaveLength(1);
    expect(declines[0]!.payload).toMatchObject({ reason: 'offer_capability_missing: this daemon does not advertise agent-egress-policy', retryable: false });
    expect(declines[0]!.payload).not.toHaveProperty('code');
  });
});

describe('sealed payload refusal on a daemon without sealed-payload-v1 (#654)', () => {
  it.each(sealedOffers)(
    'declines a %s task.offer (%s) non-retryably with the closed code sealed_key_unavailable and never starts a session',
    async (_form, _label, line) => {
      const adapter = new StubRuntimeAdapter('pi');
      const sent: Envelope[] = [];
      const runner = await runnerWith(adapter, sent);
      const offer = createEnvelope('task.offer', line.payload as never, { taskId: 'sealed-task', seq: 1 });

      await runner.handleEnvelope(offer);
      await runner.handleEnvelope(offer);

      const declines = sent.filter((envelope) => envelope.type === 'task.decline');
      expect(declines.map((envelope) => envelope.payload), 'one decline, also for a redelivered offer').toEqual([{
        reason: 'sealed_key_unavailable',
        code: 'sealed_key_unavailable',
        retryable: false,
        agentRef: line.payload.agentRef,
        admission: { totalMs: expect.any(Number) },
      }]);
      expect(sent.filter((envelope) => envelope.type === 'task.claim')).toHaveLength(0);
      expect(adapter.startCalls).toHaveLength(0);
    },
  );

  it('drops a sealed steer and keeps steering the task in plaintext', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = await runnerWith(adapter, sent);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runner.handleEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER,  instruction: 'plain task', runtime: 'pi' }, { taskId: 'plain-task', seq: 1 }));
      const session = adapter.sessions[0]!;

      await runner.handleEnvelope(createEnvelope('task.steer', sealedSteer as never, { taskId: 'plain-task', seq: 2 }));
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
