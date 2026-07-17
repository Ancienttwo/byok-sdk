import { describe, expect, it } from 'vitest';
import type { DaemonEvent, DaemonTaskInfo } from '../index';
import {
  formatAgentEvent,
  formatDaemonEventLine,
  formatRuntimeLines,
  formatStatusLines,
  formatTaskLine,
  formatTaskListLines,
  type StatusView,
} from '../bin/format';
import type { ProbedRuntime } from '../bin/runtime-probe';

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[/;

describe('bin/format: formatAgentEvent', () => {
  it('renders every known AgentEvent type as plain, single-line text', () => {
    expect(formatAgentEvent({ type: 'progress', text: 'doing the thing' })).toBe('progress: "doing the thing"');
    expect(formatAgentEvent({ type: 'tool_use', tool: 'bash' })).toBe('tool_use: bash');
    expect(formatAgentEvent({ type: 'tool_result', tool: 'bash' })).toBe('tool_result: bash');
    expect(formatAgentEvent({ type: 'artifact', name: 'out.txt', contentType: 'text/plain' })).toBe(
      'artifact: out.txt (text/plain)',
    );
    expect(formatAgentEvent({ type: 'needs_approval', summary: 'needs a human' })).toBe('needs_approval: "needs a human"');
    expect(formatAgentEvent({ type: 'turn_end' })).toBe('turn_end');
    expect(formatAgentEvent({ type: 'error', message: 'boom' })).toBe('error: "boom"');
    expect(formatAgentEvent({ type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15 })).toBe(
      'usage: in=10 out=5 total=15',
    );
    expect(formatAgentEvent({ type: 'usage' })).toBe('usage: (no fields reported)');
  });

  it('escapes embedded quotes/newlines so a progress line never breaks onto a second physical line', () => {
    const line = formatAgentEvent({ type: 'progress', text: 'line one\nline "two"' });
    expect(line.includes('\n')).toBe(false);
    expect(line).toBe('progress: "line one\\nline \\"two\\""');
  });
});

describe('bin/format: formatDaemonEventLine', () => {
  it('renders each DaemonEvent kind on one plain line prefixed with its timestamp', () => {
    const cases: DaemonEvent[] = [
      { kind: 'offered', ts: 'T', taskId: 't1', runtime: 'pi' },
      { kind: 'claimed', ts: 'T', taskId: 't1' },
      { kind: 'started', ts: 'T', taskId: 't1' },
      { kind: 'progress', ts: 'T', taskId: 't1', event: { type: 'turn_end' } },
      { kind: 'artifact', ts: 'T', taskId: 't1', name: 'out.txt', contentType: 'text/plain' },
      { kind: 'awaiting-approval', ts: 'T', taskId: 't1', summary: 'needs a human' },
      { kind: 'completed', ts: 'T', taskId: 't1', summary: 'done', sessionRef: 'sess-1' },
      { kind: 'failed', ts: 'T', taskId: 't1', reason: 'boom', retryable: false },
      { kind: 'failed', ts: 'T', taskId: 't1', reason: 'declined', retryable: false, preClaim: true },
      { kind: 'cancelled', ts: 'T', taskId: 't1', reason: 'user cancelled' },
      { kind: 'cancelled', ts: 'T', taskId: 't1' },
      { kind: 'connection', ts: 'T', state: 'open' },
      { kind: 'paired', ts: 'T', deviceId: 'dev-1' },
      { kind: 'unpaired', ts: 'T' },
      { kind: 'runtimes-detected', ts: 'T', runtimes: [{ id: 'pi' }, { id: 'claude' }] },
    ];

    expect(cases.map(formatDaemonEventLine)).toEqual([
      '[T] offered taskId=t1 runtime=pi',
      '[T] claimed taskId=t1',
      '[T] started taskId=t1',
      '[T] progress taskId=t1 turn_end',
      '[T] artifact taskId=t1 name=out.txt contentType=text/plain',
      '[T] awaiting-approval taskId=t1 summary="needs a human"',
      '[T] completed taskId=t1 sessionRef=sess-1 summary="done"',
      '[T] failed taskId=t1 retryable=false reason="boom"',
      '[T] failed taskId=t1 retryable=false preClaim=true reason="declined"',
      '[T] cancelled taskId=t1 reason="user cancelled"',
      '[T] cancelled taskId=t1',
      '[T] connection state=open',
      '[T] paired deviceId=dev-1',
      '[T] unpaired',
      '[T] runtimes-detected ids=pi,claude',
    ]);
  });

  it('never emits ANSI escape sequences (plain/headless-safe by construction)', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: 'T', taskId: 't1', runtime: 'pi' },
      { kind: 'progress', ts: 'T', taskId: 't1', event: { type: 'progress', text: 'hi' } },
      { kind: 'connection', ts: 'T', state: 'degraded' },
    ];
    for (const line of events.map(formatDaemonEventLine)) {
      expect(line).not.toMatch(ANSI_ESCAPE_RE);
    }
  });
});

