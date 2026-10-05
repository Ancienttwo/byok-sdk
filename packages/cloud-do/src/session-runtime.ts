import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import type { JsonObject } from '@earendil-works/pi-ai';
import { Harness, ToolTask, createRegistry, defineExtension, hook, type AgentChange, type ConversationId, type ToolExecutionApi, type ToolExecutionResult, type Storage, type Cursor } from '@earendil-works/pi-durable';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import { CloudDoError, safeCloudError, type CloudDoErrorCode } from './errors';
import { admitCloudPayload, prepareCloudGuard, type CloudOperationGuard } from './input-guard';
import { CloudState, CLOUD_CONTEXT_BYTES, runInputSeqs, type RunRow } from './cloud-state';
import { InvocationLedger, type ExecutionRow, type InvocationRow, type InvocationTerminalState } from './invocation-ledger';
import { createPlatformModels, type CloudModelAccount } from './platform-provider';
import { PLATFORM_PROFILES, platformCredentialReader, type PlatformProfileId } from './platform-credentials';
import { CLOUD_BUDGET, CLOUD_LIMITS, admitSessionConfig, type CloudSessionConfig } from './session-config';
import { openDurableObjectStorage } from './storage';
import { admitCloudDispatcher, dispatcherDigest, CLOUD_DOMAIN_ERROR_CODES, argsDigest, canonicalArgs, invocationId, replayForTool, type CloudToolDispatcher } from './tools';

export const CLOUD_HARNESS_SETTINGS = {
  compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 }, stream: { maxRetries: 0 },
} as const;

class StaleInvocationAttempt extends CloudDoError {
  constructor() { super('CLOUD_EXECUTION_INTERRUPTED'); }
}

export interface ExecutionLease {
  conversationId?: number;
  trigger?: 'submit' | 'wake';
  readonly profile: PlatformProfileId;
  readonly deadlineAt: number;
  readonly controller: AbortController;
  connected: boolean;
  timer?: ReturnType<typeof setTimeout>;
  guard?: CloudOperationGuard;
  liveOwner: boolean;
  settled: boolean;
}

export interface CloudRenewRequest {
  nativeRunId: number;
  requestId: string | null;
  kind: 'model' | 'tool';
  toolName?: string;
  recovery: boolean;
}
export type CloudRenewResult = { ok: true } | { ok: false; code: CloudDoErrorCode };
export interface CloudRunSettlement {
  nativeRunId: number;
  requestId: string | null;
  trigger: RunRow['trigger'];
  state: 'completed' | 'failed' | 'interrupted';
  errorCode: CloudDoErrorCode | null;
  reservation: RunRow['reservation'];
  admissionDigest: string | null;
  admittedSeqs: readonly number[];
  claimedSeqs: readonly number[];
  usage: Readonly<{ steps: number; sentRequests: number; inputTokens: number; outputTokens: number; credits: number }>;
}

async function raceSignal<T>(work: Promise<T>, signal: AbortSignal, code: () => CloudDoErrorCode): Promise<T> {
  let remove = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new CloudDoError(code()));
    signal.addEventListener('abort', abort, { once: true });
    remove = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { remove(); }
}

/** Bound consumer work even when it ignores the supplied signal. */
export function raceLease<T>(work: Promise<T>, lease: ExecutionLease): Promise<T> {
  return raceSignal(work, lease.controller.signal,
    () => Date.now() >= lease.deadlineAt ? 'CLOUD_EXECUTION_TIMEOUT' : 'CLOUD_EXECUTION_ABORTED');
}

export interface RuntimeOptions {
  createDispatcher(id: string): CloudToolDispatcher | undefined;
  projectInvocation?(row: InvocationRow): { key: string; dataJson: string } | undefined;
  onCommit?(): void;
  onInvocationSettled?(id: string, state: InvocationTerminalState): void | Promise<void>;
  instructions?(profile: PlatformProfileId): string | undefined;
  renew?(request: CloudRenewRequest, signal: AbortSignal): CloudRenewResult | Promise<CloudRenewResult>;
  settleRun?(run: CloudRunSettlement, signal: AbortSignal): void | Promise<void>;
}

export interface RunOutcome {
  state: 'completed' | 'failed' | 'interrupted';
  errorCode?: CloudDoErrorCode;
  text?: string;
  entryId?: number;
  requeue?: boolean;
}

/** One physical DO owns this runtime. Native pi owns all model and task scheduling. */
export class SessionRuntime {
  readonly ledger: InvocationLedger;
  readonly cloud: CloudState;
  #piStorage?: Storage;
  #recoveryGuard?: CloudOperationGuard;
  #repairRetrying = false;
  #repairing = false;
  #settlementFlights = new Map<number, Promise<void>>();
  #initializing = false;
  #deferredSettlements: InvocationRow[] = [];
  #opened?: Promise<Harness>;
  #recovery?: Promise<void>;
  #recovered = false;
  #config?: CloudSessionConfig;
  #dispatcher?: CloudToolDispatcher;
  #bootstrapFailure?: CloudDoErrorCode;
  #stale = new Set<number>();
  #active?: ExecutionLease;
  #inline = 0;
  #invocations = new Map<string, Promise<Record<string, unknown>>>();
  #fatalDispositions = new Map<number, CloudDoErrorCode>();

