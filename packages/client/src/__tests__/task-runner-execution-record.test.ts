import { testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentEvent, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { ExecutionRecord } from '../daemon/execution-record';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { RuntimeDisposalFailure, RuntimeExecutionFailure } from '../runtime-failure';
import { StubRuntimeAdapter, type StubSession } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

const RECORD_AGENT = { agentId: 'record-agent', profileRevision: 'rev-1' } as const;

const TASK_ID = 'execution-record-task';
const TERMINAL_TYPES = ['task.complete', 'task.fail', 'task.cancelled'];

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface RunnerOptions {
  /** The adapter declares `trajectoryEvidence: 'event-stream'`. */
  declared?: boolean;
  /** Omit `onExecutionRecord` entirely, as a runner that never publishes. */
  withoutRecords?: boolean;
  deps?: Partial<Pick<TaskRunnerDeps, 'awaitTerminalCommit' | 'onRuntimeDisposalFailure' | 'onExecutionRecord'>>;
}

async function makeRunner(options: RunnerOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-execution-record-'));
  directories.push(directory);
  const adapter = new StubRuntimeAdapter('pi', undefined, undefined, undefined, options.declared === true ? 'event-stream' : undefined);
  const sent: Envelope[] = [];
  const records: ExecutionRecord[] = [];
  const runner = new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    ...testAgentHomeDeps(),
    deviceId: 'execution-record-device',
    send: envelope => { sent.push(envelope); },
    blobClient: {
      resolveInstruction: async () => { throw new Error('unused'); },
      uploadArtifact: async () => { throw new Error('unused'); },
    },
    approvalRegistry: new ApprovalRegistry(),
    storeDir: directory,
    productId: 'execution-record-product',
    ...(options.withoutRecords === true ? {} : { onExecutionRecord: (record: ExecutionRecord) => { records.push(record); } }),
    ...options.deps,
  });
  await runner.handleEnvelope(createEnvelope('task.offer_for_agent', { agentRef: RECORD_AGENT,  instruction: 'run' }, { taskId: TASK_ID, seq: 1 }));
  const session = adapter.sessions[0]!;
  const terminals = () => sent.filter(envelope => TERMINAL_TYPES.includes(envelope.type));
  const finished = () => vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
  return { runner, adapter, session, sent, records, terminals, finished };
}

function emitAll(session: StubSession, events: AgentEvent[]): void {
  for (const event of events) session.emit(event);
}

const use = (toolCallId: string): AgentEvent => ({ type: 'tool_use', tool: 'bash', input: { command: 'secret-input' }, toolCallId });
const result = (toolCallId: string): AgentEvent => ({ type: 'tool_result', tool: 'bash', output: { stdout: 'secret-output' }, toolCallId, isError: false });

