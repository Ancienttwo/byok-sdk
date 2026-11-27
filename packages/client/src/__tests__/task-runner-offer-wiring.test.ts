// #1099 S3: production wiring proof for the offer/admission reducer.
//
// The existing `handle-offer-characterization` suite remains the behavioral
// oracle. This file only adds the seam the oracle cannot see: the per-runner
// host recorded the same decline/claim boundary the wire saw.
import { describe, expect, it } from 'vitest';
import { createEnvelope, isSealedTaskPlainOutput, type Envelope } from '@byok-sdk/protocol';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { ApprovalRegistry } from '../daemon/approvals';
import { hostFor, forgetHost } from '../daemon/task-runner/host';
import { FRESH_OFFER, freshOfferRunnerDeps } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from './fixtures/execution-scratch';
import { testHarnesses, testIngressBudget, acceptClaimSettlement } from './fixtures/activity-ingress';
import { StubRuntimeAdapter, StubSession } from './fixtures/stub-adapter';
import type { BlobResolver } from '../daemon/blob-client';
import { RuntimeExecutionFailure } from '../runtime-failure';

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used in this test'); },
  uploadArtifact: async () => { throw new Error('not used in this test'); },
};

function makeRunner(sent: Envelope[], overrides: Partial<TaskRunnerDeps> = {}): TaskRunner {
  return new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); },
    ...freshOfferRunnerDeps(),
    getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement,
    scratchRoot: testScratchOwner(),
    adapters: [new StubRuntimeAdapter()],
    ...testAgentHomeDeps(),
    deviceId: 'device-1',
    send: envelope => { sent.push(envelope); },
    blobClient: unusedBlobClient,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    approvalRegistry: new ApprovalRegistry(),
    ...overrides,
  });
}

async function offer(runner: TaskRunner, taskId: string, payload: Record<string, unknown> = {}): Promise<void> {
  await runner.handleEnvelope(createEnvelope(
    'task.offer',
    { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER, ...payload },
    { taskId, seq: 1 },
  ));
}

