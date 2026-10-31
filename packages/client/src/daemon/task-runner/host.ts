// The IO half of the #1099 TaskRunner reducer: one host per runner (kept in
// a WeakMap so `TaskRunner`'s private member surface stays byte-identical),
// one strict-FIFO mailbox per taskId, and the effect executor that lets the
// phase adapters keep their IO while the reducer owns the transition.
//
// S3 wired the offer/admission path; S4 wired claim/start/cancel; S5 wires
// the approval path. Effects whose IO still lives in the staged offer
// pipeline (and every S6 effect) are recorded as `legacy` and not executed
// here; the phase adapter performs them exactly as before.
import type { Envelope } from '@byok-sdk/protocol';
import {
  createRunnerState,
  reduce,
  type EffectEnvelope,
  type EffectKind,
  type ReducerEvent,
  type ReducerEventTemplate,
  type ReducerSnapshot,
  type ReduceResult,
  type RunnerStateV1,
  type TaskStateV1,
  type TerminalCause,
  type TerminalKind,
} from './state';
import type { TaskRunner } from '../task-runner';

/** Mutable per-offer facts the host keeps out of the serializable State. */
export interface HostOfferContext {
  /** Monotonic across the runner's lifetime; events from an older offer drop. */
  generation: number;
  /** Current admission stage, used by an `admission.declined` event. */
  stage: string;
  /** Agent identity for a `send.decline` effect; set once the offer names it. */
  agentRef?: unknown;
  /** #1103 typed cause for the next `send.decline` effect. */
  runtimeUnavailable?: unknown;
  /** The adapter-owned decline send. Called synchronously, exactly once. */
  sendDecline?: (effect: EffectEnvelope, context: HostOfferContext) => void;
  /**
   * S4: the adapter-owned `task.claim` send. The host runs it inside the
   * `claim.journaled -> send.claim -> claim.sent` atomic group, so no other
   * event can be reduced between the journal receipt and the claim commit.
   */
  sendClaim?: (effect: EffectEnvelope, context: HostOfferContext) => void;
}

/**
 * One in-flight `requestApproval` call: the side-table half the reducer must
 * not serialize (summary, abort signal, promise resolver, timeout handle).
 * The authoritative pending/queue shape lives in `TaskStateV1.approval`.
 */
export interface HostApprovalRequest {
  readonly taskId: string;
  readonly requestId: string;
  readonly summary: string;
  readonly kind: 'tool-authorization' | 'task-terminal';
  readonly resolve: (outcome: { readonly approved: boolean; readonly reason?: string }) => void;
  /** Set once the reducer dispatched this request (A1/A4). */
  approvalId?: string;
  /** Registry timeout handle; cleared by the `clear.timeout` effect. */
  timer?: ReturnType<typeof setTimeout>;
  /** Removes this request's abort listener once it settles. */
  detach?: () => void;
}

/**
 * One task's first terminal decision. The reducer picks kind/reason/retryable
 * synchronously at `terminal.requested` (first-terminal-wins); this side table
 * holds the IO half the reducer must not serialize — the envelope-building
 * closure and its cached bytes — plus the receipt every legacy caller awaits.
 */
export interface HostTerminalPlan {
  readonly kind: TerminalKind;
  readonly cause: TerminalCause;
  readonly reason?: string;
  readonly retryable?: boolean;
  /** Interrupt + evidence + exact envelope construction, as the legacy adapter ran it. */
  readonly prepare: () => Promise<Envelope>;
}

export interface HostTerminalIntent {
  readonly taskId: string;
  readonly plan: HostTerminalPlan;
  envelope?: Envelope;
  receipt?: Promise<boolean>;
  settle?: (ok: boolean) => void;
  reject?: (error: unknown) => void;
  settled: boolean;
  /** Result of the cleanup barrier, read by the T15 completion. */
  finishOk?: boolean;
}

/** The daemon-authored required-message body awaiting its disposition (S6). */
export interface HostMessageCompletion {
  readonly finalOutput: string;
  readonly document?: unknown;
  readonly failureReason?: string;
}