describe('TaskRunner execution record', () => {
  it('records a paired run of a declaring adapter as complete', async () => {
    const { session, records, terminals, finished } = await makeRunner({ declared: true });
    emitAll(session, [use('a'), result('a'), { type: 'progress', text: 'answer' }, { type: 'turn_end' }]);
    await finished();
    expect(terminals().map(envelope => envelope.type)).toEqual(['task.complete']);
    expect(records).toEqual([{ taskId: TASK_ID, terminal: 'complete', status: 'complete', source: 'event-stream', gaps: [] }]);
  });

  it('records a call without a result as partial, with the unpaired count', async () => {
    const { session, records, finished } = await makeRunner({ declared: true });
    emitAll(session, [use('a'), use('b'), result('b'), { type: 'turn_end' }]);
    await finished();
    expect(records).toEqual([{
      taskId: TASK_ID, terminal: 'complete', status: 'partial', source: 'event-stream', gaps: [{ reason: 'unpaired_tool_call', count: 1 }],
    }]);
  });

  it('adds the counts the session reports below its event stream', async () => {
    const { session, records, finished } = await makeRunner({ declared: true });
    session.evidenceCounts = { decodeDropped: 2, unmappedFrames: 0, syntheticToolResults: 0 };
    emitAll(session, [use('a'), result('a'), { type: 'turn_end' }]);
    await finished();
    expect(records).toMatchObject([{ status: 'partial', gaps: [{ reason: 'decode_dropped', count: 2 }] }]);
  });

  it('records unknown for an adapter that declares no evidence source', async () => {
    const { session, records, finished } = await makeRunner();
    session.evidenceCounts = { decodeDropped: 0, unmappedFrames: 0, syntheticToolResults: 0 };
    emitAll(session, [use('a'), result('a'), { type: 'turn_end' }]);
    await finished();
    expect(records).toEqual([{
      taskId: TASK_ID, terminal: 'complete', status: 'unknown', source: 'none', gaps: [], unknownReason: 'source_not_declared',
    }]);
  });

  it('marks a runtime stream that failed before turn_end', async () => {
    const { session, records, terminals, finished } = await makeRunner({ declared: true });
    session.emit(use('a'));
    session.fail(new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure', retry: 'retryable', reason: 'runtime exited' }));
    await finished();
    expect(terminals().map(envelope => [envelope.type, envelope.payload])).toEqual([['task.fail', { agentRef: RECORD_AGENT, reason: 'runtime exited', retryable: true }]]);
    expect(records).toEqual([{
      taskId: TASK_ID, terminal: 'failed', status: 'partial', source: 'event-stream',
      gaps: [{ reason: 'unpaired_tool_call', count: 1 }, { reason: 'stream_ended_early', count: 1 }],
    }]);
  });

  it('stops at a cancel: events the runtime delivers while it is interrupted are not observed', async () => {
    const { runner, session, sent, records, terminals, finished } = await makeRunner({ declared: true });
    session.emit(use('a'));
    // The pump observes an event before it batches it, so a sent batch proves the call was seen.
    await vi.waitFor(() => expect(sent.some(envelope => envelope.type === 'task.progress')).toBe(true));
    // Like Pi's cooperative abort: the runtime answers the open call and settles during the interrupt.
    let interruptDelivered = false;
    session.interrupt = async () => {
      emitAll(session, [result('a'), { type: 'turn_end' }]);
      interruptDelivered = true;
    };
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'operator' }, { taskId: TASK_ID, seq: 2 }));
    await finished();
    expect(interruptDelivered).toBe(true);
    expect(terminals().map(envelope => envelope.type)).toEqual(['task.cancelled']);
    expect(records).toEqual([{
      taskId: TASK_ID, terminal: 'cancelled', status: 'partial', source: 'event-stream',
      gaps: [{ reason: 'unpaired_tool_call', count: 1 }, { reason: 'no_turn_end', count: 1 }],
    }]);
  });

  it('publishes once, only after Session.close() and the terminal commit', async () => {
    const commitGate = deferred();
    const awaitTerminalCommit = vi.fn(() => commitGate.promise);
    const onRuntimeDisposalFailure = vi.fn();
    const { runner, session, records, terminals } = await makeRunner({ declared: true, deps: { awaitTerminalCommit, onRuntimeDisposalFailure } });
    const originalClose = session.close.bind(session);
    let closeFailures = 1;
    session.close = async () => {
      if (closeFailures-- > 0) throw new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'receipt fixture failed' });
      await originalClose();
    };
    session.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(onRuntimeDisposalFailure).toHaveBeenCalledOnce());
    expect(terminals().map(envelope => envelope.type)).toEqual(['task.complete']);
    expect(runner.activeTaskCount).toBe(1);
    expect(awaitTerminalCommit).not.toHaveBeenCalled();
    expect(records).toEqual([]);

    const retry = runner.retryTerminalFinalization(TASK_ID);
    await vi.waitFor(() => expect(awaitTerminalCommit).toHaveBeenCalledTimes(1));
    expect(records).toEqual([]);
    commitGate.resolve();
    await retry;
    expect(runner.activeTaskCount).toBe(0);
    await runner.retryTerminalFinalization(TASK_ID);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ terminal: 'complete', status: 'complete' });
  });

  it('logs a throwing record listener without its text and finishes the task unchanged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { session, terminals, finished } = await makeRunner({
      declared: true,
      withoutRecords: true,
      deps: { onExecutionRecord: () => { throw new Error('listener secret'); } },
    });
    emitAll(session, [use('a'), result('a'), { type: 'turn_end' }]);
    await finished();
    expect(terminals().map(envelope => envelope.type)).toEqual(['task.complete']);
    const logged = error.mock.calls.map(call => call.join(' ')).filter(line => line.includes('execution record'));
    expect(logged).toEqual([`[byok/client] execution record for task ${TASK_ID} was not published`]);
    expect(error.mock.calls.flat().join(' ')).not.toContain('listener secret');
  });

  it('publishes nothing for a task whose runtime never started', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-execution-record-start-'));
    directories.push(directory);
    const adapter = new StubRuntimeAdapter('pi', undefined, undefined, undefined, 'event-stream');
    adapter.startError = new RuntimeExecutionFailure({ phase: 'start', category: 'infrastructure', retry: 'retryable', reason: 'spawn failed' });
    const sent: Envelope[] = [];
    const onExecutionRecord = vi.fn();
    const runner = new TaskRunner({...testAgentHomeDeps(),  getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
      adapters: [adapter], deviceId: 'execution-record-device',
      send: envelope => { sent.push(envelope); },
      blobClient: { resolveInstruction: async () => { throw new Error('unused'); }, uploadArtifact: async () => { throw new Error('unused'); } },
      approvalRegistry: new ApprovalRegistry(),
      storeDir: directory, productId: 'execution-record-product', onExecutionRecord,
    });
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent', { agentRef: RECORD_AGENT,  instruction: 'run' }, { taskId: TASK_ID, seq: 1 }));
    expect(sent.filter(envelope => TERMINAL_TYPES.includes(envelope.type)).map(envelope => envelope.type)).toEqual(['task.fail']);
    expect(onExecutionRecord).not.toHaveBeenCalled();
  });
});

