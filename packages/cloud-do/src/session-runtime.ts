import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import type { JsonObject } from '@earendil-works/pi-ai';
import { Harness, ToolTask, createRegistry, defineExtension, hook, type ConversationId, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import { CloudDoError, safeCloudError, type CloudDoErrorCode } from './errors';
import { admitCloudPayload } from './input-guard';
import { InvocationLedger, type InvocationRow, type InvocationTerminalState } from './invocation-ledger';
import { createPlatformModels } from './platform-provider';
import { platformCredentialReader, type PlatformProfileId } from './platform-credentials';
import { CLOUD_LIMITS, admitSessionConfig, type CloudSessionConfig } from './session-config';
import { openDurableObjectStorage } from './storage';
import { admitCloudTools, argsDigest, canonicalArgs, invocationId, replayForTool, type CloudToolDispatcher } from './tools';

export const CLOUD_HARNESS_SETTINGS = {
  compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 }, stream: { maxRetries: 0 },
} as const;

// Fixed serving-domain failures remain data outcomes. Raw upstream diagnostics never enter pi.
const domainErrorCodes: Readonly<Record<string, CloudDoErrorCode>> = Object.freeze({
  NOT_FOUND: 'CLOUD_TOOL_NOT_AVAILABLE', DATA_NOT_LICENSED: 'CLOUD_TOOL_NOT_AVAILABLE',
  DATA_QUALITY_HOLD: 'CLOUD_TOOL_NOT_AVAILABLE', SCOPE_DENIED: 'CLOUD_TOOL_NOT_AVAILABLE',
  TOOL_UNAVAILABLE: 'CLOUD_TOOL_NOT_AVAILABLE', TOOL_ARGUMENT_INVALID: 'CLOUD_TOOL_ARGUMENT_INVALID',
  OUT_OF_RANGE: 'CLOUD_TOOL_ARGUMENT_INVALID', TOO_MANY_ROWS: 'CLOUD_TOOL_ARGUMENT_INVALID',
  AMBIGUOUS_SECURITY: 'CLOUD_TOOL_ARGUMENT_INVALID', SYMBOL_AMBIGUOUS: 'CLOUD_TOOL_ARGUMENT_INVALID',
});

class StaleInvocationAttempt extends CloudDoError {
  constructor() { super('CLOUD_EXECUTION_INTERRUPTED'); }
}

export interface ExecutionLease {
  conversationId?: number;
  readonly profile: PlatformProfileId;
  readonly deadlineAt: number;
  readonly controller: AbortController;
  connected: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface RuntimeOptions {
  createDispatcher(id: string): CloudToolDispatcher | undefined;
  onInvocationSettled?(id: string, state: InvocationTerminalState): void | Promise<void>;
}

/** One physical DO owns this runtime. Native pi owns all model and task scheduling. */
export class SessionRuntime {
  readonly ledger: InvocationLedger;
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
    this.ledger = new InvocationLedger(state.storage);
  }

  get recovering(): boolean { return !this.#recovered; }

  /** Binding/RPC callers authorize the session before calling this immutable configuration operation. */
  async configure(input: unknown): Promise<void> {
    const config = admitSessionConfig(input);
    await admitCloudPayload(this.env, config);
    const dispatcher = this.options.createDispatcher(config.dispatcherId);
    if (!dispatcher) throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
    admitCloudTools(dispatcher.tools);
    await this.#guardToolMetadata(dispatcher);
    this.#sessionSchema();
    this.state.storage.transactionSync(() => {
      const existing = this.#storedConfig();
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(config)) throw new CloudDoError('CLOUD_SESSION_CONFLICT');
        return;
      }
      if (this.#opened) throw new CloudDoError('CLOUD_SESSION_CONFLICT');
      this.state.storage.sql.exec('UPDATE cloud_session SET configJson=? WHERE id=1', JSON.stringify(config));
    });
  }