  constructor(private readonly state: DurableObjectState, private readonly env: Readonly<Record<string, unknown>>,
    private readonly options: RuntimeOptions) {
    this.cloud = new CloudState(state.storage);
    this.ledger = new InvocationLedger(state.storage, {
      started: (row, guard) => {
        this.cloud.appendEvent({ eventKey: `tool:${row.invocationId}:started`, type: 'tool.started', conversationId: row.conversationId,
          ref: row.invocationId, data: { invocationId: row.invocationId, toolName: row.toolName, state: row.state } }, guard ?? this.#guard());
      },
      startedCommitted: () => this.#doorbell(),
      terminal: (row, recovery) => {
        const guard = this.#guard();
        const event = this.cloud.appendEvent({ eventKey: `tool:${row.invocationId}:settled`, type: 'tool.settled', conversationId: row.conversationId,
          ref: row.invocationId, data: { invocationId: row.invocationId, state: row.state, errorCode: row.errorCode, late: recovery } }, guard);
        row.settledAt = event.createdAt;
        row.settledEventSeq = event.seq;
        this.cloud.projectInvocation(row, this.options.projectInvocation, guard);
        return event;
      },
      committed: row => {
        if (this.#initializing) this.#deferredSettlements.push(row);
        else this.#notifyCommitted(row);
      },
    });
  }

  get recovering(): boolean { return !this.#recovered; }
  get activeLease(): ExecutionLease | undefined { return this.#active; }
  get hasLiveOwner(): boolean { return this.#active?.liveOwner === true; }
  get busy(): boolean { return this.#active !== undefined || this.#repairing; }
  get repairRetrying(): boolean { return this.#repairRetrying; }
  #schedulingBusy(): boolean { return this.hasLiveOwner || this.#repairing; }
  #clearSettlementRetry(): void {
    if (!this.#repairing && (!this.#active || this.hasLiveOwner)) this.#repairRetrying = false;
  }
  prepareGuard(profile?: PlatformProfileId): Promise<CloudOperationGuard> { return prepareCloudGuard(this.env, profile); }
  #guard(): CloudOperationGuard {
    const guard = this.#active?.guard ?? this.#recoveryGuard;
    if (!guard) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    return guard;
  }
  #doorbell(): void { try { this.options.onCommit?.(); } catch { /* Doorbells are advisory. */ } }
  #notifyCommitted(row: InvocationRow): void {
    this.#doorbell();
    // A post-commit hook never enters an execution's catch path.
    void Promise.resolve().then(() => this.options.onInvocationSettled?.(row.invocationId, row.state as InvocationTerminalState)).catch(() => undefined);
  }
  #flushSettlements(): void {
    this.#initializing = false;
    for (const row of this.#deferredSettlements.splice(0)) this.#notifyCommitted(row);
  }

  /** Binding/RPC callers authorize the session before calling this immutable configuration operation. */
  async configure(input: unknown): Promise<void> {
    const config = admitSessionConfig(input);
    await admitCloudPayload(this.env, config);
    const candidate = this.options.createDispatcher(config.dispatcherId);
    if (!candidate) throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
    const dispatcher = admitCloudDispatcher(candidate);
    await this.#guardToolMetadata(dispatcher);
    const policyDigest = await dispatcherDigest(dispatcher);
    this.#sessionSchema();
    this.state.storage.transactionSync(() => {
      const existing = this.#storedConfig();
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(config) || this.#storedDispatcherDigest() !== policyDigest) throw new CloudDoError('CLOUD_SESSION_CONFLICT');
        return;
      }
      if (this.#opened) throw new CloudDoError('CLOUD_SESSION_CONFLICT');
      this.state.storage.sql.exec('UPDATE cloud_session SET configJson=?,dispatcherDigest=? WHERE id=1', JSON.stringify(config), policyDigest);
    });
  }

  open(selected?: PlatformProfileId): Promise<Harness> {
    if (!this.#opened) {
      // Credential reads must finish before entering the bounded initialization gate.
      const initialized = prepareCloudGuard(this.env, selected).then(guard => {
        this.#recoveryGuard = guard;
        this.#initializing = true;
        return this.state.blockConcurrencyWhile(async () => {
          this.ledger.ensureSchema();
          this.cloud.ensureSchema();
          this.#sessionSchema();
          this.#config = this.#storedConfig();
          if (!this.#config && this.ledger.pending().length) this.#bootstrapFailure = 'CLOUD_TOOL_NOT_AVAILABLE';
          if (this.#config) {
            this.#config = admitSessionConfig(this.#config);
            const candidate = this.options.createDispatcher(this.#config.dispatcherId);
            if (!candidate) this.#bootstrapFailure = 'CLOUD_TOOL_NOT_AVAILABLE';
            else {
              const dispatcher = admitCloudDispatcher(candidate);
              const metadata = dispatcher.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
              guard.guardPayload(JSON.stringify(metadata));
              if (await dispatcherDigest(dispatcher) !== this.#storedDispatcherDigest()) this.#bootstrapFailure = 'CLOUD_SESSION_CONFLICT';
              else this.#dispatcher = dispatcher;
            }
          }
          const registry = createRegistry();
          const tools = this.#dispatcher?.tools.map(tool => ({ name: tool.name, description: tool.description,
            parameters: tool.parameters, replay: 'unsafe' as const,
            outputLimits: { maxBytes: CLOUD_LIMITS.resultBytes, maxLines: CLOUD_LIMITS.resultBytes },
            execute: (args: Record<string, unknown>, api: ToolExecutionApi, context: Context) => this.#execute(tool.name, args, api, context),
          })) ?? [];
          registry.install(defineExtension({ name: 'cloud-session-tools', tools,
            hooks: [hook(ToolTask, { beforeTool: async (_call, api) => {
              if (this.#stale.has(api.conversationId)) return { block: 'CLOUD_EXECUTION_INTERRUPTED' };
              try { this.ledger.countTool(api.conversationId, String(api.taskId), this.#limits().toolCalls); }
              catch (error) {
                const code = safeCloudError(error).code;
                this.#recordFatal(api.conversationId, code);
                return { block: code };
              }
            } })],
          }));
          this.#piStorage = await openDurableObjectStorage(this.state.storage);
          const harness = await Harness.open(this.#piStorage, {
            models: createPlatformModels(this.env, platformCredentialReader(this.env), {
              beforeRequest: info => this.#beforeRequest(info),
              admitToolCall: async (name, id, args) => {
                try { await admitCloudPayload(this.env, { name, id, args }, this.#active?.profile); }
                catch (error) {
                  if (error instanceof CloudDoError && error.code === 'CLOUD_USER_CREDENTIAL_REJECTED') {
                    throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
                  }
                  throw error;
                }
                const tool = this.#dispatcher?.tools.find(tool => tool.name === name);
                if (!tool) throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
                try { validateToolArguments(tool, { type: 'toolCall', id, name, arguments: args as JsonObject }); }
                catch { throw new CloudDoError('CLOUD_TOOL_ARGUMENT_INVALID'); }
              },
              requestSignal: signal => this.#requestSignal(signal),
            }), registry, settings: CLOUD_HARNESS_SETTINGS,
          }, BACKGROUND_CONTEXT);
          const inspection = await harness.inspect(BACKGROUND_CONTEXT);
          this.#stale = new Set([...inspection.tasks.map(task => task.record.conversationId),
            ...inspection.submissions.map(submission => submission.conversationId)]);
          this.state.storage.sql.exec('UPDATE cloud_session SET staleJson=? WHERE id=1', JSON.stringify([...this.#stale]));
          this.cloud.captureEligibility(this.#stale);
          const replay = this.ledger.claimRecovery();
          await this.cloud.rearmAlarm({ busy: false, repairRetrying: false });
          return { harness, replay };

        });
      });
      // This continuation runs after the initialization input gate was released.
      this.#opened = initialized.then(({ harness, replay }) => {
        this.#flushSettlements();
        this.#recovery = this.#recover(harness, replay).finally(() => {
          this.#recoveryGuard?.dispose();
          this.#recoveryGuard = undefined;
        });
        void this.#recovery.catch(() => undefined);
        return harness;
      }, error => {
        this.#flushSettlements();
        this.#recoveryGuard?.dispose();
        this.#recoveryGuard = undefined;
        throw error;
      });
    }
    return this.#opened;
  }

  async ready(selected?: PlatformProfileId): Promise<Harness> {
    const harness = await this.open(selected);
    await this.#recovery;
    return harness;
  }

  agentChange(profile: PlatformProfileId, guard: CloudOperationGuard): AgentChange {
    const model = { provider: profile, modelId: PLATFORM_PROFILES[profile].model };
    try {
      const text = this.options.instructions?.(profile);
      if (text === undefined) return { model };
      if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > CLOUD_CONTEXT_BYTES) {
        throw new CloudDoError('CLOUD_REQUEST_INVALID');
      }
      guard.guardText(text);
      return { model, instructions: text };
    } catch { throw new CloudDoError('CLOUD_REQUEST_INVALID'); }
  }

  reserve(profile: PlatformProfileId, guard?: CloudOperationGuard): ExecutionLease {
    if (!this.#recovered) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    if (this.#bootstrapFailure) throw new CloudDoError(this.#bootstrapFailure);
    if (this.#active) throw new CloudDoError('CLOUD_TOOL_BUSY');
    if (this.#repairing) throw new CloudDoError('CLOUD_TOOL_BUSY');
    const lease: ExecutionLease = { profile, deadlineAt: Date.now() + this.#limits().turnTimeoutMs,
      controller: new AbortController(), connected: true, liveOwner: true, settled: false, guard };
    this.#active = lease;
    this.cloud.setSchedulingState({ busy: true, repairRetrying: this.#repairRetrying });
    return lease;
  }

  attach(lease: ExecutionLease, conversationId: number, trigger: 'submit' | 'wake' = 'submit', guard = lease.guard): void {
    if (this.#active !== lease || lease.conversationId !== undefined) throw new CloudDoError('CLOUD_TOOL_BUSY');
    lease.conversationId = conversationId;
    lease.trigger = trigger;
    lease.guard = guard;
    if (!lease.guard) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    this.cloud.startRun(conversationId, trigger, lease.deadlineAt, lease.guard);
    if (trigger === 'submit') this.cloud.markRunning(conversationId, lease.guard);
    lease.timer = setTimeout(() => {
      if (this.#active !== lease || lease.settled) return;
      this.#recordFatal(conversationId, 'CLOUD_EXECUTION_TIMEOUT');
      lease.controller.abort();
    }, Math.max(0, lease.deadlineAt - Date.now()));
    this.#doorbell();
  }

  cancel(lease: ExecutionLease, code: CloudDoErrorCode = 'CLOUD_EXECUTION_ABORTED'): void {
    if (this.#active !== lease || lease.settled) return;
    if (lease.conversationId !== undefined) {
      const row = this.cloud.run(lease.conversationId);
      if (row && row.state !== 'starting' && row.state !== 'running') return;
    }
    lease.connected = false;
    if (lease.conversationId !== undefined) {
      this.#recordFatal(lease.conversationId, code);
      try { this.ledger.abortExecution(lease.conversationId, code); }
      catch { /* The in-memory disposition still closes the transport if storage fails. */ }
    }
    lease.controller.abort();
  }

  async release(lease: ExecutionLease, retryCount = 0): Promise<void> {
    clearTimeout(lease.timer);
    lease.liveOwner = false;
    if (this.#active !== lease) return;
    try {
      const run = lease.conversationId === undefined ? undefined : this.cloud.run(lease.conversationId);
      if (run?.state === 'running') {
        // A wake already owns an alarm generation. A submit needs its first repair alarm.
        this.#repairRetrying = lease.trigger === 'wake';
        await this.cloud.rearmAlarm({ busy: false, repairRetrying: this.#repairRetrying });
        return;
      }
      if (run?.state === 'starting') {
        this.cloud.settleRun(run.conversationId, { state: 'interrupted', errorCode: this.fatal(run.conversationId) ?? 'CLOUD_WAKE_EMPTY' }, this.#guard());
        this.#doorbell();
      }
      // Consumer settlement owns no execution lease. A later run may start now.
      this.#active = undefined;
      try {
        await this.#deliverSettlements(lease.guard);
        this.#clearSettlementRetry();
      }
      catch (error) {
        if (lease.trigger === 'wake') {
          this.#repairRetrying = retryCount < 6;
          this.cloud.setSchedulingState({ busy: this.#schedulingBusy(), repairRetrying: this.#repairRetrying });
          throw error;
        }
        // Keep an existing retry generation. A submit without one creates its first alarm.
      }
      await this.cloud.rearmAlarm({ busy: this.#schedulingBusy(), repairRetrying: this.#repairRetrying });
    } catch (error) {
      if (this.#active === lease) {
        this.#repairRetrying = lease.trigger === 'wake';
        this.cloud.setSchedulingState({ busy: false, repairRetrying: this.#repairRetrying });
        // A failed submit has no platform retry generation to protect.
        if (!this.#repairRetrying) await this.cloud.rearmAlarm({ busy: false, repairRetrying: false });
      }
      throw error;
    } finally {
      lease.guard?.dispose();
      lease.guard = undefined;
    }
  }

  recordSubmission(conversationId: number, submissionId: number): void {
    this.cloud.recordSubmission(conversationId, submissionId);
  }
  markReservation(conversationId: number, reservation: 'pending' | 'held' | 'none', admission?: { digest: string; seqs: number[] }): void {
    this.cloud.markReservation(conversationId, reservation, this.#guard(), Date.now(), admission);
    this.#doorbell();
  }
  claimWake(lease: ExecutionLease, seqs: readonly number[], profile = lease.profile) {
    if (this.#active !== lease || lease.conversationId === undefined || !lease.liveOwner) throw new CloudDoError('CLOUD_TOOL_BUSY');
    const claimed = this.cloud.claim(lease.conversationId, [...seqs], profile, this.#guard());
    this.#doorbell();
    return claimed;
  }
  async settle(lease: ExecutionLease, outcome: RunOutcome): Promise<void> {
    if (this.#active !== lease || lease.conversationId === undefined) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    const delivery = await this.#deliveryEvidence(await this.#opened!, lease.conversationId, outcome.state === 'completed');
    this.state.storage.transactionSync(() => {
      const fatal = this.fatal(lease.conversationId!)
        ?? (lease.controller.signal.aborted ? 'CLOUD_EXECUTION_ABORTED' : Date.now() >= lease.deadlineAt ? 'CLOUD_EXECUTION_TIMEOUT' : undefined);
      const finalOutcome = outcome.state === 'completed' && fatal ? { state: 'failed' as const, errorCode: fatal } : outcome;
      const stored = this.cloud.settleRun(lease.conversationId!, finalOutcome, this.#guard());
      for (const link of delivery) this.cloud.setDelivery(link.invocationId,
        stored?.state === 'completed' ? link.state : 'undelivered',
        stored?.state === 'completed' ? link.taskId : null,
        stored?.state === 'completed' ? link.entryId : null, this.#guard());
    });
    lease.settled = true;
    clearTimeout(lease.timer);
    this.#doorbell();
  }
  cancelActive(code: CloudDoErrorCode = 'CLOUD_EXECUTION_ABORTED'): boolean {
    if (!this.#active || this.#active.settled) return false;
    this.cancel(this.#active, code);
    return true;
  }
  /** Only an owner that exited may be repaired. A live provider run is never adjudicated here. */
  async repairPendingRuns(retryCount = 0): Promise<boolean> {
    if (this.hasLiveOwner || this.#repairing) return false;
    const runs = this.cloud.unsettledRuns();
    if (!runs.length) {
      if (this.#repairRetrying && !this.cloud.unackedRuns().length) {
        this.#repairRetrying = false;
        await this.cloud.rearmAlarm({ busy: this.busy, repairRetrying: false });
      }
      return false;
    }
    this.#repairing = true;
    this.#repairRetrying = true;
    this.cloud.setSchedulingState({ busy: true, repairRetrying: true });
    let guard: CloudOperationGuard | undefined;
    const previousGuard = this.#active?.guard;
    try {
      guard = await this.prepareGuard();
      this.#recoveryGuard = guard;
      if (this.#active) this.#active.guard = guard;
      const harness = await this.#opened!;
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      const live = new Set<number>([...inspection.tasks.map(task => task.record.conversationId), ...inspection.submissions.map(submission => submission.conversationId)]);
      this.cloud.captureEligibility(live);
      for (const run of runs) {
        const id = run.conversationId;
        if (!live.has(id as ConversationId)) continue;
        this.#stale.add(id);
        this.#recordFatal(id, 'CLOUD_EXECUTION_INTERRUPTED');
        const conversation = await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
        if (conversation) { await conversation.abort(BACKGROUND_CONTEXT, { background: true }); await conversation.waitForIdle(BACKGROUND_CONTEXT); }
      }
      await this.#adjudicateRuns(harness);
      clearTimeout(this.#active?.timer);
      this.#active = undefined;
      this.#repairRetrying = this.cloud.unackedRuns().length > 0;
      await this.cloud.rearmAlarm({ busy: false, repairRetrying: this.#repairRetrying });
      return true;
    } catch (error) {
      // The platform's count belongs to this alarm generation. No SDK retry counter or timer.
      this.#repairRetrying = retryCount < 6;
      this.cloud.setSchedulingState({ busy: false, repairRetrying: this.#repairRetrying });
      throw error;
    } finally {
      this.#repairing = false;
      guard?.dispose();
      previousGuard?.dispose();
      this.#recoveryGuard = undefined;
      if (this.#active) this.#active.guard = undefined;
    }
  }

  async deliverSettlementsForAlarm(retryCount = 0, providedGuard?: CloudOperationGuard): Promise<void> {
    let ownGuard: CloudOperationGuard | undefined;
    try {
      if (this.cloud.unackedRuns().length) {
        const guard = providedGuard ?? (ownGuard = await this.prepareGuard());
        await this.#deliverSettlements(guard);
      }
      this.#clearSettlementRetry();
      await this.cloud.rearmAlarm({ busy: this.#schedulingBusy(), repairRetrying: this.#repairRetrying });
    } catch (error) {
      this.#repairRetrying = retryCount < 6;
      this.cloud.setSchedulingState({ busy: this.#schedulingBusy(), repairRetrying: this.#repairRetrying });
      throw safeCloudError(error);
    } finally { ownGuard?.dispose(); }
  }

  async #deliverSettlements(guard?: CloudOperationGuard): Promise<void> {
    const rows = this.cloud.unackedRuns();
    if (!rows.length) return;
    if (!guard) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    const jobs = rows.map(row => {
      const previous = this.#settlementFlights.get(row.conversationId);
      if (previous) return previous;
      const job = this.#deliverSettlement(row, guard).finally(() => this.#settlementFlights.delete(row.conversationId));
      this.#settlementFlights.set(row.conversationId, job);
      return job;
    });
    // Every run is tried. All hook deadlines run together, so a batch does not wait N times 60 s.
    const results = await Promise.allSettled(jobs);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw safeCloudError(failures[0]!.reason);
  }

  async #deliverSettlement(row: RunRow, guard: CloudOperationGuard): Promise<void> {
    if (this.cloud.readRun(row.conversationId)?.settlementAck !== 0) return;
    const input: CloudRunSettlement = Object.freeze({
      nativeRunId: row.conversationId, requestId: row.requestId, trigger: row.trigger,
      state: row.state as CloudRunSettlement['state'], errorCode: row.errorCode,
      reservation: row.reservation, admissionDigest: row.admissionDigest,
      admittedSeqs: Object.freeze(JSON.parse(row.admittedSeqs ?? '[]') as number[]),
      claimedSeqs: Object.freeze(this.cloud.claimedSeqs(row.conversationId)),
      usage: Object.freeze({ steps: row.steps, sentRequests: row.sentRequests,
        inputTokens: row.inputTokens, outputTokens: row.outputTokens, credits: row.credits }),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUD_LIMITS.callTimeoutMs);
    try {
      await raceSignal(Promise.resolve().then(() => this.options.settleRun?.(input, controller.signal)),
        controller.signal, () => 'CLOUD_EXECUTION_TIMEOUT');
      if (this.cloud.ackSettlement(row.conversationId, guard)) this.#doorbell();
    } catch (error) { throw safeCloudError(error); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  async #adjudicateRuns(harness: Harness): Promise<void> {
    for (const run of this.cloud.unsettledRuns()) {
      const eligibility = JSON.parse(run.eligibilityJson ?? JSON.stringify({ steps: run.steps, aborted: run.aborted, fatalCode: run.fatalCode })) as Pick<ExecutionRow, 'steps' | 'aborted' | 'fatalCode'> & { wasStale?: boolean };
      const aborted = eligibility.aborted || run.aborted;
      let outcome: RunOutcome;
      const submission = run.requestId ? await this.#piStorage!.submissionByRequest(run.conversationId as ConversationId, run.requestId, BACKGROUND_CONTEXT) : undefined;
      if (run.state === 'starting') outcome = { state: 'interrupted', errorCode: 'CLOUD_WAKE_EMPTY' };
      else if (!aborted && !eligibility.fatalCode && submission?.status === 'done') {
        const conversation = await harness.conversation(run.conversationId as ConversationId, BACKGROUND_CONTEXT);
        const context = conversation ? await conversation.context(BACKGROUND_CONTEXT) : undefined;
        const final = context ? [...context.entries].reverse().find(entry => entry.kind === 'pi.assistant' && entry.model?.some(message => message.role === 'assistant' && message.stopReason !== 'toolUse')) : undefined;
        const message = final?.model?.find(message => message.role === 'assistant' && message.stopReason !== 'toolUse');
        const text = message?.role === 'assistant' ? message.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
        outcome = { state: 'completed', text, entryId: final?.id };
      } else if (!aborted && !eligibility.fatalCode && submission?.status === 'unanswered' && submission.reason !== 'aborted') {
        outcome = { state: 'failed', errorCode: safeCloudError(new Error(typeof submission.detail === 'string' ? submission.detail : '')).code };
      } else {
        // Pi abort writes an unanswered/aborted receipt. It is interrupted work, not a model failure.
        // Eligibility alone decides whether that unpaid wake can return to the inbox.
        outcome = { state: 'interrupted', errorCode: eligibility.fatalCode ?? (aborted ? 'CLOUD_EXECUTION_ABORTED' : 'CLOUD_EXECUTION_INTERRUPTED'),
          requeue: run.trigger === 'wake' && eligibility.steps === 0 && !aborted && !eligibility.fatalCode };
      }
      const delivery = await this.#deliveryEvidence(harness, run.conversationId, outcome.state === 'completed');
      this.state.storage.transactionSync(() => {
        // A binding cancellation can arrive during the asynchronous pi evidence reads.
        const current = this.cloud.run(run.conversationId);
        const finalOutcome = current?.aborted && !eligibility.aborted
          ? { state: 'interrupted' as const, errorCode: 'CLOUD_EXECUTION_ABORTED' as const }
          : outcome;
        const stored = this.cloud.settleRun(run.conversationId, finalOutcome, this.#guard());
        for (const link of delivery) this.cloud.setDelivery(link.invocationId,
          stored?.state === 'completed' ? link.state : 'undelivered',
          stored?.state === 'completed' ? link.taskId : null,
          stored?.state === 'completed' ? link.entryId : null, this.#guard());
      });
      this.#doorbell();
    }
  }

  async #deliveryEvidence(harness: Harness, conversationId: number, completed: boolean) {
    const rows = this.ledger.forConversation(conversationId);
    const links = rows.map(row => ({ invocationId: row.invocationId, state: 'undelivered' as 'delivered' | 'undelivered', taskId: null as number | null, entryId: null as number | null }));
    if (!completed || !rows.length) return links;
    const conversation = await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return links;
    const context = await conversation.context(BACKGROUND_CONTEXT);
    let cursor: Cursor | undefined;
    do {
      const page = await this.#piStorage!.scanTasks({ conversationId: conversationId as ConversationId, kind: ToolTask.definition.name }, 100, cursor, BACKGROUND_CONTEXT);
      for (const task of page.items) {
        if (task.state.status !== 'terminal' || task.state.outcome.status !== 'completed') continue;
        const input = task.input as unknown as { assistant?: number; callId?: string };
        const rowIndex = rows.findIndex(row => row.assistantEntryId === input.assistant && row.toolCallId === input.callId);
        if (rowIndex < 0) continue;
        const result = task.state.outcome.result as unknown as { entryId?: number };
        const entryIndex = context.entries.findIndex(entry => entry.id === result.entryId && entry.kind === 'pi.tool-result' && entry.byTaskId === task.id);
        if (entryIndex < 0 || !context.contributions[entryIndex]?.some(message => message.role === 'toolResult')) continue;
        links[rowIndex] = { invocationId: rows[rowIndex]!.invocationId, state: 'delivered', taskId: task.id, entryId: result.entryId! };
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return links;
  }

  fatal(conversationId: number): CloudDoErrorCode | undefined {
    const remembered = this.#fatalDispositions.get(conversationId);
    if (remembered) return remembered;
    try {
      const code = this.ledger.execution(conversationId)?.fatalCode;
      return code ? this.#toolErrorCode(new Error(code)) : undefined;
    }
    catch { return this.#recordFatal(conversationId, 'CLOUD_TOOL_FAILED'); }
  }
  readInvocation(id: string): InvocationRow | undefined { return this.ledger.read(id); }
  #limits() { return this.#config?.limits ?? CLOUD_LIMITS; }

  async #guardToolMetadata(dispatcher: CloudToolDispatcher): Promise<void> {
    // Pi persists tool schemas and descriptions before the first model request.
    const metadata = dispatcher.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    await admitCloudPayload(this.env, JSON.parse(JSON.stringify(metadata)));
  }

  #sessionSchema(): void {
    this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cloud_session (
      id INTEGER PRIMARY KEY CHECK(id=1), configJson TEXT, staleJson TEXT NOT NULL DEFAULT '[]'
    ); INSERT OR IGNORE INTO cloud_session(id) VALUES(1)`);
    const columns = this.state.storage.sql.exec<{ name: string }>('PRAGMA table_info(cloud_session)').toArray();
    if (!columns.some(row => row.name === 'dispatcherDigest')) this.state.storage.sql.exec('ALTER TABLE cloud_session ADD COLUMN dispatcherDigest TEXT');
  }

  #storedDispatcherDigest(): string | null {
    return this.state.storage.sql.exec<{ dispatcherDigest: string | null }>('SELECT dispatcherDigest FROM cloud_session WHERE id=1').one().dispatcherDigest;
  }

  #storedConfig(): CloudSessionConfig | undefined {
    const row = this.state.storage.sql.exec<{ configJson: string | null }>('SELECT configJson FROM cloud_session WHERE id=1').toArray()[0];
    return row?.configJson ? JSON.parse(row.configJson) as CloudSessionConfig : undefined;
  }

  async #renew(request: CloudRenewRequest, signal: AbortSignal): Promise<void> {
    const result = this.options.renew ? await this.options.renew(Object.freeze(request), signal) : { ok: true };
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new CloudDoError('CLOUD_MODEL_REQUEST_FAILED');
    if (!result.ok) throw safeCloudError(new Error((result as {code: string}).code));
  }

  async #beforeRequest(info: { inputBytes: number }): Promise<CloudModelAccount> {
    if (!this.#recovered || !this.#active?.liveOwner || this.#active.conversationId === undefined) {
      throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    }
    const lease = this.#active;
    const id = lease.conversationId!;
    const fatal = this.fatal(id);
    if (fatal) throw new CloudDoError(fatal);
    try {
      await raceLease(Promise.resolve().then(() => this.#renew({ nativeRunId: id,
        requestId: this.cloud.readRun(id)?.requestId ?? null, kind: 'model', recovery: false }, lease.controller.signal)), lease);
      if (this.#active !== lease || !lease.liveOwner) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
      const stopped = this.fatal(id);
      if (stopped) throw new CloudDoError(stopped);
      this.ledger.countModel(id, this.#limits().modelSteps, Date.now(), {
        inputBytes: info.inputBytes, inputTokens: CLOUD_BUDGET.inputTokens, outputTokens: CLOUD_BUDGET.outputTokens,
      });
    } catch (error) { throw new CloudDoError(this.#recordFatal(id, safeCloudError(error).code)); }
    const seen = { input: 0, output: 0 };
    const record = (work: () => void): void => {
      try { work(); }
      catch { throw new CloudDoError(this.#recordFatal(id, 'CLOUD_MODEL_REQUEST_FAILED')); }
    };
    return {
      sent: () => record(() => this.ledger.markModelSent(id)),
      usage: usage => record(() => {
        const input = usage.input ?? seen.input;
        const output = usage.output ?? seen.output;
        if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < seen.input || output < seen.output) {
          throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
        }
        if (input !== seen.input || output !== seen.output) this.ledger.addModelUsage(id, input - seen.input, output - seen.output);
        seen.input = input; seen.output = output;
      }),
    };
  }

  #requestSignal(native?: AbortSignal): AbortSignal {
    const signals = [...(native ? [native] : []), ...(this.#active ? [this.#active.controller.signal] : [])];
    return AbortSignal.any(signals);
  }

  async #recover(harness: Harness, replay: InvocationRow[]): Promise<void> {
    for (const id of this.#stale) {
      this.#recordFatal(id, 'CLOUD_EXECUTION_INTERRUPTED');
      const conversation = await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
      if (conversation) {
        await conversation.abort(BACKGROUND_CONTEXT, { background: true });
        await conversation.waitForIdle(BACKGROUND_CONTEXT);
      }
    }
    for (const row of replay) {
      if (!this.#config || !this.#dispatcher) {
        this.ledger.finish(row.invocationId, 'failed', undefined, 'CLOUD_EXECUTION_INTERRUPTED');
        continue;
      }
      await this.#runInvocation(row, undefined, true).catch(() => undefined);
    }
    await this.#adjudicateRuns(harness);
    await this.#backfillTurns(harness);
    await this.cloud.rearmAlarm({ busy: false, repairRetrying: false });
    this.#recovered = true;
    this.#recoveryGuard?.dispose();
    this.#recoveryGuard = undefined;
  }

  async #backfillTurns(harness: Harness): Promise<void> {
    let before = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const runs = this.cloud.pendingBackfills(before);
      if (!runs.length) return;
      for (const run of runs) {
        let seqs: number[];
        try {
          const conversation = await harness.conversation(run.conversationId as ConversationId, BACKGROUND_CONTEXT);
          const view = conversation ? await conversation.context(BACKGROUND_CONTEXT) : undefined;
          seqs = view ? runInputSeqs(view.entries) : [];
        } catch { continue; } // Keep this run pending. A later boot retries its native read.
        this.cloud.applyBackfill(run.conversationId, seqs);
      }
      before = runs[runs.length - 1]!.conversationId;
    }
  }

  async #execute(name: string, args: Record<string, unknown>, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
    try { return await this.#executeChecked(name, args, api, context); }
    catch (error) {
      const code = this.#toolErrorCode(error);
      this.#recordFatal(api.conversationId, code);
      try {
        if (error instanceof StaleInvocationAttempt) {
          const harness = await this.#opened!;
          // abortTask marks first, then joins this invocation. Never await the self-join here.
          void harness.abortTask(api.taskId, BACKGROUND_CONTEXT).catch(() => undefined);
          await harness.getTask(api.taskId, BACKGROUND_CONTEXT);
        }
      } catch { /* The fixed receipt remains the only SDK output if cancellation storage fails. */ }
      return this.#errorResult(code);
    }
  }

  async #executeChecked(name: string, args: Record<string, unknown>, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
    if (this.#stale.has(api.conversationId) || !this.#config || !this.#dispatcher) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    const task = await api.getTask(api.taskId, context);
    const input = task?.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.assistant !== 'number') {
      throw new CloudDoError('CLOUD_TOOL_FAILED');
    }
    this.#guard().guardPayload(canonicalArgs({ name, id: api.callId, args }));
    const id = await invocationId(api.conversationId, input.assistant, api.callId);
    const execution = this.ledger.execution(api.conversationId);
    if (!execution) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    const begun = this.ledger.begin({ invocationId: id, sessionId: this.#config.identity.sessionId,
      conversationId: api.conversationId, assistantEntryId: input.assistant, toolCallId: api.callId,
      toolName: name, argsDigest: await argsDigest(name, args), argsJson: canonicalArgs(args), replay: replayForTool(name),
      deadlineAt: Math.min(Date.now() + this.#limits().callTimeoutMs, execution.deadlineAt),
    });
    if (begun.kind === 'pending') {
      const pending = this.#invocations.get(id);
      if (!pending) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
      await pending;
    } else if (begun.kind === 'started') {
      const running = this.#runInvocation(begun.row, context.abortSignal, false);
      this.#invocations.set(id, running);
      try { await running; }
      finally { this.#invocations.delete(id); }
    }
    return this.#modelResult(this.ledger.read(id)!);
  }

  #modelResult(row: InvocationRow): ToolExecutionResult {
    const result = this.#result(row);
    const error = result.error as { code: string; data?: unknown } | undefined;
    if (Object.hasOwn(result, 'modelView')) return { isError: result.ok === false,
      content: [{ type: 'text', text: JSON.stringify(result.modelView) }] };
    if (result.ok === false) {
      if (this.#dispatcher?.domainErrors?.includes(error!.code)) return { isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }] };
      return this.#errorResult(error!.code as CloudDoErrorCode);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  #errorResult(code: CloudDoErrorCode): ToolExecutionResult {
    const fixed = safeCloudError(new Error(typeof code === 'string' ? code : 'CLOUD_TOOL_FAILED')).code;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: fixed } }) }] };
  }

  #toolErrorCode(error: unknown): CloudDoErrorCode {
    const code = safeCloudError(error).code;
    return code === 'CLOUD_MODEL_REQUEST_FAILED' ? 'CLOUD_TOOL_FAILED' : code;
  }

  #recordFatal(conversationId: number, code: CloudDoErrorCode): CloudDoErrorCode {
    let first = this.#fatalDispositions.get(conversationId);
    if (!first) {
      try {
        const stored = this.ledger.execution(conversationId)?.fatalCode;
        first = stored ? this.#toolErrorCode(new Error(stored)) : code;
      }
      catch { first = code; }
      this.#fatalDispositions.set(conversationId, first);
    }
    try { this.ledger.failExecution(conversationId, first); }
    catch { /* Fail closed in memory. Do not expose an exception from failure persistence. */ }
    return first;
  }

  #result(row: InvocationRow): Record<string, unknown> {
    if (row.state !== 'succeeded' || row.resultJson === null) throw new CloudDoError(row.errorCode ?? 'CLOUD_TOOL_FAILED');
    return JSON.parse(row.resultJson) as Record<string, unknown>;
  }

  async #runInvocation(row: InvocationRow, native: AbortSignal | undefined, recovery: boolean): Promise<Record<string, unknown>> {
    const lease = recovery ? undefined : this.#active;
    const controller = new AbortController();
    let deadline = row.deadlineAt;
    const signals = [controller.signal, ...(native ? [native] : []), ...(lease ? [lease.controller.signal] : [])];
    const signal = AbortSignal.any(signals);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      deadline = Math.min(row.deadlineAt, this.ledger.execution(row.conversationId)?.deadlineAt ?? row.deadlineAt);
      if (Date.now() >= deadline) throw new CloudDoError('CLOUD_TOOL_TIMEOUT');
      if (!this.#config || !this.#dispatcher) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
      if (!recovery && this.fatal(row.conversationId)) throw new CloudDoError(this.fatal(row.conversationId)!);
      const args = JSON.parse(row.argsJson) as Record<string, unknown>;
      await admitCloudPayload(this.env, args, lease?.profile);
      if (Date.now() >= deadline) throw new CloudDoError(this.#timeoutCode(row.conversationId));
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new CloudDoError(Date.now() >= deadline
          ? Date.now() >= (this.ledger.execution(row.conversationId)?.deadlineAt ?? Infinity)
            ? 'CLOUD_EXECUTION_TIMEOUT' : 'CLOUD_TOOL_TIMEOUT'
          : 'CLOUD_EXECUTION_ABORTED'));
        signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      });
      timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
      await Promise.race([Promise.resolve().then(() => this.#renew({ nativeRunId: row.conversationId,
        requestId: this.cloud.readRun(row.conversationId)?.requestId ?? null, kind: 'tool',
        toolName: row.toolName, recovery }, signal)), cancelled]);
      if (Date.now() >= deadline) throw new CloudDoError(this.#timeoutCode(row.conversationId));
      signal.throwIfAborted();
      if (!recovery && this.fatal(row.conversationId)) throw new CloudDoError(this.fatal(row.conversationId)!);
      if ((this.ledger.execution(row.conversationId)?.credits ?? 0) > CLOUD_BUDGET.credits) throw new CloudDoError('CLOUD_BUDGET_EXCEEDED');
      const usesFetchSlot = this.#dispatcher.tools.find(tool => tool.name === row.toolName)?.execution !== 'pure';
      if (usesFetchSlot && this.#inline >= this.#limits().inlineFetches) throw new CloudDoError('CLOUD_TOOL_BUSY');
      if (usesFetchSlot) this.#inline++;
      const dispatchContext = Object.freeze({
        identity: Object.freeze({ ...this.#config.identity }),
        principal: Object.freeze({ ...this.#config.principal }),
        scopes: Object.freeze([...this.#config.scopes]), dispatcherId: this.#config.dispatcherId,
        call: Object.freeze({ invocationId: row.invocationId, conversationId: row.conversationId, toolCallId: row.toolCallId, attempt: row.attempt }),
        lookup: (id: string) => {
          const found = this.ledger.read(id);
          if (!found || found.sessionId !== this.#config?.identity.sessionId) return undefined;
          return Object.freeze({ toolName: found.toolName, state: found.state, errorCode: found.errorCode, resultJson: found.resultJson,
            conversationId: found.conversationId, toolCallId: found.toolCallId, settledAt: found.settledAt, settledEventSeq: found.settledEventSeq });
        },
      });
      const dispatcher = this.#dispatcher;
      const work = Promise.resolve().then(() => {
        if (Date.now() >= deadline) throw new CloudDoError(this.#timeoutCode(row.conversationId));
        signal.throwIfAborted();
        return dispatcher.execute(dispatchContext, row.toolName, args, signal);
      });
      // A dispatcher that ignores cancellation cannot release a still-running fetch slot early.
      void work.finally(() => { if (usesFetchSlot) this.#inline--; }).catch(() => undefined);
      let result = await Promise.race([work, cancelled]);
      try {
        await admitCloudPayload(this.env, result, lease?.profile);
        result = JSON.parse(this.#guard().guardPayload(JSON.stringify(result))) as Record<string, unknown>;
      }
      catch (error) {
        if (error instanceof CloudDoError && error.code === 'CLOUD_USER_CREDENTIAL_REJECTED') {
          throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
        }
        throw error;
      }
      if (Object.hasOwn(result, 'modelView') && !this.#dispatcher.modelViews) throw new CloudDoError('CLOUD_TOOL_FAILED');
      const usage = result.usage;
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)
        || !Number.isSafeInteger((usage as Record<string, unknown>).credits) || Number((usage as Record<string, unknown>).credits) < 0) {
        throw new CloudDoError('CLOUD_TOOL_USAGE_INVALID');
      }
      if (typeof result.ok !== 'boolean' || (result.ok && result.error != null)) throw new CloudDoError('CLOUD_TOOL_FAILED');
      let responseFailure: CloudDoErrorCode | undefined;
      if (result.ok === false) {
        const rawCode = result.error && typeof result.error === 'object' && !Array.isArray(result.error)
          ? (result.error as Record<string, unknown>).code : undefined;
        const domainCode = typeof rawCode === 'string' && Object.hasOwn(CLOUD_DOMAIN_ERROR_CODES, rawCode) ? CLOUD_DOMAIN_ERROR_CODES[rawCode] : undefined;
        if (typeof rawCode === 'string' && this.#dispatcher.domainErrors?.includes(rawCode)) {
          const rawError = result.error as Record<string, unknown>;
          const hasData = Object.hasOwn(rawError, 'data');
          // Measure the guard-parsed value with the same JSON serialization used by the ledger.
          if (hasData && new TextEncoder().encode(JSON.stringify(rawError.data)).length > 2_048) throw new CloudDoError('CLOUD_TOOL_RESULT_LIMIT');
          result = { ...result, error: { code: rawCode, ...(hasData ? { data: rawError.data } : {}) } };
        } else {
          const code = domainCode ?? 'CLOUD_TOOL_FAILED';
          const bill = usage as Record<string, unknown>;
          result = { ok: false, error: { code }, usage: { credits: bill.credits,
            ...(Number.isSafeInteger(bill.rows) && Number(bill.rows) >= 0 ? { rows: bill.rows } : {}),
            ...(typeof bill.cached === 'boolean' ? { cached: bill.cached } : {}),
          } };
          if (!domainCode) responseFailure = code;
        }
      }
      if (new TextEncoder().encode(JSON.stringify(result)).length > this.#limits().resultBytes) throw new CloudDoError('CLOUD_TOOL_RESULT_LIMIT');
      const settled = this.ledger.finish(row.invocationId, 'succeeded', result, undefined, Date.now(), {
        attempt: row.attempt, clientConnected: recovery || lease?.connected === true, recovery, creditCap: CLOUD_BUDGET.credits,
      });
      if (!settled) throw new CloudDoError('CLOUD_TOOL_FAILED');
      if (settled.attempt !== row.attempt) throw new StaleInvocationAttempt();
      if (responseFailure && !recovery) this.#recordFatal(row.conversationId, responseFailure);
      return this.#result(settled);
    } catch (error) {
      if (error instanceof StaleInvocationAttempt) throw error;
      const code = signal.aborted
        ? Date.now() >= deadline ? this.#timeoutCode(row.conversationId) : 'CLOUD_EXECUTION_ABORTED'
        : this.#toolErrorCode(error);
      const state: InvocationTerminalState = code === 'CLOUD_TOOL_TIMEOUT' || code === 'CLOUD_EXECUTION_TIMEOUT' ? 'timed_out'
        : code === 'CLOUD_EXECUTION_ABORTED' ? 'aborted' : 'failed';
      let settled: InvocationRow | undefined;
      try { settled = this.ledger.finish(row.invocationId, state, undefined, code, Date.now(), { attempt: row.attempt, recovery }); }
      catch { /* Do not replace a fixed code with raw storage error text. */ }
      if (settled && settled.attempt !== row.attempt) throw new StaleInvocationAttempt();
      if (!recovery) this.#recordFatal(row.conversationId, code);
      throw new CloudDoError(code);
    } finally {
      clearTimeout(timer);
      removeAbort?.();
      controller.abort();
    }
  }

  #timeoutCode(conversationId: number): CloudDoErrorCode {
    return Date.now() >= (this.ledger.execution(conversationId)?.deadlineAt ?? Infinity)
      ? 'CLOUD_EXECUTION_TIMEOUT' : 'CLOUD_TOOL_TIMEOUT';
  }
}
