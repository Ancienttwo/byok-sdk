import type { AgentEvent } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { createDaemonRecordProjector, DAEMON_RECORD_KINDS, isDaemonRecordKind, type DaemonEvent, type DaemonRecord } from '../index';
import { MAX_TRACKED_TASKS } from '../daemon/observer';
import { parseRuntimeObservations, validateRuntimeDetectResult } from '../runtime-detection';

const SENTINEL = 'SENTINEL-395';

function progress(taskId: string, event: AgentEvent, ts = 'T'): DaemonEvent {
  return { kind: 'progress', ts, taskId, event };
}

/** One event of every `DaemonEvent` kind, every free-form field holding the sentinel. */
const EVERY_KIND: DaemonEvent[] = [
  { kind: 'offered', ts: 'T', taskId: 't1', runtime: 'pi' },
  { kind: 'claimed', ts: 'T', taskId: 't1', claimedRuntime: 'pi' },
  { kind: 'started', ts: 'T', taskId: 't1' },
  progress('t1', { type: 'progress', text: SENTINEL }),
  progress('t1', { type: 'tool_use', tool: 'bash', input: { command: SENTINEL } }),
  progress('t1', { type: 'tool_result', tool: 'bash', output: SENTINEL }),
  progress('t1', { type: 'artifact', name: SENTINEL, contentType: 'text/plain' }),
  progress('t1', { type: 'error', message: SENTINEL }),
  progress('t1', { type: 'turn_end' }),
  { kind: 'artifact', ts: 'T', taskId: 't1', name: SENTINEL, contentType: 'text/plain', inline: Buffer.from(SENTINEL).toString('base64') },
  {
    kind: 'artifact',
    ts: 'T',
    taskId: 't1',
    name: SENTINEL,
    contentType: 'text/plain',
    blobRef: { blobId: 'b1', contentHash: 'sha256:abc', size: 9, contentType: 'text/plain', url: `https://x/${SENTINEL}` },
  },
  { kind: 'awaiting-approval', ts: 'T', taskId: 't1', approvalId: 'ap-1', summary: SENTINEL },
  { kind: 'tool-authorization', ts: 'T', taskId: 't1', toolName: SENTINEL, toolCallId: 'c1',
    decision: 'allow', authorization: { source: 'rule', ruleIds: ['approved-push'] }, reasons: [] },
  { kind: 'tool-reminder', ts: 'T', taskId: 't1', toolName: SENTINEL, toolCallId: 'c2',
    summary: SENTINEL, authorization: { source: 'floor', ruleIds: [] }, reasons: ['sensitive-path'] },
  { kind: 'stale-approval-decision', ts: 'T', taskId: 't1', decision: 'reject', reason: SENTINEL },
  { kind: 'runtime-disposal-failed', ts: 'T', taskId: 't1', runtimeId: 'pi', stage: 'cleanup', reason: SENTINEL },
  { kind: 'file-scope', ts: 'T', taskId: 't1', decision: 'deny', lane: 'rpc', homeAccess: 'writer',
    scope: { source: 'host', mode: 'workspaces', digest: 'sha256:scope' }, rootId: 'repo', access: 'write',
    code: 'file_scope_denied', reason: 'outside_scope' },
  { kind: 'completed', ts: 'T', taskId: 't1', summary: SENTINEL, sessionRef: 'sess-1' },
  { kind: 'failed', ts: 'T', taskId: 't2', reason: SENTINEL, retryable: false, preClaim: true },
  { kind: 'cancelled', ts: 'T', taskId: 't3', reason: SENTINEL },
  { kind: 'lifecycle', ts: 'T', lifecycle: { phase: 'running', connection: 'open' } },
  { kind: 'paired', ts: 'T', deviceId: 'dev-1' },
  { kind: 'unpaired', ts: 'T' },
  { kind: 'runtimes-detected', ts: 'T', runtimes: [{ id: 'pi', present: true, outcome: 'available', version: SENTINEL, steer: true, resume: true }] },
  { kind: 'shutdown-requested', ts: 'T', reason: SENTINEL },
  { kind: 'shutdown-complete', ts: 'T', reason: SENTINEL, undeliveredOutboxCount: 0 },
  { kind: 'agent-memory-intent-integrity', ts: 'T', intentId: 'i1', disposition: 'conflict' },
  { kind: 'device-assertion', ts: 'T', result: 'issued', lane: 'device', audience: 'aud', jti: 'j1', expiresAt: 'E' },
  { kind: 'device-assertion', ts: 'T', result: 'denied', lane: 'task', taskId: 't1', reason: 'audience_denied', audienceSize: 9 },
];

