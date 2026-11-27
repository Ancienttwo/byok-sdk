import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits.js';
import { createRuntimeReaders } from '../../runtime/runtime-readers.js';
import type { RuntimeListModelsOptions, RuntimeModelCatalog, RuntimeAccountUsageOptions, RuntimeAccountUsage } from '../../runtime/runtime-reader-types.js';
import { antigravityVersionRefusal } from '../../runtime/oar-version-floors.js';
import type { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { oarStartClassifier, runtimeStartFailure } from '../runtime-start-failure.js';
import type { AgentEvent, TaskFailure } from '@byok-sdk/protocol';
import type { ExecutionScratch } from '../../daemon/retention/scratch.js';
import type { McpEventIdentities } from '../../mcp/event-identity.js';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeDetectResult,
  type RuntimeOperationManifest,
  type RuntimeOperationStartInput,
  type RuntimeVersionPolicy,
  type Session,
} from '../../types.js';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeDisposalFailure, isRuntimeExecutionFailure, runtimeFailureClassOf } from '../../runtime-failure.js';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment.js';
import { requireImageInput } from '../input-images.js';
import type { RuntimeInputImage, RuntimeInputOptions } from '../../types.js';
import type { AcpControl, AcpPermissionRequest, AcpPermissionResponse, AcpRecord, RawAcpSession } from '../../runtime/acp-session-runtime.js';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import { sessionCredentialRedactor } from '../../runtime/claude-session-runtime.js';
import { resolveRuntimeApiKey } from '../resolve-runtime-api-key.js';
import { createOwnedTerminalSpawn } from '../../runtime/owned-terminal-process.js';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy.js';
import { AsyncQueue } from '../../util/async-queue.js';
import { haltGate, SettleWaiters, raceDeadline, oarCancelSettled, RetryableOnce } from '../session-kit.js';
import { comparablePath } from '../../util/comparable-path.js';
import { agentPersona } from '../agent-persona.js';
import { agyEndpointOf } from './agy-endpoint.js';
import { startAgyGeminiProxy, type AgyGeminiProxy } from './agy-gemini-proxy.js';
import { agyPermissionDecision, type AgyReaderScope } from './permissions.js';
import { acquireAgySessionRetention, brandAgySessionStore } from '../../util/agy-session-retention.js';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome.js';
import { bindVerifiedDetection, takeVerifiedDetection } from '../../runtime-detection.js';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable.js';
import type { ResolvedBin } from '../codex/resolve-bin.js';
import { AGY_RUNTIME_CAPABILITIES } from './agy-capabilities.js';
import { agyEnvironment, agyNativeHome, agyStoreDir, ensureAgyHome } from './agy-profile.js';
import { AGY_VERSION_POLICY, agyVersionToken } from './agy-version.js';
import { AgyProjection, agyMcpEventIdentities, type AgyTurnOutcome } from './projection.js';
import { resolveAgyBin } from './resolve-bin.js';

/** Upstream's bound: the CLI can read its update state before it prints the version. */
const VERSION_TIMEOUT_MS = 30_000;
const AGY_PROVIDER_ID = 'google';

export interface AgyAdapterOptions {
  /**
   * Absolute path of the OS home (`HOME`, `USERPROFILE`) this SDK owns for the
   * agy process and every tool it starts. It must persist across executions:
   * agy keeps its conversations below it, and resume reads them back. It must
   * not be the user's home or anything under the user's `~/.gemini`.
   */
  home: string;
  /** Resolves the Gemini API key in the Host's credential scope just before each authenticated spawn. */
  resolveKey: () => Promise<string>;
  /** Model id for every session, set again on each resume. Absent: the CLI default. */
  model?: string;
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment agy and its tools get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  /** Deadline for a cancelled turn to settle before the session fails. Default 1 s. */
  interruptTimeoutMs?: number;
}

const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason });
const infrastructure = (reason: string, failure?: TaskFailure) =>
  new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason, failure });
/** OAR's own class on a refusal (`input_too_large` past agy's input bound) is structured evidence, so it reaches `task.fail`. */
const refused = (body: AcpControl['response']['body'] | undefined, fallback: string) =>
  infrastructure(body?.reason ?? fallback, body?.failure === undefined ? undefined : { class: runtimeFailureClassOf(body.failure) });

/**
 * The Antigravity CLI over its native ACP
 * (`agy acp --dangerously-skip-permissions --process-per-session`), through
 * the vendored OAR Antigravity profile. The SDK owns the process, the OS home
 * it runs in, the record budget and the permission policy.
 *
 * `agy` is not a frozen wire runtime id, so a task reaches this adapter by the
 * custom-harness identity (`harnessId: 'agy'`).
 */
