import { describe, expect, it } from 'vitest';
import type { DaemonEvent, DaemonTaskInfo } from '../index';
import {
  formatAgentEvent,
  formatApprovalsListLines,
  formatDaemonEventLine,
  formatLiveStatusLines,
  formatRuntimeLines,
  formatStatusLines,
  formatTaskLine,
  formatTaskListLines,
  type StatusView,
} from '../bin/format';
import type { ControlStatusResult, PendingApproval } from '../daemon/control-protocol';
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
      { kind: 'awaiting-approval', ts: 'T', taskId: 't1', summary: 'needs a human', approvalId: 'appr-1' },
      { kind: 'completed', ts: 'T', taskId: 't1', summary: 'done', sessionRef: 'sess-1' },
      { kind: 'failed', ts: 'T', taskId: 't1', reason: 'boom', retryable: false },
      { kind: 'failed', ts: 'T', taskId: 't1', reason: 'declined', retryable: false, preClaim: true },
      { kind: 'cancelled', ts: 'T', taskId: 't1', reason: 'user cancelled' },
      { kind: 'cancelled', ts: 'T', taskId: 't1' },
      { kind: 'connection', ts: 'T', state: 'open' },
      { kind: 'paired', ts: 'T', deviceId: 'dev-1' },
      { kind: 'unpaired', ts: 'T' },
      { kind: 'runtimes-detected', ts: 'T', runtimes: [{ id: 'pi' }, { id: 'claude' }] },
      { kind: 'shutdown-complete', ts: 'T', reason: 'operator' },
      { kind: 'shutdown-complete', ts: 'T', reason: 'operator', undeliveredOutboxCount: 0 },
      { kind: 'shutdown-complete', ts: 'T', reason: 'operator', undeliveredOutboxCount: 2 },
    ];

    expect(cases.map((event) => formatDaemonEventLine(event))).toEqual([
      '[T] offered taskId=t1 runtime=pi',
      '[T] claimed taskId=t1',
      '[T] started taskId=t1',
      '[T] progress taskId=t1 turn_end',
      '[T] artifact taskId=t1 name=out.txt contentType=text/plain',
      '[T] awaiting-approval taskId=t1 summary="needs a human"',
      '[T] awaiting-approval taskId=t1 approvalId=appr-1 summary="needs a human"',
      '[T] completed taskId=t1 sessionRef=sess-1 summary="done"',
      '[T] failed taskId=t1 retryable=false reason="boom"',
      '[T] failed taskId=t1 retryable=false preClaim=true reason="declined"',
      '[T] cancelled taskId=t1 reason="user cancelled"',
      '[T] cancelled taskId=t1',
      '[T] connection state=open',
      '[T] paired deviceId=dev-1',
      '[T] unpaired',
      '[T] runtimes-detected ids=pi,claude',
      '[T] shutdown-complete reason="operator"',
      '[T] shutdown-complete reason="operator" undeliveredOutboxCount=0',
      '[T] shutdown-complete reason="operator" undeliveredOutboxCount=2',
    ]);
  });

  describe('finding F8: redactApprovalSummary option', () => {
    it('redacts an awaiting-approval summary to a byte-count placeholder when set, leaving taskId/approvalId intact', () => {
      const event: DaemonEvent = { kind: 'awaiting-approval', ts: 'T', taskId: 't1', approvalId: 'appr-1', summary: 'Bash: rm -rf /tmp/secret' };
      const line = formatDaemonEventLine(event, { redactApprovalSummary: true });
      expect(line).toBe(`[T] awaiting-approval taskId=t1 approvalId=appr-1 summary="[redacted: ${Buffer.byteLength('Bash: rm -rf /tmp/secret', 'utf8')} bytes]"`);
      expect(line).not.toContain('rm -rf');
    });

    it('defaults to full fidelity (option omitted) — unchanged from before this finding', () => {
      const event: DaemonEvent = { kind: 'awaiting-approval', ts: 'T', taskId: 't1', summary: 'needs a human' };
      expect(formatDaemonEventLine(event)).toBe('[T] awaiting-approval taskId=t1 summary="needs a human"');
    });

    it('explicit redactApprovalSummary:false also keeps full fidelity', () => {
      const event: DaemonEvent = { kind: 'awaiting-approval', ts: 'T', taskId: 't1', summary: 'needs a human' };
      expect(formatDaemonEventLine(event, { redactApprovalSummary: false })).toBe('[T] awaiting-approval taskId=t1 summary="needs a human"');
    });

    it('the option only ever affects awaiting-approval — every other kind renders identically with or without it', () => {
      const events: DaemonEvent[] = [
        { kind: 'completed', ts: 'T', taskId: 't1', summary: 'done', sessionRef: 'sess-1' },
        { kind: 'failed', ts: 'T', taskId: 't1', reason: 'boom', retryable: false },
        { kind: 'cancelled', ts: 'T', taskId: 't1', reason: 'user cancelled' },
      ];
      for (const event of events) {
        expect(formatDaemonEventLine(event, { redactApprovalSummary: true })).toBe(formatDaemonEventLine(event));
      }
    });
  });

  it('never emits ANSI escape sequences (plain/headless-safe by construction)', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: 'T', taskId: 't1', runtime: 'pi' },
      { kind: 'progress', ts: 'T', taskId: 't1', event: { type: 'progress', text: 'hi' } },
      { kind: 'connection', ts: 'T', state: 'degraded' },
    ];
    for (const line of events.map((event) => formatDaemonEventLine(event))) {
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

describe('bin/format: formatLiveStatusLines', () => {
  function baseLive(overrides: Partial<ControlStatusResult> = {}): ControlStatusResult {
    return {
      pid: 123,
      uptimeMs: 4567,
      paired: true,
      transport: 'open',
      activeTasks: [],
      runtimeIds: ['pi'],
      queueWatermarks: [],
      approvals: [],
      approvalsPending: 0,
      ...overrides,
    };
  }

  it('renders pid/uptime/transport, paired+deviceId, and runtimes on their own lines', () => {
    const lines = formatLiveStatusLines(baseLive({ deviceId: 'dev-1', runtimeIds: ['pi', 'claude'] }));
    expect(lines).toContain('live: pid=123 uptimeMs=4567 transport=open');
    expect(lines).toContain('live-paired: yes deviceId=dev-1');
    expect(lines).toContain('live-runtimes: pi,claude');
  });

  it('shows a placeholder for no active tasks, and one line per active task otherwise', () => {
    expect(formatLiveStatusLines(baseLive())).toContain('live-active-tasks: (none)');
    const lines = formatLiveStatusLines(baseLive({ activeTasks: [{ taskId: 't1', state: 'Running' }] }));
    expect(lines).toContain('live-active-task: t1 Running');
    expect(lines).not.toContain('live-active-tasks: (none)');
  });

  it('renders approvalsPending as its own line', () => {
    expect(formatLiveStatusLines(baseLive({ approvalsPending: 0 }))).toContain('live-approvals-pending: 0');
    expect(formatLiveStatusLines(baseLive({ approvalsPending: 3 }))).toContain('live-approvals-pending: 3');
  });

  // Finding F4: `status`'s live section must surface actual approvalIds,
  // not just a count — otherwise an operator still has no way to learn one
  // short of the dedicated `approvals` command.
  it('shows a placeholder for no pending approvals, and one line per approval (with its approvalId) otherwise', () => {
    expect(formatLiveStatusLines(baseLive())).toContain('live-approvals: (none)');

    const lines = formatLiveStatusLines(
      baseLive({
        approvals: [{ approvalId: 'appr-1', taskId: 't1', summary: 'Bash: rm -rf /tmp/x', createdAt: '2026-01-01T00:00:00.000Z' }],
        approvalsPending: 1,
      }),
    );
    expect(lines).toContain('live-approval: appr-1 taskId=t1 summary="Bash: rm -rf /tmp/x"');
    expect(lines).not.toContain('live-approvals: (none)');
  });

  it('truncates a long approval summary in the live section (display-width concern, not redaction — F8 keeps stdout redaction separate)', () => {
    const longSummary = 'x'.repeat(100);
    const lines = formatLiveStatusLines(
      baseLive({
        approvals: [{ approvalId: 'appr-2', taskId: 't2', summary: longSummary, createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    expect(lines.some((l) => l.startsWith('live-approval: appr-2') && l.includes('…') && !l.includes(longSummary))).toBe(true);
  });

  it('renders "(no summary)" for a pending approval with no summary at all', () => {
    const lines = formatLiveStatusLines(
      baseLive({ approvals: [{ approvalId: 'appr-3', taskId: 't3', createdAt: '2026-01-01T00:00:00.000Z' }] }),
    );
    expect(lines).toContain('live-approval: appr-3 taskId=t3 summary="(no summary)"');
  });

  it('shows a placeholder for no queue watermarks, and one line per task otherwise (M4 Phase 4, part B.3)', () => {
    expect(formatLiveStatusLines(baseLive())).toContain('live-queue-watermarks: (none)');

    const lines = formatLiveStatusLines(
      baseLive({
        queueWatermarks: [
          { taskId: 't1', progressBatcherPending: 4, pendingApprovals: 2 },
          { taskId: 't2', progressBatcherPending: 0, pendingApprovals: 0 },
        ],
      }),
    );
    expect(lines).toContain('live-queue-watermark: t1 progressBatcherPending=4 pendingApprovals=2');
    expect(lines).toContain('live-queue-watermark: t2 progressBatcherPending=0 pendingApprovals=0');
    expect(lines).not.toContain('live-queue-watermarks: (none)');
  });

  it('never emits ANSI escape sequences', () => {
    const lines = formatLiveStatusLines(
      baseLive({
        deviceId: 'dev-1',
        activeTasks: [{ taskId: 't1', state: 'Running' }],
        queueWatermarks: [{ taskId: 't1', progressBatcherPending: 1, pendingApprovals: 1 }],
        approvals: [{ approvalId: 'appr-1', taskId: 't1', summary: 'Bash: echo hi', createdAt: '2026-01-01T00:00:00.000Z' }],
        approvalsPending: 1,
      }),
    );
    for (const line of lines) expect(line).not.toMatch(ANSI_ESCAPE_RE);
  });
});

describe('bin/format: formatApprovalsListLines (finding F4)', () => {
  function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
    return { approvalId: 'appr-1', taskId: 't1', summary: 'Bash: rm -rf /tmp/x', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
  }

  it('shows a placeholder for an empty list', () => {
    expect(formatApprovalsListLines([], Date.now())).toEqual(['(no pending approvals)']);
  });

  it('renders approvalId, taskId, age, and a quoted summary excerpt — one line per pending approval', () => {
    const nowMs = Date.parse('2026-01-01T00:01:30.000Z'); // 90s after createdAt
    const lines = formatApprovalsListLines([approval()], nowMs);
    expect(lines).toEqual(['appr-1 taskId=t1 age=1m summary="Bash: rm -rf /tmp/x"']);
  });

  it('renders one line per entry, preserving order', () => {
    const nowMs = Date.parse('2026-01-01T00:00:10.000Z');
    const lines = formatApprovalsListLines(
      [approval({ approvalId: 'appr-1', taskId: 't1' }), approval({ approvalId: 'appr-2', taskId: 't2' })],
      nowMs,
    );
    expect(lines).toEqual([
      'appr-1 taskId=t1 age=10s summary="Bash: rm -rf /tmp/x"',
      'appr-2 taskId=t2 age=10s summary="Bash: rm -rf /tmp/x"',
    ]);
  });

  it('renders ages in seconds/minutes/hours/days at their natural thresholds', () => {
    const created = '2026-01-01T00:00:00.000Z';
    expect(formatApprovalsListLines([approval({ createdAt: created })], Date.parse(created) + 45_000)[0]).toContain('age=45s');
    expect(formatApprovalsListLines([approval({ createdAt: created })], Date.parse(created) + 5 * 60_000)[0]).toContain('age=5m');
    expect(formatApprovalsListLines([approval({ createdAt: created })], Date.parse(created) + 3 * 3_600_000)[0]).toContain('age=3h');
    expect(formatApprovalsListLines([approval({ createdAt: created })], Date.parse(created) + 2 * 86_400_000)[0]).toContain('age=2d');
  });

  it('renders "(no summary)" when summary is absent', () => {
    const lines = formatApprovalsListLines([approval({ summary: undefined })], Date.now());
    expect(lines[0]).toContain('summary="(no summary)"');
  });

  it('truncates a long summary with an ellipsis rather than wrapping the table', () => {
    const longSummary = 'y'.repeat(200);
    const lines = formatApprovalsListLines([approval({ summary: longSummary })], Date.now());
    expect(lines[0]).toContain('…');
    expect(lines[0]).not.toContain(longSummary);
  });

  it('never emits ANSI escape sequences', () => {
    const lines = formatApprovalsListLines([approval()], Date.now());
    for (const line of lines) expect(line).not.toMatch(ANSI_ESCAPE_RE);
  });
});
