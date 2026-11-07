import type { spawn as nodeSpawn } from 'node:child_process';
import type { AgentEvent } from '@byok-sdk/protocol';
import { AsyncQueue } from '../../util/async-queue';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeExecutionFailure, isRuntimeDisposalFailure, runtimeFailureClassOf, type RuntimeFailurePhase } from '../../runtime-failure';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import { createOwnedTerminalSpawn } from '../../runtime/owned-terminal-process';
import type { AcpRecord, RawAcpSession } from '../../runtime/acp-session-runtime';
import { freezeRuntimeAdapterDescriptor, PolicyUnsupportedError, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type RuntimeOperationStartInput, type RuntimeVersionPolicy, type Session } from '../../types';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable';
import { resolveRuntimeInvocation, runtimeInvocationHost } from '../runtime-invocation';
import type { ResolvedBin } from '../codex/resolve-bin';
import { agentPersona } from '../agent-persona';
import { OPENCODE_RUNTIME_CAPABILITIES } from './opencode-capabilities';
import { opencodeVersionToken } from './opencode-version';
import { resolveOpenCodeBin } from './resolve-bin';
import { object, OpenCodeProjection, type OpenCodeTurnOutcome } from './projection';

export interface OpenCodeAdapterOptions {
  /** Ordered Host model ids. The SDK has no default and does not consult prices or a model catalog. */
  models: readonly string[];
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** No default qualification policy exists until native OS/line canaries pass. */
  versionPolicy?: RuntimeVersionPolicy;
  /** Internal: marks the source of a daemon-configured policy. */
  versionPolicySource?: 'adapter-option' | 'daemon-config';
  resolveBin?: () => ResolvedBin;
  nativeAssetRoot?: string;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  interruptTimeoutMs?: number;
}

const authority = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });
const infrastructure = (reason: string, phase: RuntimeFailurePhase = 'run') => new RuntimeExecutionFailure({ phase, category: 'infrastructure', retry: 'non-retryable', reason });

/** Native OpenCode ACP, addressed through harnessId `opencode`; never touches user configuration or login storage. */
export class OpenCodeAdapter implements RuntimeAdapter {
  private readonly options: OpenCodeAdapterOptions;
  private readonly environment: RuntimeEnvironmentPolicy;
  private readonly policy?: RuntimeVersionPolicy;

