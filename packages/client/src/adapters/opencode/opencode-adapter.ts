import type { spawn as nodeSpawn } from 'node:child_process';
import type { AgentEvent } from '@byok-sdk/protocol';
import { AsyncQueue } from '../../util/async-queue.js';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeExecutionFailure, isRuntimeDisposalFailure, runtimeFailureClassOf } from '../../runtime-failure.js';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment.js';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import { createOwnedTerminalSpawn } from '../../runtime/owned-terminal-process.js';
import type { AcpRecord, RawAcpSession } from '../../runtime/acp-session-runtime.js';
import { freezeRuntimeAdapterDescriptor, PolicyUnsupportedError, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type RuntimeOperationStartInput, type RuntimeVersionPolicy, type Session } from '../../types.js';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy.js';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome.js';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable.js';
import { resolveRuntimeInvocation, runtimeInvocationHost } from '../runtime-invocation.js';
import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits.js';
import { haltGate, oarCancelSettled, raceDeadline, RetainedRecordBudget, RetryableOnce } from '../session-kit.js';
import type { ResolvedBin } from '../codex/resolve-bin.js';
import { agentPersona } from '../agent-persona.js';
import { oarStartClassifier, runtimeStartFailure } from '../runtime-start-failure.js';
import { OPENCODE_RUNTIME_CAPABILITIES } from './opencode-capabilities.js';
import { OPENCODE_VERSION_POLICY, opencodeVersionToken } from './opencode-version.js';
import { resolveOpenCodeBin } from './resolve-bin.js';
import { object, OpenCodeProjection, type OpenCodeTurnOutcome } from './projection.js';

export interface OpenCodeAdapterOptions {
  /** Ordered Host model ids. The SDK has no default and does not consult prices or a model catalog. */
  models: readonly string[];
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** No default qualification policy exists until native OS/line canaries pass. */
  versionPolicy?: RuntimeVersionPolicy;
  resolveBin?: () => ResolvedBin;
  nativeAssetRoot?: string;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  interruptTimeoutMs?: number;
}

const authority = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason });
const infrastructure = (reason: string) => new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason });

/** Native OpenCode ACP, addressed through harnessId `opencode`; never touches user configuration or login storage. */
export class OpenCodeAdapter implements RuntimeAdapter {
  private readonly options: OpenCodeAdapterOptions & { maxRetainedBytes: number; interruptTimeoutMs: number };
  private readonly environment: RuntimeEnvironmentPolicy;
  private readonly policy?: RuntimeVersionPolicy;

