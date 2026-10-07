// Copy-and-own Host composition, not a public SDK API or native Pi plugin.
// Only the real embedded server + stub daemon have been exercised.
// There is no per-step time limit; a stuck step is bounded by the goal deadline,
// and only when the Host calls tickGoal. No background timer is installed. The Host
// owns authentication, selected context, semantic acceptance and scheduling.
import type { ByokServer, FreshAgentEgressDispatchInput } from '@byok-sdk/server';
import type { DaemonConfig } from '@byok-sdk/client';
import { HostRevisionConflict, SqliteGoalBtwStore, type HostSnapshot } from './goal-btw-store';

export const GOAL_RESULT_CONTRACT = 'host-goal-step-v1';
export const BTW_RESULT_CONTRACT = 'host-btw-answer-v1';
export type BotTarget = Pick<FreshAgentEgressDispatchInput, 'deviceId' | 'agentRef' | 'egressPolicy'> & {
  runtime: 'pi' | 'claude' | 'codex';
  requiredToolsets?: FreshAgentEgressDispatchInput['requiredToolsets'];
};
type Input = BotTarget & { taskId: string; instruction: string; terminalProjection: NonNullable<FreshAgentEgressDispatchInput['terminalProjection']> };
type Pending = { input: Input; phase: 'reserved' | 'sending' };
export type GoalDecision =
  | { outcome: 'continue' | 'complete' }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'wait'; reason: string; resumeAt: number | null };