describe('TaskRunner execution record invariance', () => {
  /** Every outbound envelope minus its random id and clock: what the server, and so K4, can see. */
  function wire(sent: readonly Envelope[]): string[] {
    return sent.map(envelope => JSON.stringify({ type: envelope.type, task_id: envelope.task_id, session_ref: envelope.session_ref, payload: envelope.payload }));
  }

  const variants: Array<[string, RunnerOptions, (session: StubSession) => void]> = [
    ['no record listener and no declared source', { withoutRecords: true }, () => {}],
    ['an unknown record', {}, () => {}],
    ['a declared source', { declared: true }, () => {}],
    ['a declared source with adapter counts', { declared: true }, session => { session.evidenceCounts = { decodeDropped: 3, unmappedFrames: 1, syntheticToolResults: 0 }; }],
  ];

  type Script = (session: StubSession, runner: TaskRunner, sent: readonly Envelope[]) => void | Promise<void>;
  it.each<[string, Script]>([
    ['a completed task', session => emitAll(session, [use('a'), result('a'), { type: 'progress', text: 'answer' }, { type: 'turn_end' }])],
    ['a failed task', session => {
      emitAll(session, [use('a'), { type: 'progress', text: 'partial work' }]);
      session.fail(new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: 'runtime refused' }));
    }],
    ['a cancelled task', async (session, runner, sent) => {
      session.emit(use('a'));
      // A sent batch proves the pump observed the call before the cancel.
      await vi.waitFor(() => expect(sent.some(envelope => envelope.type === 'task.progress')).toBe(true));
      await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'operator' }, { taskId: TASK_ID, seq: 2 }));
    }],
  ])('keeps the wire bytes of %s identical, with one start and one terminal, whatever the record says', async (_label, script) => {
    const outcomes: Array<{ wire: string[]; starts: number; record?: ExecutionRecord }> = [];
    for (const [, options, prepare] of variants) {
      const { runner, adapter, session, sent, records, finished } = await makeRunner(options);
      prepare(session);
      await script(session, runner, sent);
      await finished();
      outcomes.push({ wire: wire(sent), starts: adapter.startCalls.length, ...(records[0] === undefined ? {} : { record: records[0] }) });
    }
    expect(outcomes.map(outcome => outcome.record?.status)).toEqual([undefined, 'unknown', expect.any(String), 'partial']);
    for (const outcome of outcomes) {
      expect(outcome.wire).toEqual(outcomes[0]!.wire);
      expect(outcome.starts).toBe(1);
      expect(outcome.wire.filter(line => TERMINAL_TYPES.some(type => line.includes(`"type":"${type}"`)))).toHaveLength(1);
      // Counts and closed codes only: the record never carries tool content.
      if (outcome.record !== undefined) expect(JSON.stringify(outcome.record)).not.toMatch(/secret-(input|output)|answer|partial work|runtime refused/);
    }
  });
});