describe('bin/format: formatTaskLine / formatTaskListLines', () => {
  it('renders a full task with every optional field present', () => {
    const task: DaemonTaskInfo = {
      taskId: 't1',
      state: 'Complete',
      runtime: 'pi',
      summary: 'all done',
      sessionRef: 'sess-1',
      declined: true,
      updatedAt: 'T',
    };
    expect(formatTaskLine(task)).toBe('t1 Complete runtime=pi updatedAt=T sessionRef=sess-1 declined=true summary="all done"');
  });

  it('renders a minimal task with no optional fields', () => {
    const task: DaemonTaskInfo = { taskId: 't2', state: 'Offered', updatedAt: 'T' };
    expect(formatTaskLine(task)).toBe('t2 Offered updatedAt=T');
  });

  it('formatTaskListLines shows a placeholder line for an empty list', () => {
    expect(formatTaskListLines([])).toEqual(['(no tasks observed yet)']);
  });

  it('formatTaskListLines renders one line per task', () => {
    const tasks: DaemonTaskInfo[] = [
      { taskId: 't1', state: 'Running', updatedAt: 'T' },
      { taskId: 't2', state: 'Complete', updatedAt: 'T' },
    ];
    expect(formatTaskListLines(tasks)).toEqual(['t1 Running updatedAt=T', 't2 Complete updatedAt=T']);
  });
});

describe('bin/format: formatRuntimeLines', () => {
  it('shows a placeholder for an empty runtime list', () => {
    expect(formatRuntimeLines([])).toEqual(['(no runtimes configured — check runtimeAllowlist)']);
  });

  it('renders an absent runtime minimally', () => {
    const runtimes: ProbedRuntime[] = [{ id: 'claude', present: false, steer: true, resume: true, permissionModes: ['auto'] }];
    expect(formatRuntimeLines(runtimes)).toEqual(['claude: absent']);
  });

  it('renders a present runtime with full detail', () => {
    const runtimes: ProbedRuntime[] = [
      { id: 'pi', present: true, version: '1.2.3', authPresent: true, steer: true, resume: true, permissionModes: ['auto', 'readonly'] },
    ];
    expect(formatRuntimeLines(runtimes)).toEqual([
      'pi: present version=1.2.3 authPresent=true capabilities=steer,resume modes=auto,readonly',
    ]);
  });

  it('renders (none) for capabilities/modes when both are empty', () => {
    const runtimes: ProbedRuntime[] = [{ id: 'codex', present: true, steer: false, resume: false, permissionModes: [] }];
    expect(formatRuntimeLines(runtimes)).toEqual(['codex: present capabilities=(none) modes=(none)']);
  });
});

describe('bin/format: formatStatusLines', () => {
  function baseView(overrides: Partial<StatusView> = {}): StatusView {
    return {
      productName: 'Acme',
      productId: 'acme-product',
      paired: false,
      runtimes: [],
      taskCounts: { total: 0, Offered: 0, Claimed: 0, Running: 0, AwaitApproval: 0, Complete: 0, Failed: 0, Cancelled: 0 },
      auditLogPath: '/store/audit.jsonl',
      auditLogLineCount: 0,
      ...overrides,
    };
  }

  it('prefers branding.displayName over productName, and includes supportUrl when set', () => {
    const lines = formatStatusLines(
      baseView({ branding: { displayName: 'Acme Coder', supportUrl: 'https://acme.example/support' } }),
    );
    expect(lines[0]).toBe('product: Acme Coder (acme-product)');
    expect(lines).toContain('support: https://acme.example/support');
  });

  it('falls back to productName with no branding, and omits the support line', () => {
    const lines = formatStatusLines(baseView());
    expect(lines[0]).toBe('product: Acme (acme-product)');
    expect(lines.some((l) => l.startsWith('support:'))).toBe(false);
  });

  it('shows paired + deviceId', () => {
    const lines = formatStatusLines(baseView({ paired: true, deviceId: 'dev-1' }));
    expect(lines).toContain('paired: yes deviceId=dev-1');
  });

  it('shows an honest "unknown" connection line when no connection event has been observed', () => {
    const lines = formatStatusLines(baseView());
    expect(lines.some((l) => l.startsWith('connection: unknown'))).toBe(true);
  });

  it('shows the last-known connection state + timestamp when available', () => {
    const lines = formatStatusLines(baseView({ connection: { state: 'open', ts: '2026-01-01T00:00:00.000Z' } }));
    expect(lines).toContain('connection: last-known=open at=2026-01-01T00:00:00.000Z');
  });

  it('summarizes runtimes as id=present/absent pairs', () => {
    const lines = formatStatusLines(
      baseView({
        runtimes: [
          { id: 'pi', present: true, steer: true, resume: true, permissionModes: [] },
          { id: 'claude', present: false, steer: true, resume: true, permissionModes: [] },
        ],
      }),
    );
    expect(lines).toContain('runtimes: pi=present claude=absent');
  });

  it('renders full task counts', () => {
    const lines = formatStatusLines(
      baseView({
        taskCounts: { total: 3, Offered: 0, Claimed: 1, Running: 1, AwaitApproval: 0, Complete: 1, Failed: 0, Cancelled: 0 },
      }),
    );
    expect(lines).toContain(
      'tasks: total=3 offered=0 claimed=1 running=1 awaitApproval=0 complete=1 failed=0 cancelled=0',
    );
  });

  it('renders the audit log path + event count, singular vs plural', () => {
    expect(formatStatusLines(baseView({ auditLogLineCount: 1 }))).toContain('audit-log: /store/audit.jsonl (1 event)');
    expect(formatStatusLines(baseView({ auditLogLineCount: 2 }))).toContain('audit-log: /store/audit.jsonl (2 events)');
  });

  it('never emits ANSI escape sequences', () => {
    const lines = formatStatusLines(
      baseView({
        branding: { displayName: 'Acme Coder', supportUrl: 'https://acme.example/support' },
        paired: true,
        deviceId: 'dev-1',
        connection: { state: 'open', ts: 'T' },
        runtimes: [{ id: 'pi', present: true, version: '1.0', authPresent: true, steer: true, resume: true, permissionModes: ['auto'] }],
      }),
    );
    for (const line of lines) expect(line).not.toMatch(ANSI_ESCAPE_RE);
  });
});
