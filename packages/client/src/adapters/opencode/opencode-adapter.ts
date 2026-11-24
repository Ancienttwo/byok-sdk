import type { spawn as nodeSpawn } from 'node:child_process';
import { createRuntimeReaders } from '../../runtime/runtime-readers.js';
import type { RuntimeListModelsOptions, RuntimeModelCatalog } from '../../runtime/runtime-reader-types.js';
import type { AgentEvent } from '@byok-sdk/protocol';
import { AsyncQueue } from '../../util/async-queue.js';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeExecutionFailure, isRuntimeDisposalFailure, runtimeFailureClassOf } from '../../runtime-failure.js';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment.js';
import { sessionCredentialRedactor } from '../../runtime/claude-session-runtime.js';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import { createOwnedTerminalSpawn } from '../../runtime/owned-terminal-process.js';
import { requireImageInput } from '../input-images.js';
import type { RuntimeInputOptions } from '../../types.js';
import { SteerUnsupportedError } from '../../types.js';
import type { AcpRecord, RawAcpSession } from '../../runtime/acp-session-runtime.js';
import { freezeRuntimeAdapterDescriptor, PolicyUnsupportedError, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type RuntimeOperationStartInput, type RuntimeVersionPolicy, type Session } from '../../types.js';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy.js';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome.js';
import { resolveRuntimeCommand, runtimeExecutableFields, sameDetectedExecutable } from '../runtime-executable.js';
import { resolveManagedRuntime } from '../managed-runtime-path.js';
import { withoutProviderCredentials } from '../provider-credential-environment.js';
import { resolveRuntimeInvocation, runtimeInvocationHost } from '../runtime-invocation.js';
import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits.js';
import { haltGate, oarCancelSettled, raceDeadline, RetryableOnce } from '../session-kit.js';
import type { ResolvedBin } from '../codex/resolve-bin.js';
import { agentPersona } from '../agent-persona.js';
import { oarStartClassifier, runtimeStartFailure } from '../runtime-start-failure.js';
import { OPENCODE_RUNTIME_CAPABILITIES } from './opencode-capabilities.js';
import { OPENCODE_VERSION_POLICY, opencodeVersionToken, opencodeVersionUnsupported } from './opencode-version.js';
import { resolveOpenCodeBin } from './resolve-bin.js';
import { object, OpenCodeProjection, type OpenCodeTurnOutcome } from './projection.js';

/** OAR's record of a child's own update that arrived once the root prompt was answered: native only, no events (vendored `shared/acp/records.ts`). */
const CHILD_UPDATE_AFTER_ANSWER = 'opencode/session/child_update/after_answer';

export interface OpenCodeAdapterOptions {
  /** SDK install root in which to find a managed runtime. */
  runtimeInstallRoot?: string;
  /** Ordered Host model IDs. Without a list, each offer selects a model explicitly. */
  models?: readonly string[];
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
  #runtimeReaders?: ReturnType<typeof createRuntimeReaders>;

