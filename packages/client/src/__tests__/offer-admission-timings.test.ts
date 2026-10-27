// #1014: admission phase durations on the task.claim or task.decline that ends admission.
import { testScratchOwner } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, OFFER_ADMISSION_MAX_DURATION_MS, type Envelope, type OfferAdmissionTimings } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentEgressController } from '../daemon/agent-egress-controller';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { DaemonObserver, type DaemonEvent } from '../daemon/observer';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { OfferAdmissionTiming } from '../daemon/task-runner/offer-admission-timing';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeCapabilities } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { observationOf } from './fixtures/mcp-observation';
import { testIngressBudget } from './fixtures/activity-ingress';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

const AGENT_REF = { agentId: 'admission-agent', profileRevision: '1' } as const;
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };
const MCP_CAPABLE: RuntimeCapabilities = { steer: false, resume: true, approvalInteractive: true, mcpToolsets: true };
/** Each timed fixture phase sleeps this long; the assertions allow timer jitter below it. */
const PHASE_MS = 25;
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function harness(adapter: StubRuntimeAdapter, overrides: Partial<TaskRunnerDeps> = {}) {
  const sent: Envelope[] = [];
  const runner = new TaskRunner({
    getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }), scratchRoot: testScratchOwner(),
    adapters: [adapter],
    agentHome: new AgentHomeManager({ hostStorageRoot: await temporary('byok-admission-home-') }),
    agentSessionHandoffs: new AgentSessionHandoffStore(),
    deviceId: 'device-admission',
    send: (envelope) => sent.push(envelope),
    blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
    approvalRegistry: new ApprovalRegistry(),
    storeDir: await temporary('byok-admission-store-'),
    productId: 'admission-test',
    tenantId: 'tenant-admission',
    ...overrides,
  });
  return { runner, sent };
}

function admissionOf(sent: readonly Envelope[], type: 'task.claim' | 'task.decline'): OfferAdmissionTimings | undefined {
  const envelope = sent.find((candidate) => candidate.type === type);
  if (envelope === undefined) throw new Error(`no ${type} was sent`);
  return (envelope.payload as { admission?: OfferAdmissionTimings }).admission;
}

function phaseSum(admission: OfferAdmissionTimings): number {
  const { totalMs: _total, ...phases } = admission;
  return Object.values(phases).reduce((sum, value) => sum + value, 0);
}

/** An adapter whose prepared operation resolves its runtime launch the way Pi's does, and fails it. */
class FailingLaunchAdapter extends StubRuntimeAdapter {
  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const prepared = await super.prepare(input);
    if (prepared.kind !== 'prepared') return prepared;
    return { ...prepared, operation: { ...prepared.operation, resolveRuntimeLaunch: async () => { await sleep(PHASE_MS); throw new Error('launch fixture failure'); } } };
  }
}

describe('OfferAdmissionTiming (#1014)', () => {
  it('reports whole milliseconds, a phase that failed included, so the phases never sum past the total', async () => {
    let now = 1000.4;
    const timing = new OfferAdmissionTiming(() => now);
    await timing.time('messageHelperPreflightMs', async () => { now += 10.9; });
    await expect(timing.time('resultHelperPreflightMs', async () => { now += 5.6; throw new Error('preflight fixture'); }))
      .rejects.toThrow('preflight fixture');
    now += 0.2;
    expect(timing.snapshot()).toEqual({ totalMs: 16, messageHelperPreflightMs: 10, resultHelperPreflightMs: 5 });
  });

  it('reports only the total when no phase ran', () => {
    let now = 5;
    const timing = new OfferAdmissionTiming(() => now);
    now += 3;
    expect(timing.snapshot()).toEqual({ totalMs: 3 });
  });

  it('omits the whole block once the total passes the cap, and keeps it at the cap', () => {
    let now = 0;
    const timing = new OfferAdmissionTiming(() => now);
    now = OFFER_ADMISSION_MAX_DURATION_MS;
    expect(timing.snapshot()).toEqual({ totalMs: OFFER_ADMISSION_MAX_DURATION_MS });
    now += 1;
    expect(timing.snapshot()).toBeUndefined();
  });
});

