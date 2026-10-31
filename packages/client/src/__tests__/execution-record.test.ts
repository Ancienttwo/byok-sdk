import { freshTestAgentRef } from './fixtures/test-agent';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentEvent } from '@byok-sdk/protocol';
import { appendAuditRecord, auditLogPath, readAuditRecords } from '../daemon/audit-log';
import { formatDaemonEventLine } from '../diagnostics/format';
import { ExecutionRecordAccumulator, MAX_OPEN_TOOL_CALLS, type ExecutionRecord, type ExecutionRecordGap } from '../daemon/execution-record';
import { DaemonObserver, MAX_TRACKED_TASKS } from '../daemon/observer';
import { createDaemonRecordProjector, type DaemonEvent } from '../index';
import type { Session, SessionEvidence } from '../types';

const NO_LOSS: SessionEvidence = { decodeDropped: 0, unmappedFrames: 0, syntheticToolResults: 0 };

function declared(evidence: SessionEvidence | undefined = NO_LOSS): ExecutionRecordAccumulator {
  const session: Pick<Session, 'evidence'> = evidence === undefined ? {} : { evidence: () => evidence };
  return new ExecutionRecordAccumulator('task-1', 'event-stream', session);
}

function feed(accumulator: ExecutionRecordAccumulator, events: AgentEvent[]): ExecutionRecordAccumulator {
  for (const event of events) accumulator.observe(event);
  return accumulator;
}

const use = (toolCallId?: string): AgentEvent => ({ type: 'tool_use', tool: 'bash', input: { command: 'secret-input' }, ...(toolCallId === undefined ? {} : { toolCallId }) });
const result = (toolCallId?: string, isError = false): AgentEvent => ({
  type: 'tool_result', tool: 'bash', output: { stdout: 'secret-output' }, isError, ...(toolCallId === undefined ? {} : { toolCallId }),
});
const turnEnd: AgentEvent = { type: 'turn_end' };

