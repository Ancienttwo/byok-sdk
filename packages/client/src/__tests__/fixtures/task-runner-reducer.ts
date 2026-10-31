// Shared fixtures for the #1099 S1 reducer/table tests.
import {
  createOfferFacts,
  createRunnerState,
  createTaskState,
  type AdmissionStateV1,
  type ApprovalStateV1,
  type CancelStateV1,
  type ClaimStateV1,
  type CompletionStateV1,
  type ExecutionFactsV1,
  type MessageStateV1,
  type OfferFactsV1,
  type ReducerEvent,
  type ReducerEventType,
  type ReducerSnapshot,
  type RunnerStateV1,
  type StartupStateV1,
  type TaskPhase,
  type TaskStateV1,
  type TeardownStateV1,
  type TerminalStateV1,
} from '../../daemon/task-runner/state';

export interface TaskInput {
  readonly taskId?: string;
  readonly phase?: TaskPhase;
  readonly generation?: number;
  readonly revision?: number;
  readonly offer?: Partial<OfferFactsV1>;
  readonly admission?: Partial<AdmissionStateV1>;
  readonly startup?: Partial<StartupStateV1>;
  readonly claim?: Partial<ClaimStateV1>;
  readonly execution?: ExecutionFactsV1;
  readonly approval?: Partial<ApprovalStateV1>;
  readonly message?: Partial<MessageStateV1>;
  readonly completion?: CompletionStateV1;
  readonly terminal?: Partial<TerminalStateV1>;
  readonly cancel?: Partial<CancelStateV1>;
  readonly teardown?: Partial<TeardownStateV1>;
}

export function terminalState(overrides: Partial<TerminalStateV1> = {}): TerminalStateV1 {
  return {
    token: 't1:2',
    kind: 'failed',
    cause: 'failed',
    stage: 'selected',
    evidence: 'none',
    envelope: 'none',
    ...overrides,
  };
}

export function makeTask(input: TaskInput = {}): TaskStateV1 {
  const taskId = input.taskId ?? 't1';
  const base = createTaskState({
    taskId,
    generation: input.generation ?? 1,
    revision: input.revision ?? 1,
    phase: input.phase ?? 'running',
    offer: { ...createOfferFacts(), ...input.offer },
  });
  const terminal = input.terminal === undefined
    ? base.terminal
    : { ...terminalState(), ...input.terminal };
  return {
    ...base,
    ...(terminal === undefined ? {} : { terminal }),
    admission: { ...base.admission, ...input.admission },
    startup: { ...base.startup, ...input.startup },
    claim: { ...base.claim, ...input.claim },
    ...(input.execution === undefined ? {} : { execution: input.execution }),
    approval: { ...base.approval, ...input.approval },
    message: { ...base.message, ...input.message },
    ...(input.completion === undefined ? {} : { completion: input.completion }),
    cancel: { ...base.cancel, ...input.cancel },
    teardown: { ...base.teardown, ...input.teardown },
  };
}

export function makeEvent(
  type: ReducerEventType,
  overrides: Omit<Partial<ReducerEvent>, 'type'> = {},
): ReducerEvent {
  return { type, taskId: 't1', atMs: 100, ...overrides };
}

export interface SnapshotInput {
  readonly task?: TaskInput;
  readonly runner?: Partial<RunnerStateV1>;
}

export function makeSnapshot(input: SnapshotInput = {}): ReducerSnapshot {
  const runner = { ...createRunnerState(), ...input.runner };
  return {
    runner,
    ...(input.task === undefined ? {} : { task: makeTask(input.task) }),
  };
}

export interface RowFixture {
  readonly event: ReducerEvent;
  readonly snapshot: ReducerSnapshot;
}

export function fixture(
  event: ReducerEvent,
  input: SnapshotInput = {},
): RowFixture {
  return { event, snapshot: makeSnapshot(input) };
}

const execution: ExecutionFactsV1 = {
  sessionRef: 'session-1',
  runtimeId: 'pi',
  home: '/home/.agent',
  cwd: '/work',
  leaseId: 'lease-1',
  startedAtMs: 90,
};

const pending = {
  approvalId: 'a1',
  requestId: 'r1',
  kind: 'task-terminal' as const,
};