export interface HostEffectContext {
  readonly taskId: string | undefined;
  readonly event: ReducerEvent;
  readonly snapshot: ReducerSnapshot;
  /** Enqueue a completion event at the tail of this task's mailbox. */
  readonly enqueue: (event: ReducerEventTemplate) => void;
}

export interface HostEffectResult {
  /** Completion event appended at the mailbox tail after the barrier settles. */
  readonly completion?: ReducerEventTemplate;
}

/**
 * A handler may finish synchronously (return nothing) or be a barrier (return
 * a promise). A barrier's completion event is appended at the TAIL of the
 * mailbox, never ahead of an event that arrived while it was in flight.
 */
export type HostEffectHandler = (
  envelope: EffectEnvelope,
  context: HostEffectContext,
) => void | HostEffectResult | Promise<void | HostEffectResult>;

export interface HostAuditEntry {
  readonly taskId: string | undefined;
  readonly effectId: string;
  readonly kind: EffectKind;
  readonly mode: EffectEnvelope['mode'];
  readonly outcome: 'executed' | 'legacy' | 'skipped' | 'completion';
  readonly reason?: string;
}

interface QueuedEvent {
  readonly event: ReducerEvent;
  readonly resolve: (result: ReduceResult) => void;
  readonly reject: (error: unknown) => void;
}

interface Mailbox {
  readonly queue: QueuedEvent[];
  draining: boolean;
}

interface AppliedEvent {
  readonly result: ReduceResult;
  readonly pending?: Promise<void | HostEffectResult>;
}

const GLOBAL_MAILBOX = '\u0000runner';
const MAX_ARCHIVED_TASKS = 128;
const MAX_AUDIT_ENTRIES = 512;

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function';
}

function requiresAdmit(snapshot: ReducerSnapshot, envelope: EffectEnvelope): boolean {
  const requires = envelope.requires;
  if (requires === undefined || requires.alwaysRun === true) return true;
  const task = snapshot.task;
  if (requires.phase !== undefined) {
    if (task === undefined || !requires.phase.includes(task.phase)) return false;
  }
  if (requires.claim === 'required' && task?.claim.sent !== true) return false;
  if (requires.claim === 'forbidden' && task?.claim.sent === true) return false;
  if (requires.terminal === 'none' && task?.terminal !== undefined) return false;
  if (requires.terminal === 'selected' && task?.terminal === undefined) return false;
  if (requires.generation !== undefined && task?.generation !== requires.generation) return false;
  return true;
}

/**
 * Per-TaskRunner reducer host. One instance per runner, held by the module
 * WeakMap; the class is internal to the client package and is not exported
 * from any public entry.
 */
export class TaskRunnerHost {
  private runnerState: RunnerStateV1 = createRunnerState();
  private readonly tasks = new Map<string, TaskStateV1>();
  private readonly archived = new Map<string, TaskStateV1>();
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly offers = new Map<string, HostOfferContext>();
  private readonly approvalRequests = new Map<string, HostApprovalRequest>();
  private readonly terminalIntents = new Map<string, HostTerminalIntent>();
  private readonly messageCompletions = new Map<string, HostMessageCompletion>();
  private readonly handlers = new Map<EffectKind, HostEffectHandler>();
  private readonly audit: HostAuditEntry[] = [];
  private generation = 0;
  private approvalSequence = 0;

  constructor(_runner: TaskRunner) {}

  runnerSnapshot(): RunnerStateV1 {
    return this.runnerState;
  }

  snapshot(taskId: string): ReducerSnapshot {
    const task = this.tasks.get(taskId);
    return {
      runner: this.runnerState,
      ...(task === undefined ? {} : { task }),
    };
  }

  current(taskId: string): TaskStateV1 | undefined {
    return this.tasks.get(taskId);
  }

  archivedTask(taskId: string): TaskStateV1 | undefined {
    return this.archived.get(taskId);
  }

  offerContext(taskId: string): HostOfferContext | undefined {
    return this.offers.get(taskId);
  }

  auditLog(): readonly HostAuditEntry[] {
    return this.audit;
  }