export class AgyAdapter implements RuntimeAdapter {
  #runtimeReaders?: ReturnType<typeof createRuntimeReaders>;

  private get readers() {
    return this.#runtimeReaders ??= createRuntimeReaders(this, {
      nativeAssetRoot: this.options.nativeAssetRoot,
      spawnFn: this.options.spawnFn,
      command: (env) => resolveRuntimeCommand(this.options.resolveBin, () => resolveAgyBin(env)).bin.command,
      version: agyVersionToken,
      versionRefusal: antigravityVersionRefusal,
      environment: env => ({ env: agyEnvironment(env, this.root) }),
      authenticate: async (env, signal) => {
        await ensureAgyHome(this.root);
        const { env: authenticated, proxy, credentials } = await this.authenticatedEnvironment(env, signal);
        return { env: authenticated, credentials, close: proxy.close };
      },
    });
  }

  listModels(options: RuntimeListModelsOptions = {}): Promise<RuntimeModelCatalog> {
    return this.readers.listModels(options, async (installation, _reader, withAuthentication) => {
      const { antigravityListModels } = await import('#byok-acp-runtime');
      return withAuthentication(reader => antigravityListModels(installation, reader));
    });
  }

  async accountUsage(options: RuntimeAccountUsageOptions = {}): Promise<RuntimeAccountUsage> {
    if (options.allowPrintMode !== true) return { kind: 'unsupported', reason: 'print_mode_disabled' };
    return this.readers.accountUsage(options, async (installation, reader) => {
      const { antigravityAccountUsage } = await import('#byok-oar-readers');
      return antigravityAccountUsage(installation, { ...reader, allowPrintMode: true });
    });
  }

  private readonly root: string;
  private readonly options: AgyAdapterOptions;
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  private readonly effectiveVersionPolicy: RuntimeVersionPolicy | undefined;
  private readonly interruptTimeoutMs: number;
  private readonly maxRetainedBytes: number;

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({
      id: 'agy',
      selectionModes: ['byok'],
      byokProviderId: AGY_PROVIDER_ID,
      supportsEffort: true,
      requiresMcpToolsetToolObservation: true,
      platforms: ['darwin', 'linux', 'win32'],
      capabilities: AGY_RUNTIME_CAPABILITIES,
      ...(this.effectiveVersionPolicy === undefined ? {} : { versionPolicy: this.effectiveVersionPolicy }),
    });
  }

  constructor(options: AgyAdapterOptions) {
    if (typeof options?.home !== 'string' || !path.isAbsolute(options.home)) throw new TypeError('AgyAdapterOptions.home must be an absolute path');
    const root = path.resolve(options.home);
    const candidate = comparablePath(root);
    const userNative = comparablePath(agyNativeHome(os.homedir()));
    if (candidate === comparablePath(os.homedir()) || candidate === userNative || candidate.startsWith(`${userNative}${path.sep}`))
      throw new TypeError('AgyAdapterOptions.home must not be the user\'s home or ~/.gemini');
    if (typeof options.resolveKey !== 'function') throw new TypeError('AgyAdapterOptions.resolveKey must be a function');
    if (options.model !== undefined && options.model.trim() === '') throw new TypeError('AgyAdapterOptions.model must not be blank');
    this.maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'agy');
    this.interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs, 'agy');
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'AgyAdapterOptions.runtimeEnvironment');
    this.effectiveVersionPolicy = resolveRuntimeVersionPolicy(AGY_VERSION_POLICY, options.versionPolicy);
    this.root = root;
    this.options = { ...options };
    brandAgySessionStore(this, agyStoreDir(root));
  }

  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }

  private async authenticatedEnvironment(base: Readonly<NodeJS.ProcessEnv>, signal?: AbortSignal) {
    const apiKey = await resolveRuntimeApiKey('agy', this.options.resolveKey, signal);
    const proxy = await startAgyGeminiProxy({ apiKey, environment: base, upstreamOrigin: agyEndpointOf(this) });
    return { env: agyEnvironment(base, this.root, proxy), proxy, credentials: [apiKey, proxy.token] };
  }

  /**
   * Reads the installation version without resolving credentials. A caller
   * abort rethrows its reason, before the home is written. An `available`
   * observation carries the probed command for this adapter's `prepare()`.
   */
  async detect(signal?: AbortSignal): Promise<RuntimeDetectResult> {
    signal?.throwIfAborted();
    try {
      const { env: base } = await this.runtimeEnvironment();
      const resolved = resolveRuntimeCommand(this.options.resolveBin, () => resolveAgyBin(base));
      const command = resolved.bin.command;
      await ensureAgyHome(this.root);
      const version = await probeRuntimeVersion(command, VERSION_TIMEOUT_MS, agyEnvironment(base, this.root), [], signal);
      if (version.kind !== 'available') return version;
      const token = agyVersionToken(version.stdout);
      const unsupported = antigravityVersionRefusal(token);
      if (unsupported !== null) {
        const { installedVersion, requiredVersion } = unsupported;
        return { kind: 'refused', reason: 'acp_unavailable', unsupportedVersion: { installedVersion, requiredVersion } };
      }
      return bindVerifiedDetection(this, {
        kind: 'available' as const,
        sessionCapabilities: (await import('#byok-acp-runtime')).antigravitySessionCapabilities(),
        version: token,
        ...runtimeExecutableFields(resolved, command),
        ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, token),
      }, command);
    } catch (error) {
      signal?.throwIfAborted();
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const { effort, target } = input.offer;
    if (target.lane !== 'harness' || target.harnessId !== 'agy' || target.selection.mode !== 'byok' || target.selection.providerId !== AGY_PROVIDER_ID) {
      return { kind: 'reject', reason: 'agy requires the google BYOK provider', retryable: false };
    }
    const { modelId } = target.selection;
    if (modelId === undefined || modelId.trim() === '') {
      return { kind: 'reject', code: 'invalid_request', reason: 'AGY requires an explicit BYOK model ID', retryable: false };
    }
    input.signal?.throwIfAborted();
    // Launch the command an observation of this adapter probed: this offer's
    // admission observation when this adapter made it, else a fresh one.
    let detected = input.detected;
    let command = takeVerifiedDetection<string>(this, detected);
    if (command === undefined) {
      detected = await this.detect(input.signal);
      if (detected.kind !== 'available') {
        return { kind: 'reject', reason: `agy installation refused: ${detected.kind === 'refused' ? detected.reason : detected.kind}`, retryable: false };
      }
      command = takeVerifiedDetection<string>(this, detected);
      if (command === undefined) return { kind: 'reject', reason: 'agy installation refused: unverified detection', retryable: false };
    }
    const { version, executableSource, versionVerdict } = detected as Extract<RuntimeDetectResult, { kind: 'available' }>;
    return { kind: 'prepared', detected: { version, executableSource, versionVerdict }, operation: {
      acquireSessionLease: (sessionRef) => acquireAgySessionRetention(agyStoreDir(this.root), sessionRef),
      start: (start) => this.start(start, command, modelId, effort),
    } };
  }

  private async start(input: RuntimeOperationStartInput, command: string, model: string | undefined, effort: string | undefined): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('agy requires a resolved instruction');
    const selection = input.manifest.selection;
    if (selection?.mode !== 'byok' || selection.providerId !== AGY_PROVIDER_ID || selection.modelId !== model || input.manifest.effort !== effort) {
      throw authority('agy manifest differs from the admitted provider, model or effort');
    }
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('agy manifest has no sealed cwd');
    const resume = input.manifest.sessionRef;
    // A writer runs in the Agent home, where agy reads AGENTS.md itself. A reader runs in `.byok/runs/<task>`, which agy
    // only walks up from when the home has `.git`, and that reader sees the persona twice; there is no root-marker option.
    // agy replaces its append on every resume and drops it when omitted, so the reader's persona goes in every open.
    const persona = input.manifest.homeAccess === 'memory-reader'
      ? await agentPersona('agy', input.manifest, { reappliesOnResume: true })
      : undefined;
    const reader = readerScope(input.manifest);
    const session = new AgySession(
      input.scratch,
      this.interruptTimeoutMs,
      agyMcpEventIdentities(input.mcpToolsetTools),
      resume,
      reader,
    );
    // The ACP stack and its protocol SDK load only when an agy session starts.
    const acp = await import('#byok-acp-runtime');
    try {
      await ensureAgyHome(this.root);
      const { env, proxy, credentials } = await this.authenticatedEnvironment({ ...input.env, ...input.scratch.env }, input.signal);
      session.useProxy(proxy);
      if (input.signal?.aborted) throw infrastructure('agy start was aborted');
      const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
      const redactor = sessionCredentialRedactor({ env, mcpServers });
      for (const value of credentials) redactor.addExplicit(value);
      const spawnAgent = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'agy acp', stderrRedactor: redactor });
      const hooks: NonNullable<Parameters<typeof import('../../runtime/acp-session-runtime.js').antigravitySession>[4]> = {
        credentialsForRedaction: credentials,
        onReady: id => session.ready(id),
        onRecord: record => session.record(record),
        onPermission: request => session.permission(request),
      };
      const raw = await acp.antigravitySession(
        (bin, args, options) => {
          const child = spawnAgent(bin, args, options);
          session.own(child);
          void child.exited.then(() => session.exited(), (error) => session.fail(redactor.redactValue(error)));
          return haltGate(child, () => session.halted !== undefined);
        },
        // agy runs its own commands and never asks for a client terminal; the stack still requires the seam.
        createOwnedTerminalSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn }),
        { kind: 'available', via: 'executable', command },
        {
          cwd,
          env,
          retainedBytes: this.maxRetainedBytes,
          // Without it agy reports to play.googleapis.com, the one host beside the model endpoint it contacts.
          launchArgs: ['--disable-telemetry'],
          ...(persona === undefined ? {} : { appendSystemPrompt: persona }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          ...(resume === undefined ? {} : { resume }),
        },
        hooks,
      );
      session.bind(raw);
      if (input.signal?.aborted) throw infrastructure('agy start was aborted');
      await session.prompt(input.instruction, input.images);
      return session;
    } catch (thrown) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal });
      }
      throw runtimeStartFailure(session.halted ?? thrown, { classify: oarStartClassifier(acp), exitedOnItsOwn: session.exitedOnItsOwn, runtime: 'agy' });
    }
  }
}

