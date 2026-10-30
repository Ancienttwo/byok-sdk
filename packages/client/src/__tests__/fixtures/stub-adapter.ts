import { testRuntimeEnvironment } from './runtime-env';
import type { RuntimeEnvironment } from '../../runtime/environment';
import type { RuntimeTaskInput } from '../../types';
import type { AgentEvent } from '@byok-sdk/protocol';
import {
  freezeRuntimeAdapterDescriptor,
  type RuntimeAdapter,
  type RuntimeAdapterDescriptor,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeCapabilities,
  type RuntimeDetectResult,
  type RuntimeOperationStartInput,
  type RuntimePreparedLaunchV1,
  type MessageDraftDelta,
  type Session,
  type SessionEvidence,
} from '../../types';
import { AsyncQueue } from '../../util/async-queue';

/** In-memory Session double: tests push AgentEvents, request approvals and record interrupt/steer/close calls. */
export class StubSession implements Session {
  readonly queue = new AsyncQueue<AgentEvent | MessageDraftDelta>();
  interruptCalled = false;
  closeCalled = false;
  readonly steerCalls: string[] = [];
  readonly followUpCalls: RuntimeTaskInput[] = [];
  /** Every approval outcome {@link requestApproval} received, in order. */
  readonly approvalResults: Array<{ approved: boolean; reason?: string }> = [];
  /**
   * Test hook: when set, the NEXT `steer()` call throws this instead of
   * recording the call, then clears itself so subsequent calls succeed
   * normally. `TaskRunner.handleSteer` has no try/catch around its
   * `session.steer()` call (unlike cancel/approve/reject, which all
   * swallow a failing session call and report a terminal message instead)
   * — this is the one handler whose failure genuinely propagates all the
   * way up through `handleEnvelope` to `ConnectionManager.process()`, which
   * is what a test needing a real "the handler throws" case (e.g. the
   * long-poll cursor-not-advanced-before-handler regression test) needs.
   */
  steerError: Error | undefined;
  /**
   * Test hook (finding P2/Fix 2a): when set, EVERY `steer()` call throws this
   * — unlike `steerError`, it never auto-clears. Used to simulate a
   * persistently-failing handler (as opposed to `steerError`'s "fails once,
   * then recovers") for the long-poll stalled-cursor backoff/dedup
   * regression tests.
   */
  steerErrorPersistent: Error | undefined;
  /** Test hook: counts every `steer()` invocation regardless of outcome (throw or success) — lets a test observe retry attempts even while `steerErrorPersistent` means `steerCalls` never gets appended to. */
  steerAttempts = 0;
  /** Test hook: what `evidence()` reports; the daemon reads it only for a declaring adapter. */
  evidenceCounts: SessionEvidence = { decodeDropped: 0, unmappedFrames: 0, syntheticToolResults: 0 };
  private closeGate: Promise<void> | undefined;
  private steerGate: Promise<void> | undefined;
  private terminalFailure: Error | undefined;

  constructor(
    public readonly sessionRef: string,
    private readonly approvalChannel?: RuntimeOperationStartInput['approvalChannel'],
  ) {}

