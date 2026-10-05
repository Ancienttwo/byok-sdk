// Copy-and-own Host reference, not SDK API or pi-ask. Only HTTP/stub execution
// is exercised, not prepared Pi/provider continuity. Authentication, semantic
// result acceptance and notification destination authorization belong to Host.
// No per-step timer: Host must call tick/recover. Notification is at-least-once;
// the receiver must durably deduplicate deliveryId. Never use SDK/Agent DBs here.
import { randomUUID } from 'node:crypto';
import type { ByokServer, FreshAgentEgressDispatchInput } from '@byok-sdk/server';
import type { DaemonConfig } from '@byok-sdk/client';
import { HostRevisionConflict, type HostSnapshot } from './goal-btw-store';
import type { BotTarget } from './goal-btw';
import { SqliteClarificationStore } from './clarification-store';

export const CLARIFICATION_CONTRACT = 'clarification-step.v1';
export type ClarificationResult =
  | { contract: typeof CLARIFICATION_CONTRACT; outcome: 'complete' }
  | { contract: typeof CLARIFICATION_CONTRACT; outcome: 'blocked'; reason: string }
  | { contract: typeof CLARIFICATION_CONTRACT; outcome: 'needs_input'; questionId: string; question: string; checkpoint: string; answerKind: 'text' }
  | { contract: typeof CLARIFICATION_CONTRACT; outcome: 'needs_input'; questionId: string; question: string; checkpoint: string; answerKind: 'single_choice'; options: { id: string; label: string }[] };
type Input = FreshAgentEgressDispatchInput & { taskId: string; instruction: string };
export interface QuestionBinding {
  tenantId: string; runId: string; sessionId: string; sourceTaskId: string; generation: number;
  contextRevision: string; questionId: string; questionRevision: number;
  deviceId: string; agentId: string; profileRevision: string; destination: string;
}
export interface AnswerReceipt { answerId: string; answerDigest: string; binding: QuestionBinding; continuationTaskId: string; }
export interface Ticket {
  binding: QuestionBinding; result: Extract<ClarificationResult, { outcome: 'needs_input' }>;
  expiresAt: number; state: 'open' | 'answered' | 'cancelled' | 'expired' | 'obsolete';
  notification: 'pending' | 'delivered' | 'closed'; receipt: AnswerReceipt | null;
}
export interface ClarificationRun {
  id: string; tenantId: string; sessionId: string; respondentId: string; destination: string;
  target: BotTarget; contextRevision: string; context: string; objective: string;
  status: 'running' | 'waiting_input' | 'continuation_reserved' | 'complete' | 'blocked' | 'cancelled' | 'expired' | 'obsolete';
  generation: number; maxExecutions: number; deadline: number; questionTtlMs: number;
  pending: { input: Input; phase: 'reserved' | 'sending' } | null;
  tickets: Ticket[]; reason: string | null;
}
type Server = Pick<ByokServer, 'dispatchFreshAgentEgress' | 'tasks'>;
export interface Principal { tenantId: string; userId: string; }
function text(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
}
function object(value: unknown): { [key: string]: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as { [key: string]: unknown };
}
function keys(value: object, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(',')) throw new Error('Unexpected clarification fields');
}
function time(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Host time'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as { [key: string]: unknown })[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function validateTarget(target: BotTarget): void {
  const t = object(target); const allowed = ['deviceId','agentRef','runtime','policy','egressPolicy','requiredToolsets'];
  if (Object.keys(t).some(k => !allowed.includes(k))) throw new Error('Target contains undeclared authority');
  text(target.deviceId, 'deviceId', 200); text(target.agentRef?.agentId, 'agentId', 200); text(target.agentRef?.profileRevision, 'profileRevision', 200);
  if (!['pi','claude','codex'].includes(target.runtime) || !target.policy || !target.egressPolicy) throw new Error('Invalid target');
}
export function parseClarification(document: unknown): ClarificationResult {
  if (Buffer.byteLength(JSON.stringify(document) ?? '') > 16384) throw new Error('Clarification document too large');
  const d = object(document);
  if (d.contract !== CLARIFICATION_CONTRACT) throw new Error('Wrong clarification contract');
  if (d.outcome === 'complete') keys(d, ['contract','outcome']);
  else if (d.outcome === 'blocked') { keys(d, ['contract','outcome','reason']); text(d.reason,'reason'); }
  else if (d.outcome === 'needs_input') {
    const base = ['contract','outcome','questionId','question','checkpoint','answerKind'];
    keys(d, d.answerKind === 'single_choice' ? [...base,'options'] : base);
    text(d.questionId,'model questionId',200); text(d.question,'question'); text(d.checkpoint,'checkpoint');
    if (d.answerKind === 'single_choice') {
      if (!Array.isArray(d.options) || d.options.length < 2 || d.options.length > 8) throw new Error('Invalid options');
      const seen = new Set<string>();
      for (const option of d.options) {
        const o = object(option); keys(o,['id','label']); text(o.id,'option id',100); text(o.label,'option label',500);
        if (seen.has(o.id)) throw new Error('Duplicate option id'); seen.add(o.id);
      }
    } else if (d.answerKind !== 'text') throw new Error('Unsupported answer kind');
  } else throw new Error('Unknown clarification outcome');
  return structuredClone(document) as ClarificationResult;
}
type ResultTask = Parameters<NonNullable<DaemonConfig['resultDocument']>['extract']>[1];
export function extractClarification(output: string, task: ResultTask): unknown {
  if (task.terminalProjection?.mode !== 'result-document' || task.terminalProjection.contract !== CLARIFICATION_CONTRACT) return undefined;
  return parseClarification(JSON.parse(output));
}
const stopped = (run: ClarificationRun) => ['cancelled','expired','obsolete','blocked','complete'].includes(run.status);