  /** Registers an effect handler; returns the unregister function. */
  registerHandler(kind: EffectKind, handler: HostEffectHandler): () => void {
    this.handlers.set(kind, handler);
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  /**
   * Starts a new offer for `taskId` with a fresh generation. A retained entry
   * from an earlier delivery (ordinary declines are not deduped) is archived
   * first, so the reducer's O1 row always sees a fresh task.
   */
  beginOffer(
    taskId: string,
    options: { readonly stage?: string; readonly sendDecline?: HostOfferContext['sendDecline'] } = {},
  ): HostOfferContext {
    const previous = this.tasks.get(taskId);
    if (previous !== undefined) this.archive(taskId, previous);
    this.tasks.delete(taskId);
    this.generation += 1;
    const context: HostOfferContext = {
      generation: this.generation,
      stage: options.stage ?? 'receive',
      ...(options.sendDecline === undefined ? {} : { sendDecline: options.sendDecline }),
    };
    this.offers.set(taskId, context);
    return context;
  }

  setStage(taskId: string, stage: string): void {
    const context = this.offers.get(taskId);
    if (context !== undefined) context.stage = stage;
  }

  setAgentRef(taskId: string, agentRef: unknown): void {
    const context = this.offers.get(taskId);
    if (context !== undefined) context.agentRef = agentRef;
  }

  setRuntimeUnavailable(taskId: string, runtimeUnavailable: unknown): void {
    const context = this.offers.get(taskId);
    if (context !== undefined) context.runtimeUnavailable = runtimeUnavailable;
  }

  /** Installs the adapter-owned claim send for the current offer (S4). */
  setSendClaim(taskId: string, sendClaim: HostOfferContext['sendClaim']): void {
    const context = this.offers.get(taskId);
    if (context !== undefined) context.sendClaim = sendClaim;
  }

  /* ------------------------- S5 approval side table ------------------------ */

  /** Mints the reducer-only requestId for one `requestApproval` call. */
  nextApprovalRequestId(): string {
    this.approvalSequence += 1;
    return 'approval-' + String(this.approvalSequence);
  }

  beginApprovalRequest(request: HostApprovalRequest): void {
    this.approvalRequests.set(request.requestId, request);
  }

  approvalRequest(requestId: string): HostApprovalRequest | undefined {
    return this.approvalRequests.get(requestId);
  }

  approvalRequestByApprovalId(approvalId: string): HostApprovalRequest | undefined {
    for (const request of this.approvalRequests.values()) {
      if (request.approvalId === approvalId) return request;
    }
    return undefined;
  }

  /** Records the approvalId the reducer minted for an already-queued request. */
  setApprovalDispatched(requestId: string, approvalId: string): void {
    const request = this.approvalRequests.get(requestId);
    if (request !== undefined) request.approvalId = approvalId;
  }

  setApprovalTimer(approvalId: string, timer: ReturnType<typeof setTimeout>): void {
    const request = this.approvalRequestByApprovalId(approvalId);
    if (request !== undefined) request.timer = timer;
  }

  clearApprovalTimer(approvalId: string | undefined): void {
    if (approvalId === undefined) return;
    const request = this.approvalRequestByApprovalId(approvalId);
    if (request?.timer === undefined) return;
    clearTimeout(request.timer);
    request.timer = undefined;
  }

  /**
   * Settles one request exactly once: removes the side-table entry (and its
   * abort listener/timer) before resolving, so a re-entrant decision cannot
   * settle it twice.
   */
  settleApprovalRequest(requestId: string, outcome: { readonly approved: boolean; readonly reason?: string }): boolean {
    const request = this.approvalRequests.get(requestId);
    if (request === undefined) return false;
    request.detach?.();
    if (request.timer !== undefined) clearTimeout(request.timer);
    this.approvalRequests.delete(requestId);
    request.resolve(outcome);
    return true;
  }

  /* ------------------------- S6 terminal side table ----------------------- */

  /**
   * Registers the FIRST terminal plan for a task. The receipt is shared by every
   * competing caller; `winner` is true only for the caller that registered the
   * plan and therefore owns dispatching the selecting event. A retry after a
   * failed close/commit reuses the same plan and cached bytes but gets a fresh
   * receipt and settles the old one.
   */
  beginTerminalIntent(
    taskId: string,
    plan: HostTerminalPlan,
  ): { readonly intent: HostTerminalIntent; readonly receipt: Promise<boolean>; readonly winner: boolean } {
    const existing = this.terminalIntents.get(taskId);
    if (existing !== undefined) {
      if (!existing.settled && existing.receipt !== undefined) {
        return { intent: existing, receipt: existing.receipt, winner: false };
      }
      existing.receipt = this.newTerminalReceipt(existing);
      return { intent: existing, receipt: existing.receipt, winner: false };
    }
    const intent: HostTerminalIntent = { taskId, plan, settled: false };
    this.terminalIntents.set(taskId, intent);
    intent.receipt = this.newTerminalReceipt(intent);
    return { intent, receipt: intent.receipt, winner: true };
  }

  terminalIntent(taskId: string): HostTerminalIntent | undefined {
    return this.terminalIntents.get(taskId);
  }

  terminalReceipt(taskId: string): Promise<boolean> | undefined {
    return this.terminalIntents.get(taskId)?.receipt;
  }

  /** True once the current attempt settled (failed/complete); false while in flight. */
  terminalSettled(taskId: string): boolean | undefined {
    return this.terminalIntents.get(taskId)?.settled;
  }

  /** Fresh receipt for a close/commit retry; the plan and envelope bytes stay. */
  retryTerminal(taskId: string): Promise<boolean> | undefined {
    const intent = this.terminalIntents.get(taskId);
    if (intent === undefined) return undefined;
    if (!intent.settled && intent.receipt !== undefined) return intent.receipt;
    intent.receipt = this.newTerminalReceipt(intent);
    return intent.receipt;
  }

  /** Settles the current receipt exactly once; a stale second call is a no-op. */
  settleTerminal(taskId: string, ok: boolean): void {
    const intent = this.terminalIntents.get(taskId);
    if (intent === undefined || intent.settled) return;
    intent.settled = true;
    const settle = intent.settle;
    intent.settle = undefined;
    intent.reject = undefined;
    settle?.(ok);
  }

  rejectTerminal(taskId: string, error: unknown): void {
    const intent = this.terminalIntents.get(taskId);
    if (intent === undefined || intent.settled) return;
    intent.settled = true;
    const reject = intent.reject;
    intent.settle = undefined;
    intent.reject = undefined;
    reject?.(error);
  }

  private newTerminalReceipt(intent: HostTerminalIntent): Promise<boolean> {
    intent.settled = false;
    intent.finishOk = undefined;
    return new Promise<boolean>((resolve, reject) => {
      intent.settle = resolve;
      intent.reject = reject;
    });
  }

  /* ----------------------- S6 message completion gate --------------------- */

  setMessageCompletion(taskId: string, completion: HostMessageCompletion): void {
    this.messageCompletions.set(taskId, completion);
  }

  messageCompletion(taskId: string): HostMessageCompletion | undefined {
    return this.messageCompletions.get(taskId);
  }

  clearMessageCompletion(taskId: string): HostMessageCompletion | undefined {
    const completion = this.messageCompletions.get(taskId);
    this.messageCompletions.delete(taskId);
    return completion;
  }

  /** Ends an offer that never reached `active`; a retained state is archived. */
  endOffer(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task !== undefined) this.archive(taskId, task);
    this.tasks.delete(taskId);
    this.offers.delete(taskId);
    this.mailboxes.delete(taskId);
    this.dropApprovals(taskId, 'task is not currently active on this device');
    this.terminalIntents.delete(taskId);
    this.messageCompletions.delete(taskId);
  }