  constructor(options: OpenCodeAdapterOptions) {
    if (!Array.isArray(options?.models) || options.models.length === 0 || options.models.some(id => typeof id !== 'string' || !id.trim()))
      throw new TypeError('OpenCodeAdapterOptions.models must be a nonempty list of nonblank Host model ids');
    for (const [name, value] of [['maxRetainedBytes', options.maxRetainedBytes ?? 16 * 1024 * 1024], ['interruptTimeoutMs', options.interruptTimeoutMs ?? 1000]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || (name === 'interruptTimeoutMs' && value > 2_147_483_647)) throw new TypeError(`invalid opencode ${name}`);
    }
    this.environment = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'OpenCodeAdapterOptions.runtimeEnvironment');
    this.policy = resolveRuntimeVersionPolicy(options.versionPolicy === undefined ? {} : options.versionPolicySource === 'daemon-config'
      ? { daemonConfig: options.versionPolicy } : { adapterOption: options.versionPolicy }).policy;
    this.options = { ...options, models: Object.freeze([...options.models]) };
  }

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({ id: 'opencode', supportsDispatchSelection: false,
      // PR 3 adds only OS/line combinations with native first-task, resume and cleanup evidence.
      platforms: [], capabilities: OPENCODE_RUNTIME_CAPABILITIES,
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
    if (input.offer.dispatchSelection !== undefined) return { kind: 'reject', reason: 'opencode models belong to the Host candidate list', retryable: false };
    if (Object.keys(input.mcpServers ?? {}).length > 0) return { kind: 'reject', reason: 'opencode Host MCP toolsets are not qualified on both release lines', retryable: false };
    const probe = await this.probe();
    if (probe.detected.kind !== 'available' || probe.command === undefined || probe.version === undefined)
      return { kind: 'reject', reason: `opencode installation refused: ${probe.detected.kind}`, retryable: false };
    const { command, version } = probe;
    return { kind: 'prepared', operation: { start: input => this.start(input, command, version) } };
  }

  private async start(input: RuntimeOperationStartInput, command: string, version: string): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('opencode requires a resolved instruction');
    if (input.manifest.dispatchSelection !== undefined) throw authority('opencode cannot receive a dispatch selection');
    if (!input.manifest.cwd) throw authority('opencode requires a sealed cwd');
    if (Object.keys(input.mcpServers ?? {}).length > 0) throw authority('opencode Host MCP toolsets are not qualified');
    if (version.startsWith('2.') && input.manifest.homeAccess === 'memory-reader')
      throw authority('opencode v2 does not load the instructions configuration used for session-local appended prompts; ACP exposes no equivalent transient instruction channel');
    const persona = input.manifest.homeAccess === 'memory-reader'
      ? await agentPersona('opencode', input.manifest, { reappliesOnResume: true }) : undefined;
    const session = new OpenCodeSession(input, this.options, command, version, persona);
    try {
      await session.start();
      return session;
    } catch (error) {
      try { await session.close(); }
      catch (disposal) { throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal }); }
      if (isRuntimeExecutionFailure(error)) {
        if (error.phase === 'start') throw error;
        throw new RuntimeExecutionFailure({ phase: 'start', category: error.category, retry: error.retry, reason: error.message, failure: error.failure }, { cause: error });
      }
      const acp = await import('#byok-acp-runtime');
      if (error instanceof acp.UnsupportedOptionError || error instanceof acp.SessionNotFoundError) throw authority(error.message);
      if (error instanceof acp.RuntimeFailureError) throw new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable',
        reason: error.message, failure: { class: runtimeFailureClassOf(error.failure) } }, { cause: error });
      throw infrastructure(error instanceof Error ? error.message : 'opencode start failed', 'start');
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
  private retained = 0;
  private failure?: RuntimeExecutionFailure;
  private ending = false;
  private cancelled = false;
  private closing = false;
  private stopAttempt?: Promise<void>;
  private closeAttempt?: Promise<void>;
  private runner?: Promise<void>;
  private settle?: (outcome: OpenCodeTurnOutcome) => void;
  private outcome?: Promise<OpenCodeTurnOutcome>;
  private opening?: Promise<void>;

  constructor(private readonly input: RuntimeOperationStartInput & { kind: 'instruction' }, private readonly options: OpenCodeAdapterOptions,
    private readonly command: string, private readonly version: string, private readonly persona?: string) {}

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
        if (this.child === child && !this.ending && child.exitedOnItsOwn) this.halt(infrastructure('opencode acp exited'));
      }, error => { if (this.child === child) this.halt(error); });
      return { ...child, onLine: handler => child.onLine(line => { if (!this.failure) handler(line); }) };
    }, (bin, args, opts) => {
      const spawnTerminal = createOwnedTerminalSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn });
      if (opts.shell) return spawnTerminal(bin, args, opts);
      const invocation = resolveRuntimeInvocation(bin, runtimeInvocationHost(opts.env));
      return spawnTerminal(invocation.command, [...invocation.args, ...args], opts);
    },
    { kind: 'available', via: 'executable', command: this.command, version: this.version }, {
      cwd: this.input.manifest.cwd!, env: { ...this.input.env, ...this.input.scratch.env }, model: this.options.models[index]!,
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
      this.retained += Buffer.byteLength(JSON.stringify(record));
      if (this.retained > (this.options.maxRetainedBytes ?? 16 * 1024 * 1024)) throw infrastructure('opencode retained record byte budget exceeded');
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
        const failure = (cause?: unknown) => new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: outcome.reason ?? 'opencode turn failed',
          failure: { class: outcome.fromText ? 'unknown' : runtimeFailureClassOf(outcome.failure) } }, { cause });
        if (!this.cancelled && outcome.failure === 'rate_limited' && !this.projection?.output && index === 0 && this.options.models.length > 1) {
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
        finally { await this.raw?.dispose(); }
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
    this.child?.observeDescendants();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { await this.raw?.abort(); await this.runner; })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(infrastructure('opencode interrupt timed out')), this.options.interruptTimeoutMs ?? 1000); }),
      ]);
    } catch (error) { this.halt(error); await this.close(); throw error; }
    finally { clearTimeout(timer); }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.cancelled = true;
    this.closeAttempt ??= (async () => {
      try {
        await this.opening?.catch(() => {});
        await this.stop();
        this.settle?.({ kind: 'aborted' });
        await this.runner;
        await this.input.scratch.release();
      } finally { this.queue.end(); }
    })().catch(error => { this.closeAttempt = undefined; throw error; });
    return this.closeAttempt;
  }
}