export interface HostGoal {
  kind: 'goal'; id: string; objective: string; target: BotTarget;
  status: 'active' | 'paused' | 'waiting' | 'blocked' | 'complete' | 'cancelled' | 'exhausted';
  maxSteps: number; deadline: number; steps: number; pending: Pending | null;
  resumeAt: number | null; lastTaskId: string | null; reason: string | null;
}
export interface HostBtw {
  kind: 'btw'; id: string; mainTaskId: string; mainAgentId: string;
  mainDestination: string; destination: string; snapshotRevision: string;
  status: 'pending' | 'complete' | 'blocked' | 'cancelled';
  pending: Pending; answer: string | null; reason: string | null;
}
type Record = HostGoal | HostBtw;
type Server = Pick<ByokServer, 'dispatchFreshAgentEgress' | 'tasks'>;

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`);
}
function safeTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Host time must be a nonnegative safe integer');
}
function validateTarget(target: BotTarget): void {
  nonempty(target.deviceId, 'deviceId'); nonempty(target.agentRef?.agentId, 'agentId');
  nonempty(target.agentRef?.profileRevision, 'profileRevision');
  if (!['pi', 'claude', 'codex'].includes(target.runtime) || !target.egressPolicy) throw new Error('Select an explicit runtime and egress policy');
  const keys = ['deviceId', 'agentRef', 'egressPolicy', 'runtime', 'requiredToolsets'];
  if (Object.keys(target).some(key => !keys.includes(key))) throw new Error('Target contains undeclared execution authority');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as { [key: string]: unknown })[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function sameAgent(a: { agentId: string; profileRevision: string }, b: { agentId: string; profileRevision: string }): boolean {
  return a.agentId === b.agentId && a.profileRevision === b.profileRevision;
}
function parseDecision(document: unknown, now: number): GoalDecision {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Missing goal result document');
  const value = document as { [key: string]: unknown };
  if (value.contract !== GOAL_RESULT_CONTRACT) throw new Error('Wrong goal result contract');
  if (value.outcome === 'complete' || value.outcome === 'continue') {
    if (Object.keys(value).sort().join(',') !== 'contract,outcome') throw new Error('Unexpected goal verdict fields');
    return { outcome: value.outcome };
  }
  if (value.outcome === 'blocked' || value.outcome === 'wait') {
    nonempty(value.reason, 'reason');
    const keys = value.outcome === 'wait' ? 'contract,outcome,reason,resumeAt' : 'contract,outcome,reason';
    if (Object.keys(value).sort().join(',') !== keys) throw new Error('Unexpected goal verdict fields');
    if (value.outcome === 'blocked') return { outcome: 'blocked', reason: value.reason };
    if (value.resumeAt !== null) {
      if (typeof value.resumeAt !== 'number') throw new Error('Invalid wait time');
      safeTime(value.resumeAt);
      if (value.resumeAt <= now) throw new Error('A timed goal wait must be in the future');
    }
    return { outcome: 'wait', reason: value.reason, resumeAt: value.resumeAt as number | null };
  }
  throw new Error('Unknown goal verdict');
}

type ResultTask = Parameters<NonNullable<DaemonConfig['resultDocument']>['extract']>[1];
/** Use the existing daemon resultDocument.extract seam; unknown contracts are not handled. */
export function extractBotResult(output: string, task: ResultTask): unknown {
  const contract = task.terminalProjection?.mode === 'result-document' ? task.terminalProjection.contract : undefined;
  if (contract !== GOAL_RESULT_CONTRACT && contract !== BTW_RESULT_CONTRACT) return undefined;
  const document: unknown = JSON.parse(output);
  if (contract === GOAL_RESULT_CONTRACT) parseDecision(document, -1);
  else {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Invalid side result');
    const doc = document as { contract?: unknown; answer?: unknown };
    if (Object.keys(doc).sort().join(',') !== 'answer,contract' || doc.contract !== contract || typeof doc.answer !== 'string' || !doc.answer.trim()) throw new Error('Invalid side result');
  }
  return document;
}

export class GoalBtwHost {
  constructor(private readonly server: Server, private readonly store: SqliteGoalBtwStore, private readonly now: () => number,
    private readonly acceptGoalResult: (goal: Readonly<HostGoal>, decision: GoalDecision) => boolean | Promise<boolean>) {}
  private time(): number { const time = this.now(); safeTime(time); return time; }
  private read<T extends Record>(kind: T['kind'], id: string): HostSnapshot<T> {
    nonempty(id, 'id');
    const row = this.store.read<T>(`${kind}:${id}`);
    if (!row || !row.value || row.value.kind !== kind || row.value.id !== id) throw new Error('Host record not found or invalid');
    const value = row.value;
    if (value.kind === 'goal') {
      validateTarget(value.target); safeTime(value.deadline);
      if (!Number.isSafeInteger(value.maxSteps) || value.maxSteps < 1 || !Number.isSafeInteger(value.steps) || value.steps < 0 || value.steps > value.maxSteps
        || !['active', 'paused', 'waiting', 'blocked', 'complete', 'cancelled', 'exhausted'].includes(value.status)) throw new Error('Invalid goal state');
    } else if (!['pending', 'complete', 'blocked', 'cancelled'].includes(value.status)) throw new Error('Invalid btw state');
    if (value.pending) {
      const execution = value.pending;
      if (!execution.input || !['reserved', 'sending'].includes(execution.phase)) throw new Error('Invalid reserved execution');
      const input = execution.input;
      nonempty(input.taskId, 'reserved taskId'); nonempty(input.instruction, 'reserved instruction');
      const contract = value.kind === 'goal' ? GOAL_RESULT_CONTRACT : BTW_RESULT_CONTRACT;
      const { taskId: _id, instruction: _text, terminalProjection: projection, ...target } = input;
      validateTarget(target);
      if (projection?.mode !== 'result-document' || projection.contract !== contract) throw new Error('Invalid reserved result authority');
      if (value.kind === 'goal') {
        if (canonical(target) !== canonical(value.target)) throw new Error('Reserved execution widened its Host binding');
      } else if (target.agentRef.agentId === value.mainAgentId
        || value.destination === value.mainDestination || input.taskId === value.mainTaskId) {
        throw new Error('Reserved execution widened its Host binding');
      }
    }
    return row;
  }
  goal(id: string): HostSnapshot<HostGoal> { return this.read<HostGoal>('goal', id); }
  btw(id: string): HostSnapshot<HostBtw> { return this.read<HostBtw>('btw', id); }
  private checkRevision<T>(row: HostSnapshot<T>, expected: number): void {
    if (row.revision !== expected) throw new HostRevisionConflict();
  }
  startGoal(input: { id: string; objective: string; target: BotTarget; maxSteps: number; deadline: number }): HostSnapshot<HostGoal> {
    nonempty(input.id, 'goal id'); nonempty(input.objective, 'objective'); validateTarget(input.target); safeTime(input.deadline);
    if (!Number.isSafeInteger(input.maxSteps) || input.maxSteps < 1 || input.deadline <= this.time()) throw new Error('Select a positive step budget and future deadline');
    return this.store.write(`goal:${input.id}`, null, {
      kind: 'goal', id: input.id, objective: input.objective, target: input.target,
      status: 'active', maxSteps: input.maxSteps, deadline: input.deadline, steps: 0,
      pending: null, resumeAt: null, lastTaskId: null, reason: null,
    });
  }
  reserveGoalStep(id: string, revision: number, taskId: string, context: string): HostSnapshot<HostGoal> {
    const row = this.goal(id); this.checkRevision(row, revision); nonempty(taskId, 'taskId');
    if (typeof context !== 'string') throw new Error('Host context must be an explicit text snapshot');
    const goal = row.value; const now = this.time();
    if (goal.pending) throw new Error('Settle the reserved execution before admitting another step');
    if (goal.status === 'waiting' && goal.resumeAt !== null && now >= goal.resumeAt) goal.status = 'active';
    if (goal.status !== 'active') throw new Error('Goal is not active');
    if (goal.steps >= goal.maxSteps || now >= goal.deadline) throw new Error('Goal budget exhausted');
    const instruction = `Objective:\n${goal.objective}\n\nHost-selected context:\n${context}\n\nReturn only a JSON document with contract "${GOAL_RESULT_CONTRACT}" and outcome "continue", "complete", "blocked" or "wait". blocked requires reason; wait requires reason and resumeAt (future epoch milliseconds or null for an external event). Report complete only with evidence that the objective is fulfilled.`;
    const input: Input = { ...goal.target, taskId, instruction, terminalProjection: { mode: 'result-document', contract: GOAL_RESULT_CONTRACT } };
    goal.pending = { input, phase: 'reserved' }; goal.steps += 1; goal.resumeAt = null; goal.reason = null;
    return this.store.write(`goal:${id}`, revision, goal, taskId);
  }
  private async verifyOffer(input: Input): Promise<boolean> {
    const offer = await this.server.tasks.offer(input.taskId);
    if (!offer) return false;
    const { taskId: _taskId, deviceId: _deviceId, ...payload } = input;
    if (offer.taskId !== input.taskId || offer.deviceId !== input.deviceId || offer.type !== 'task.offer_for_agent_with_egress_fresh' || canonical(offer.payload) !== canonical(payload)) {
      throw new Error('Persisted SDK offer differs from the reserved Host input');
    }
    return offer.delivered;
  }
  private async flushCancellation(record: Record): Promise<void> {
    if (!record.pending) return;
    const attempt = await this.server.tasks.attempt(record.pending.input.taskId);
    if (attempt) {
      const input = record.pending.input;
      if (attempt.taskId !== input.taskId || attempt.deviceId !== input.deviceId || !attempt.agentRef || !sameAgent(attempt.agentRef, input.agentRef)) throw new Error('Cancellation target differs from the reservation');
      await this.verifyOffer(input);
      await this.server.tasks.cancel(input.taskId, 'Host stopped this execution');
    }
  }
  private stopped(record: Record): boolean {
    return record.kind === 'goal' ? ['cancelled', 'exhausted'].includes(record.status) : record.status === 'cancelled';
  }
  private async send<T extends Record>(kind: T['kind'], id: string, revision: number, recovery: boolean): Promise<HostSnapshot<T>> {
    let row = this.read<T>(kind, id); this.checkRevision(row, revision);
    if (!row.value.pending) throw new Error('No reserved execution');
    if (this.stopped(row.value)) { await this.flushCancellation(row.value); return this.read<T>(kind, id); }
    if (row.value.kind === 'goal' && row.value.status !== 'active') throw new Error('Goal is not active');
    if (row.value.kind === 'goal' && this.time() >= row.value.deadline) {
      row.value.status = 'exhausted'; row.value.reason = 'goal_deadline_reached';
      const saved = this.store.write(`${kind}:${id}`, revision, row.value);
      await this.flushCancellation(saved.value); return saved;
    }
    if (row.value.pending.phase === 'sending' && !recovery) throw new Error('Submission may have happened; use explicit recovery');
    if (row.value.pending.phase === 'reserved') {
      row.value.pending.phase = 'sending';
      row = this.store.write(`${kind}:${id}`, revision, row.value);
    }
    const input = row.value.pending!.input;
    if (!await this.verifyOffer(input)) {
      // A durable offer without its delivered marker is not evidence that append
      // never happened. Only the SDK's exact-input recovery path may repair it.
      const latest = this.read<T>(kind, id);
      if (this.stopped(latest.value)) { await this.flushCancellation(latest.value); return latest; }
      if (latest.value.kind === 'goal' && latest.value.status !== 'active') return latest;
      try { await this.server.dispatchFreshAgentEgress(input); }
      catch (error) { if (!await this.verifyOffer(input)) throw error; }
    }
    const latest = this.read<T>(kind, id);
    if (this.stopped(latest.value)) await this.flushCancellation(latest.value);
    return latest;
  }
  sendGoalStep(id: string, revision: number): Promise<HostSnapshot<HostGoal>> { return this.send('goal', id, revision, false); }
  recoverGoalStep(id: string, revision: number): Promise<HostSnapshot<HostGoal>> { return this.send('goal', id, revision, true); }

  private async terminal(input: Input) {
    const attempt = await this.server.tasks.attempt(input.taskId);
    if (!attempt) return undefined;
    if (attempt.taskId !== input.taskId || attempt.deviceId !== input.deviceId || !attempt.agentRef || !sameAgent(attempt.agentRef, input.agentRef)) throw new Error('SDK attempt differs from the reservation');
    const terminal = await this.server.tasks.deviceTerminal(input.taskId);
    // Cancellation intent is authoritative even when a late complete exists.
    const latest = await this.server.tasks.attempt(input.taskId);
    if (!latest || latest.cancellation) return { outcome: 'cancelled' as const };
    if (!terminal) return undefined;
    if (terminal.envelope.task_id !== input.taskId) throw new Error('Terminal differs from the reservation');
    if (terminal.envelope.type !== 'task.complete') return { outcome: 'blocked' as const };
    return { outcome: 'complete' as const, document: terminal.envelope.payload.document };
  }
  async reconcileGoal(id: string, revision: number): Promise<HostSnapshot<HostGoal>> {
    const row = this.goal(id); this.checkRevision(row, revision);
    if (!row.value.pending) return row;
    const observed = await this.terminal(row.value.pending.input);
    if (!observed) return row;
    const goal = row.value; goal.lastTaskId = goal.pending!.input.taskId; goal.pending = null;
    if (this.stopped(goal)) return this.store.write(`goal:${id}`, revision, goal);
    if (observed.outcome !== 'complete') { goal.status = 'blocked'; goal.reason = observed.outcome === 'cancelled' ? 'execution_cancelled' : 'execution_failed_or_declined'; }
    else {
      let decision: GoalDecision;
      try { decision = parseDecision(observed.document, this.time()); }
      catch { goal.status = 'blocked'; goal.reason = 'invalid_goal_result'; return this.store.write(`goal:${id}`, revision, goal); }
      if (!await this.acceptGoalResult(structuredClone(goal), structuredClone(decision))) {
        goal.status = 'blocked'; goal.reason = 'goal_result_not_accepted';
        return this.store.write(`goal:${id}`, revision, goal);
      }
      // Pause stops further admission; it does not discard completion/blockage.
      if (decision.outcome === 'complete') goal.status = 'complete';
      else if (decision.outcome === 'blocked') { goal.status = 'blocked'; goal.reason = decision.reason; }
      else if (goal.status !== 'paused') {
        if (goal.steps >= goal.maxSteps || this.time() >= goal.deadline) { goal.status = 'exhausted'; goal.reason = 'goal_budget_exhausted'; }
        else if (decision.outcome === 'wait') { goal.status = 'waiting'; goal.reason = decision.reason; goal.resumeAt = decision.resumeAt; }
        else goal.status = 'active';
      }
    }
    return this.store.write(`goal:${id}`, revision, goal);
  }
  pauseGoal(id: string, revision: number): HostSnapshot<HostGoal> {
    const row = this.goal(id); this.checkRevision(row, revision);
    if (!['active', 'waiting'].includes(row.value.status)) throw new Error('Goal cannot be paused');
    row.value.status = 'paused'; return this.store.write(`goal:${id}`, revision, row.value);
  }
  resumeGoal(id: string, revision: number): HostSnapshot<HostGoal> {
    const row = this.goal(id); this.checkRevision(row, revision);
    if (!['paused', 'waiting', 'blocked'].includes(row.value.status)) throw new Error('Goal cannot be resumed');
    row.value.status = row.value.steps >= row.value.maxSteps || this.time() >= row.value.deadline ? 'exhausted' : 'active';
    row.value.reason = null; row.value.resumeAt = null;
    return this.store.write(`goal:${id}`, revision, row.value);
  }
  async cancelGoal(id: string, revision: number): Promise<HostSnapshot<HostGoal>> {
    const row = this.goal(id); this.checkRevision(row, revision);
    if (['complete', 'exhausted'].includes(row.value.status)) throw new Error('Goal is already terminal');
    row.value.status = 'cancelled'; const saved = this.store.write(`goal:${id}`, revision, row.value);
    await this.flushCancellation(saved.value); return this.goal(id);
  }
  async tickGoal(id: string, revision: number): Promise<HostSnapshot<HostGoal>> {
    const row = this.goal(id); this.checkRevision(row, revision);
    if (['complete', 'cancelled', 'exhausted'].includes(row.value.status) || this.time() < row.value.deadline) return row;
    row.value.status = 'exhausted'; row.value.reason = 'goal_deadline_reached';
    const saved = this.store.write(`goal:${id}`, revision, row.value);
    await this.flushCancellation(saved.value); return this.goal(id);
  }

  async reserveBtw(input: { id: string; taskId: string; mainTaskId: string; mainDestination: string; destination: string; snapshotRevision: string; snapshot: string; question: string; target: BotTarget }): Promise<HostSnapshot<HostBtw>> {
    for (const key of ['id', 'taskId', 'mainTaskId', 'mainDestination', 'destination', 'snapshotRevision', 'question'] as const) nonempty(input[key], key);
    validateTarget(input.target);
    if (typeof input.snapshot !== 'string') throw new Error('Provide an explicit Host-selected snapshot');
    const main = await this.server.tasks.attempt(input.mainTaskId);
    if (!main?.agentRef || main.status !== 'running' || main.cancellation) throw new Error('The main task is not running');
    if (input.target.agentRef.agentId === main.agentRef.agentId) throw new Error('btw requires a different Agent home, not a different profileRevision');
    if (input.destination === input.mainDestination || input.taskId === input.mainTaskId) throw new Error('btw requires an independent task and destination');
    const execution: Input = { ...input.target, taskId: input.taskId,
      instruction: `Host-selected main-thread snapshot (${input.snapshotRevision}):\n${input.snapshot}\n\nSide question:\n${input.question}\n\nAnswer independently. Do not change or steer the main task. Return only JSON {"contract":"${BTW_RESULT_CONTRACT}","answer":"your answer"}.`,
      terminalProjection: { mode: 'result-document', contract: BTW_RESULT_CONTRACT } };
    return this.store.write(`btw:${input.id}`, null, {
      kind: 'btw', id: input.id, mainTaskId: input.mainTaskId, mainAgentId: main.agentRef.agentId,
      mainDestination: input.mainDestination, destination: input.destination, snapshotRevision: input.snapshotRevision,
      status: 'pending', pending: { input: execution, phase: 'reserved' }, answer: null, reason: null,
    }, input.taskId);
  }
  sendBtw(id: string, revision: number): Promise<HostSnapshot<HostBtw>> { return this.send('btw', id, revision, false); }
  recoverBtw(id: string, revision: number): Promise<HostSnapshot<HostBtw>> { return this.send('btw', id, revision, true); }
  async reconcileBtw(id: string, revision: number): Promise<HostSnapshot<HostBtw>> {
    const row = this.btw(id); this.checkRevision(row, revision);
    if (row.value.status !== 'pending') return row;
    const observed = await this.terminal(row.value.pending.input);
    if (!observed) return row;
    if (observed.outcome !== 'complete') { row.value.status = 'blocked'; row.value.reason = 'side_execution_failed_or_cancelled'; }
    else {
      const doc = observed.document as { contract?: unknown; answer?: unknown } | undefined;
      if (!doc || Array.isArray(doc) || typeof doc !== 'object' || Object.keys(doc).sort().join(',') !== 'answer,contract'
        || doc.contract !== BTW_RESULT_CONTRACT || typeof doc.answer !== 'string' || !doc.answer.trim()) {
        row.value.status = 'blocked'; row.value.reason = 'invalid_side_result';
      } else { row.value.status = 'complete'; row.value.answer = doc.answer; }
    }
    return this.store.write(`btw:${id}`, revision, row.value);
  }
  async cancelBtw(id: string, revision: number): Promise<HostSnapshot<HostBtw>> {
    const row = this.btw(id); this.checkRevision(row, revision);
    if (row.value.status === 'complete') throw new Error('btw is already complete');
    row.value.status = 'cancelled'; const saved = this.store.write(`btw:${id}`, revision, row.value);
    await this.flushCancellation(saved.value); return this.btw(id);
  }
}