  /**
   * Test hook (finding P2/Fix 2b-2c): pause a *successful* `steer()` call
   * after it's already decided not to throw, before it records the call —
   * lets a test deterministically hold a retried "in-flight" steer open long
   * enough for a concurrent duplicate redelivery to attempt landing behind
   * it, instead of depending on real network/microtask race timing. Returns
   * the release function; the blocked `steer()` call resolves once it's
   * called.
   */
  blockSteer(): () => void {
    let release!: () => void;
    this.steerGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  /**
   * Test hook: widen the window `TaskRunner.finish()` spends inside
   * `await session.close()` — `finish()` deletes the task from its active
   * map *before* awaiting close(), so this lets a test deterministically
   * reproduce "an event arrives while the task is already gone from the map
   * but the session hasn't finished tearing down yet" (the exact shape of
   * the post-cancel stray-turn_end race `TaskRunner.pump`'s guard exists
   * for) instead of depending on real interprocess-timing luck. Returns the
   * release function; close() resolves once it's called.
   */
  blockClose(): () => void {
    let release!: () => void;
    this.closeGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  get events(): AsyncIterable<AgentEvent | MessageDraftDelta> {
    const queue = this.queue;
    const session = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent | MessageDraftDelta> {
        const inner = queue[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<AgentEvent | MessageDraftDelta>> {
            const result = await inner.next();
            if (result.done && session.terminalFailure) throw session.terminalFailure;
            return result;
          },
        };
      },
    };
  }

  async steer(text: string): Promise<void> {
    this.steerAttempts += 1;
    if (this.steerErrorPersistent) {
      throw this.steerErrorPersistent;
    }
    if (this.steerError) {
      const err = this.steerError;
      this.steerError = undefined;
      throw err;
    }
    if (this.steerGate) await this.steerGate;
    this.steerCalls.push(text);
  }

  async followUp(task: RuntimeTaskInput): Promise<void> {
    this.followUpCalls.push(task);
  }

  async interrupt(): Promise<void> {
    this.interruptCalled = true;
  }

  async close(): Promise<void> {
    if (this.closeGate) await this.closeGate;
    this.closeCalled = true;
    this.queue.end();
  }

  /**
   * Test helper: ask for approval the way an `approvalInteractive` adapter
   * does, through the channel TaskRunner handed this session, and record the
   * outcome. The test drives what "resuming" looks like by calling `emit()`
   * afterward.
   */
  requestApproval(summary: string): Promise<void> {
    if (this.approvalChannel === undefined) throw new Error('no approval channel was handed to this session');
    return this.approvalChannel.request(summary).then(({ approved, reason }) => {
      this.approvalResults.push(reason === undefined ? { approved } : { approved, reason });
    });
  }

  evidence(): SessionEvidence {
    return this.evidenceCounts;
  }

  /** Test helper: push a normalized event as if the runtime produced it. */
  emit(event: AgentEvent | MessageDraftDelta): void {
    this.queue.push(event);
  }

  /** Test helper: end the session's event stream without a `turn_end` (simulates an unexpected exit). */
  endAbruptly(): void {
    this.queue.end();
  }

  /** Test helper: end the stream with an explicit typed or untyped terminal failure. */
  fail(error: Error): void {
    this.terminalFailure = error;
    this.queue.end();
  }
}

/**
 * Default `capabilities()` result for a {@link StubRuntimeAdapter} that
 * doesn't override it — deliberately the MOST permissive set, not any one
 * real bundled adapter's actual declared set. `StubRuntimeAdapter` is a
 * generic, anonymous test double used all over this suite for scenarios that
 * have nothing to do with per-runtime capability matching (e.g. the
 * out-of-band approval flow, which is `TaskRunner`-level and
 * adapter-agnostic). A test that specifically wants to simulate a
 * capability-RESTRICTED adapter passes an explicit `capabilities` override via
 * the 3rd constructor param instead of relying on this default.
 */
const DEFAULT_STUB_CAPABILITIES: RuntimeCapabilities = {
  steer: true,
  resume: true,
  approvalInteractive: true,
  mcpToolsets: true,
};

/** In-memory RuntimeAdapter double: records every start() call and its resulting session. */
export class StubRuntimeAdapter implements RuntimeAdapter {
  readonly descriptor;
  readonly startCalls: Array<{
    task: RuntimeTaskInput;
    ctx: {
      workspaceDir: string;
      env: NodeJS.ProcessEnv;
      mcpServers?: RuntimeOperationStartInput['mcpServers'];
      mcpToolsetTools?: RuntimeOperationStartInput['mcpToolsetTools'];
      approvalChannel?: RuntimeOperationStartInput['approvalChannel'];
    };
  }> = [];
  /**
   * Every prepared start this adapter was handed, in order.
   *
   * Recorded separately from {@link startCalls} rather than folded into it: the
   * two lanes carry mutually exclusive authority over the request bytes, and a
   * single list would let a test assert "it started" without saying which
   * request it started.
   */
  readonly preparedStartCalls: Array<{
    preparation: RuntimePreparedLaunchV1;
    input: RuntimeOperationStartInput;
    manifest: RuntimeOperationStartInput['manifest'];
  }> = [];
  readonly sessions: StubSession[] = [];
  private readonly detectResult: RuntimeDetectResult;
  private sessionCounter = 0;
  /** When set, start() throws this instead of returning a session (for testing the daemon's failure paths). */
  startError: Error | undefined;
  private startGate: Promise<void> | undefined;