describe('daemon-record: createDaemonRecordProjector', () => {
  it('F6 persists suppressed risk codes for both decisions and reminders without raw content', () => {
    const projector = createDaemonRecordProjector();
    const suppressedReasons = ['destructive-git'] as const;
    const [decision] = projector.project({ kind: 'tool-authorization', ts: 'T', taskId: 't',
      toolName: SENTINEL, toolCallId: 'push', decision: 'allow', reasons: [], suppressedReasons,
      authorization: { source: 'rule', ruleIds: ['push-origin'] } });
    expect(decision).toMatchObject({ kind: 'tool-authorization', taskId: 't', toolCallId: 'push', decision: 'allow',
      authorization: { source: 'rule', ruleIds: ['push-origin'] }, reasons: [], suppressedReasons: ['destructive-git'] });
    expect(JSON.stringify(decision)).not.toContain(SENTINEL);
    const [reminder] = projector.project({ kind: 'tool-reminder', ts: 'T', taskId: 't', toolName: SENTINEL,
      summary: SENTINEL, authorization: { source: 'rule', ruleIds: ['ask-push'] }, reasons: ['custom-rule'], suppressedReasons });
    expect(reminder).toMatchObject({ kind: 'tool-reminder', taskId: 't', reasons: ['custom-rule'],
      authorization: { source: 'rule', ruleIds: ['ask-push'] }, suppressedReasons: ['destructive-git'] });
    expect(JSON.stringify(reminder)).not.toContain(SENTINEL);
  });

  it('retains authorization identifiers and provenance without persisting tool text', () => {
    const projector = createDaemonRecordProjector();
    const [decision] = projector.project({ kind: 'tool-authorization', ts: 'T', taskId: 't',
      toolName: SENTINEL, toolCallId: 'call-1', decision: 'deny', code: 'tool_authorization_denied',
      authorization: { source: 'rule', ruleIds: ['ask-before-write'] }, reasons: ['custom-rule'] });
    expect(decision).toMatchObject({ kind: 'tool-authorization', taskId: 't', decision: 'deny',
      authorization: { source: 'rule', ruleIds: ['ask-before-write'] }, reasons: ['custom-rule'] });
    expect(JSON.stringify(decision)).not.toContain(SENTINEL);
    const [reminder] = projector.project({ kind: 'tool-reminder', ts: 'T', taskId: 't',
      toolName: SENTINEL, summary: SENTINEL, authorization: { source: 'floor', ruleIds: [] }, reasons: ['sensitive-path'] });
    expect(reminder).toMatchObject({ kind: 'tool-reminder', taskId: 't',
      authorization: { source: 'floor', ruleIds: [] }, reasons: ['sensitive-path'], summaryBytes: Buffer.byteLength(SENTINEL) });
    expect(JSON.stringify(reminder)).not.toContain(SENTINEL);
  });
  it('keeps the configured unqualified-version advisory without persisting actual runtime version text', () => {
    const [record] = createDaemonRecordProjector().project({
      kind: 'runtimes-detected', ts: 'T',
      runtimes: [{
        id: 'codex', present: true, outcome: 'available', version: SENTINEL, qualifiedVersion: '0.101.0',
        versionVerdict: { state: 'block', qualifiedVersion: '0.101.0', matched: '0.10.' }, steer: true, resume: true,
      }],
    });
    if (record?.kind !== 'runtimes-detected') throw new Error('expected a runtime record');
    expect(record.runtimes).toEqual([{ id: 'codex', present: true, outcome: 'available', qualifiedVersion: '0.101.0', steer: true, resume: true }]);
    expect(JSON.stringify(record)).not.toContain('versionVerdict');
    expect(parseRuntimeObservations(record.runtimes)).toEqual(record.runtimes);
    expect(validateRuntimeDetectResult({ kind: 'available', advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '0.101.0' } }))
      .toEqual({ kind: 'available', advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '0.101.0' } });
  });
  it('a turn of 30 deltas and 3 tool calls is ONE turn record with correct counts', () => {
    const projector = createDaemonRecordProjector();
    const records: DaemonRecord[] = [];
    const deltas = Array.from({ length: 30 }, (_, i) => `delta-${i} `);
    for (const text of deltas) records.push(...projector.project(progress('t1', { type: 'progress', text })));
    for (let i = 0; i < 3; i++) {
      records.push(...projector.project(progress('t1', { type: 'tool_use', tool: 'bash', input: { i } })));
      records.push(...projector.project(progress('t1', { type: 'tool_result', tool: 'bash', output: i })));
    }
    records.push(...projector.project(progress('t1', { type: 'usage', inputTokens: 11, outputTokens: 22, totalTokens: 33 })));
    expect(records).toEqual([]);
    expect(projector.project(progress('t1', { type: 'turn_end' }, 'T-end'))).toEqual([
      {
        kind: 'turn',
        ts: 'T-end',
        taskId: 't1',
        turn: 1,
        closedBy: 'turn_end',
        progressEvents: 38,
        textBytes: deltas.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
        toolUses: 3,
        toolResults: 3,
        artifacts: 0,
        errors: 0,
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
      },
    ]);
    // The next turn of the same task is numbered on.
    projector.project(progress('t1', { type: 'progress', text: 'x' }));
    expect(projector.project(progress('t1', { type: 'turn_end' }))).toMatchObject([{ kind: 'turn', turn: 2, progressEvents: 2, textBytes: 1 }]);
  });

  it('closes an open turn before the task terminal, at stop, and on eviction', () => {
    const projector = createDaemonRecordProjector();
    projector.project(progress('a', { type: 'progress', text: 'abc' }));
    expect(projector.project({ kind: 'failed', ts: 'T2', taskId: 'a', reason: 'boom', retryable: true })).toEqual([
      expect.objectContaining({ kind: 'turn', ts: 'T2', taskId: 'a', turn: 1, closedBy: 'terminal', textBytes: 3 }),
      { kind: 'failed', ts: 'T2', taskId: 'a', retryable: true, reasonBytes: 4 },
    ]);
    // A terminal with no open turn is just the terminal record.
    expect(projector.project({ kind: 'completed', ts: 'T', taskId: 'z', summary: '', sessionRef: 's' })).toEqual([
      { kind: 'completed', ts: 'T', taskId: 'z', sessionRef: 's', summaryBytes: 0 },
    ]);

    projector.project(progress('b', { type: 'progress', text: 'x' }));
    expect(projector.flush('T3')).toEqual([expect.objectContaining({ kind: 'turn', ts: 'T3', taskId: 'b', closedBy: 'stop' })]);
    expect(projector.flush('T4')).toEqual([]);

    const bounded = createDaemonRecordProjector();
    bounded.project(progress('oldest', { type: 'progress', text: 'x' }));
    for (let i = 1; i < MAX_TRACKED_TASKS; i++) bounded.project(progress(`t${i}`, { type: 'turn_end' }));
    expect(bounded.project(progress('newest', { type: 'progress', text: 'y' }, 'T5'))).toEqual([
      expect.objectContaining({ kind: 'turn', ts: 'T5', taskId: 'oldest', closedBy: 'evicted' }),
    ]);
  });

  it('projects every DaemonEvent kind without content: the sentinel never survives', () => {
    const projector = createDaemonRecordProjector();
    const records = [...EVERY_KIND.flatMap((event) => projector.project(event)), ...projector.flush('T')];
    const projected = new Set(records.map((record) => record.kind));
    for (const event of EVERY_KIND) expect(projected.has(event.kind === 'progress' ? 'turn' : event.kind)).toBe(true);
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
    expect(records).toContainEqual({
      kind: 'artifact',
      ts: 'T',
      taskId: 't1',
      nameBytes: Buffer.byteLength(SENTINEL),
      contentType: 'text/plain',
      inlineBytes: Buffer.byteLength(Buffer.from(SENTINEL).toString('base64')),
    });
    expect(records).toContainEqual({ kind: 'runtimes-detected', ts: 'T', runtimes: [{ id: 'pi', present: true, outcome: 'available', steer: true, resume: true }] });
    expect(records).toContainEqual({ kind: 'device-assertion', ts: 'T', result: 'denied', lane: 'task', taskId: 't1', reason: 'audience_denied', audienceBytes: 9 });
  });
});

describe('daemon-record: DAEMON_RECORD_KINDS', () => {
  it('lists every kind once, and every projected record kind is listed', () => {
    expect(new Set(DAEMON_RECORD_KINDS).size).toBe(DAEMON_RECORD_KINDS.length);
    const projector = createDaemonRecordProjector();
    for (const record of [...EVERY_KIND.flatMap((event) => projector.project(event)), ...projector.flush('T')]) {
      expect(DAEMON_RECORD_KINDS).toContain(record.kind);
    }
    for (const kind of ['environment-resolved', 'daemon-started', 'daemon-stopped'] as const) expect(DAEMON_RECORD_KINDS).toContain(kind);
  });

  it('isDaemonRecordKind accepts exactly the listed kinds', () => {
    for (const kind of DAEMON_RECORD_KINDS) expect(isDaemonRecordKind(kind)).toBe(true);
    for (const value of ['progress', 'toString', '', 1, undefined]) expect(isDaemonRecordKind(value)).toBe(false);
  });
});