describe('ExecutionRecordAccumulator', () => {
  it('is complete when every call has one result, nothing was dropped and turn_end arrived', () => {
    const record = feed(declared(), [use('a'), result('a'), { type: 'progress', text: 'done' }, turnEnd]).finish('complete');
    expect(record).toEqual({ taskId: 'task-1', terminal: 'complete', status: 'complete', source: 'event-stream', gaps: [] });
  });

  it('pairs by toolCallId, not by order, and keeps a tool error as a result', () => {
    // T0: parallel ends can arrive in a different order than their starts.
    const record = feed(declared(), [use('a'), use('b'), result('b', true), result('a'), turnEnd]).finish('failed');
    expect(record).toMatchObject({ terminal: 'failed', status: 'complete', gaps: [] });
  });

  it.each<[string, AgentEvent[], ExecutionRecordGap, number]>([
    ['a call without a result', [use('a'), use('b'), result('b'), turnEnd], 'unpaired_tool_call', 1],
    ['a call without an id', [use(), turnEnd], 'unpaired_tool_call', 1],
    ['a reused open id', [use('a'), use('a'), result('a'), turnEnd], 'unpaired_tool_call', 1],
    ['a result no open call had', [use('a'), result('a'), result('x'), turnEnd], 'orphan_tool_result', 1],
    ['a result without an id', [result(), turnEnd], 'orphan_tool_result', 1],
    ['a second result for one call', [use('a'), result('a'), result('a'), result('a'), turnEnd], 'duplicate_tool_result', 2],
  ])('is partial for %s', (_label, events, reason, count) => {
    const record = feed(declared(), events).finish('complete');
    expect(record.status).toBe('partial');
    expect(record.gaps).toEqual([{ reason, count }]);
  });

  it('counts an id reused after its result as one unpaired call and one duplicate result', () => {
    const record = feed(declared(), [use('a'), result('a'), use('a'), result('a'), turnEnd]).finish('complete');
    expect(record.gaps).toEqual([{ reason: 'unpaired_tool_call', count: 1 }, { reason: 'duplicate_tool_result', count: 1 }]);
  });

  it('adds the session evidence counts and is partial when one of them is above zero', () => {
    const record = feed(declared({ decodeDropped: 2, unmappedFrames: 1, syntheticToolResults: 3 }), [turnEnd]).finish('complete');
    expect(record).toMatchObject({ status: 'partial', gaps: [
      { reason: 'synthetic_tool_result', count: 3 },
      { reason: 'decode_dropped', count: 2 },
      { reason: 'unmapped_frame', count: 1 },
    ] });
  });

  it('reads the session evidence once, when the record is finished', () => {
    const evidence = vi.fn(() => NO_LOSS);
    const accumulator = new ExecutionRecordAccumulator('task-1', 'event-stream', { evidence });
    feed(accumulator, [use('a'), result('a'), turnEnd]);
    expect(evidence).not.toHaveBeenCalled();
    accumulator.finish('complete');
    expect(evidence).toHaveBeenCalledOnce();
  });

  it('counts only the stream when a declaring session has no evidence()', () => {
    expect(feed(declared(undefined), [use('a'), result('a'), turnEnd]).finish('complete')).toMatchObject({ status: 'complete', gaps: [] });
  });

  it('refuses an evidence count that is not a non-negative safe integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => feed(declared({ ...NO_LOSS, decodeDropped: bad }), [turnEnd]).finish('complete')).toThrow(TypeError);
    }
  });

  it('marks a stream that ended before turn_end, and leaves its open calls unpaired', () => {
    const accumulator = feed(declared(), [use('a')]);
    accumulator.streamEnded();
    expect(accumulator.finish('failed').gaps).toEqual([
      { reason: 'unpaired_tool_call', count: 1 },
      { reason: 'stream_ended_early', count: 1 },
    ]);
  });

  it('marks a terminal the daemon decided before turn_end', () => {
    expect(feed(declared(), [use('a'), result('a')]).finish('cancelled')).toMatchObject({
      terminal: 'cancelled', status: 'partial', gaps: [{ reason: 'no_turn_end', count: 1 }],
    });
  });

  it('ignores a stream end after turn_end', () => {
    const accumulator = feed(declared(), [turnEnd]);
    accumulator.streamEnded();
    expect(accumulator.finish('complete').status).toBe('complete');
  });

  it('counts a tool input or output whose spilled bytes could not be stored', () => {
    const spill = { field: 'output' as const, totalBytes: 9, omittedBytes: 9, contentType: 'application/json' as const, unstoredReason: 'upload failed' };
    const record = feed(declared(), [
      { ...use('a'), spill: { ...spill, field: 'input' } } as AgentEvent,
      { ...result('a'), spill } as AgentEvent,
      turnEnd,
    ]).finish('complete');
    expect(record.gaps).toEqual([{ reason: 'spill_unstored', count: 2 }]);
  });

  it(`tracks ${MAX_OPEN_TOOL_CALLS} open calls and is unknown at one more`, () => {
    const atLimit = declared();
    for (let index = 0; index < MAX_OPEN_TOOL_CALLS; index++) atLimit.observe(use(`call-${index}`));
    atLimit.observe(turnEnd);
    expect(atLimit.finish('complete')).toMatchObject({ status: 'partial', gaps: [{ reason: 'unpaired_tool_call', count: MAX_OPEN_TOOL_CALLS }] });

    const over = declared({ decodeDropped: 1, unmappedFrames: 0, syntheticToolResults: 0 });
    for (let index = 0; index <= MAX_OPEN_TOOL_CALLS; index++) over.observe(use(`call-${index}`));
    over.observe(turnEnd);
    expect(over.finish('complete')).toEqual({
      taskId: 'task-1', terminal: 'complete', status: 'unknown', source: 'event-stream', gaps: [], unknownReason: 'evidence_overflow',
    });
  });

  it('does not count answered calls against the open-call limit', () => {
    const accumulator = declared();
    for (let index = 0; index < MAX_OPEN_TOOL_CALLS * 2; index++) {
      accumulator.observe(use(`call-${index}`));
      accumulator.observe(result(`call-${index}`));
    }
    accumulator.observe(turnEnd);
    expect(accumulator.finish('complete')).toMatchObject({ status: 'complete', gaps: [] });
  });

  it('is unknown without reading evidence when the adapter declares no source', () => {
    const evidence = vi.fn(() => ({ ...NO_LOSS, decodeDropped: 5 }));
    const accumulator = new ExecutionRecordAccumulator('task-1', undefined, { evidence });
    feed(accumulator, [use('a'), turnEnd]);
    expect(accumulator.finish('failed')).toEqual({
      taskId: 'task-1', terminal: 'failed', status: 'unknown', source: 'none', gaps: [], unknownReason: 'source_not_declared',
    });
    expect(evidence).not.toHaveBeenCalled();
  });

  it('carries no tool input or output and stays within 1 KiB with every possible gap present', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const accumulator = new ExecutionRecordAccumulator('t'.repeat(128), 'event-stream', {
      evidence: () => ({ decodeDropped: max, unmappedFrames: max, syntheticToolResults: max }),
    });
    const spill = { field: 'output' as const, totalBytes: 9, omittedBytes: 9, contentType: 'application/json' as const, unstoredReason: 'upload failed' };
    feed(accumulator, [use('a'), use(), result('x'), result('b'), use('c'), result('c'), result('c'), { ...result('d'), spill } as AgentEvent]);
    accumulator.streamEnded();
    const record = accumulator.finish('cancelled');
    expect(record.gaps.map(gap => gap.reason)).toEqual([
      'unpaired_tool_call', 'orphan_tool_result', 'duplicate_tool_result', 'synthetic_tool_result',
      'decode_dropped', 'unmapped_frame', 'stream_ended_early', 'spill_unstored',
    ]);
    const line = JSON.stringify({ kind: 'execution-record', ts: '2026-10-20T00:00:00.000Z', ...record });
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1024);
    for (const content of ['secret-input', 'secret-output', 'bash', 'upload failed']) expect(line).not.toContain(content);
  });
});