  private get readers() {
    return this.#runtimeReaders ??= createRuntimeReaders(this, {
      nativeAssetRoot: this.options.nativeAssetRoot,
      spawnFn: this.options.spawnFn,
      command: (env) => resolveRuntimeCommand(this.options.resolveBin, () => resolveOpenCodeBin(env), () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'opencode')).bin.command,
      version: opencodeVersionToken,
      environment: env => ({ env: withoutProviderCredentials(env) }),
    });
  }

  listModels(options: RuntimeListModelsOptions = {}): Promise<RuntimeModelCatalog> {
    return this.readers.listModels(options, async (installation, reader) => {
      const { opencodeListModels } = await import('#byok-oar-readers');
      return opencodeListModels(installation, reader);
    });
  }

  private readonly options: OpenCodeAdapterOptions & { maxRetainedBytes: number; interruptTimeoutMs: number };
  private readonly environment: RuntimeEnvironmentPolicy;
  private readonly policy?: RuntimeVersionPolicy;

  constructor(options: OpenCodeAdapterOptions = {}) {
    const { models } = options;
    if (models !== undefined && (!Array.isArray(models) || models.length === 0 || models.some(id => typeof id !== 'string' || !id.trim())))
      throw new TypeError('OpenCodeAdapterOptions.models must be a nonempty list of nonblank Host model ids');
    const maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'opencode');
    const interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs, 'opencode');
    this.environment = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'OpenCodeAdapterOptions.runtimeEnvironment');
    this.policy = resolveRuntimeVersionPolicy(OPENCODE_VERSION_POLICY, options.versionPolicy);
    this.options = { ...options, ...(models === undefined ? {} : { models: Object.freeze([...models]) }), maxRetainedBytes, interruptTimeoutMs };
  }

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({ id: 'opencode',
      selectionModes: this.options.models === undefined ? ['adapter-model'] : ['device-default', 'adapter-model'],
      ...(this.options.models === undefined ? {} : { defaultModelModes: ['adapter-model'] }),
      supportsEffort: true,
      // `platforms` is OS-grained: `darwin` covers x64 and arm64; `win32` is x64. Each has the lifecycle contract on both lines (#1593).
      platforms: ['darwin', 'win32'], capabilities: OPENCODE_RUNTIME_CAPABILITIES,
      ...(this.policy === undefined ? {} : { versionPolicy: this.policy }),
    });
  }
  runtimeEnvironment() { return buildRuntimeEnvironment(this.environment); }

  private async resolveInvocation() {
    const env = withoutProviderCredentials((await this.runtimeEnvironment()).env);
    const resolved = resolveRuntimeCommand(this.options.resolveBin, () => resolveOpenCodeBin(env), () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'opencode'));
    const invocation = resolveRuntimeInvocation(resolved.bin.command, runtimeInvocationHost(env));
    return { env, resolved, invocation };
  }

  private async probe(signal?: AbortSignal): Promise<{ detected: RuntimeDetectResult; command?: string; version?: string }> {
    try {
      const { env, resolved, invocation } = await this.resolveInvocation();
      const version = await probeRuntimeVersion(invocation.command, 15_000, env, invocation.args, signal);
      if (version.kind !== 'available') return { detected: version };
      const token = opencodeVersionToken(version.stdout.trim() || version.stderr);
      if (token === undefined) return { detected: { kind: 'refused', reason: 'acp_unavailable' } };
      const unsupportedVersion = opencodeVersionUnsupported(token);
      if (unsupportedVersion !== undefined) return { detected: { kind: 'refused', reason: 'acp_unavailable', unsupportedVersion } };
      return { command: resolved.bin.command, version: token, detected: {
        kind: 'available', version: token, rawVersion: version.stdout,
        sessionCapabilities: (await import('#byok-acp-runtime')).opencodeSessionCapabilities({ kind: 'available', via: 'executable', command: resolved.bin.command, version: token }),
        ...runtimeExecutableFields(resolved, invocation.executable), ...runtimeVersionDetectionFields(this.policy, token),
      } };
    } catch (error) {
      signal?.throwIfAborted();
      return { detected: classifyDetectError(error) };
    }
  }

  /** The admission observation when it is of the executable resolved now; otherwise a fresh probe. */
  private async admittedProbe(input: RuntimeAdapterPrepareInput): Promise<{ detected: RuntimeDetectResult; command?: string; version?: string }> {
    const detected = input.detected;
    if (detected?.kind === 'available' && detected.version !== undefined) {
      let reused: { command: string } | undefined;
      try {
        const { resolved, invocation } = await this.resolveInvocation();
        if (sameDetectedExecutable(detected, runtimeExecutableFields(resolved, invocation.executable))) reused = { command: resolved.bin.command };
      } catch { /* resolution failed: the fresh probe classifies it */ }
      if (reused !== undefined) return { detected, command: reused.command, version: detected.version };
    }
    return this.probe(input.signal);
  }

  async detect(signal?: AbortSignal): Promise<RuntimeDetectResult> { return (await this.probe(signal)).detected; }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const { target, effort } = input.offer;
    const selection = target.lane === 'harness' ? target.selection : undefined;
    if (target.lane === 'harness' && (target.harnessId !== 'opencode' || (selection?.mode !== 'device-default' && selection?.mode !== 'adapter-model'))) {
      return { kind: 'reject', reason: 'OpenCode does not support the requested selection', retryable: false };
    }
    const modelId = selection?.mode === 'adapter-model' ? selection.modelId : undefined;
    const configured = this.options.models;
    const models = modelId === undefined ? configured : [modelId];
    if (models === undefined || modelId?.trim() === '') {
      return { kind: 'reject', code: 'invalid_request', reason: 'OpenCode requires a model ID when no models are configured', retryable: false };
    }
    if (modelId !== undefined && configured !== undefined && !configured.includes(modelId)) {
      return { kind: 'reject', code: 'model_unavailable', reason: 'The requested OpenCode model is outside the configured list', retryable: false };
    }
    const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({
      name, command: server.command, ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    }));
    if (mcpServers.some(server => !server.name || typeof server.command !== 'string' || !server.command.trim() ||
      server.args?.some(arg => typeof arg !== 'string') || Object.values(server.env ?? {}).some(value => typeof value !== 'string')))
      return { kind: 'reject', reason: 'invalid opencode Host MCP server', retryable: false };
    const probe = await this.admittedProbe(input);
    if (probe.detected.kind !== 'available' || probe.command === undefined || probe.version === undefined)
      return { kind: 'reject', reason: `opencode installation refused: ${probe.detected.kind}`, retryable: false };
    const { command, version, detected: { executableSource, versionVerdict } } = probe;
    return {
      kind: 'prepared',
      detected: { version, executableSource, versionVerdict },
      operation: { start: start => {
        const actual = start.manifest.selection;
        if (actual?.mode !== selection?.mode || (actual?.mode === 'adapter-model' && actual.modelId !== modelId) || start.manifest.effort !== effort) {
          throw authority('prepared OpenCode operation received a manifest with different runtime selection');
        }
        return this.start(start, command, version, models, effort);
      } },
    };
  }

  private async start(input: RuntimeOperationStartInput, command: string, version: string, models: readonly string[], effort: string | undefined): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('opencode requires a resolved instruction');
    if (!input.manifest.cwd) throw authority('opencode requires a sealed cwd');
    if (version.startsWith('2.') && input.manifest.homeAccess === 'memory-reader')
      throw authority('opencode v2 does not load the instructions configuration used for session-local appended prompts; ACP exposes no equivalent transient instruction channel');
    const persona = input.manifest.homeAccess === 'memory-reader'
      ? await agentPersona('opencode', input.manifest, { reappliesOnResume: true }) : undefined;
    const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
    const session = new OpenCodeSession(input, this.options, command, version, models, effort, mcpServers, this.options.maxRetainedBytes, this.options.interruptTimeoutMs, persona);
    try {
      await session.start();
      return session;
    } catch (error) {
      try { await session.close(); }
      catch (disposal) { throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal }); }
      const acp = await import('#byok-acp-runtime');
      const classify = oarStartClassifier(acp);
      throw runtimeStartFailure(error, {
        classify: cause => cause instanceof acp.AcpError && (cause.kind === 'timeout' || cause.kind === 'startup_directory')
          ? { retry: 'retryable', failure: { class: 'unknown' } }
          : classify(cause),
        exitedOnItsOwn: session.exitedOnItsOwn, runtime: 'opencode',
      });
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
    private readonly models: readonly string[], private readonly effort: string | undefined,
    private readonly mcpServers: readonly { name: string; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }[],
    private readonly maxRetainedBytes: number, private readonly interruptTimeoutMs: number, private readonly persona?: string) {}

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
    const env = withoutProviderCredentials({ ...this.input.env, ...this.input.scratch.env });
    const redactor = sessionCredentialRedactor({ env, mcpServers: this.mcpServers });
    const spawn = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'opencode acp', stderrRedactor: redactor });
    const expected = this.sessionRef || this.input.manifest.sessionRef;
    this.raw = await acp.opencodeSession((bin, args, opts) => {
      this.input.signal?.throwIfAborted();
      if (this.closing) throw infrastructure('opencode session is closing');
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
      cwd: this.input.manifest.cwd!, env,
      retainedBytes: this.maxRetainedBytes, model: this.models[index]!,
      ...(this.effort === undefined ? {} : { effort: this.effort }),
      ...(this.mcpServers.length === 0 ? {} : { mcpServers: this.mcpServers }),
      ...(expected === undefined ? {} : { resume: expected }),
      ...(this.persona === undefined ? {} : { appendSystemPrompt: this.persona }),
    }, {
      ...(this.input.signal === undefined ? {} : { startupSignal: this.input.signal }),
      onReady: id => {
        if (expected !== undefined && expected !== id) throw authority('opencode resume returned a different native session id');
        if (this.sessionRef === '') this.sessionRef = id;
        this.projection = new OpenCodeProjection(id);
      },
      onRecord: record => this.record(record, index),
      // Omitted permission hook cancels every unsupported request in the maintained ACP boundary.
    });
    if (this.failure) throw this.failure;
    if (this.model !== this.models[index]) throw authority('opencode session model readback does not match the Host selected model');
  }

  private record(record: AcpRecord, index: number): void {
    if (this.failure) return;
    try {
      const body = object(record.body);
      if (record.kind === 'frame' && record.sessionId === this.sessionRef && Array.isArray(body?.events)) {
        for (const value of body.events) {
          const event = object(value);
          if (event?.kind === 'model' && typeof event.model === 'string') {
            this.model = event.model;
            if (this.prompting && this.model !== this.models[index]) throw authority('opencode changed the selected model');
          }
        }
      }
      if (record.kind === 'frame' && body?.type === CHILD_UPDATE_AFTER_ANSWER) {
        console.warn(`[byok/client] opencode child ${record.sessionId} update after the root prompt answer is not delivered to this turn`);
        return;
      }
      // The turn ends at the root turn end: later frames are recorded by OAR and not delivered to it.
      if (this.prompting) this.projection?.consume(record, event => this.queue.push(event), outcome => { this.prompting = false; this.settle?.(outcome); });
    } catch (error) { this.halt(error); throw error; }
  }
  private halt(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error) ? error : infrastructure(error instanceof Error ? error.message : 'opencode stream failed');
    this.settle?.({ kind: 'failed' });
    this.haltExit = this.child?.exited;
    this.child?.kill();
  }
  get capabilities() { return { images: this.raw?.capabilities.images === true }; }

  private async prompt(): Promise<void> {
    requireImageInput(this.input.images, this.capabilities.images);
    this.prompting = true;
    const result = await this.raw!.prompt(this.input.instruction, { images: this.input.images });
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
        if (!this.cancelled && !outcome.fromText && outcome.failure === 'rate_limited' && !this.projection?.output && index === 0 && this.models.length > 1 && this.effort === undefined) {
          // Resume the admitted native identity and apply the next model through ACP; never create a replacement session.
          try { await this.open(1); }
          catch (error) {
            if (isRuntimeDisposalFailure(error)) throw error;
            throw failure(error);
          }
          if (this.closing || this.cancelled) return;
          this.queue.push({ type: 'error', message: JSON.stringify({ event: 'model_switch', from: this.models[0], to: this.models[1], reason: 'rate_limited' }) });
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
    this.prompting = false;
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
  async steer(text: string, options?: RuntimeInputOptions): Promise<void> {
    if (!this.raw?.steer) throw new SteerUnsupportedError('opencode', 'opened session has no steering channel');
    requireImageInput(options?.images, this.capabilities.images);
    const result = await this.raw.steer(text, options);
    if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'opencode steer refused');
  }
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