  constructor(options: OpenCodeAdapterOptions) {
    if (!Array.isArray(options?.models) || options.models.length === 0 || options.models.some(id => typeof id !== 'string' || !id.trim()))
      throw new TypeError('OpenCodeAdapterOptions.models must be a nonempty list of nonblank Host model ids');
    const maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'opencode');
    const interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs, 'opencode');
    this.environment = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'OpenCodeAdapterOptions.runtimeEnvironment');
    this.policy = resolveRuntimeVersionPolicy(OPENCODE_VERSION_POLICY, options.versionPolicy);
    this.options = { ...options, models: Object.freeze([...options.models]), maxRetainedBytes, interruptTimeoutMs };
  }

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({ id: 'opencode', supportsDispatchSelection: false,
      // `platforms` is OS-grained: `darwin` covers x64 and arm64; `win32` is x64. Each has the lifecycle contract on both lines (#1593).
      platforms: ['darwin', 'win32'], capabilities: OPENCODE_RUNTIME_CAPABILITIES,
      ...(this.policy === undefined ? {} : { versionPolicy: this.policy }),
    });
  }
  runtimeEnvironment() { return buildRuntimeEnvironment(this.environment); }

  private async probe(): Promise<{ detected: RuntimeDetectResult; command?: string; version?: string }> {
    try {
      const { env } = await this.runtimeEnvironment();
      const resolved = resolveRuntimeCommand(this.options.resolveBin, () => resolveOpenCodeBin(env));
      const invocation = resolveRuntimeInvocation(resolved.bin.command, runtimeInvocationHost(env));
      const version = await probeRuntimeVersion(invocation.command, 15_000, env, invocation.args);
      if (version.kind !== 'available') return { detected: version };
      const token = opencodeVersionToken(version.stdout);
      if (token === undefined) return { detected: { kind: 'refused', reason: 'acp_unavailable' } };
      return { command: resolved.bin.command, version: token, detected: {
        kind: 'available', version: token, rawVersion: version.stdout,
        ...runtimeExecutableFields(resolved, invocation.executable), ...runtimeVersionDetectionFields(this.policy, token),
      } };
    } catch (error) { return { detected: classifyDetectError(error) }; }
  }
  async detect(): Promise<RuntimeDetectResult> { return (await this.probe()).detected; }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({
      name, command: server.command, ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    }));
    if (mcpServers.some(server => !server.name || typeof server.command !== 'string' || !server.command.trim() ||
      server.args?.some(arg => typeof arg !== 'string') || Object.values(server.env ?? {}).some(value => typeof value !== 'string')))
      return { kind: 'reject', reason: 'invalid opencode Host MCP server', retryable: false };
    const probe = await this.probe();
    if (probe.detected.kind !== 'available' || probe.command === undefined || probe.version === undefined)
      return { kind: 'reject', reason: `opencode installation refused: ${probe.detected.kind}`, retryable: false };
    const { command, version } = probe;
    return { kind: 'prepared', operation: { start: input => this.start(input, command, version) } };
  }

  private async start(input: RuntimeOperationStartInput, command: string, version: string): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('opencode requires a resolved instruction');
    if (!input.manifest.cwd) throw authority('opencode requires a sealed cwd');
    if (version.startsWith('2.') && input.manifest.homeAccess === 'memory-reader')
      throw authority('opencode v2 does not load the instructions configuration used for session-local appended prompts; ACP exposes no equivalent transient instruction channel');
    const persona = input.manifest.homeAccess === 'memory-reader'
      ? await agentPersona('opencode', input.manifest, { reappliesOnResume: true }) : undefined;
    const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
    const session = new OpenCodeSession(input, this.options, command, version, mcpServers, this.options.maxRetainedBytes, this.options.interruptTimeoutMs, persona);
    try {
      await session.start();
      return session;
    } catch (error) {
      try { await session.close(); }
      catch (disposal) { throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal }); }
      throw runtimeStartFailure(error, { classify: oarStartClassifier(await import('#byok-acp-runtime')), exitedOnItsOwn: session.exitedOnItsOwn, runtime: 'opencode' });
    }
  }
}

type OwnedChild = ReturnType<ReturnType<typeof createOwnedLineProcessSpawn>>;

class OpenCodeSession implements Session {
  sessionRef = '';
  private readonly queue = new AsyncQueue<AgentEvent>();
  private raw?: RawAcpSession;
  private child?: OwnedChild;
  private projection?: OpenCodeProjection;
  private model?: string;
  private prompting = false;
  private readonly recordBudget: RetainedRecordBudget;
  private failure?: RuntimeExecutionFailure;
  private haltExit?: Promise<number | null>;
  private ending = false;
  private cancelled = false;
  private closing = false;
  private stopAttempt?: Promise<void>;
  private readonly closeOnce = new RetryableOnce();
  private runner?: Promise<void>;
  private settle?: (outcome: OpenCodeTurnOutcome) => void;
  private outcome?: Promise<OpenCodeTurnOutcome>;
  private opening?: Promise<void>;

  constructor(private readonly input: RuntimeOperationStartInput & { kind: 'instruction' }, private readonly options: OpenCodeAdapterOptions,
    private readonly command: string, private readonly version: string,
    private readonly mcpServers: readonly { name: string; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }[],
    maxRetainedBytes: number, private readonly interruptTimeoutMs: number, private readonly persona?: string) {
    this.recordBudget = new RetainedRecordBudget(maxRetainedBytes, 'opencode');
  }