  /** Terminal cleanup: the per-task map is bounded even after a claimed task ends. */
  endTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task !== undefined) this.archive(taskId, task);
    this.tasks.delete(taskId);
    this.offers.delete(taskId);
    this.mailboxes.delete(taskId);
    this.dropApprovals(taskId, 'task is not currently active on this device');
    this.terminalIntents.delete(taskId);
    this.messageCompletions.delete(taskId);
  }

  /** Whether a barrier (or an atomic group) currently owns this task's mailbox. */
  isDraining(taskId: string | undefined): boolean {
    return this.mailboxes.get(taskId ?? GLOBAL_MAILBOX)?.draining === true;
  }

  /**
   * Dispatches one event through the task's mailbox. Same-task events are
   * reduced in enqueue order; a barrier completion is appended at the tail.
   */
  dispatch(event: ReducerEvent): Promise<ReduceResult> {
    const mailbox = this.mailboxFor(event.taskId);
    const normalized = this.normalize(event);
    return new Promise<ReduceResult>((resolve, reject) => {
      mailbox.queue.push({ event: normalized, resolve, reject });
      this.drain(mailbox);
    });
  }

  /**
   * Synchronous dispatch for atomic-only events (the offer/admission path).
   * Throws when the mailbox is behind an in-flight barrier: an atomic group
   * must never be interleaved with another event's effects.
   */
  dispatchSync(event: ReducerEvent): ReduceResult {
    const mailbox = this.mailboxFor(event.taskId);
    if (mailbox.draining) {
      throw new Error('TaskRunnerHost: synchronous dispatch cannot queue behind an in-flight barrier');
    }
    // Mark the mailbox busy for the whole atomic group: a dispatch from inside
    // an effect handler queues behind the group instead of re-entering it.
    mailbox.draining = true;
    let result: ReduceResult | undefined;
    try {
      const applied = this.applyEvent(this.normalize(event));
      if (applied.pending !== undefined) {
        throw new Error('TaskRunnerHost: synchronous dispatch produced a barrier effect');
      }
      result = applied.result;
    } finally {
      mailbox.draining = false;
    }
    if (mailbox.queue.length > 0) this.drain(mailbox);
    if (result === undefined) throw new Error('TaskRunnerHost: synchronous dispatch produced no result');
    return result;
  }

  private mailboxFor(taskId: string | undefined): Mailbox {
    const key = taskId ?? GLOBAL_MAILBOX;
    let mailbox = this.mailboxes.get(key);
    if (mailbox === undefined) {
      mailbox = { queue: [], draining: false };
      this.mailboxes.set(key, mailbox);
    }
    return mailbox;
  }

  private normalize(event: ReducerEvent): ReducerEvent {
    const context = event.taskId === undefined ? undefined : this.offers.get(event.taskId);
    const generation = event.generation ?? context?.generation;
    return Object.freeze({
      ...event,
      atMs: event.atMs ?? Date.now(),
      ...(generation === undefined ? {} : { generation }),
    });
  }

  private drain(mailbox: Mailbox): void {
    if (mailbox.draining) return;
    mailbox.draining = true;
    while (mailbox.queue.length > 0) {
      const queued = mailbox.queue[0]!;
      let applied: AppliedEvent;
      try {
        applied = this.applyEvent(queued.event);
      } catch (error) {
        mailbox.queue.shift();
        queued.reject(error);
        continue;
      }
      if (applied.pending === undefined) {
        mailbox.queue.shift();
        queued.resolve(applied.result);
        continue;
      }
      // The barrier is in flight. Later events stay queued behind it; the
      // barrier's completion goes to the tail, never ahead of them.
      mailbox.queue.shift();
      void applied.pending.then(
        (outcome) => {
          if (outcome?.completion !== undefined && queued.event.taskId !== undefined) {
            mailbox.queue.push(this.completionWaiter(queued.event.taskId, outcome.completion));
          }
          queued.resolve(applied.result);
          mailbox.draining = false;
          this.drain(mailbox);
        },
        (error) => {
          queued.reject(error);
          mailbox.draining = false;
          this.drain(mailbox);
        },
      );
      return;
    }
    mailbox.draining = false;
  }

  private completionWaiter(taskId: string, template: ReducerEventTemplate): QueuedEvent {
    const event = this.normalize({
      ...template,
      taskId,
      atMs: Date.now(),
    } as ReducerEvent);
    return {
      event,
      resolve: () => undefined,
      reject: (error) => {
        console.error('[byok/client] TaskRunnerHost completion event failed', error);
      },
    };
  }

  private applyEvent(event: ReducerEvent): AppliedEvent {
    const snapshot = this.snapshot(event.taskId ?? '');
    const result = reduce(snapshot, event);
    this.runnerState = result.runner;
    const taskId = event.taskId;
    if (result.task !== undefined) this.tasks.set(result.task.taskId, result.task);
    else if (taskId !== undefined && event.type === 'offer.sealed_declined') this.tasks.delete(taskId);
    if (taskId !== undefined) this.settleTerminalFromEvent(taskId, event, result);
    const pending = this.executeEffects(
      result.effects,
      event,
      { runner: result.runner, ...(result.task === undefined ? {} : { task: result.task }) },
    );
    return { result, ...(pending === undefined ? {} : { pending }) };
  }

  /**
   * Terminal receipts settle on the reducer's own completion events, never on
   * an adapter callback: T15 is the single finish authority, and a failed
   * close/commit settles false so `retry.finalization` can retry that barrier
   * with the same token and bytes.
   */
  private settleTerminalFromEvent(taskId: string, event: ReducerEvent, result: ReduceResult): void {
    if (event.type === 'finish.completed') {
      const intent = this.terminalIntents.get(taskId);
      this.settleTerminal(taskId, intent?.finishOk !== false);
      this.terminalIntents.delete(taskId);
      this.endTask(taskId);
      return;
    }
    if ((event.type === 'terminal.close' || event.type === 'terminal.commit') && event.ok === false) {
      this.settleTerminal(taskId, false);
    }
    if (result.task === undefined && (event.type === 'terminal.requested' || event.type === 'cancel.received')) {
      // A selecting event that never reached a terminal row must not strand
      // the caller's receipt.
      const intent = this.terminalIntents.get(taskId);
      if (intent !== undefined && intent.settled === false && result.disposition === 'dropped') {
        this.settleTerminal(taskId, true);
      }
    }
  }

  private executeEffects(
    effects: readonly EffectEnvelope[],
    event: ReducerEvent,
    snapshot: ReducerSnapshot,
  ): Promise<void | HostEffectResult> | undefined {
    for (const envelope of effects) {
      if (!requiresAdmit(snapshot, envelope)) {
        this.record(envelope, 'skipped', 'requires');
        continue;
      }
      const pending = this.executeEffect(envelope, event, snapshot);
      if (pending !== undefined) return pending;
    }
    return undefined;
  }

  private executeEffect(
    envelope: EffectEnvelope,
    event: ReducerEvent,
    snapshot: ReducerSnapshot,
  ): Promise<void | HostEffectResult> | undefined {
    const taskId = envelope.effect.taskId ?? event.taskId;
    const context: HostEffectContext = {
      taskId,
      event,
      snapshot,
      enqueue: (template) => {
        if (taskId === undefined) return;
        const mailbox = this.mailboxFor(taskId);
        mailbox.queue.push(this.completionWaiter(taskId, template));
        this.drain(mailbox);
      },
    };
    if (envelope.effect.kind === 'send.decline') {
      const offer = taskId === undefined ? undefined : this.offers.get(taskId);
      if (offer?.sendDecline !== undefined) {
        offer.sendDecline(envelope, offer);
        this.record(envelope, 'executed');
        return this.completeAtomically(envelope, taskId);
      }
    }
    if (envelope.effect.kind === 'send.claim') {
      const offer = taskId === undefined ? undefined : this.offers.get(taskId);
      if (offer?.sendClaim !== undefined) {
        // The claim is the first external commitment: the send happens before
        // the atomic `claim.sent` completion, and a throwing send leaves the
        // state journaled-but-unsent exactly like the legacy path did.
        offer.sendClaim(envelope, offer);
        this.record(envelope, 'executed');
        return this.completeAtomically(envelope, taskId);
      }
    }
    if (envelope.effect.kind === 'audit' || envelope.effect.kind === 'log') {
      this.record(envelope, 'executed');
      return this.completeAtomically(envelope, taskId);
    }
    const handler = this.handlers.get(envelope.effect.kind);
    if (handler === undefined) {
      // S3 keeps the staged offer IO in the phase adapters. Anything not
      // registered here is executed by that adapter, in the original order.
      this.record(envelope, 'legacy');
      return undefined;
    }
    let outcome: void | HostEffectResult | Promise<void | HostEffectResult>;
    try {
      outcome = handler(envelope, context);
    } catch (error) {
      this.record(envelope, 'skipped', 'handler-threw');
      throw error;
    }
    this.record(envelope, 'executed');
    if (!isPromise(outcome)) {
      // A synchronous handler may supply its own completion (S5 mints the
      // next approvalId for `dispatch.next_approval` this way); the atomic
      // group still reduces it inside this same turn. A completion that itself
      // opens a barrier (T7 -> T9 -> await.close) hands that barrier back to
      // the mailbox instead of re-entering the drain recursively.
      return this.completeAtomically(envelope, taskId, outcome?.completion);
    }
    // A barrier completion goes to the mailbox tail; an envelope completion
    // is the same contract for a barrier that declares one.
    const declared = envelope.completion === undefined
      ? undefined
      : envelope.effect.token !== undefined && envelope.completion.token === undefined
        ? { ...envelope.completion, token: envelope.effect.token }
        : envelope.completion;
    return outcome.then((result) => {
      if (result?.completion !== undefined) return result;
      return declared === undefined ? result : { completion: declared };
    });
  }

  /**
   * Executes a synchronous effect's completion event inside the SAME atomic
   * group: no other mailbox event can be reduced between the effect and its
   * completion, and the completion's own effects stay in this turn.
   */
  private completeAtomically(
    envelope: EffectEnvelope,
    taskId: string | undefined,
    override?: ReducerEventTemplate,
  ): Promise<void | HostEffectResult> | undefined {
    const declared = override ?? envelope.completion;
    if (declared === undefined) return undefined;
    const template = envelope.effect.token !== undefined && declared.token === undefined
      ? { ...declared, token: envelope.effect.token }
      : declared;
    const event = this.normalize({
      ...template,
      ...(taskId === undefined ? {} : { taskId }),
      atMs: Date.now(),
    } as ReducerEvent);
    const applied = this.applyEvent(event);
    this.audit.push({
      taskId: envelope.effect.taskId,
      effectId: envelope.id,
      kind: envelope.effect.kind,
      mode: envelope.mode,
      outcome: 'completion',
    });
    return applied.pending;
  }

  /**
   * A task that ends with approval requests still tracked here (only possible
   * on a path that skipped `finish`) still settles every caller fail-closed:
   * an unresolved `requestApproval` promise would otherwise hang forever.
   */
  private dropApprovals(taskId: string, reason: string): void {
    for (const [requestId, request] of this.approvalRequests) {
      if (request.taskId !== taskId) continue;
      request.detach?.();
      if (request.timer !== undefined) clearTimeout(request.timer);
      this.approvalRequests.delete(requestId);
      request.resolve({ approved: false, reason });
    }
  }

  private archive(taskId: string, task: TaskStateV1): void {
    this.archived.delete(taskId);
    this.archived.set(taskId, task);
    if (this.archived.size > MAX_ARCHIVED_TASKS) {
      const oldest = this.archived.keys().next().value;
      if (oldest !== undefined) this.archived.delete(oldest);
    }
  }

  private record(
    envelope: EffectEnvelope,
    outcome: HostAuditEntry['outcome'],
    reason?: string,
  ): void {
    this.audit.push({
      taskId: envelope.effect.taskId,
      effectId: envelope.id,
      kind: envelope.effect.kind,
      mode: envelope.mode,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
    if (this.audit.length > MAX_AUDIT_ENTRIES) this.audit.splice(0, this.audit.length - MAX_AUDIT_ENTRIES);
  }
}

const hosts = new WeakMap<TaskRunner, TaskRunnerHost>();

/** The one host for a runner; S3 never adds a TaskRunner private member. */
export function hostFor(runner: TaskRunner): TaskRunnerHost {
  let host = hosts.get(runner);
  if (host === undefined) {
    host = new TaskRunnerHost(runner);
    hosts.set(runner, host);
  }
  return host;
}

/** Test seam: drops the host so a WeakMap entry cannot outlive a fixture. */
export function forgetHost(runner: TaskRunner): void {
  hosts.delete(runner);
}
