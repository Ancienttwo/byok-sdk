import { randomUUID } from 'node:crypto';
import { AsyncQueue } from '../../util/async-queue.js';
import { RuntimeExecutionFailure } from '../../runtime-failure.js';
import type { RuntimeInputImage, RuntimeTaskInput } from '../../types.js';
import { projectedServiceTier } from '../shared-rules.js';
import type { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import {
  claudeSessionCapabilities, claudeProjectionProfile, initialClaudeProjection, resumedClaudeProjection, streamJsonSession,
  claudeServiceTierRefusal, claudeServiceTierEvents,
  type ClaudeControl, type ClaudeCredentialRedactor, type ClaudeRecord, type RawClaudeSession,
} from '../../runtime/claude-session-runtime.js';
import { claudeRecordFrame, type ClaudeFrame, type ClaudeStreamMessage } from './projection.js';

/** The SDK stdio handshake answers within this deadline or the start fails. */
const INITIALIZE_TIMEOUT_MS = 60_000;
/** Claude answers `mcp_status` from memory; a slow answer only leaves `mcp` absent. */
const MCP_STATUS_TIMEOUT_MS = 5_000;

type OwnedLineProcess = ReturnType<ReturnType<typeof createOwnedLineProcessSpawn>>;

/** One runtime request: the native `control_request` and the recorded reply writer. */
export type ClaudeAppRequest = (message: ClaudeStreamMessage, respond: (reply: Record<string, unknown>) => Promise<void>) => void;

type ClaudeExecutionOptions = Pick<RuntimeTaskInput, 'effort' | 'serviceTier' | 'serviceTierFallback'>;

export interface ClaudeStreamSessionOptions extends ClaudeExecutionOptions {
  /** The requested `--resume` id; a fresh session learns its id from `system/init`. */
  resume?: string;
  /** The kernel's retention limit: past it the oldest native payloads are elided. */
  maxRetainedBytes: number;
  /** `initialize` with these SDK callback hooks; absent when no native control is in use. */
  initialize?: { hooks: Readonly<Record<string, unknown>> | null };
  onAppRequest: ClaudeAppRequest;
  /** Every recorded native frame but a runtime request, in order, before the event consumer reads it. */
  onFrame(frame: ClaudeStreamMessage): void;
  /** The process exited: the bridges end their requests. */
  onExit(): void;
}

/** A private control request the profile consumes: `initialize` or `mcp_status`. */
interface PendingControl { id: string; settle(response: Record<string, unknown> | undefined): void }

/**
 * The OAR stream-json session on an SDK-owned Claude process. OAR owns the
 * record model, turn and busy state, interrupt and the runtime-request
 * records; this module owns the handshake, the private `mcp_status` lookup,
 * the event frame queue and the session identity from `system/init`.
 */
export class ClaudeStreamSession {
  readonly frames = new AsyncQueue<ClaudeFrame>();
  readonly sessionRef: Promise<string>;
  hooksApplied: boolean | undefined;
  #raw: RawClaudeSession | undefined;
  redactDiagnostic = (text: string): string => this.credentials.redact(text);
  #executionOptions: ClaudeExecutionOptions = {};
  get effort() { return this.#executionOptions.effort; }
  get serviceTier() { return this.#executionOptions.serviceTier; }
  get serviceTierFallback() { return this.#executionOptions.serviceTierFallback; }
  #initialServiceTier: ReturnType<typeof projectedServiceTier>;

  takeInitialServiceTier(): ReturnType<typeof projectedServiceTier> {
    const tier = this.#initialServiceTier;
    this.#initialServiceTier = undefined;
    return tier;
  }
  #inputWrites: Promise<void>[] | undefined;
  #withdraw!: NonNullable<RawClaudeSession['withdraw']>;
  /** Input ids of the follow-ups OAR holds for after a Claude-own turn; an interrupt withdraws them first. */
  #held = new Set<string>();
  #fatal: Error | undefined;
  #controls = new Map<string, PendingControl>();
  #ended = false;
  #initModel: string | undefined;
  #results = 0;
  #resultWaiters = new Set<() => void>();
  #unmapped = new Map<string, number>();
  #resolveRef!: (sessionRef: string) => void;
  #rejectRef!: (error: Error) => void;

  constructor(readonly child: OwnedLineProcess, readonly credentials: ClaudeCredentialRedactor) {
    this.sessionRef = new Promise<string>((resolve, reject) => { this.#resolveRef = resolve; this.#rejectRef = reject; });
    void this.sessionRef.catch(() => {});
  }

  /** Spawn and adoption settle before the first protocol write; the open writes `initialize` when asked. */
  async open(options: ClaudeStreamSessionOptions): Promise<void> {
    const { effort, serviceTier, serviceTierFallback } = options;
    this.#executionOptions = { effort, serviceTier, serviceTierFallback };
    await this.child.spawned;
    // A start halted during adoption writes nothing to the adopted process.
    if (this.#fatal !== undefined) throw this.#fatal;
    // OAR's void write is synchronous. Keep its turn/queue decisions, but retain
    // the owned transport's receipt for the SDK input call that issued a write.
    const owned = this.child;
    const child: OwnedLineProcess = {
      pid: owned.pid, spawned: owned.spawned, exited: owned.exited,
      kill: () => owned.kill(), dispose: () => owned.dispose(),
      get exitedOnItsOwn() { return owned.exitedOnItsOwn; },
      observeDescendants: () => owned.observeDescendants(), exitError: () => this.#exitError(),
      onLine: handler => owned.onLine(handler), onExit: handler => owned.onExit(handler),
      writeAcknowledged: text => owned.writeAcknowledged(text),
      write: (text: string): void => {
        // OAR's drain writes a held follow-up as a user line named by its input id; written, it can no longer be withdrawn (#1940).
        if (this.#held.size > 0) {
          let line: { type?: unknown; uuid?: unknown };
          try { line = JSON.parse(text); }
          catch { throw new Error('Claude stream writer emitted malformed JSON'); }
          if (line.type === 'user' && typeof line.uuid === 'string') this.#held.delete(line.uuid);
        }
        // Keep the owned transport's synchronous writability refusal visible to OAR.
        const written = owned.writeAcknowledged(text);
        this.#inputWrites?.push(written);
        // Held queue drains and interrupts have no input caller awaiting them;
        // the owned transport still fails the process and event stream.
        void written.catch(() => {});
      },
    };
    this.#raw = await streamJsonSession(child, options.resume ?? randomUUID(), this.credentials, {
      projection: claudeProjectionProfile,
      initial: options.resume === undefined ? initialClaudeProjection : resumedClaudeProjection,
      capabilities: { queue: { durable: false }, attribution: 'attributed', images: claudeSessionCapabilities().images },
      steer: false,
      consume: message => this.#consume(message),
      open: async () => {
        if (options.initialize === undefined && serviceTier === undefined) return;
        const response = await this.#control({ subtype: 'initialize', hooks: options.initialize?.hooks ?? null }, INITIALIZE_TIMEOUT_MS);
        if (response?.subtype !== 'success') {
          throw new RuntimeExecutionFailure({ phase: 'start', retry: 'retryable', reason: 'Claude native control initialization failed', failure: this.startupExit() });
        }
        if (serviceTier !== undefined) {
          const refusal = claudeServiceTierRefusal(serviceTier, { response }, serviceTierFallback);
          if (refusal !== null) throw new RuntimeExecutionFailure({
            phase: 'start', retry: 'non-retryable', reason: this.credentials.redact(refusal), failure: { class: 'invalid_request' },
          });
          const applied = this.credentials.redactValue(response.response) as Record<string, unknown> | undefined;
          this.#initialServiceTier = applied === undefined ? undefined : projectedServiceTier(claudeServiceTierEvents(applied));
        }
        const applied = (response.response as { hooks_applied?: unknown } | undefined)?.hooks_applied;
        this.hooksApplied = typeof applied === 'boolean' ? applied : undefined;
      },
      exited: () => { this.#end(); options.onExit(); },
      disposing: () => this.#end(),
    }, {
      onRecord: record => this.#record(record, options.onFrame),
      onSessionInit: id => {
        if (this.credentials.redact(id) !== id || this.credentials.matches(id)) {
          this.fail(new RuntimeExecutionFailure({
            phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' },
            reason: 'Claude reported an unsafe session id',
          }));
          return;
        }
        if (this.#fatal === undefined) this.#resolveRef(id);
      },
      onRequestCancelled: id => options.onFrame({ type: 'control_cancel_request', request_id: id }),
      // After a halt no reply reaches Claude, whatever a bridge still decides.
      onAppRequest: (request, respond) => options.onAppRequest(request.native as ClaudeStreamMessage,
        reply => this.#fatal === undefined ? respond(reply) : Promise.reject(this.#fatal)),
      // Before a native interrupt: tools it orphans stay killable at disposal.
      beforeInterrupt: () => this.child.observeDescendants(),
    }, options.maxRetainedBytes);
    // Without withdraw a cancelled task's held follow-up would still reach Claude.
    if (this.#raw.withdraw === undefined) throw new Error('claude stream-json session has no withdraw');
    this.#withdraw = this.#raw.withdraw.bind(this.#raw);
  }

  /** An input returns only after the writes it issued complete; an OAR-held queue issues none. */
  #input(control: () => Promise<ClaudeControl>): Promise<ClaudeControl> {
    const writes: Promise<void>[] = [];
    this.#inputWrites = writes;
    let result: Promise<ClaudeControl>;
    try { result = control(); }
    finally { this.#inputWrites = undefined; }
    return Promise.all([result, Promise.all(writes)]).then(([prompted]) => prompted);
  }

  prompt(input: string, images?: readonly RuntimeInputImage[]): Promise<ClaudeControl> {
    return this.#input(() => this.raw.prompt(input, { images }));
  }

  /** Input for after the turn Claude runs on its own, held by OAR under an input id the interrupt can withdraw. */
  async queue(input: string, images?: readonly RuntimeInputImage[]): Promise<ClaudeControl> {
    const inputId = randomUUID();
    this.#held.add(inputId);
    const queued = await this.#input(() => this.raw.queue(input, { inputId, images }));
    if (queued.response.body.kind !== 'accepted') this.#held.delete(inputId);
    return queued;
  }

  get raw(): RawClaudeSession {
    if (this.#raw === undefined) throw new Error('claude stream-json session is not open');
    return this.#raw;
  }

  /** Context window of the latest `result`, by the model its turn's `system/init` named. */
  get initModel(): string | undefined { return this.#initModel; }

  /** The process ended on its own, before any kill, disposal or transport failure. */
  get processExited(): boolean { return this.#fatal === undefined && this.child.exitedOnItsOwn; }

  get terminalError(): Error { return this.#fatal ?? this.#exitError(); }

  #exitError(): Error {
    const error = this.child.exitError();
    return this.credentials.redactValue(error);
  }

  /** A start step Claude's own exit ended is `runtime_exited`. */
  startupExit() { return this.processExited ? { class: 'runtime_exited' as const } : undefined; }

  /** A halted start: nothing more is written, and the failure outranks the exit. The start's owner disposes the process. */
  halt(error: Error): void {
    this.#fatal ??= error;
    this.#rejectRef(error);
  }

  /** A fatal bridge failure outranks the exit it causes; the event stream ends with it. */
  fail(error: Error): void {
    this.halt(error);
    this.child.kill();
  }

  /** The owned process tree's disposal: the one receipt that the process and its descendants are gone. */
  dispose(): Promise<void> { return this.child.dispose(); }

  /** Claude's own `mcp_status` answer, or undefined on failure, timeout or close. */
  async mcpStatus(): Promise<unknown> {
    const response = await this.#control({ subtype: 'mcp_status' }, MCP_STATUS_TIMEOUT_MS);
    return response?.subtype === 'success' ? response.response : undefined;
  }

  /** OAR records the interrupt and its acknowledgement; the ACK and the turn's `result` share the deadline. */
  async interruptAndSettle(timeoutMs: number): Promise<boolean> {
    // A held follow-up belongs to the task being cancelled: OAR would send it when the interrupted turn ends.
    const held = [...this.#held];
    this.#held.clear();
    for (const inputId of held) await this.#withdraw(inputId).catch(() => undefined);
    const seen = this.#results;
    let release!: () => void;
    const result = new Promise<void>(resolve => { release = resolve; });
    this.#resultWaiters.add(release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.raw.abort().then(async control => {
          if (control.response.body.kind !== 'accepted') return false;
          if (this.#results === seen) await result;
          return this.#results > seen;
        // An interrupt that could not be written did not reach Claude: the owner terminates.
        }, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.#resultWaiters.delete(release);
    }
  }

  /** Logs one warning per frame label that has no AgentEvent mapping. */
  recordUnmappedFrame(label: string): void {
    const next = (this.#unmapped.get(label) ?? 0) + 1;
    this.#unmapped.set(label, next);
    if (next === 1) {
      console.warn(`[byok/claude-adapter] claude emitted a frame with no AgentEvent mapping: "${label}" (further occurrences of this label won't be logged individually)`);
    }
  }

  #record(record: ClaudeRecord, onFrame: (frame: ClaudeStreamMessage) => void): void {
    if (record.kind === 'response' && (record.body as { kind?: unknown }).kind === 'exited') {
      this.#rejectRef(this.terminalError);
      this.frames.end();
      return;
    }
    const native = record.kind === 'frame' ? (record.body as { native?: unknown }).native as ClaudeStreamMessage | undefined : undefined;
    // A runtime request reaches the bridges once, through onAppRequest.
    if (native !== undefined && native.type !== 'control_request' && native.type !== 'control_cancel_request') onFrame(native);
    const projected = claudeRecordFrame(record);
    if (projected === undefined) return;
    const { native: frame, agentPath } = projected;
    const root = agentPath.length === 0;
    if (frame.type === 'system' && frame.subtype === 'init' && root) {
      if (typeof frame.model === 'string') this.#initModel = frame.model;
    }
    if (frame.type === 'result' && root) {
      this.#results += 1;
      for (const release of this.#resultWaiters) release();
    }
    this.frames.push(projected);
  }

  #consume(message: Record<string, unknown>): boolean {
    if (message.type !== 'control_response') return false;
    const response = message.response as Record<string, unknown> | undefined;
    const pending = typeof response?.request_id === 'string' ? this.#controls.get(response.request_id) : undefined;
    if (pending === undefined) return false;
    pending.settle(response);
    return true;
  }

  /** One private control request on stdin, consumed from stdout before the fold. Undefined when timed out, unwritable or closed. */
  #control(request: Record<string, unknown>, deadline: number): Promise<Record<string, unknown> | undefined> {
    if (this.#ended || this.#fatal !== undefined) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => settle(undefined), deadline);
      const settle = (response: Record<string, unknown> | undefined) => {
        if (!this.#controls.delete(id)) return;
        clearTimeout(timer);
        resolve(response);
      };
      this.#controls.set(id, { id, settle });
      try {
        this.child.writeAcknowledged(`${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`).catch(() => settle(undefined));
      } catch { settle(undefined); }
    });
  }

  #end(): void {
    this.#ended = true;
    for (const pending of [...this.#controls.values()]) pending.settle(undefined);
    for (const release of this.#resultWaiters) release();
  }
}