  get exitedOnItsOwn(): boolean { return this.child?.exitedOnItsOwn === true; }

  async start(): Promise<void> {
    await this.open(0);
    if (this.input.signal?.aborted) throw infrastructure('opencode start was aborted');
    await this.prompt();
    this.runner = this.finish(0).catch(error => {
      this.failure ??= isRuntimeExecutionFailure(error) ? error : infrastructure(error instanceof Error ? error.message : 'opencode execution failed');
    }).finally(() => { this.queue.end(); });
  }

  private open(index: number): Promise<void> {
    this.opening = this.openRuntime(index);
    return this.opening;
  }
  private async openRuntime(index: number): Promise<void> {
    const acp = await import('#byok-acp-runtime');
    if (this.closing) throw infrastructure('opencode session is closing');
    this.raw = undefined;
    this.prompting = false;
    this.child = undefined;
    this.haltExit = undefined;
    this.ending = false;
    this.model = undefined;
    this.stopAttempt = undefined;
    this.outcome = new Promise(resolve => { this.settle = resolve; });
    const spawn = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'opencode acp' });
    const expected = this.sessionRef || this.input.manifest.sessionRef;
    this.raw = await acp.opencodeSession((bin, args, opts) => {
      const invocation = resolveRuntimeInvocation(bin, runtimeInvocationHost(opts.env));
      const child = spawn(invocation.command, [...invocation.args, ...args], opts);
      this.child = child;
      void child.exited.then(() => {
        // OAR reaps a refused opening before rejecting it; that requested cleanup is not an execution exit.
        if (this.child === child && !this.ending && child.exitedOnItsOwn) this.halt(new RuntimeExecutionFailure({
          phase: 'run', retry: 'non-retryable', reason: 'opencode acp exited', failure: { class: 'runtime_exited' },
        }));
      }, error => { if (this.child === child) this.halt(error); });
      // ACP consumes exit notifications; owned disposal separately owns retryable
      // quiescence failures, which must not permanently reject ACP's exit state.
      const exited = new Promise<number | null>(resolve => child.onExit(resolve));
      return { ...haltGate(child, () => this.failure !== undefined), exited };
    }, (bin, args, opts) => {
      const spawnTerminal = createOwnedTerminalSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn });
      if (opts.shell) return spawnTerminal(bin, args, opts);
      const invocation = resolveRuntimeInvocation(bin, runtimeInvocationHost(opts.env));
      return spawnTerminal(invocation.command, [...invocation.args, ...args], opts);
    },
    { kind: 'available', via: 'executable', command: this.command, version: this.version }, {
      cwd: this.input.manifest.cwd!, env: { ...this.input.env, ...this.input.scratch.env }, model: this.options.models[index]!,
      ...(this.mcpServers.length === 0 ? {} : { mcpServers: this.mcpServers }),
      ...(expected === undefined ? {} : { resume: expected }),
      ...(this.persona === undefined ? {} : { appendSystemPrompt: this.persona }),
    }, {
      onReady: id => {
        if (expected !== undefined && expected !== id) throw authority('opencode resume returned a different native session id');
        if (this.sessionRef === '') this.sessionRef = id;
        this.projection = new OpenCodeProjection(id);
      },
      onRecord: record => this.record(record, index),
      // Omitted permission hook cancels every unsupported request in the maintained ACP boundary.
    });
    if (this.failure) throw this.failure;
    if (this.model !== this.options.models[index]) throw authority('opencode session model readback does not match the Host selected model');
  }

  private record(record: AcpRecord, index: number): void {
    if (this.failure) return;
    try {
      this.recordBudget.add(record);
      const body = object(record.body);
      if (record.kind === 'frame' && record.sessionId === this.sessionRef && Array.isArray(body?.events)) {
        for (const value of body.events) {
          const event = object(value);
          if (event?.kind === 'model' && typeof event.model === 'string') {
            this.model = event.model;
            if (this.prompting && this.model !== this.options.models[index]) throw authority('opencode changed the selected model');
          }
        }
      }
      if (this.prompting) this.projection?.consume(record, event => this.queue.push(event), outcome => this.settle?.(outcome));
    } catch (error) { this.halt(error); throw error; }
  }
  private halt(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error) ? error : infrastructure(error instanceof Error ? error.message : 'opencode stream failed');
    this.settle?.({ kind: 'failed' });
    this.haltExit = this.child?.exited;
    this.child?.kill();
  }
  private async prompt(): Promise<void> {
    this.prompting = true;
    const result = await this.raw!.prompt(this.input.instruction);
    if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'opencode prompt refused');
  }
  private async finish(index: number): Promise<void> {
    try {
      const outcome = await this.outcome!;
      await this.stop();
      if (this.closing) return;
      if (this.failure) throw this.failure;
      if (outcome.kind === 'failed') {
        const failure = (cause?: unknown) => new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason: outcome.reason ?? 'opencode turn failed',
          failure: { class: outcome.fromText ? 'unknown' : runtimeFailureClassOf(outcome.failure) } }, { cause });
        if (!this.cancelled && !outcome.fromText && outcome.failure === 'rate_limited' && !this.projection?.output && index === 0 && this.options.models.length > 1) {
          // Resume the admitted native identity and apply the next model through ACP; never create a replacement session.
          try { await this.open(1); }
          catch (error) {
            if (isRuntimeDisposalFailure(error)) throw error;
            throw failure(error);
          }
          if (this.closing || this.cancelled) return;
          this.queue.push({ type: 'error', message: JSON.stringify({ event: 'model_switch', from: this.options.models[0], to: this.options.models[1], reason: 'rate_limited' }) });
          await this.prompt();
          await this.finish(1);
          return;
        }
        throw failure();
      }
      this.queue.push({ type: 'turn_end' });
    } finally {
      await this.stop();
    }
  }
  private stop(): Promise<void> {
    this.ending = true;
    this.stopAttempt ??= (async () => {
      try {
        try { this.child?.observeDescendants(); }
        finally {
          if (this.haltExit !== undefined) {
            // kill() can fail before signalling. Retry owned disposal before waiting
            // for exit, and let its fresh receipt supersede a rejected exit receipt.
            await this.child?.dispose();
            await this.haltExit.catch(() => {});
          }
          // ACP must observe a halted process's exit before it can send session/close.
          await this.raw?.dispose();
        }
      }
      finally { await this.child?.dispose(); }
    })().catch(error => { this.stopAttempt = undefined; throw error; });
    return this.stopAttempt;
  }
  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return (async function* () {
      for await (const event of self.queue) yield event;
      if (self.failure) throw self.failure;
    })();
  }
  async steer(): Promise<void> { throw new PolicyUnsupportedError('opencode steer is unsupported on both release lines'); }
  async followUp(): Promise<void> { throw new PolicyUnsupportedError('opencode runs one turn per process; resume for a later turn'); }
  async interrupt(): Promise<void> {
    this.cancelled = true;
    if (!this.ending) this.child?.observeDescendants();
    try {
      const settled = this.ending || !this.raw ? this.runner ?? Promise.resolve()
        : oarCancelSettled(this.raw.abort(), this.runner ?? Promise.resolve(), 'opencode').then(() => this.runner);
      await raceDeadline(settled, this.interruptTimeoutMs, () => infrastructure('opencode interrupt timed out'));
    } catch (error) { this.halt(error); await this.close(); throw error; }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.cancelled = true;
    return this.closeOnce.run(async () => {
      try {
        await this.opening?.catch(() => {});
        await this.stop();
        this.settle?.({ kind: 'aborted' });
        await this.runner;
        await this.input.scratch.release();
      } finally { this.queue.end(); }
    });
  }
}