describe('TaskRunner offer/admission host wiring (S3)', () => {
  it('records a limits decline and sends exactly one task.decline', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent, { admissionGuard: () => ({ admit: false, reason: 'admission guard veto', retryable: true }) });
    const taskId = 'task-s3-limits-1';
    await offer(runner, taskId);

    const declines = sent.filter(envelope => envelope.type === 'task.decline');
    expect(declines).toHaveLength(1);
    const payload = declines[0]!.payload as { reason: string; retryable: boolean };
    expect(payload.retryable).toBe(true);

    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('declined');
    expect(archived?.admission.stage).toBe('limits');
    expect(archived?.terminal?.reason).toBe(payload.reason);
    expect(archived?.terminal?.retryable).toBe(true);
    expect(hostFor(runner).current(taskId)).toBeUndefined();
    expect(sent.some(envelope => envelope.type === 'task.claim')).toBe(false);
    forgetHost(runner);
  });

  it('declines a cancel-before-offer at checkpoint 1 through the reducer', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent);
    const taskId = 'task-s3-cancel-before-offer';
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'stop' }, { taskId, seq: 1 }));
    await offer(runner, taskId);

    const decline = sent.find(envelope => envelope.type === 'task.decline');
    expect(decline).toBeDefined();
    expect((decline!.payload as { reason: string }).reason).toBe('cancelled before claim: stop');
    expect(sent.some(envelope => envelope.type === 'task.claim')).toBe(false);

    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('declined');
    expect(archived?.terminal?.reason).toBe('cancelled before claim: stop');
    forgetHost(runner);
  });

  it('records an offer-shape decline from readOfferRequest', async () => {
    const sent: Envelope[] = [];
    // No agent egress policy on this runner: the fresh offer's egress policy is refused.
    const runner = makeRunner(sent, { agentEgressPolicy: undefined });
    const taskId = 'task-s3-egress-1';
    await offer(runner, taskId);

    const decline = sent.find(envelope => envelope.type === 'task.decline');
    expect(decline).toBeDefined();
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('declined');
    expect(archived?.terminal?.reason).toBe('Agent egress offer policy is not exactly enabled by this daemon');
    expect(hostFor(runner).current(taskId)).toBeUndefined();
    forgetHost(runner);
  });

  it.each([true, false])('honors the runtime execution-options opt-in (%s)', async supported => {
    const sent: Envelope[] = [];
    const stub = new StubRuntimeAdapter('grok');
    const prepare = vi.fn<RuntimeAdapter['prepare']>(async ({ offer }) => {
      expect(offer).toMatchObject({ modelId: 'task-model', effort: 'high' });
      return { kind: 'prepared', operation: { start: async () => {
        throw new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason: 'model_rejected', failure: { class: 'model_unavailable' } });
      } } };
    });
    const runner = makeRunner(sent, { adapters: [{
      descriptor: { ...stub.descriptor, supportsEffort: supported },
      detect: () => stub.detect(), runtimeEnvironment: () => stub.runtimeEnvironment(), prepare,
    }] });
    await offer(runner, 'task-options', { target: { lane: 'harness', harnessId: 'grok', selection: { mode: 'adapter-model', modelId: 'task-model' }, effort: 'high' } });
    expect(prepare).toHaveBeenCalledTimes(supported ? 1 : 0);
    expect(sent.some(envelope => envelope.type === 'task.claim')).toBe(supported);
    expect(sent.find(envelope => envelope.type === (supported ? 'task.fail' : 'task.decline'))?.payload).toMatchObject(supported
      ? { reason: 'model_rejected', retryable: false, failure: { class: 'model_unavailable' } }
      : { retryable: false });
    forgetHost(runner);
  });

  it.each([true, false])('admits the tier only on the named adapter (supports tier: %s)', async supported => {
    const sent: Envelope[] = [];
    const stub = new StubRuntimeAdapter('codex');
    const start = vi.fn<PreparedRuntimeOperation['start']>(async ({ manifest }) => {
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(manifest).toMatchObject({ serviceTier: 'fast', serviceTierFallback: 'default' });
      const session = new StubSession('stub-session-tier');
      session.emit({ type: 'turn_end' });
      return session;
    });
    const prepare = vi.fn<RuntimeAdapter['prepare']>(async ({ offer }) => {
      expect(offer).toMatchObject({ serviceTier: 'fast', serviceTierFallback: 'default' });
      return { kind: 'prepared', operation: { start } };
    });
    const descriptor = supported ? { ...stub.descriptor, supportsServiceTier: true, supportsServiceTierFallback: true } : stub.descriptor;
    const runner = makeRunner(sent, { adapters: [{
      descriptor, detect: () => stub.detect(), runtimeEnvironment: () => stub.runtimeEnvironment(), prepare,
    }] });
    const taskId = 'task-tier';
    await offer(runner, taskId, { target: { lane: 'harness', harnessId: 'codex', selection: { mode: 'device-default' },
      serviceTier: 'fast', serviceTierFallback: 'default' } });
    expect(prepare).toHaveBeenCalledTimes(supported ? 1 : 0);
    expect(start).toHaveBeenCalledTimes(supported ? 1 : 0);
    expect(sent.some(envelope => envelope.type === 'task.claim')).toBe(supported);
    if (!supported) expect(sent.find(envelope => envelope.type === 'task.decline')?.payload).toMatchObject({
      reason: expect.stringContaining('service tier'), retryable: false,
    });
    await runner.shutdownActiveTasks('test complete');
    forgetHost(runner);
  });

  it('advances through claim/start and leaves the task running in the reducer (S4 boundary)', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent);
    const taskId = 'task-s4-started-1';
    await offer(runner, taskId);

    expect(sent.some(envelope => envelope.type === 'task.claim')).toBe(true);
    expect(sent.some(envelope => envelope.type === 'task.started')).toBe(true);
    const current = hostFor(runner).current(taskId);
    expect(current?.phase).toBe('running');
    expect(current?.claim.journaled).toBe(true);
    expect(current?.claim.sent).toBe(true);
    expect(current?.execution?.sessionRef).toBe('stub-session-1');
    expect(current?.startup.owner).toBe('active');
    forgetHost(runner);
  });
});

// The device's declaration and the execution lane share the Pi descriptor contract.
import { computeCapabilities } from '../daemon/create-daemon/support';
import { PI_MEMORY_LANE } from '../bin/pi-memory-lane';
import * as nativeRenderer from '../daemon/native-sessions/renderer';
import { vi } from 'vitest';
import { NATIVE_SESSIONS_GUIDANCE } from '../daemon/memory-guidance';
import type { PreparedRuntimeOperation, RuntimeAdapter, RuntimeOperationStartInput } from '../types';