export class ClarificationHost {
  constructor(private readonly server: Server, private readonly store: SqliteClarificationStore, private readonly now: () => number) {}
  private clock(): number { const n = this.now(); time(n); return n; }
  run(id: string): HostSnapshot<ClarificationRun> {
    const row = this.store.read<ClarificationRun>(id);
    if (!row || row.value.id !== id || row.value.tenantId !== this.store.tenantId) throw new Error('Host run not found');
    return row;
  }
  private check(row: HostSnapshot<ClarificationRun>, revision: number): void { if (row.revision !== revision) throw new HostRevisionConflict(); }
  private write(run: ClarificationRun, revision: number | null, taskId?: string): HostSnapshot<ClarificationRun> {
    return this.store.write(run.id, revision, run, run.status === 'waiting_input', taskId);
  }
  private input(run: ClarificationRun, taskId: string, answer?: { ticket: Ticket; value: string }): Input {
    text(taskId,'taskId',200);
    const instruction = `Objective:\n${run.objective}\nHost-selected context (${run.contextRevision}):\n${run.context}\n${answer ? `Validated clarification answer:\n${JSON.stringify({ question: answer.ticket.result, answer: answer.value })}\n` : ''}Return only JSON with contract "${CLARIFICATION_CONTRACT}" and outcome complete, blocked (reason), or needs_input (questionId, question, checkpoint, answerKind). answerKind text has no options; single_choice requires 2-8 unique {id,label} options. No additional fields. Clarification never grants tool permission.`;
    return { ...run.target, taskId, instruction, terminalProjection: { mode: 'result-document', contract: CLARIFICATION_CONTRACT } };
  }
  start(input: Omit<ClarificationRun, 'tenantId'|'status'|'generation'|'pending'|'tickets'|'reason'>, taskId: string): HostSnapshot<ClarificationRun> {
    for (const key of ['id','sessionId','respondentId','destination','contextRevision','objective'] as const) text(input[key],key);
    text(input.context,'context',16384); validateTarget(input.target); time(input.deadline); time(input.questionTtlMs);
    if (!Number.isSafeInteger(input.maxExecutions) || input.maxExecutions < 1 || input.maxExecutions > 16 || input.questionTtlMs < 1 || input.deadline <= this.clock()) throw new Error('Invalid execution budget or deadline');
    const run: ClarificationRun = { ...input, tenantId: this.store.tenantId, status: 'running', generation: 1, tickets: [], pending: null, reason: null };
    run.pending = { input: this.input(run,taskId), phase: 'reserved' };
    return this.write(run,null,taskId);
  }
  private async offer(input: Input): Promise<boolean> {
    const offer = await this.server.tasks.offer(input.taskId);
    if (!offer) return false;
    const { taskId: _id, deviceId: _device, ...payload } = input;
    if (offer.taskId !== input.taskId || offer.deviceId !== input.deviceId || offer.type !== 'task.offer_for_agent_with_egress_fresh' || canonical(offer.payload) !== canonical(payload)) throw new Error('SDK offer differs from reserved input');
    return offer.delivered;
  }
  private async cancelPending(run: ClarificationRun): Promise<void> {
    if (!run.pending) return;
    const input = run.pending.input; const attempt = await this.server.tasks.attempt(input.taskId);
    if (!attempt) return;
    if (attempt.taskId !== input.taskId || attempt.deviceId !== input.deviceId || canonical(attempt.agentRef) !== canonical(input.agentRef)) throw new Error('SDK cancellation binding mismatch');
    await this.offer(input); await this.server.tasks.cancel(input.taskId,'Host clarification stopped');
  }
  async recover(id: string, revision: number): Promise<HostSnapshot<ClarificationRun>> { return this.send(id,revision,true); }
  async send(id: string, revision: number, recovery = false): Promise<HostSnapshot<ClarificationRun>> {
    let row = this.run(id); this.check(row,revision);
    if (stopped(row.value)) { await this.cancelPending(row.value); return this.run(id); }
    if (this.clock() >= row.value.deadline) return this.tick(id,revision);
    if (!row.value.pending) throw new Error('No reserved execution');
    if (row.value.pending.phase === 'sending' && !recovery) throw new Error('Use explicit exact-input recovery');
    if (row.value.pending.phase === 'reserved') {
      row.value.pending.phase = 'sending'; row.value.status = 'running'; row = this.write(row.value,revision);
    }
    const input = row.value.pending!.input;
    if (!await this.offer(input)) {
      const latest = this.run(id);
      if (stopped(latest.value)) { await this.cancelPending(latest.value); return latest; }
      try { await this.server.dispatchFreshAgentEgress(input); }
      catch (error) { if (!await this.offer(input)) throw error; }
    }
    const latest = this.run(id);
    if (stopped(latest.value)) await this.cancelPending(latest.value);
    return latest;
  }
  async reconcile(id: string, revision: number): Promise<HostSnapshot<ClarificationRun>> {
    const row = this.run(id); this.check(row,revision); const run = row.value;
    if (stopped(run)) { await this.cancelPending(run); return this.run(id); }
    if (this.clock() >= run.deadline) return this.tick(id,revision);
    if (!run.pending) return row;
    const input = run.pending.input;
    await this.offer(input);
    const attempt = await this.server.tasks.attempt(input.taskId);
    if (!attempt) return row;
    if (attempt.deviceId !== input.deviceId || canonical(attempt.agentRef) !== canonical(input.agentRef)) throw new Error('SDK terminal binding mismatch');
    const terminal = await this.server.tasks.deviceTerminal(input.taskId);
    const latest = await this.server.tasks.attempt(input.taskId);
    if (latest?.cancellation) { run.status = 'blocked'; run.reason = 'execution_cancelled'; }
    else if (!terminal) return row;
    else if (terminal.envelope.task_id !== input.taskId) throw new Error('SDK terminal taskId mismatch');
    else if (terminal.envelope.type !== 'task.complete') { run.status = 'blocked'; run.reason = 'execution_failed_or_declined'; }
    else {
      let result: ClarificationResult;
      try { result = parseClarification(terminal.envelope.payload.document); }
      catch { run.status = 'blocked'; run.reason = 'invalid_clarification_result'; run.pending = null; return this.write(run,revision); }
      if (result.outcome === 'complete') run.status = 'complete';
      else if (result.outcome === 'blocked') { run.status = 'blocked'; run.reason = result.reason; }
      else if (run.generation >= run.maxExecutions) { run.status = 'blocked'; run.reason = 'execution_budget_exhausted'; }
      else {
        const expiresAt = Math.min(run.deadline,this.clock() + run.questionTtlMs); time(expiresAt);
        run.tickets.push({ binding: { tenantId: run.tenantId,runId: run.id,sessionId: run.sessionId,sourceTaskId: input.taskId,generation: run.generation,
          contextRevision: run.contextRevision,questionId: randomUUID(),questionRevision: 1,deviceId: input.deviceId,
          agentId: input.agentRef.agentId,profileRevision: input.agentRef.profileRevision,destination: run.destination },
          result,expiresAt,state: 'open',notification: 'pending',receipt: null });
        run.status = 'waiting_input';
      }
    }
    run.pending = null;
    // The cap is checked inside the CAS transaction. A full tenant stays at the
    // same source terminal; retry only after expiry/cap space, never dispatch.
    return this.write(run,revision);
  }
  async notify(id: string, revision: number, deliver: (notice: { deliveryId: string; binding: QuestionBinding; question: Ticket['result'] }) => Promise<void>): Promise<HostSnapshot<ClarificationRun>> {
    const row = this.run(id); this.check(row,revision);
    if (row.value.status !== 'waiting_input') return row;
    const ticket = row.value.tickets.at(-1)!;
    if (this.clock() >= ticket.expiresAt) return this.tick(id,revision);
    if (ticket.notification !== 'pending') return row;
    await deliver({ deliveryId: ticket.binding.questionId,binding: structuredClone(ticket.binding),question: structuredClone(ticket.result) });
    // A concurrent answer/cancel wins. A successful notification isn't allowed
    // to overwrite it; if acknowledgement is lost the consumer dedupes the ID.
    const latest = this.run(id);
    if (latest.revision !== revision) return latest;
    ticket.notification = 'delivered'; return this.write(row.value,revision);
  }
  answer(principal: Principal, binding: QuestionBinding, input: { answerId: string; value: string; taskId: string; nextContextRevision: string }): AnswerReceipt {
    if (principal.tenantId !== this.store.tenantId || binding.tenantId !== principal.tenantId) throw new Error('Answer tenant unauthorized');
    const row = this.run(binding.runId); const run = row.value;
    if (principal.userId !== run.respondentId) throw new Error('Answer respondent unauthorized');
    text(input.answerId,'answerId',200); text(input.value,'answer');
    const digest = canonical({ binding,value: input.value });
    const duplicate = run.tickets.find(t => t.receipt?.answerId === input.answerId);
    if (duplicate) {
      if (duplicate.receipt!.answerDigest !== digest) throw new Error('Answer id conflicts with recorded body');
      return structuredClone(duplicate.receipt!); // Historical receipt, not permission to redispatch.
    }
    const ticket = run.tickets.at(-1);
    if (run.status !== 'waiting_input' || !ticket || ticket.state !== 'open' || canonical(ticket.binding) !== canonical(binding)
      || binding.contextRevision !== run.contextRevision || binding.generation !== run.generation || this.clock() >= ticket.expiresAt) throw new Error('Answer is stale or question is closed');
    if (ticket.result.answerKind === 'single_choice' && !ticket.result.options.some(o => o.id === input.value)) throw new Error('Invalid option answer');
    text(input.nextContextRevision,'nextContextRevision',200);
    if (input.nextContextRevision === run.contextRevision) throw new Error('Continuation requires a new context revision');
    const receipt: AnswerReceipt = { answerId: input.answerId,answerDigest: digest,binding: structuredClone(binding),continuationTaskId: input.taskId };
    ticket.state = 'answered'; ticket.notification = 'closed'; ticket.receipt = receipt;
    run.contextRevision = input.nextContextRevision; run.generation += 1; run.status = 'continuation_reserved';
    run.pending = { input: this.input(run,input.taskId,{ ticket,value: input.value }),phase: 'reserved' };
    this.write(run,row.revision,input.taskId); return structuredClone(receipt);
  }
  private close(run: ClarificationRun, status: 'cancelled'|'expired'|'obsolete'): void {
    run.status = status; run.reason = `host_${status}`;
    const ticket = run.tickets.at(-1);
    if (ticket?.state === 'open') { ticket.state = status; ticket.notification = 'closed'; }
  }
  async cancel(id: string, revision: number): Promise<HostSnapshot<ClarificationRun>> {
    const row = this.run(id); this.check(row,revision);
    if (row.value.status === 'complete') throw new Error('Run already complete');
    this.close(row.value,'cancelled'); const saved = this.write(row.value,revision);
    await this.cancelPending(saved.value); return this.run(id);
  }
  async changeContext(id: string, revision: number, nextRevision: string): Promise<HostSnapshot<ClarificationRun>> {
    const row = this.run(id); this.check(row,revision); text(nextRevision,'contextRevision',200);
    if (nextRevision === row.value.contextRevision || stopped(row.value)) throw new Error('Context cannot be changed');
    row.value.contextRevision = nextRevision; this.close(row.value,'obsolete');
    const saved = this.write(row.value,revision); await this.cancelPending(saved.value); return this.run(id);
  }
  async tick(id: string, revision: number): Promise<HostSnapshot<ClarificationRun>> {
    const row = this.run(id); this.check(row,revision);
    if (stopped(row.value)) { await this.cancelPending(row.value); return this.run(id); }
    const ticket = row.value.tickets.at(-1); const now = this.clock();
    if (now < row.value.deadline && !(row.value.status === 'waiting_input' && ticket && now >= ticket.expiresAt)) return row;
    this.close(row.value,'expired'); const saved = this.write(row.value,revision); await this.cancelPending(saved.value); return this.run(id);
  }
}
