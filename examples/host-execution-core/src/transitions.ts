import { canonical, DEFAULT_RETRY, hash, project, taskId, validateInput,
  type Conclusion, type Intent, type IntentInput, type Json, type LedgerState } from './model';

export function enqueue(state: LedgerState, tenant: string, input: IntentInput): Intent {
  validateInput(input);
  const frozen = structuredClone({ ...input, retry: input.retry ?? DEFAULT_RETRY });
  const id = hash(input.key);
  const prior = state.intents[id];
  if (prior) {
    const { key, source, execution, waitUntil, retry } = prior;
    if (canonical({ key, source, execution, waitUntil, retry }) !== canonical(frozen)) throw new Error('Intent identity conflict');
    return prior;
  }
  const intent: Intent = { ...frozen, id, agent: hash([tenant, input.execution.deviceId, input.execution.payload.agentRef.agentId]),
    sequence: ++state.sequence, phase: 'queued', generation: 0, taskId: taskId(input.key, 0), notBefore: 0, attempts: 0 };
  state.intents[id] = intent;
  state.executions[intent.taskId] = { input: { ...structuredClone(input.execution), taskId: intent.taskId }, submission: 'reserved', started: false };
  state.outbox[`intent:${id}`] = { kind: 'intent', intentId: id };
  return intent;
}

export function settle(state: LedgerState, intent: Intent, conclusion: Conclusion): void {
  if (intent.conclusion) return;
  intent.phase = 'settled'; intent.conclusion = conclusion;
  if (intent.occurrence) state.occurrences[intent.occurrence]!.conclusion = conclusion;
  delete state.outbox[`intent:${intent.id}`];
  const terminal = state.executions[intent.taskId]?.terminal;
  const document = conclusion === 'succeeded' && terminal?.envelope.type === 'task.complete' ? terminal.envelope.payload.document : undefined;
  project(state, `intent:${intent.key}`, JSON.parse(JSON.stringify({ intentKey: intent.key, source: intent.source,
    taskId: intent.taskId, conclusion, preparationError: intent.preparationError, occurrenceKey: intent.occurrence, document })) as Json);
}

export function cancelWake(state: LedgerState, key: string): void {
  delete state.outbox[`schedule:${key}`];
  state.outbox[`cancel:${key}`] = { kind: 'cancel-wake', key };
}
