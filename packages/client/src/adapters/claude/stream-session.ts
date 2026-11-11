import { randomUUID } from 'node:crypto';
import { AsyncQueue } from '../../util/async-queue.js';
import { RuntimeExecutionFailure } from '../../runtime-failure.js';
import type { McpStdioServerConfig } from '../../types.js';
import type { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import {
  claudeProjectionProfile, initialClaudeProjection, resumedClaudeProjection, sessionCredentialRedactor, streamJsonSession,
  type ClaudeRecord, type RawClaudeSession,
} from '../../runtime/claude-session-runtime.js';
import { claudeRecordFrame, parseClaudeContextWindow, type ClaudeStreamMessage } from './projection.js';

/** The SDK stdio handshake answers within this deadline or the start fails. */
const INITIALIZE_TIMEOUT_MS = 60_000;
/** Claude answers `mcp_status` from memory; a slow answer only leaves `mcp` absent. */
const MCP_STATUS_TIMEOUT_MS = 5_000;

type OwnedLineProcess = ReturnType<ReturnType<typeof createOwnedLineProcessSpawn>>;

/** One runtime request: the native `control_request` and the recorded reply writer. */
export type ClaudeAppRequest = (message: ClaudeStreamMessage, respond: (reply: Record<string, unknown>) => Promise<void>) => void;

export interface ClaudeStreamSessionOptions {
  /** The requested `--resume` id; a fresh session learns its id from `system/init`. */
  resume?: string;
  env: Readonly<Record<string, string>>;
  mcpServers: Readonly<Record<string, McpStdioServerConfig>>;
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
  readonly frames = new AsyncQueue<ClaudeStreamMessage>();
  readonly sessionRef: Promise<string>;
  hooksApplied: boolean | undefined;
  #raw: RawClaudeSession | undefined;
  #fatal: Error | undefined;
  #controls = new Map<string, PendingControl>();
  #ended = false;
  #initModel: string | undefined;
  #contextWindow: number | null = null;
  #results = 0;
  #resultWaiters = new Set<() => void>();
  #unmapped = new Map<string, number>();
  #resolveRef!: (sessionRef: string) => void;
  #rejectRef!: (error: Error) => void;

  constructor(readonly child: OwnedLineProcess) {
    this.sessionRef = new Promise<string>((resolve, reject) => { this.#resolveRef = resolve; this.#rejectRef = reject; });
    void this.sessionRef.catch(() => {});
  }

  /** Spawn and adoption settle before the first protocol write; the open writes `initialize` when asked. */
  async open(options: ClaudeStreamSessionOptions): Promise<void> {
    await this.child.spawned;
    // A start halted during adoption writes nothing to the adopted process.
    if (this.#fatal !== undefined) throw this.#fatal;
    const mcpServers = Object.entries(options.mcpServers).map(([name, server]) => ({ name, ...server }));
    this.#raw = await streamJsonSession(this.child, options.resume ?? randomUUID(), sessionCredentialRedactor({ env: options.env, mcpServers }), {
      projection: claudeProjectionProfile,
      initial: options.resume === undefined ? initialClaudeProjection : resumedClaudeProjection,
      capabilities: { queue: { durable: false }, attribution: 'attributed', images: false },
      steer: false,
      consume: message => this.#consume(message),
      open: async () => {
        if (options.initialize === undefined) return;
        const response = await this.#control({ subtype: 'initialize', hooks: options.initialize.hooks }, INITIALIZE_TIMEOUT_MS);
        if (response?.subtype !== 'success') {
          throw new RuntimeExecutionFailure({ phase: 'start', retry: 'retryable', reason: 'Claude native control initialization failed', failure: this.startupExit() });
        }
        const applied = (response.response as { hooks_applied?: unknown } | undefined)?.hooks_applied;
        this.hooksApplied = typeof applied === 'boolean' ? applied : undefined;
      },
      exited: () => { this.#end(); options.onExit(); },
      disposing: () => this.#end(),
    }, {
      onRecord: record => this.#record(record, options.onFrame),
      onAppRequest: (request, respond) => options.onAppRequest(request.native as ClaudeStreamMessage, respond),
      // Before a native interrupt: tools it orphans stay killable at disposal.
      beforeInterrupt: () => this.child.observeDescendants(),
    });
  }

  get raw(): RawClaudeSession {
    if (this.#raw === undefined) throw new Error('claude stream-json session is not open');
    return this.#raw;
  }

  /** Context window of the latest `result`, by the model its turn's `system/init` named. */
  get contextWindow(): number | null { return this.#contextWindow; }

  /** The process ended on its own, before any kill, disposal or transport failure. */
  get processExited(): boolean { return this.#fatal === undefined && this.child.exitedOnItsOwn; }

  get terminalError(): Error { return this.#fatal ?? this.child.exitError(); }

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
        }),
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
    if (native !== undefined && native.type !== 'control_request') onFrame(native);
    const frame = claudeRecordFrame(record);
    if (frame === undefined) return;
    const root = frame.parent_tool_use_id === undefined || frame.parent_tool_use_id === null;
    if (frame.type === 'system' && frame.subtype === 'init' && root) {
      if (typeof frame.model === 'string') this.#initModel = frame.model;
      if (typeof frame.session_id === 'string' && frame.session_id.length > 0) this.#resolveRef(frame.session_id);
    }
    if (frame.type === 'result') {
      this.#contextWindow = parseClaudeContextWindow(frame.modelUsage, this.#initModel);
      this.#results += 1;
      for (const release of this.#resultWaiters) release();
    }
    this.frames.push(frame);
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
    if (this.#ended) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => settle(undefined), deadline);
      const settle = (response: Record<string, unknown> | undefined) => {
        if (!this.#controls.delete(id)) return;
        clearTimeout(timer);
        resolve(response);
      };
      this.#controls.set(id, { id, settle });
      this.child.writeAcknowledged(`${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`).catch(() => settle(undefined));
    });
  }

  #end(): void {
    this.#ended = true;
    for (const pending of [...this.#controls.values()]) pending.settle(undefined);
    for (const release of this.#resultWaiters) release();
  }
}