const queued = { requestId: 'r1', kind: 'task-terminal' as const };

export const ROW_FIXTURES: ReadonlyMap<string, RowFixture> = new Map<string, RowFixture>([
  ['O0', fixture(makeEvent('offer.sealed_opening'), {})],
  ['O1', fixture(makeEvent('offer.received', { offer: createOfferFacts() }), {})],
  ['O2', fixture(makeEvent('offer.sealed_declined', { code: 'sealed_unsupported' }), {
    runner: { sealedOpening: ['t1'] },
  })],
  ['O3', fixture(makeEvent('admission.begin'), {
    task: { phase: 'received' },
    runner: { pendingCancelled: [{ taskId: 't1', reason: 'stop', atMs: 1 }] },
  })],
  ['O4', fixture(makeEvent('admission.stage', { stage: 'home' }), {
    task: { phase: 'admitting' },
  })],
  ['O5', fixture(makeEvent('admission.declined', {
    stage: 'home', reason: 'agent home busy', retryable: true,
  }), { task: { phase: 'admitting' } })],
  ['C1', fixture(makeEvent('admission.claimable'), { task: { phase: 'admitting' } })],
  ['C2', fixture(makeEvent('claim.journaled'), { task: { phase: 'claiming' } })],
  ['C9', fixture(makeEvent('claim.journal_failed', {
    reason: 'claim journal unavailable: disk full',
    retryable: true,
  }), { task: { phase: 'claiming' } })],
  ['C3', fixture(makeEvent('claim.sent'), {
    task: { phase: 'claiming', claim: { journaled: true, sent: false } },
  })],
  ['C0', fixture(makeEvent('startup.registered'), { task: { phase: 'claimed' } })],
  ['C0b', fixture(makeEvent('startup.transferred'), {
    task: { phase: 'claimed', startup: { owner: 'startup', registered: true } },
  })],
  ['C4', fixture(makeEvent('runtime.session_bound', { execution }), {
    task: { phase: 'claimed' },
  })],
  ['C5', fixture(makeEvent('runtime.started', { execution }), {
    task: { phase: 'claimed' },
  })],
  ['C6', fixture(makeEvent('runtime.started'), {
    task: { phase: 'claimed', cancel: { requested: true, reason: 'wire cancel' } },
  })],
  ['C7', fixture(makeEvent('runtime.start_failed', { reason: 'spawn failed', retryable: true }), {
    task: { phase: 'claimed' },
  })],
  ['C8', fixture(makeEvent('runtime.activation_failed', { reason: 'bind failed' }), {
    task: { phase: 'claimed' },
  })],
  ['A1', fixture(makeEvent('approval.requested', {
    approvalId: 'a1', requestId: 'r1', kind: 'task-terminal',
  }), { task: { phase: 'running', teardown: { batcher: 'running' } } })],
  ['A2', fixture(makeEvent('approval.requested', {
    approvalId: 'a2', requestId: 'r2', kind: 'tool-authorization',
  }), {
    task: {
      phase: 'running',
      teardown: { batcher: 'running' },
      approval: { pending, queue: [] },
    },
  })],
  ['A3', fixture(makeEvent('approval.requested', {
    approvalId: 'a3', requestId: 'r3', kind: 'task-terminal',
  }), {})],
  ['A4', fixture(makeEvent('approval.dispatch_next'), {
    task: { phase: 'running', teardown: { batcher: 'running' }, approval: { queue: [queued] } },
  })],
  ['A5', fixture(makeEvent('approval.decided', {
    approvalId: 'a1', decision: 'approve', origin: 'wire',
  }), {
    task: { phase: 'awaiting_approval', approval: { pending, queue: [] } },
  })],
  ['A6', fixture(makeEvent('approval.decided', {
    approvalId: 'a1', decision: 'reject', origin: 'wire',
  }), {
    task: {
      phase: 'awaiting_approval',
      approval: { pending: { ...pending, kind: 'tool-authorization' }, queue: [] },
    },
  })],
  ['A7', fixture(makeEvent('approval.decided', {
    approvalId: 'a1', decision: 'reject', reason: 'no', origin: 'wire',
  }), {
    task: { phase: 'awaiting_approval', approval: { pending, queue: [] } },
  })],
  ['A9', fixture(makeEvent('approval.withdrawn', { requestId: 'r1' }), {
    task: { phase: 'running', approval: { queue: [queued] } },
  })],
  ['A10', fixture(makeEvent('approval.withdrawn', { requestId: 'r1' }), {
    task: { phase: 'awaiting_approval', approval: { pending, queue: [] } },
  })],
  ['A11', fixture(makeEvent('approval.stale'), { task: { phase: 'running' } })],
  ['T1', fixture(makeEvent('turn.ended'), {
    task: { phase: 'running', offer: { message: { required: true } } },
  })],
  ['T1b', fixture(makeEvent('turn.ended'), { task: { phase: 'running' } })],
  ['T2', fixture(makeEvent('terminal.requested', { kind: 'complete' }), {
    task: { phase: 'running', claim: { journaled: true, sent: true } },
  })],
  ['T3', fixture(makeEvent('terminal.requested', { kind: 'failed', reason: 'boom' }), {
    task: { phase: 'running', claim: { journaled: true, sent: true } },
  })],
  ['T4', fixture(makeEvent('terminal.requested', { kind: 'failed', reason: 'boom' }), {
    task: { phase: 'admitting', claim: { journaled: false, sent: false } },
  })],
  ['T5', fixture(makeEvent('terminal.requested', { kind: 'complete' }), {
    task: { phase: 'running', terminal: terminalState() },
  })],
  ['T6', fixture(makeEvent('terminal.evidence', { token: 't1:2', ok: true }), {
    task: { phase: 'terminalizing', terminal: terminalState() },
  })],
  ['T7', fixture(makeEvent('terminal.envelope_ready', { token: 't1:2' }), {
    task: { phase: 'terminalizing', terminal: terminalState({ evidence: 'ok' }) },
  })],
  ['T8', fixture(makeEvent('terminal.envelope_failed', { token: 't1:2' }), {
    task: { phase: 'terminalizing', terminal: terminalState() },
  })],
  ['T9', fixture(makeEvent('terminal.sent', { token: 't1:2' }), {
    task: { phase: 'terminalizing', terminal: terminalState({ envelope: 'ready' }) },
  })],
  ['T10', fixture(makeEvent('terminal.close', { token: 't1:2', ok: true }), {
    task: { phase: 'retiring', terminal: terminalState({ stage: 'sent' }) },
  })],
  ['T11', fixture(makeEvent('terminal.close', { token: 't1:2', ok: false }), {
    task: { phase: 'retiring', terminal: terminalState({ stage: 'sent' }) },
  })],
  ['T12', fixture(makeEvent('terminal.commit', { token: 't1:2', ok: true }), {
    task: {
      phase: 'retiring',
      terminal: terminalState({ stage: 'sent' }),
      teardown: { close: 'settled' },
    },
  })],
  ['T13', fixture(makeEvent('terminal.commit', { token: 't1:2', ok: false }), {
    task: {
      phase: 'retiring',
      terminal: terminalState({ stage: 'sent' }),
      teardown: { close: 'settled' },
    },
  })],
  ['T14', fixture(makeEvent('retry.finalization'), {
    task: {
      phase: 'retiring',
      terminal: terminalState({ stage: 'sent' }),
      teardown: { close: 'failed' },
    },
  })],
  ['T15', fixture(makeEvent('finish.completed'), {
    task: { phase: 'retiring', terminal: terminalState({ stage: 'committed' }) },
  })],
  ['X1', fixture(makeEvent('cancel.received', { reason: 'early' }), {})],
  ['X7', fixture(makeEvent('cancel.received'), {
    task: { phase: 'running', cancel: { requested: true, reason: 'first' } },
  })],
  ['X2', fixture(makeEvent('cancel.received', { reason: 'stop' }), {
    task: { phase: 'admitting' },
  })],
  ['X2a', fixture(makeEvent('cancel.received', { reason: 'stop' }), {
    task: { phase: 'claiming' },
  })],
  ['X2b', fixture(makeEvent('cancel.received', { reason: 'stop' }), {
    task: { phase: 'claiming', claim: { journaled: true, sent: false } },
  })],
  ['X3', fixture(makeEvent('cancel.received', { reason: 'stop' }), {
    task: { phase: 'claimed', startup: { owner: 'startup', registered: true } },
  })],
  ['X3b', fixture(makeEvent('cancel.received', { reason: 'stop' }), {
    task: { phase: 'claimed' },
  })],
  ['X4', fixture(makeEvent('cancel.received', { reason: 'stop' }), {
    task: { phase: 'running' },
  })],
  ['X8', fixture(makeEvent('cancel.received', { reason: 'shutdown', source: 'shutdown' }), {
    task: { phase: 'running' },
  })],
  ['X5', fixture(makeEvent('cancel.received'), {
    task: { phase: 'terminalizing', terminal: terminalState() },
  })],
  ['X6', fixture(makeEvent('cancel.received'), { task: { phase: 'finished' } })],
  ['ST1', fixture(makeEvent('steer.received'), { task: { phase: 'running' } })],
  ['ST4', fixture(makeEvent('steer.received', { sealed: true }), {
    task: { phase: 'running' },
  })],
  ['ST2', fixture(makeEvent('steer.received'), {})],
  ['ST3', fixture(makeEvent('steer.failed', { reason: 'unsupported' }), {
    task: { phase: 'running' },
  })],
  ['SH1', fixture(makeEvent('shutdown.stop_accepting', { reason: 'owner' }), {})],
  ['SH2', fixture(makeEvent('shutdown.stop_accepting'), {
    runner: { acceptingOffers: false, shutdown: { reason: 'owner', atMs: 1, phase: 'stopping' } },
  })],
  ['SH3', fixture(makeEvent('shutdown.drain', { reason: 'owner' }), {})],
  ['SH4', fixture(makeEvent('shutdown.drain'), {
    runner: { acceptingOffers: false, shutdown: { reason: 'owner', atMs: 1, phase: 'draining' } },
  })],
  ['SH5', fixture(makeEvent('startup.disposed', { ok: true }), {
    task: { phase: 'claimed', startup: { owner: 'startup', registered: true } },
  })],
  ['SH6', fixture(makeEvent('shutdown.completed'), {
    runner: { acceptingOffers: false, shutdown: { reason: 'owner', atMs: 1, phase: 'draining' } },
  })],
  ['M0', fixture(makeEvent('message.accepted'), { task: { phase: 'running' } })],
  ['M1', fixture(makeEvent('message.accepted', { completionToken: 'c1' }), {
    task: { phase: 'running', completion: { token: 'c1', kind: 'complete', atMs: 50 } },
  })],
  ['M2', fixture(makeEvent('message.refused', { completionToken: 'c1' }), {
    task: { phase: 'running', completion: { token: 'c1', kind: 'complete', atMs: 50 } },
  })],
  ['M3', fixture(makeEvent('message.send_attempted'), { task: { phase: 'running' } })],
  ['M4', fixture(makeEvent('message.accepted'), {
    task: { phase: 'terminalizing', terminal: terminalState() },
  })],
  ['F-OFFER', fixture(makeEvent('offer.sealed_opened'), { task: { phase: 'running' } })],
  ['F-ADMISSION', fixture(makeEvent('admission.begin'), { task: { phase: 'running' } })],
  ['F-CLAIM', fixture(makeEvent('claim.sent'), { task: { phase: 'running' } })],
  ['F-STARTUP', fixture(makeEvent('startup.registered'), { task: { phase: 'running' } })],
  ['F-RUNTIME', fixture(makeEvent('runtime.started'), { task: { phase: 'running' } })],
  ['F-TURN', fixture(makeEvent('turn.ended'), { task: { phase: 'admitting' } })],
  ['F-APPROVAL', fixture(makeEvent('approval.dispatch_next'), {
    task: { phase: 'terminalizing', terminal: terminalState() },
  })],
  ['F-TERMINAL', fixture(makeEvent('terminal.sent'), { task: { phase: 'running' } })],
  ['F-MESSAGE', fixture(makeEvent('message.send_attempted'), {})],
  ['F-SHUTDOWN', fixture(makeEvent('shutdown.completed'), {})],
]);