  open(): Promise<Harness> {
    if (!this.#opened) {
      const initialized = this.state.blockConcurrencyWhile(async () => {
        this.ledger.ensureSchema();
        this.#sessionSchema();
        this.#config = this.#storedConfig();
        if (!this.#config && this.ledger.pending().length) this.#bootstrapFailure = 'CLOUD_TOOL_NOT_AVAILABLE';
        if (this.#config) {
          this.#config = admitSessionConfig(this.#config);
          this.#dispatcher = this.options.createDispatcher(this.#config.dispatcherId);
          if (!this.#dispatcher) this.#bootstrapFailure = 'CLOUD_TOOL_NOT_AVAILABLE';
          else {
            admitCloudTools(this.#dispatcher.tools);
            await this.#guardToolMetadata(this.#dispatcher);
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
        const harness = await Harness.open(await openDurableObjectStorage(this.state.storage), {
          models: createPlatformModels(this.env, platformCredentialReader(this.env), {
            beforeRequest: () => this.#beforeRequest(),
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
        const replay = this.ledger.claimRecovery();
        return { harness, replay };
      });
      // This continuation runs after the initialization input gate was released.
      this.#opened = initialized.then(({ harness, replay }) => {
        this.#recovery = this.#recover(harness, replay);
        void this.#recovery.catch(() => undefined);
        return harness;
      });
    }
    return this.#opened;
  }

  async ready(): Promise<Harness> {
    const harness = await this.open();
    await this.#recovery;
    return harness;
  }

  reserve(profile: PlatformProfileId): ExecutionLease {
    if (!this.#recovered) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    if (this.#bootstrapFailure) throw new CloudDoError(this.#bootstrapFailure);
    if (this.#active) throw new CloudDoError('CLOUD_TOOL_BUSY');
    const lease: ExecutionLease = { profile, deadlineAt: Date.now() + this.#limits().turnTimeoutMs,
      controller: new AbortController(), connected: true };
    this.#active = lease;
    return lease;
  }

  attach(lease: ExecutionLease, conversationId: number): void {
    if (this.#active !== lease || lease.conversationId !== undefined) throw new CloudDoError('CLOUD_TOOL_BUSY');
    lease.conversationId = conversationId;
    this.ledger.startExecution(conversationId, lease.deadlineAt);
    lease.timer = setTimeout(() => {
      this.#recordFatal(conversationId, 'CLOUD_EXECUTION_TIMEOUT');
      lease.controller.abort();
    }, Math.max(0, lease.deadlineAt - Date.now()));
  }

  cancel(lease: ExecutionLease, code: CloudDoErrorCode = 'CLOUD_EXECUTION_ABORTED'): void {
    lease.connected = false;
    if (lease.conversationId !== undefined) {
      this.#recordFatal(lease.conversationId, code);
      try { this.ledger.abortExecution(lease.conversationId, code); }
      catch { /* The in-memory disposition still closes the transport if storage fails. */ }
    }
    lease.controller.abort();
  }

  release(lease: ExecutionLease): void {
    clearTimeout(lease.timer);
    if (this.#active === lease) this.#active = undefined;
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
  }

  #storedConfig(): CloudSessionConfig | undefined {
    const row = this.state.storage.sql.exec<{ configJson: string | null }>('SELECT configJson FROM cloud_session WHERE id=1').toArray()[0];
    return row?.configJson ? JSON.parse(row.configJson) as CloudSessionConfig : undefined;
  }

  #beforeRequest(): void {
    if (!this.#recovered || !this.#active || this.#active.conversationId === undefined) {
      throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    }
    const fatal = this.fatal(this.#active.conversationId);
    if (fatal) throw new CloudDoError(fatal);
    this.ledger.countModel(this.#active.conversationId, this.#limits().modelSteps);
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
    this.#recovered = true;
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
    const id = await invocationId(api.conversationId, input.assistant, api.callId);
    const execution = this.ledger.execution(api.conversationId);
    if (!execution) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
    const begun = this.ledger.begin({ invocationId: id, sessionId: this.#config.identity.sessionId,
      conversationId: api.conversationId, assistantEntryId: input.assistant, toolCallId: api.callId,
      toolName: name, argsDigest: await argsDigest(name, args), argsJson: canonicalArgs(args), replay: replayForTool(name),
      deadlineAt: Math.min(Date.now() + this.#limits().callTimeoutMs, execution.deadlineAt),
    });
    let result: Record<string, unknown>;
    if (begun.kind === 'settled') result = this.#result(begun.row);
    else if (begun.kind === 'pending') {
      const pending = this.#invocations.get(id);
      if (!pending) throw new CloudDoError('CLOUD_EXECUTION_INTERRUPTED');
      result = await pending;
    } else {
      const running = this.#runInvocation(begun.row, context.abortSignal, false);
      this.#invocations.set(id, running);
      try { result = await running; }
      finally { this.#invocations.delete(id); }
    }
    if (result.ok === false) {
      const error = result.error as { code: CloudDoErrorCode };
      return this.#errorResult(error.code);
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
      if (this.#inline >= this.#limits().inlineFetches) throw new CloudDoError('CLOUD_TOOL_BUSY');
      this.#inline++;
      const dispatchContext = this.#config;
      const dispatcher = this.#dispatcher;
      const work = Promise.resolve().then(() => {
        if (Date.now() >= deadline) throw new CloudDoError(this.#timeoutCode(row.conversationId));
        signal.throwIfAborted();
        return dispatcher.execute(dispatchContext, row.toolName, args, signal);
      });
      // A dispatcher that ignores cancellation cannot release a still-running fetch slot early.
      void work.finally(() => { this.#inline--; }).catch(() => undefined);
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
      let result = await Promise.race([work, cancelled]);
      try { await admitCloudPayload(this.env, result, lease?.profile); }
      catch (error) {
        if (error instanceof CloudDoError && error.code === 'CLOUD_USER_CREDENTIAL_REJECTED') {
          throw new CloudDoError('CLOUD_MODEL_RESPONSE_REJECTED');
        }
        throw error;
      }
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
        const domainCode = typeof rawCode === 'string' && Object.hasOwn(domainErrorCodes, rawCode) ? domainErrorCodes[rawCode] : undefined;
        const code = domainCode ?? 'CLOUD_TOOL_FAILED';
        const bill = usage as Record<string, unknown>;
        result = { ok: false, error: { code }, usage: { credits: bill.credits,
          ...(Number.isSafeInteger(bill.rows) && Number(bill.rows) >= 0 ? { rows: bill.rows } : {}),
          ...(typeof bill.cached === 'boolean' ? { cached: bill.cached } : {}),
        } };
        if (!domainCode) responseFailure = code;
      }
      if (new TextEncoder().encode(JSON.stringify(result)).length > this.#limits().resultBytes) throw new CloudDoError('CLOUD_TOOL_RESULT_LIMIT');
      const settled = this.ledger.finish(row.invocationId, 'succeeded', result, undefined, Date.now(), {
        attempt: row.attempt, clientConnected: recovery || lease?.connected === true, recovery,
      });
      if (!settled) throw new CloudDoError('CLOUD_TOOL_FAILED');
      if (settled.attempt !== row.attempt) throw new StaleInvocationAttempt();
      if (responseFailure && !recovery) this.#recordFatal(row.conversationId, responseFailure);
      await this.options.onInvocationSettled?.(settled.invocationId, settled.state as InvocationTerminalState);
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
      if (settled && settled.state !== 'running' && settled.state !== 'accepted') {
        await this.options.onInvocationSettled?.(settled.invocationId, settled.state);
      }
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
