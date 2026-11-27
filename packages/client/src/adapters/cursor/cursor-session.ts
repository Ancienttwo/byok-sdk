import type { AgentEvent } from '@byok-sdk/protocol';
import type { StartCursorAcpSession, RawAcpSession, AcpRecord } from '../../runtime/acp-session-runtime.js';
import { RuntimeExecutionFailure, isRuntimeDisposalFailure, isRuntimeExecutionFailure, runtimeFailureClassOf } from '../../runtime-failure.js';
import { sessionCredentialRedactor } from '../../runtime/claude-session-runtime.js';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import { SteerUnsupportedError, PolicyUnsupportedError, offerSelection, type MessageDraftDelta, type RuntimeInputImage,
  type RuntimeOperationInstructionStartInput, type RuntimeTaskInput, type Session } from '../../types.js';
import { AsyncQueue } from '../../util/async-queue.js';
import { AcpTurnBuffer } from '../acp-turn-buffer.js';
import { requireImageInput } from '../input-images.js';
import { withoutProviderCredentials } from '../provider-credential-environment.js';
import { resolveRuntimeInvocation, runtimeInvocationHost } from '../runtime-invocation.js';
import { haltGate, oarCancelSettled, raceDeadline, RetryableOnce } from '../session-kit.js';
import { objectRecord } from '../shared-rules.js';
import type { CursorAdapterOptions } from './cursor-adapter.js';
import { CURSOR_LOGIN_REQUIRED } from './cursor-policy.js';

type OwnedChild = ReturnType<ReturnType<typeof createOwnedLineProcessSpawn>>;
const failure = (reason: string) => new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason });

export class CursorSession implements Session {
  sessionRef = '';
  private raw?: RawAcpSession;
  private child?: OwnedChild;
  private readonly output = new AsyncQueue<AgentEvent | MessageDraftDelta>();
  private readonly projection = new AcpTurnBuffer();
  private readonly disposal = new RetryableOnce();
  private active?: { readonly ended: PromiseWithResolvers<void>; sending?: Promise<void> };
  private failed?: RuntimeExecutionFailure;
  private interrupting = false;
  private closing = false;

  constructor(private readonly input: RuntimeOperationInstructionStartInput, private readonly cwd: string, private readonly model: string | undefined,
    private readonly effort: string | undefined, private readonly interruptTimeoutMs: number) {}

  get capabilities() { return { images: this.raw?.capabilities.images === true }; }
  get exitedOnItsOwn() { return this.child?.exitedOnItsOwn === true; }