function memoryAdapter(): { adapter: RuntimeAdapter; stub: StubRuntimeAdapter; starts: RuntimeOperationStartInput[] } {
  const stub = new StubRuntimeAdapter();
  const starts: RuntimeOperationStartInput[] = [];
  return { stub, starts, adapter: {
    descriptor: { ...stub.descriptor, memoryLane: PI_MEMORY_LANE },
    runtimeEnvironment: () => stub.runtimeEnvironment(), detect: () => stub.detect(),
    prepare: async input => {
      const prepared = await stub.prepare(input);
      if (prepared.kind !== 'prepared') return prepared;
      return { ...prepared, operation: { ...prepared.operation, start: async input => {
        starts.push(input); return prepared.operation.start(input);
      } } };
    },
  } };
}

const nativeOffer = { target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentMemory: 'none', nativeSessions: { fromMs: 1, toMs: 2 } };
const rendered = { jsonLine: '{"calls":[],"omittedCalls":0}', counts: {} };

describe('native session dream wiring', () => {
  it.each([
    [true, 'darwin', '/sessions', true, true], [true, 'linux', '/sessions', true, true],
    [false, 'darwin', '/sessions', true, false], [true, 'win32', '/sessions', true, false],
    [true, 'darwin', undefined, true, false], [true, 'darwin', '/sessions', false, false],
  ] as const)('declares only with switch=%s platform=%s directory=%s lane=%s', (enabled, platform, sessionDir, lane, expected) => {
    const { adapter, stub } = memoryAdapter();
    const flags = computeCapabilities([lane ? adapter : stub], true, false, false, undefined, false, false, false, false,
      { enabled, platform, sessionDir });
    expect(flags.includes('native-sessions')).toBe(expected);
  });

  it('refuses an undeclared native offer before claim, non-retryably', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent, { advertisedCapabilities: () => [] });
    await offer(runner, 'native-unsupported', nativeOffer);
    expect(sent.find(e => e.type === 'task.decline')?.payload).toMatchObject({ reason: 'native_sessions_unsupported', code: 'native_sessions_unsupported', retryable: false });
    expect(sent.some(e => e.type === 'task.claim')).toBe(false);
  });

  it('reports a switched-off native capability as a closed sealed decline before claim', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent, {
      advertisedCapabilities: () => freshOfferRunnerDeps().advertisedCapabilities().filter(flag => flag !== 'native-sessions'),
    });
    await offer(runner, 'native-sealed-unsupported', { ...nativeOffer,
      sealing: { scopeId: 'native-scope', epoch: 1, categories: ['task-output'] },
    });
    const decline = sent.find(e => e.type === 'task.decline')!;
    expect(decline.payload).toMatchObject({ reason: 'native_sessions_unsupported', code: 'native_sessions_unsupported', retryable: false });
    expect(isSealedTaskPlainOutput('task.decline', decline.payload, ['task-output'])).toBe(true);
    expect(sent.some(e => e.type === 'task.claim')).toBe(false);
  });

  it('refuses an explicitly selected non-Pi runtime with the selection rule', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent, { adapters: [new StubRuntimeAdapter('codex')], nativeSessions: { sessionDir: '/sessions' } });
    await offer(runner, 'native-non-pi', { ...nativeOffer, target: { lane: 'harness', harnessId: 'codex', selection: { mode: 'device-default' } } });
    expect(sent.find(e => e.type === 'task.decline')?.payload).toMatchObject({ code: 'native_sessions_selection_invalid', retryable: false });
    expect(sent.some(e => e.type === 'task.claim')).toBe(false);
  });

  // docs/protocol.md §3.2 "Order on the device": a selection rule outranks native-sessions support.
  const withoutNativeFlag = () => freshOfferRunnerDeps().advertisedCapabilities().filter(flag => flag !== 'native-sessions');
  it.each([
    ['the missing-capability check', { advertisedCapabilities: withoutNativeFlag }],
    ['handleOffer', {}],
  ] as const)('declines a rule-breaking native offer on a device without native sessions with the rule code (%s)', async (_path, deps) => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent, deps);
    await offer(runner, 'native-rule-first', { ...nativeOffer, target: { lane: 'auto' } });
    expect(sent.find(e => e.type === 'task.decline')?.payload).toMatchObject({ code: 'native_sessions_selection_invalid', retryable: false });
    expect(sent.some(e => e.type === 'task.claim')).toBe(false);
  });

  it('declines a valid Pi-target native offer in handleOffer when the device runs no native sessions', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent);
    await offer(runner, 'native-unsupported-handle-offer', nativeOffer);
    expect(sent.find(e => e.type === 'task.decline')?.payload).toMatchObject({ code: 'native_sessions_unsupported', retryable: false });
  });

  it('fails a claimed task when rendering fails and never starts it', async () => {
    const render = vi.spyOn(nativeRenderer, 'renderNativeSessions').mockRejectedValue(new nativeRenderer.NativeSessionsUnavailableError('session_directory'));
    const { adapter, starts } = memoryAdapter();
    const sent: Envelope[] = [];
    const runner = makeRunner(sent, { adapters: [adapter], nativeSessions: { sessionDir: '/sessions' } });
    try {
      await offer(runner, 'native-render-failure', nativeOffer);
      expect(sent.some(e => e.type === 'task.claim')).toBe(true);
      expect(sent.find(e => e.type === 'task.fail')?.payload).toMatchObject({ reason: 'native_sessions_unavailable: session_directory', retryable: false });
      expect(starts).toHaveLength(0);
    } finally { render.mockRestore(); await runner.shutdownActiveTasks('test'); }
  });

  it.skipIf(process.platform === 'win32')('orders guidance, JSON data and Host instruction, and supplies a memory grant', async () => {
    const render = vi.spyOn(nativeRenderer, 'renderNativeSessions').mockResolvedValue(rendered as never);
    const { adapter, starts } = memoryAdapter();
    const runner = makeRunner([], { adapters: [adapter], nativeSessions: { sessionDir: '/sessions' } });
    try {
      await offer(runner, 'native-prefix', nativeOffer);
      expect(starts[0]).toMatchObject({ kind: 'instruction', instruction: `${NATIVE_SESSIONS_GUIDANCE}\n\n${rendered.jsonLine}\n\nx`, memoryLane: { mode: 'memory' } });
      expect(render.mock.calls[0]![0]).toMatchObject({ sessionDir: '/sessions', window: nativeOffer.nativeSessions });
    } finally { render.mockRestore(); await runner.shutdownActiveTasks('test'); }
  });

  it.skipIf(process.platform === 'win32').each(['progress', 'summary', 'finalMessage', 'document'])('suppresses native lane %s egress', async field => {
    const render = vi.spyOn(nativeRenderer, 'renderNativeSessions').mockResolvedValue(rendered as never);
    const { adapter, stub } = memoryAdapter();
    const sent: Envelope[] = [];
    const runner = makeRunner(sent, { adapters: [adapter], nativeSessions: { sessionDir: '/sessions' } });
    try {
      await offer(runner, `native-egress-${field}`, nativeOffer);
      stub.sessions[0]!.emit({ type: 'progress', text: 'PRIVATE-NATIVE-TEXT' });
      stub.sessions[0]!.emit({ type: 'turn_end' });
      await vi.waitFor(() => expect(sent.some(e => e.type === 'task.complete')).toBe(true));
      const complete = sent.find(e => e.type === 'task.complete')!;
      if (field === 'progress') expect(sent.some(e => e.type === 'task.progress')).toBe(false);
      else if (field === 'summary') expect(complete.payload).toMatchObject({ summary: '' });
      else expect(complete.payload).not.toHaveProperty(field);
      expect(JSON.stringify(sent)).not.toContain('PRIVATE-NATIVE-TEXT');
    } finally { render.mockRestore(); await runner.shutdownActiveTasks('test'); }
  });

  it.skipIf(process.platform === 'win32')('awaits abort acknowledgement past the ordinary interrupt timeout before closing or ending', async () => {
    const render = vi.spyOn(nativeRenderer, 'renderNativeSessions').mockResolvedValue(rendered as never);
    const { adapter, stub } = memoryAdapter();
    const sent: Envelope[] = [];
    const runner = makeRunner(sent, { adapters: [adapter], nativeSessions: { sessionDir: '/sessions' }, shutdownInterruptTimeoutMs: 1 });
    let ack!: () => void;
    const acknowledgement = new Promise<void>(resolve => { ack = resolve; });
    try {
      await offer(runner, 'native-cancel', nativeOffer);
      const session = stub.sessions[0]!;
      session.interrupt = async () => { session.interruptCalled = true; await acknowledgement; };
      const cancel = runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'stop' }, { taskId: 'native-cancel', seq: 2 }));
      await vi.waitFor(() => expect(session.interruptCalled).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(session.closeCalled).toBe(false);
      expect(sent.some(e => e.type === 'task.cancelled')).toBe(false);
      ack(); await cancel;
      expect(sent.some(e => e.type === 'task.cancelled')).toBe(true);
    } finally { ack(); render.mockRestore(); await runner.shutdownActiveTasks('test'); }
  });
});
