import { canonical, DEFAULT_RETRY, frozenInput, hash, isSealed, project, taskId, validateInput,
  type Conclusion, type Intent, type IntentExecution, type IntentInput, type Json, type LedgerIntentInput, type LedgerState } from './model';

/**
 * Enqueues a plain intent. A sealed execution enters the ledger only as an occurrence of its routine (`admit`), whose
 * stored definition pins the `routineRef`: here no routine is checked, so `source: 'routine'` would be only a label.
 */
export function enqueue(state: LedgerState, tenant: string, input: IntentInput): Intent {
  if (isSealed(input.execution)) throw new Error('A sealed execution must be a routine template occurrence');
  return admit(state, tenant, input);
}

/** Writes one intent. Only the routine transitions admit a sealed execution, after they check its `routineRef`. */
export function admit(state: LedgerState, tenant: string, input: LedgerIntentInput): Intent {
  validateInput(input);
  const frozen = structuredClone({ ...input, retry: input.retry ?? DEFAULT_RETRY });
  const id = hash(input.key);
  const prior = state.intents[id];
  if (prior) {
    const { key, source, execution, waitUntil, retry } = prior;
    if (canonical({ key, source, execution, waitUntil, retry }) !== canonical(frozen)) throw new Error('Intent identity conflict');
    return prior;
  }
  const intent: Intent = { ...frozen, id, agent: agentKey(tenant, input.execution),
    sequence: ++state.sequence, phase: 'queued', generation: 0, taskId: taskId(input.key, 0), notBefore: 0, attempts: 0 };
  state.intents[id] = intent;
  state.executions[intent.taskId] = { input: frozenInput(input.execution, intent.taskId), submission: 'reserved', started: false };
  state.outbox[`intent:${id}`] = { kind: 'intent', intentId: id };
  return intent;
}

/** The FIFO key of an intent: one queue per tenant, device and Agent. */
export function agentKey(tenant: string, execution: Pick<IntentExecution, 'deviceId' | 'payload'>): string {
  return hash([tenant, execution.deviceId, execution.payload.agentRef.agentId]);
}

/** The head of each agent queue: the open intent with the lowest `sequence`. Settled intents must not be passed. */
export function fifoHeads<T extends Pick<Intent, 'agent' | 'sequence'>>(open: Iterable<T>): T[] {
  const heads = new Map<string, T>();
  for (const intent of open) if (!heads.has(intent.agent) || heads.get(intent.agent)!.sequence > intent.sequence) heads.set(intent.agent, intent);
  return [...heads.values()];
}

/** The conclusion of an intent that has no submit in flight (queued, memory-blocked or in backoff), or nothing while it can still start. */
export function queuedExpiry(intent: Pick<Intent, 'cancelReason' | 'waitUntil' | 'retryUntil'>, now: number): Conclusion | undefined {
  if (!intent.cancelReason && now < intent.waitUntil && now < (intent.retryUntil ?? Infinity)) return undefined;
  return intent.cancelReason === 'cancelled' ? 'cancelled' : now >= intent.waitUntil ? 'expired' : 'superseded';
}

export function settle(state: LedgerState, intent: Intent, conclusion: Conclusion): void {
  if (intent.conclusion) return;
  intent.phase = 'settled'; intent.conclusion = conclusion;
  if (intent.occurrence) state.occurrences[intent.occurrence]!.conclusion = conclusion;
  delete state.outbox[`intent:${intent.id}`];
  const terminal = state.executions[intent.taskId]?.terminal;
  const document = conclusion === 'succeeded' && terminal?.envelope.type === 'task.complete' && terminal.envelope.payload.sealed === undefined ? terminal.envelope.payload.document : undefined;
  project(state, `intent:${intent.key}`, JSON.parse(JSON.stringify({ intentKey: intent.key, source: intent.source,
    taskId: intent.taskId, conclusion, preparationError: intent.preparationError, occurrenceKey: intent.occurrence, document })) as Json);
}

export function cancelWake(state: LedgerState, key: string): void {
  delete state.outbox[`schedule:${key}`];
  state.outbox[`cancel:${key}`] = { kind: 'cancel-wake', key };
}