describe('admission timings on the message that ends admission (#1014)', () => {
  it('a claim with no timed phase carries only totalMs', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, sent } = await harness(adapter);
    await runner.handleEnvelope(createEnvelope('task.offer', { ...FRESH_OFFER, instruction: 'work', runtime: 'pi', agentRef: AGENT_REF }, { taskId: 'plain', seq: 1 }));
    expect(admissionOf(sent, 'task.claim')).toEqual({ totalMs: expect.any(Number) });
    await runner.shutdownActiveTasks('test cleanup');
  });

  it('a claim carries both helper preflights, and the total covers them', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, sent } = await harness(adapter, {
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: () => sleep(PHASE_MS),
      agentResultMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-result-mcp.js'] },
      agentResultMcpPreflight: () => sleep(PHASE_MS),
    });
    await runner.handleEnvelope(createEnvelope('task.offer', {
      ...FRESH_OFFER, instruction: 'reply and review', runtime: 'pi', agentRef: AGENT_REF,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
      terminalProjection: { mode: 'result-document', contract: 'example.review.v1', schema: { type: 'object' } },
    }, { taskId: 'helpers', seq: 1 }));
    const admission = admissionOf(sent, 'task.claim')!;
    expect(Object.keys(admission).sort()).toEqual(['messageHelperPreflightMs', 'resultHelperPreflightMs', 'totalMs']);
    expect(admission.messageHelperPreflightMs).toBeGreaterThanOrEqual(PHASE_MS - 5);
    expect(admission.resultHelperPreflightMs).toBeGreaterThanOrEqual(PHASE_MS - 5);
    expect(admission.totalMs).toBeGreaterThanOrEqual(phaseSum(admission));
    await runner.shutdownActiveTasks('test cleanup');
  });

  it('a failed result helper preflight declines with its duration and sends no claim', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, sent } = await harness(adapter, {
      agentResultMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-result-mcp.js'] },
      agentResultMcpPreflight: async () => { await sleep(PHASE_MS); throw new Error('helper tools/list omitted submit_result'); },
    });
    await runner.handleEnvelope(createEnvelope('task.offer', {
      ...FRESH_OFFER, instruction: 'review', runtime: 'pi', agentRef: AGENT_REF,
      terminalProjection: { mode: 'result-document', contract: 'example.review.v1', schema: { type: 'object' } },
    }, { taskId: 'result-preflight', seq: 1 }));
    const admission = admissionOf(sent, 'task.decline')!;
    expect(Object.keys(admission).sort()).toEqual(['resultHelperPreflightMs', 'totalMs']);
    expect(admission.resultHelperPreflightMs).toBeGreaterThanOrEqual(PHASE_MS - 5);
    expect(admission.totalMs).toBeGreaterThanOrEqual(admission.resultHelperPreflightMs!);
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
  });

  it('a claim carries the MCP toolset probe', async () => {
    const adapter = new StubRuntimeAdapter('claude', { kind: 'available' }, MCP_CAPABLE);
    const { runner, sent } = await harness(adapter, {
      getMcpToolsets: () => new Map([['salesko', { mcpServers: { salesko: { command: '/opt/salesko/bin/mcp' } } }]]),
      mcpToolsetToolsProbe: async (serverName) => { await sleep(PHASE_MS); return observationOf({ [serverName]: ['find_leads'] })[serverName]!; },
    });
    await runner.handleEnvelope(createEnvelope('task.offer', {
      ...FRESH_OFFER, instruction: 'find leads', runtime: 'claude', agentRef: AGENT_REF, requiredToolsets: ['salesko'],
    }, { taskId: 'toolsets', seq: 1 }));
    const admission = admissionOf(sent, 'task.claim')!;
    expect(Object.keys(admission).sort()).toEqual(['toolsetProbeMs', 'totalMs']);
    expect(admission.toolsetProbeMs).toBeGreaterThanOrEqual(PHASE_MS - 5);
    await runner.shutdownActiveTasks('test cleanup');
  });

  it('a failed runtime launch declines with its duration', async () => {
    const adapter = new FailingLaunchAdapter('pi');
    const { runner, sent } = await harness(adapter);
    await runner.handleEnvelope(createEnvelope('task.offer', { ...FRESH_OFFER, instruction: 'work', runtime: 'pi', agentRef: AGENT_REF }, { taskId: 'launch', seq: 1 }));
    expect(sent.find((envelope) => envelope.type === 'task.decline')?.payload).toMatchObject({ reason: 'runtime launch admission failed: launch fixture failure' });
    const admission = admissionOf(sent, 'task.decline')!;
    expect(Object.keys(admission).sort()).toEqual(['runtimeLaunchMs', 'totalMs']);
    expect(admission.runtimeLaunchMs).toBeGreaterThanOrEqual(PHASE_MS - 5);
  });

  it('a decline before any phase ran carries only totalMs', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, sent } = await harness(adapter, { agentEgressPolicy: { ...DEFAULT_AGENT_EGRESS_POLICY, policyRevision: 'daemon-v2' } });
    await runner.handleEnvelope(createEnvelope('task.offer', { ...FRESH_OFFER, instruction: 'work', runtime: 'pi', agentRef: AGENT_REF }, { taskId: 'policy', seq: 1 }));
    expect(admissionOf(sent, 'task.decline')).toEqual({ totalMs: expect.any(Number) });
  });
});

describe('DaemonObserver projects admission from the outbound envelope (#1014)', () => {
  const admission = { totalMs: 90, resultHelperPreflightMs: 40 };

  it.each([
    ['task.claim', createEnvelope('task.claim', { deviceId: 'device-1', admission }, { taskId: 'observed' }), { kind: 'claimed', ts: expect.any(String), taskId: 'observed', admission }],
    ['task.decline', createEnvelope('task.decline', { reason: 'busy', retryable: true, admission }, { taskId: 'observed' }), {
      kind: 'failed', ts: expect.any(String), taskId: 'observed', reason: 'busy', retryable: true, preClaim: true, admission,
    }],
  ] as const)('%s', (_type, envelope, expected) => {
    const observer = new DaemonObserver();
    const events: DaemonEvent[] = [];
    observer.subscribe((event) => events.push(event));
    observer.handleOutboundEnvelope(envelope);
    expect(events).toEqual([expected]);
  });
});