function readerScope(manifest: RuntimeOperationManifest): AgyReaderScope | undefined {
  if (manifest.homeAccess !== 'memory-reader') return undefined;
  const home = manifest.lease?.canonicalHome;
  if (!home || !manifest.cwd) throw authority('agy reader requires a sealed home and run directory');
  return { home, run: manifest.cwd };
}

class AgySession implements Session {
  sessionRef = '';
  private raw?: RawAcpSession;
  private child?: { dispose(): Promise<void>; kill(): void; observeDescendants(): void; readonly exitedOnItsOwn: boolean };
  private proxy?: AgyGeminiProxy;
  private exitedNaturally = false;
  private stopAttempt?: Promise<void>;
  /** The refused permission no model output has followed yet: agy ends the turn on it, and that is no success. */
  private refused?: { readonly toolCallId: string; readonly reason: string };
  private projection?: AgyProjection;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private failure?: RuntimeExecutionFailure;
  private active = false;
  private readonly turnWaiters = new SettleWaiters();
  private stopping = false;
  private readonly closeOnce = new RetryableOnce();
  /** Set when the record consumer failed: no later line reaches the ACP stream, so the kernel retains no more of them. */
  halted?: RuntimeExecutionFailure;

  constructor(
    private readonly scratch: ExecutionScratch,
    private readonly interruptMs: number,
    private readonly identities: McpEventIdentities,
    private readonly expectedSessionRef?: string,
    private readonly reader?: AgyReaderScope,
  ) {}