  async open(start: StartCursorAcpSession, command: string, options: CursorAdapterOptions, retainedBytes: number): Promise<void> {
    const { manifest, mcpServers, signal } = this.input;
    const env = withoutProviderCredentials({ ...this.input.env, ...this.input.scratch.env });
    const servers = Object.entries(mcpServers ?? {}).map(([name, server]) => ({ name, command: server.command, args: server.args }));
    const redactor = sessionCredentialRedactor({ env, mcpServers: servers });
    const spawn = createOwnedLineProcessSpawn({ nativeAssetRoot: options.nativeAssetRoot, spawnFn: options.spawnFn, label: 'cursor acp', stderrRedactor: redactor });
    this.raw = await start((bin, args, opts) => {
      signal?.throwIfAborted();
      const invocation = resolveRuntimeInvocation(bin, runtimeInvocationHost(opts.env));
      const child = spawn(invocation.command, [...invocation.args, ...args], opts);
      this.child = child;
      void child.exited.then(() => this.fail(new RuntimeExecutionFailure({
        phase: 'run', retry: 'non-retryable', reason: 'cursor acp exited', failure: { class: 'runtime_exited' },
      })), error => this.fail(error));
      // Owned disposal retains retryable failures. ACP only observes the process exit.
      const exited = new Promise<number | null>(resolve => child.onExit(resolve));
      return { ...haltGate(child, () => this.failed !== undefined), exited };
    }, { kind: 'available', via: 'executable', command }, {
      cwd: this.cwd, env, retainedBytes, model: this.model, effort: this.effort, resume: manifest.sessionRef, mcpServers: servers,
    }, {
      startupSignal: signal,
      onReady: id => {
        if (manifest.sessionRef !== undefined && manifest.sessionRef !== id) {
          throw new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason: 'Cursor resume returned a different session ID' });
        }
        this.sessionRef = id;
      },
      onRecord: record => this.record(record),
    });
    signal?.throwIfAborted();
    if (this.failed) throw this.failed;
  }

  private record(record: AcpRecord): void {
    if (this.failed || !this.active || record.kind !== 'frame' || record.sessionId !== this.sessionRef || record.agentPath.length !== 0) return;
    const body = objectRecord(record.body);
    if (!Array.isArray(body?.events)) return;
    try {
      const emit = (event: AgentEvent) => { this.output.push(event); };
      const update = objectRecord(objectRecord(body.native)?.update);
      const ended = this.projection.consume(body.events, update, emit, {
        draft: text => this.output.push({ type: 'message_draft_delta', text, startsMessage: false }),
      });
      if (ended === undefined) return;
      this.projection.end(emit, ended.kind === 'aborted');
      this.projection.flushUsage(emit);
      this.settleTurn();
      if (ended.kind === 'failed') {
        const classification = ended.fromText === true ? 'unknown' : runtimeFailureClassOf(ended.failure);
        const reason = classification === 'auth' ? CURSOR_LOGIN_REQUIRED : ended.reason;
        this.fail(new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', failure: { class: classification },
          reason: typeof reason === 'string' ? reason : 'Cursor turn failed' }));
      } else if (ended.kind === 'aborted' && !this.interrupting && !this.closing) {
        this.fail(failure('Cursor cancelled the turn'));
      } else {
        this.output.push({ type: 'turn_end' });
      }
    } catch (error) { this.fail(error); }
  }

  private settleTurn(): void {
    this.active?.ended.resolve();
    this.active = undefined;
  }

  private fail(error: unknown): void {
    if (this.closing) return;
    this.failed ??= isRuntimeExecutionFailure(error) ? error : failure('Cursor ACP stream failed');
    this.settleTurn();
    this.output.end();
  }

  get events(): AsyncIterable<AgentEvent | MessageDraftDelta> {
    const session = this;
    return (async function* () {
      yield* session.output;
      if (session.failed) throw session.failed;
    })();
  }

  async prompt(text: string, images?: readonly RuntimeInputImage[]): Promise<void> {
    if (this.failed) throw this.failed;
    if (!this.raw || this.closing) throw failure('Cursor session is closed');
    if (this.active || this.interrupting) throw failure('Cursor turn is already active');
    requireImageInput(images, this.capabilities.images);
    const active: NonNullable<CursorSession['active']> = { ended: Promise.withResolvers<void>() };
    this.active = active;
    active.sending = this.raw.prompt(text, { images }).then(({ response: { body } }) => {
      if (body.kind !== 'accepted') throw failure(body.reason ?? 'Cursor prompt refused');
    });
    try { await active.sending; }
    catch (error) {
      if (this.active === active) this.settleTurn();
      throw error;
    }
  }

  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string') throw new PolicyUnsupportedError('Cursor requires a string instruction');
    const selection = offerSelection(task.target);
    if (task.target.lane === 'harness' && (task.target.harnessId !== 'cursor' ||
      (selection?.mode !== 'device-default' && selection?.mode !== 'adapter-model'))) {
      throw new PolicyUnsupportedError('Cursor cannot change the session runtime or credential source');
    }
    const model = selection?.mode === 'adapter-model' ? selection.modelId : undefined;
    if ((model !== undefined && model !== this.model) || (task.modelId !== undefined && task.modelId !== this.model) ||
      (task.effort !== undefined && task.effort !== this.effort)) {
      throw new PolicyUnsupportedError('Cursor cannot change model or effort on a persistent session');
    }
    await this.prompt(task.instruction, task.images);
  }

  async steer(): Promise<void> { throw new SteerUnsupportedError('cursor', 'Cursor ACP has no steering channel'); }

  async interrupt(): Promise<void> {
    const { active, raw } = this;
    if (!raw || !active || this.interrupting || this.closing) return;
    this.interrupting = true;
    try {
      const cancelled = async () => {
        await active.sending;
        if (this.active === active && !this.closing) await oarCancelSettled(raw.abort(), active.ended.promise, 'cursor');
      };
      await raceDeadline(cancelled(), this.interruptTimeoutMs, () => failure('Cursor interrupt timed out'));
    } catch (error) {
      this.fail(error);
      await this.close();
      throw error;
    } finally { this.interrupting = false; }
  }

  close(): Promise<void> {
    this.closing = true;
    return this.disposal.run(async () => {
      try {
        try {
          // Native close can reparent a shell that left the CLI's process group.
          try { this.child?.observeDescendants(); }
          finally { await this.raw?.dispose(); }
        } catch (error) { if (!this.failed || isRuntimeDisposalFailure(error)) throw error; }
        finally { await this.child?.dispose(); }
        await this.input.scratch.release();
        this.raw = undefined;
      } finally {
        this.settleTurn();
        this.output.end();
      }
    });
  }
}