describe('execution record as a DaemonEvent, an audit record and a live-view line', () => {
  type RecordEvent = Extract<DaemonEvent, { kind: 'execution-record' }>;
  const partial: RecordEvent = {
    kind: 'execution-record', ts: '2026-10-20T00:00:00.000Z', taskId: 'task-1', terminal: 'complete', status: 'partial', source: 'event-stream',
    gaps: [{ reason: 'unpaired_tool_call', count: 1 }, { reason: 'decode_dropped', count: 2 }],
  };
  const unknown: RecordEvent = {
    kind: 'execution-record', ts: '2026-10-20T00:00:01.000Z', taskId: 'task-2', terminal: 'failed', status: 'unknown', source: 'none',
    gaps: [], unknownReason: 'source_not_declared',
  };

  it('projects to the same content-free record, which the audit log reads back only with its taskId', async () => {
    const records = [partial, unknown].flatMap(event => createDaemonRecordProjector().project(event));
    expect(records).toEqual([partial, unknown]);
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-audit-execution-record-'));
    try {
      for (const record of records) await appendAuditRecord(storeDir, record);
      await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ ...partial, taskId: undefined })}\n`);
      expect(await readAuditRecords(storeDir)).toEqual([partial, unknown]);
    } finally {
      await fs.rm(storeDir, { recursive: true, force: true });
    }
  });

  it('renders one live-view line with its counts and closed codes', () => {
    expect([partial, unknown].map(event => formatDaemonEventLine(event))).toEqual([
      '[2026-10-20T00:00:00.000Z] execution-record taskId=task-1 terminal=complete status=partial source=event-stream gaps=unpaired_tool_call:1,decode_dropped:2',
      '[2026-10-20T00:00:01.000Z] execution-record taskId=task-2 terminal=failed status=unknown source=none unknownReason=source_not_declared',
    ]);
  });

  function observed() {
    const observer = new DaemonObserver();
    const events: DaemonEvent[] = [];
    observer.subscribe(event => events.push(event));
    const offer = (taskId: string) => observer.handleInboundEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), session: { mode: 'resume', sessionRef: 'execution-record-session' },  instruction: 'run' }, { taskId, seq: 1 }));
    // Only the order is under test here, so every record has the same content.
    const record = (taskId: string): ExecutionRecord => ({ taskId, terminal: 'complete', status: 'complete', source: 'event-stream', gaps: [] });
    return { observer, events, offer, record };
  }

  it('follows its task terminal event, whether it is published before or after the server settles that terminal', () => {
    const { observer, events, offer, record } = observed();
    const settled = [
      createEnvelope('task.complete', { summary: 'done', sessionRef: 'session' }, { taskId: 'completed' }),
      createEnvelope('task.fail', { reason: 'runtime exited', retryable: true }, { taskId: 'failed' }),
      createEnvelope('task.cancelled', { reason: 'operator' }, { taskId: 'cancelled' }),
    ];
    for (const terminal of settled) {
      offer(terminal.task_id!);
      observer.noteExecutionRecord(record(terminal.task_id!));
      observer.handleOutboundEnvelope(terminal);
    }
    const refused = createEnvelope('task.complete', { summary: 'done', sessionRef: 'session' }, { taskId: 'refused' });
    offer('refused');
    observer.noteExecutionRecord(record('refused'));
    observer.noteOutboundRejected(refused, { envelopeId: refused.id, type: refused.type, taskId: 'refused', reason: 'not_permitted', terminal: true });
    offer('late');
    observer.handleOutboundEnvelope(createEnvelope('task.complete', { summary: 'done', sessionRef: 'session' }, { taskId: 'late' }));
    observer.noteExecutionRecord(record('late'));
    observer.noteExecutionRecord(record('untracked'));
    expect(events.map(event => `${event.kind}:${'taskId' in event ? event.taskId : ''}`)).toEqual([
      'offered:completed', 'completed:completed', 'execution-record:completed',
      'offered:failed', 'failed:failed', 'execution-record:failed',
      'offered:cancelled', 'cancelled:cancelled', 'execution-record:cancelled',
      'offered:refused', 'outbound-rejected:refused', 'execution-record:refused',
      'offered:late', 'completed:late', 'execution-record:late',
      'execution-record:untracked',
    ]);
  });

  it('lets a held record go when the task registry stops tracking its task', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { observer, events, offer, record } = observed();
      offer('oldest');
      observer.noteExecutionRecord(record('oldest'));
      expect(events.some(event => event.kind === 'execution-record')).toBe(false);
      for (let index = 0; index < MAX_TRACKED_TASKS; index++) offer(`running-${index}`);
      expect(events.filter(event => event.kind === 'execution-record').map(event => 'taskId' in event && event.taskId)).toEqual(['oldest']);
    } finally {
      warn.mockRestore();
    }
  });
});