  /**
   * `capabilities` is an optional 3rd constructor param — defaults to
   * {@link DEFAULT_STUB_CAPABILITIES} (see its own doc comment for why that
   * default is maximally permissive rather than modeled on any one real
   * adapter). Lets a test simulate an adapter's declared capabilities (for
   * example no MCP toolset projection) for `TaskRunner.pickAdapter`'s
   * capability gate without needing the real bundled adapters.
   *
   * `requiresMcpToolsetToolObservation` (4th param) defaults to `true` — the
   * pi shape, where the daemon must observe each projected server's tools
   * before admission. Pass `false` for a stub whose runtime lists the tools
   * itself and must therefore never make an offer wait on a `tools/list`
   * probe.
   *
   * `trajectoryEvidence` (5th param) defaults to absent, like a custom
   * adapter that declares no evidence source: its execution records are
   * `unknown`.
   */
  constructor(
    id = 'pi',
    detectResult: RuntimeDetectResult = { kind: 'available', version: '0.0.0' },
    capabilities: RuntimeCapabilities = DEFAULT_STUB_CAPABILITIES,
    requiresMcpToolsetToolObservation = true,
    trajectoryEvidence?: RuntimeAdapterDescriptor['trajectoryEvidence'],
  ) {
    this.detectResult = detectResult;
    this.descriptor = freezeRuntimeAdapterDescriptor({
      id,
      supportsDispatchSelection: true,
      requiresMcpToolsetToolObservation,
      trajectoryEvidence,
      capabilities,
    });
  }

  async runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return testRuntimeEnvironment();
  }

  async detect(): Promise<RuntimeDetectResult> {
    return this.detectResult;
  }

  /**
   * Test hook (finding F4): pause `start()` right before it resolves its
   * session, so a test can deterministically land a `task.cancel` in the
   * window between `task.claim` and `ActiveTask` registration — i.e. while
   * `start()` is still in flight — instead of depending on real timing.
   * Returns the release function; `start()` resolves once it's called.
   */
  blockStart(): () => void {
    let release!: () => void;
    this.startGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    return {
      kind: 'prepared',
      operation: {
        start: (startInput) => this.startPrepared(input, startInput),
      },
    };
  }

  private async startPrepared(prepared: RuntimeAdapterPrepareInput, startInput: RuntimeOperationStartInput): Promise<Session> {
    // The prepared lane carries no instruction at all, so it is recorded as
    // itself rather than as an instruction start with an empty string.
    if (startInput.kind === 'prepared') {
      this.preparedStartCalls.push({ preparation: startInput.preparation, input: startInput, manifest: startInput.manifest });
      void prepared;
      if (this.startError) throw this.startError;
      if (this.startGate) await this.startGate;
      this.sessionCounter += 1;
      const preparedSession = new StubSession(`stub-session-${this.sessionCounter}`, startInput.approvalChannel);
      this.sessions.push(preparedSession);
      return preparedSession;
    }
    this.startCalls.push({
      task: {
        instruction: startInput.instruction,
        ...(startInput.manifest.dispatchSelection === undefined ? {} : { dispatchSelection: startInput.manifest.dispatchSelection }),
        ...(startInput.manifest.sessionRef === undefined ? {} : { sessionRef: startInput.manifest.sessionRef }),
      },
      ctx: {
        workspaceDir: startInput.manifest.workspace.workspaceDir,
        env: startInput.env,
        ...(startInput.mcpServers === undefined ? {} : { mcpServers: startInput.mcpServers }),
        ...(startInput.mcpToolsetTools === undefined ? {} : { mcpToolsetTools: startInput.mcpToolsetTools }),
        ...(startInput.approvalChannel === undefined ? {} : { approvalChannel: startInput.approvalChannel }),
      },
    });
    void prepared;
    if (this.startError) throw this.startError;
    if (this.startGate) await this.startGate;
    this.sessionCounter += 1;
    const session = new StubSession(startInput.manifest.sessionRef ?? `stub-session-${this.sessionCounter}`, startInput.approvalChannel);
    this.sessions.push(session);
    return session;
  }
}