  useProxy(proxy: AgyGeminiProxy): void {
    this.proxy = proxy;
  }
  own(child: { dispose(): Promise<void>; kill(): void; observeDescendants(): void; readonly exitedOnItsOwn: boolean }): void {
    this.child = child;
  }
  get exitedOnItsOwn(): boolean {
    return this.child?.exitedOnItsOwn ?? this.exitedNaturally;
  }
  ready(id: string): void {
    if (this.expectedSessionRef !== undefined && id !== this.expectedSessionRef) throw authority('agy resume returned a different session id');
    this.sessionRef = id;
    this.projection = new AgyProjection(id, this.identities);
  }
  bind(raw: RawAcpSession): void {
    this.raw = raw;
  }
  record(record: AcpRecord): void {
    if (this.halted !== undefined) return;
    try {
      this.projection?.consume(record, (event) => this.emit(event), (turn) => this.turnEnded(turn));
    } catch (error) {
      this.fail(error);
      this.halted = this.failure;
      throw error;
    }
  }
  permission(request: AcpPermissionRequest): AcpPermissionResponse {
    const decision = agyPermissionDecision(request, this.reader);
    const option = request.options.find(candidate => candidate.kind === decision);
    const { toolCallId } = request.toolCall;
    if (option === undefined) {
      const reason = `agy offered no ${decision} option`;
      this.refused = { toolCallId, reason };
      throw new Error(reason);
    }
    if (decision === 'reject_once') this.refused = { toolCallId, reason: 'agy ended the turn on a refused write below the Agent home' };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
  private emit(event: AgentEvent): void {
    if (event.type === 'progress' || (event.type === 'tool_use' && event.toolCallId !== this.refused?.toolCallId)) this.refused = undefined;
    this.queue.push(event);
  }
  /**
   * agy's subagents and schedules
   * run in the background and report no ACP frame, so nothing of agy's may
   * outlive the turn: the tree goes before the terminal is decided and before
   * the home lease is released. Resume reads what agy already persisted.
   */
  private turnEnded(turn: AgyTurnOutcome): void {
    this.active = false;
    const refused = this.refused;
    void this.stopRuntime().then(() => {
      if (turn.kind === 'failed') {
        this.fail(new RuntimeExecutionFailure({
          phase: 'run',
          retry: !turn.fromText && turn.failure === 'rate_limited' ? 'retryable' : 'non-retryable',
          reason: turn.reason,
          // A class OAR took from error text is not structured evidence (docs/spec.md runtime failure class).
          failure: !turn.fromText && turn.failure === 'quota' && turn.resetsAt !== undefined
            ? { class: 'quota', resetsAt: turn.resetsAt } : { class: turn.fromText ? 'unknown' : turn.failure },
        }));
      } else if (turn.kind === 'completed' && refused !== undefined) {
        this.fail(new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason: refused.reason }));
      } else {
        this.queue.push({ type: 'turn_end' });
      }
    }, (error: unknown) => this.fail(error)).finally(() => {
      this.turnWaiters.settleAll();
    });
  }
  /** OAR sends session/close, which agy advertises, before it releases the process. */
  private stopRuntime(): Promise<void> {
    this.stopping = true;
    this.stopAttempt ??= Promise.resolve().then(async () => {
      try {
        try {
          // session/close ends the worker, and a daemon command that left its group would then have no parent to be found under.
          this.child?.observeDescendants();
        } finally {
          await this.raw?.dispose();
        }
      } catch (error) {
        if (!this.failure || isRuntimeDisposalFailure(error)) throw error;
      } finally {
        try {
          await this.child?.dispose();
        } finally {
          await this.proxy?.close();
          this.proxy = undefined;
        }
      }
    }).catch((error: unknown) => {
      this.stopAttempt = undefined;
      throw error;
    });
    return this.stopAttempt;
  }
  fail(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure(error instanceof Error ? error.message : 'agy runtime failed');
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) this.fail(infrastructure('agy acp exited', { class: this.exitedOnItsOwn ? 'runtime_exited' : 'unknown' }));
  }
  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return (async function* () {
      try {
        for await (const event of self.queue) yield event;
      } catch (error) {
        self.fail(error);
        throw self.failure;
      }
      if (self.failure) throw self.failure;
    })();
  }
  get capabilities() { return { images: this.raw?.capabilities.images === true }; }

  async prompt(input: string, images?: readonly RuntimeInputImage[]): Promise<void> {
    if (!this.raw) throw infrastructure('agy session is not open');
    requireImageInput(images, this.capabilities.images);
    if (this.active) throw infrastructure('agy turn is already active');
    this.active = true;
    try {
      const result = await this.raw.prompt(input, { images });
      if (result.response.body.kind !== 'accepted') throw refused(result.response.body, 'agy prompt refused');
    } catch (error) {
      this.active = false;
      throw error;
    }
  }
  async followUp(): Promise<void> {
    throw new PolicyUnsupportedError('agy runs one turn per process; a later turn resumes the session');
  }
  async steer(text: string, options?: RuntimeInputOptions): Promise<void> {
    const result = await this.raw?.steer?.(text, options);
    if (result?.response.body.kind !== 'accepted') throw refused(result?.response.body, 'agy steer refused');
  }
  async interrupt(): Promise<void> {
    if (!this.raw || !this.active) return;
    const waiter = this.turnWaiters.wait();
    try {
      await raceDeadline(oarCancelSettled(this.raw.abort(), waiter.settled, 'agy'), this.interruptMs, () => infrastructure('agy interrupt timed out'));
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      waiter.release();
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    await this.closeOnce.run(async () => {
      try {
        try {
          await this.stopRuntime();
        } finally {
          await this.scratch.release();
        }
      } finally {
        // The cancelled prompt answer can follow the cancel; end the consumer only after disposal drained stdout.
        this.queue.end();
      }
      this.raw = undefined;
      this.projection = undefined;
      this.exitedNaturally = this.exitedOnItsOwn;
      this.child = undefined;
    });
  }
}
