import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits.js';
import { createRuntimeReaders } from '../../runtime/runtime-readers.js';
import type { RuntimeListModelsOptions, RuntimeModelCatalog } from '../../runtime/runtime-reader-types.js';
import { dshVersionUnsupported } from '../../runtime/oar-version-floors.js';
import { type spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireImageInput } from '../input-images.js';
import type { RuntimeExecutableSource, RuntimeInputOptions } from '../../types.js';
import * as dshRuntime from '../../runtime/dsh-session-runtime.js';
import { oarStartClassifier, runtimeStartFailure } from '../runtime-start-failure.js';
import type { AgentEvent, TaskFailure } from '@byok-sdk/protocol';
import type { ExecutionScratch } from '../../daemon/retention/scratch.js';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeDetectResult,
  type RuntimeOperationStartInput,
  type RuntimeVersionPolicy,
  type Session,
} from '../../types.js';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure.js';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment.js';
import { dshMcpConfigs, dshSession, type DshRecord, type RawDshSession } from '../../runtime/dsh-session-runtime.js';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import { sessionCredentialRedactor } from '../../runtime/claude-session-runtime.js';
import { resolveRuntimeApiKey } from '../resolve-runtime-api-key.js';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy.js';
import { AsyncQueue } from '../../util/async-queue.js';
import { comparablePath } from '../../util/comparable-path.js';
import { classifyDetectError, probeRuntimeVersion, runDetectCommand } from '../detect-outcome.js';
import { bindVerifiedDetection, takeVerifiedDetection } from '../../runtime-detection.js';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable.js';
import { resolveManagedRuntime } from '../managed-runtime-path.js';
import type { ResolvedBin } from '../codex/resolve-bin.js';
import { agentPersona } from '../agent-persona.js';
import { DSH_RUNTIME_CAPABILITIES } from './dsh-capabilities.js';
import { assertDshModelSelection, assertDshSandboxMode, dshAgentsHome, dshEnvironment, dshPatch, dshRoute, DSH_PROVIDER_KEY_ENV } from './dsh-profile.js';
import { DSH_VERSION_POLICY, dshVersionToken } from './dsh-version.js';
import { DshProjection, type DshTurnOutcome } from './projection.js';
import { resolveDshBin } from './resolve-bin.js';
import { PI_PROVIDER_ENV_KEYS } from '../pi/pi-provider-env.generated.js';
import { offerSelection } from '../../types.js';

/** DSH uses pi-ai catalog ids verbatim except for its own DeepSeek plugin. */
const MCP_EXPLICIT_CREDENTIAL_MIN_LENGTH = 8;
const DSH_PROVIDER_CATALOG_IDS = new Map([
  ...Object.keys(PI_PROVIDER_ENV_KEYS).map(id => [id, id] as const),
  ['deepseek', 'deepseek'], // The deepseek-official plugin serves pi-ai's deepseek provider.
]);

/** Provider and model for dsh. The patch names the route and the SDK's child-only key variable. */
export interface DshModelSelection {
  /**
   * `deepseek` routes through dsh's own DeepSeek API plugin
   * (`deepseek-official`). `custom` is an OpenAI-compatible endpoint at
   * `baseUrl`. Any other value is a pi-ai catalog provider id dsh ships, for
   * example `openai`, `anthropic` or `openrouter`.
   */
  readonly provider: string;
  /** pi-ai id of a Host's custom endpoint. */
  readonly providerId?: string;
  /** Default model in the configured route. An offer can select another model on that route. */
  readonly model?: string;
  /** Endpoint for `custom` (required) or a catalog provider (optional). Not allowed for `deepseek`. It must not carry credentials. */
  readonly baseUrl?: string;
}

/** dsh's own sandbox modes (`DSH_PERMISSION_MODE`). `danger-full-access` also sets approval to `never`; the other two ask, but the bridge has no approval channel, so dsh refuses the request and returns it to the model as a tool error. */
export type DshSandboxMode = 'danger-full-access' | 'workspace-write' | 'read-only';

const VERSION_TIMEOUT_MS = 5_000;
/** `dsh --profile acp --help` boots the launcher and, on a new root, writes the acp profile: about 1.7 s measured. */
const PROFILE_PROBE_TIMEOUT_MS = 30_000;
const PATCH_FILE = 'dsh.patch.yml';

export interface DshAdapterOptions {
  /** SDK install root in which to find a managed runtime. */
  runtimeInstallRoot?: string;
  /**
   * Absolute path of the dsh home (`DSH_HOME`) this SDK owns, for example
   * under the Host's store directory. It must persist across executions:
   * dsh keeps its sessions there, and resume reads them back. It must not be
   * the user's dsh home (`~/.dsh`): dsh's stored credentials outrank the
   * environment, and the user's profile patches and plugins would change the
   * composition the SDK relies on.
   */
  home: string;
  /** Provider and default model of every execution. */
  model: DshModelSelection;
  /** Resolves the provider API key in the Host's credential scope just before each authenticated spawn. */
  resolveKey: () => Promise<string>;
  /**
   * dsh's sandbox for every session (`DSH_PERMISSION_MODE`). Default
   * `danger-full-access`, as for Codex: the bridge has no approval channel, so
   * dsh refuses every escalation the narrower modes ask for and returns it to
   * the model as a tool error.
   */
  sandbox?: DshSandboxMode;
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment dsh and its MCP servers get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  /** Deadline for a cancelled turn to settle before the session fails. Default 1 s. */
  interruptTimeoutMs?: number;
}

/** The command a version probe ran, its version token, and who chose the command. */
type DshInstallation = { readonly command: string; readonly version: string; readonly executableSource: RuntimeExecutableSource };

const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason });
const infrastructure = (reason: string, failure?: TaskFailure) =>
  new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason, failure });

/** `dsh --profile acp --help` exits 0 when the acp profile resolves; it also writes that profile into a new root. A caller abort rethrows its reason. */
async function probeAcpProfile(command: string, root: string, env: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
  const outcome = await runDetectCommand(command, ['--profile', 'acp', '--help'], { timeoutMs: PROFILE_PROBE_TIMEOUT_MS, env, cwd: root, signal });
  if (outcome.kind === 'aborted') throw outcome.reason;
  return outcome.kind === 'ok';
}

/**
 * DeepSeek Harness through the vendored OAR dsh runtime: a private plugin
 * loaded into `dsh --profile acp`, with the ACP protocol plugin off. Each
 * session runs one dsh process in an SDK-owned `DSH_HOME`, with a per-execution
 * `--patch` overlay that names the provider route and its key variable. The
 * process starts in the execution scratch directory, not the workspace, so dsh
 * does not load a workspace `.env`; the workspace is the session cwd. The SDK
 * owns the process, the environment and the record budget.
 *
 * `dsh` is not a frozen wire runtime id, so a task reaches this adapter by the
 * custom-harness identity (`harnessId: 'dsh'`).
 */
export class DshAdapter implements RuntimeAdapter {
  #runtimeReaders?: ReturnType<typeof createRuntimeReaders>;

  private get readers() {
    return this.#runtimeReaders ??= createRuntimeReaders(this, {
      nativeAssetRoot: this.options.nativeAssetRoot,
      spawnFn: this.options.spawnFn,
      command: (_env) => resolveRuntimeCommand(this.options.resolveBin, resolveDshBin, () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'dsh')).bin.command,
      version: dshVersionToken,
      versionRefusal: dshVersionUnsupported,
      environment: env => ({ env: dshEnvironment(env, this.root, this.sandbox) }),
      authenticate: async (env, signal) => {
        await this.ensureRoot();
        const key = await resolveRuntimeApiKey('dsh', this.options.resolveKey, signal);
        return { env: { ...env, [DSH_PROVIDER_KEY_ENV]: key }, credentials: [key] };
      },
    });
  }

  listModels(options: RuntimeListModelsOptions = {}): Promise<RuntimeModelCatalog> {
    return this.readers.listModels(options, async (installation, _reader, withAuthentication) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-dsh-catalog-'));
      try {
        const patch = path.join(directory, PATCH_FILE);
        await fs.writeFile(patch, dshPatch(this.options.model), { mode: 0o600 });
        const { dshListModels } = await import('#byok-oar-readers');
        return await withAuthentication(reader => dshListModels(installation, reader, { directory, patches: [patch], env: reader.env }));
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }

  private readonly root: string;
  private readonly options: DshAdapterOptions;
  private readonly sandbox: DshSandboxMode;
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  private readonly effectiveVersionPolicy: RuntimeVersionPolicy | undefined;
  private readonly interruptTimeoutMs: number;
  private readonly maxRetainedBytes: number;

  private providerId(): string | undefined {
    const { provider, providerId } = this.options.model;
    return DSH_PROVIDER_CATALOG_IDS.get(provider === 'custom' ? providerId ?? '' : provider);
  }

  get descriptor() {
    const byokProviderId = this.providerId();
    return freezeRuntimeAdapterDescriptor({
      id: 'dsh',
      selectionModes: byokProviderId === undefined ? [] : ['byok'],
      ...(byokProviderId === undefined || this.options.model.model === undefined ? {} : { defaultModelModes: ['byok'] }),
      ...(byokProviderId === undefined ? {} : { byokProviderId }),
      supportsEffort: true,
      // dsh ships no win32 build of its native addon (docs/researches/2026-11-01-dsh-adapter.md §1.9).
      platforms: ['darwin', 'linux'],
      capabilities: DSH_RUNTIME_CAPABILITIES,
      // Each `progress` is one committed assistant message.
      progressMessageBoundary: 'event',
      ...(this.effectiveVersionPolicy === undefined ? {} : { versionPolicy: this.effectiveVersionPolicy }),
    });
  }

  constructor(options: DshAdapterOptions) {
    if (typeof options?.home !== 'string' || !path.isAbsolute(options.home)) throw new TypeError('DshAdapterOptions.home must be an absolute path');
    const root = path.resolve(options.home);
    const candidate = comparablePath(root);
    const userHome = comparablePath(path.join(os.homedir(), '.dsh'));
    if (candidate === userHome || candidate.startsWith(`${userHome}${path.sep}`)) throw new TypeError('DshAdapterOptions.home must not be the user\'s dsh home (~/.dsh)');
    assertDshModelSelection(options.model, 'DshAdapterOptions.model');
    if (typeof options.resolveKey !== 'function') throw new TypeError('DshAdapterOptions.resolveKey must be a function');
    const sandbox = options.sandbox ?? 'danger-full-access';
    assertDshSandboxMode(sandbox, 'DshAdapterOptions.sandbox');
    this.maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'dsh');
    this.interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs, 'dsh');
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'DshAdapterOptions.runtimeEnvironment');
    this.effectiveVersionPolicy = resolveRuntimeVersionPolicy(DSH_VERSION_POLICY, options.versionPolicy);
    this.root = root;
    this.sandbox = sandbox;
    this.options = { ...options, model: Object.freeze({ ...options.model }) };
  }

  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(dshAgentsHome(this.root), { recursive: true, mode: 0o700 });
  }

  /**
   * Prepares the SDK root, reads `dsh --version`, then resolves the acp
   * profile, which writes it into a new root. Detection leaves key resolution
   * to authenticated spawns. A caller abort rethrows its reason, before the
   * root is written. An `available` observation carries the probed command
   * and version for this adapter's `prepare()`.
   */
  async detect(signal?: AbortSignal): Promise<RuntimeDetectResult> {
    signal?.throwIfAborted();
    try {
      const resolved = resolveRuntimeCommand(this.options.resolveBin, resolveDshBin, () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'dsh'));
      const command = resolved.bin.command;
      const { env: base } = await this.runtimeEnvironment();
      const env = dshEnvironment(base, this.root, this.sandbox);
      await this.ensureRoot();
      const version = await probeRuntimeVersion(command, VERSION_TIMEOUT_MS, env, [], signal);
      if (version.kind !== 'available') return version;
      const token = dshVersionToken(version.stdout);
      const unsupported = dshVersionUnsupported(token);
      if (unsupported !== null) {
        const { installedVersion, requiredVersion } = unsupported;
        return { kind: 'refused', reason: 'acp_unavailable', unsupportedVersion: { installedVersion, requiredVersion } };
      }
      if (!await probeAcpProfile(command, this.root, env, signal)) return { kind: 'refused', reason: 'acp_unavailable' };
      const fields = runtimeExecutableFields(resolved, command);
      const installation: DshInstallation = { command, version: token, executableSource: fields.executableSource };
      return bindVerifiedDetection(this, {
        kind: 'available' as const,
        sessionCapabilities: dshRuntime.dshSessionCapabilities(),
        version: token,
        ...fields,
        ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, token),
      }, installation);
    } catch (error) {
      signal?.throwIfAborted();
      return classifyDetectError(error);
    }
  }

  /**
   * Cheap admission: the version probe only, or none when this offer's
   * admission observation was made by this adapter. The acp profile probe
   * belongs to `detect()`.
   */
  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const { effort, target } = input.offer;
    const selection = offerSelection(target);
    const configured = this.options.model;
    if (target.lane !== 'harness' || target.harnessId !== 'dsh' || selection?.mode !== 'byok' || selection.providerId !== this.providerId()) {
      return { kind: 'reject', reason: 'dsh requires its configured BYOK provider', retryable: false };
    }
    const modelId = selection.modelId;
    const prefix = `${dshRoute(configured)}/`;
    if (modelId !== undefined && (!modelId.startsWith(prefix) || modelId.slice(prefix.length).trim() === '')) {
      return { kind: 'reject', code: 'model_unavailable', reason: 'The requested DSH model is outside the configured route', retryable: false };
    }
    const model = modelId === undefined ? configured.model : modelId.slice(prefix.length);
    if (model === undefined) {
      return { kind: 'reject', code: 'invalid_request', reason: 'DSH requires a model ID when no default is configured', retryable: false };
    }
    try {
      dshMcpConfigs(Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server })), '.');
    } catch (error) {
      return { kind: 'reject', reason: `dsh cannot attach the task MCP servers: ${(error as Error).message}`, retryable: false };
    }
    input.signal?.throwIfAborted();
    let installation = takeVerifiedDetection<DshInstallation>(this, input.detected);
    if (installation === undefined) {
      const resolved = resolveRuntimeCommand(this.options.resolveBin, resolveDshBin, () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'dsh'));
      const command = resolved.bin.command;
      const { env: base } = await this.runtimeEnvironment();
      const version = await probeRuntimeVersion(command, VERSION_TIMEOUT_MS, dshEnvironment(base, this.root, this.sandbox), [], input.signal);
      if (version.kind !== 'available') {
        return { kind: 'reject', reason: `dsh installation refused: ${version.kind === 'refused' ? version.reason : version.kind}`, retryable: false };
      }
      installation = { command, version: dshVersionToken(version.stdout), executableSource: runtimeExecutableFields(resolved, command).executableSource };
    }
    const { command, version: token, executableSource } = installation;
    const unsupported = dshVersionUnsupported(token);
    if (unsupported !== null) {
      return { kind: 'reject', reason: `dsh installation refused: ${unsupported.reason}`, retryable: false };
    }
    const modelSelection = { ...configured, model };
    return {
      kind: 'prepared',
      operation: { start: (start) => this.start(start, { command, version: token }, modelSelection, modelId, effort) },
      detected: { version: token, executableSource, ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, token) },
    };
  }

  private async start(input: RuntimeOperationStartInput, installation: { command: string; version: string }, selection: DshModelSelection & { model: string }, modelId: string | undefined, effort: string | undefined): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('dsh requires a resolved instruction');
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('dsh manifest has no sealed cwd');
    const resume = input.manifest.sessionRef;
    // A writer runs in the Agent home, which dsh loads as the project's AGENTS.md. A reader runs in `.byok/runs/<task>`,
    // and dsh climbs to the home only when it has `.git`, where that reader sees the persona twice. OAR re-applies the
    // append on every resume and the section is gone when it is omitted, so the reader's persona goes in every open.
    const persona = input.manifest.homeAccess === 'memory-reader'
      ? await agentPersona('dsh', input.manifest, { reappliesOnResume: true })
      : undefined;
    const model = `${dshRoute(selection)}/${selection.model}`;
    const requested = input.manifest.selection;
    if (requested?.mode !== 'byok' || requested.providerId !== this.providerId() || requested.modelId !== modelId || input.manifest.effort !== effort) {
      throw authority('dsh manifest differs from the admitted provider, model or effort');
    }
    const session = new DshSession(
      input.scratch,
      this.interruptTimeoutMs,
    );
    try {
      // dsh compares the canonical workspace on resume.
      const workspace = await fs.realpath(cwd);
      await this.ensureRoot();
      const patch = path.join(input.scratch.sdkDir, PATCH_FILE);
      await fs.writeFile(patch, dshPatch(selection), { mode: 0o600 });
      const env = dshEnvironment({ ...input.env, ...input.scratch.env }, this.root, this.sandbox);
      const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
      const key = await resolveRuntimeApiKey('dsh', this.options.resolveKey, input.signal);
      env[DSH_PROVIDER_KEY_ENV] = key;
      const redactor = sessionCredentialRedactor({ env, mcpServers });
      // The bridge mounts every MCP env and header value in memory, so each one is a credential whatever its name. A
      // value under eight characters is not redacted, even under a credential name, unless it is inside a longer header
      // or URL: a short value such as DEBUG=1 would redact every matching character of the model's output. A refused
      // mount echoes the entries JSON-encoded, and its diagnostics can encode them again, so each credential, including
      // a bearer token or URL password the redactor derived, is also registered with one and two levels of escaping.
      const mcpValues = mcpServers.flatMap((server) => Object.values(('headers' in server ? server.headers : server.env) ?? {}));
      const escape = (value: string): string => JSON.stringify(value).slice(1, -1);
      const credentials = [...new Set([...redactor.values(), key, ...mcpValues.filter((value) => value.length >= MCP_EXPLICIT_CREDENTIAL_MIN_LENGTH)]
        .flatMap((value) => [value, escape(value), escape(escape(value))]))];
      for (const credential of credentials) redactor.addExplicit(credential);
      const spawnAgent = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'dsh acp', stderrRedactor: redactor });
      const raw = await dshSession(
        (bin, args, options) => {
          const child = spawnAgent(bin, args, options);
          session.own(child);
          void child.exited.then(() => session.exited(), (error) => session.fail(redactor.redactValue(error)));
          return session.gate(child);
        },
        // The version admits OAR's session-log switch, which it refuses on a DSH that predates the plugin.
        { kind: 'available', via: 'executable', ...installation },
        {
          cwd: workspace,
          model,
          ...(effort === undefined ? {} : { effort }),
          // The process runs in the scratch directory, so dsh reads no workspace `.env`; the workspace stays the session cwd.
          launch: { directory: input.scratch.sdkDir, patches: [patch], env },
          retainedBytes: this.maxRetainedBytes,
          // dsh's DeepSeek session-log plugin attaches the session's events to every official DeepSeek request (#2446).
          // The bridge refuses the open before any model request unless dsh reports the plugin off.
          sessionLogUpload: 'off',
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          ...(persona === undefined ? {} : { appendSystemPrompt: persona }),
          ...(resume === undefined ? {} : { resume }),
        },
        {
          credentialsForRedaction: credentials,
          onReady: (id) => session.ready(id),
          onRouteMismatch: () => session.refuseRoute(),
          // A kernel observer: the kernel swallows its errors, so record() fails the session itself.
          onRecord: (record) => session.record(record),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      session.bind(raw);
      if (input.signal?.aborted) throw infrastructure('dsh start was aborted');
      requireImageInput(input.images, raw.capabilities.images === true);
      await session.prompt(input.instruction);
      return session;
    } catch (thrown) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal });
      }
      throw runtimeStartFailure(session.halted ?? thrown, { classify: oarStartClassifier(dshRuntime), exitedOnItsOwn: session.exitedOnItsOwn, runtime: 'dsh' });
    }
  }
}

class DshSession implements Session {
  sessionRef = '';
  private raw?: RawDshSession;
  private child?: { dispose(): Promise<void>; kill(): void; observeDescendants(): void; readonly exitedOnItsOwn: boolean };
  private exitedNaturally = false;
  private projection?: DshProjection;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private failure?: RuntimeExecutionFailure;
  private active = false;
  private readonly interruptWaiters = new Set<() => void>();
  private stopping = false;
  private stopAttempt?: Promise<void>;
  private closeAttempt?: Promise<void>;
  private turnClosed = false;
  /** Set when the record consumer failed: no later line reaches the ACP stream, so the kernel retains no more of them. */
  halted?: RuntimeExecutionFailure;

  constructor(
    private readonly scratch: ExecutionScratch,
    private readonly interruptMs: number,
  ) {}

  own(child: { dispose(): Promise<void>; kill(): void; observeDescendants(): void; readonly exitedOnItsOwn: boolean }): void {
    this.child = child;
  }
  get exitedOnItsOwn(): boolean {
    return this.child?.exitedOnItsOwn ?? this.exitedNaturally;
  }
  /** The agent's lines stop at the transport once the record stream halted. */
  gate<T extends { onLine(handler: (line: string) => void): void }>(child: T): T {
    return {
      ...child,
      onLine: (handler: (line: string) => void) => child.onLine((line) => {
        if (this.halted === undefined) handler(line);
      }),
    };
  }
  ready(id: string): void {
    this.sessionRef = id;
    this.projection = new DshProjection(id);
  }
  refuseRoute(): void {
    if (this.turnClosed || this.halted !== undefined) return;
    this.fail(new RuntimeExecutionFailure({
      phase: 'run', retry: 'non-retryable', reason: 'dsh session does not run the configured provider route and model',
    }));
    this.halted = this.failure;
  }
  bind(raw: RawDshSession): void {
    this.raw = raw;
  }
  record(record: DshRecord): void {
    if (this.halted !== undefined || this.turnClosed) return;
    try {
      this.projection?.consume(record, (event) => this.queue.push(event), (turn) => this.turnEnded(turn));
    } catch (error) {
      this.fail(error);
      this.halted = this.failure;
      throw error;
    }
  }
  /**
   * dsh's subagents and background jobs outlive the turn, and when one finishes
   * dsh opens a root turn with no prompt. Nothing of dsh's may outlive the turn:
   * the tree goes before the terminal is decided and before the home lease is
   * released, so a stopped subagent's unfinished work is lost. Resume reads what
   * dsh flushed at dispose.
   */
  private turnEnded(turn: DshTurnOutcome): void {
    this.active = false;
    this.turnClosed = true;
    void this.stopRuntime().then(() => {
      if (turn.kind === 'failed') {
        this.fail(new RuntimeExecutionFailure({
          phase: 'run',
          retry: turn.failure === 'rate_limited' ? 'retryable' : 'non-retryable',
          reason: turn.reason,
          failure: { class: turn.failure },
        }));
      } else {
        this.queue.push({ type: 'turn_end' });
      }
    }, (error: unknown) => this.fail(error)).finally(() => {
      for (const resolve of this.interruptWaiters) resolve();
    });
  }
  /** OAR asks dsh to dispose its sessions and flush its log before it releases the process. */
  private stopRuntime(): Promise<void> {
    this.stopping = true;
    this.stopAttempt ??= Promise.resolve().then(async () => {
      try {
        try {
          // A background job that left its group has no parent to be found under once dsh ends.
          this.child?.observeDescendants();
        } finally {
          await this.raw?.dispose();
        }
      } catch (error) {
        if (!this.failure || isRuntimeDisposalFailure(error)) throw error;
      } finally {
        await this.child?.dispose();
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
      : infrastructure(error instanceof Error ? error.message : 'dsh runtime failed');
    this.flushPendingUsage();
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) this.fail(infrastructure('dsh acp exited', { class: this.exitedOnItsOwn ? 'runtime_exited' : 'unknown' }));
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
  async prompt(input: string): Promise<void> {
    if (!this.raw) throw infrastructure('dsh session is not open');
    if (this.active) throw infrastructure('dsh turn is already active');
    this.active = true;
    try {
      const result = await this.raw.prompt(input);
      if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'dsh prompt refused');
    } catch (error) {
      this.active = false;
      throw error;
    }
  }
  async followUp(): Promise<void> {
    throw new PolicyUnsupportedError('dsh runs one turn per process; a later turn resumes the session');
  }
  readonly capabilities = dshRuntime.dshSessionCapabilities();

  async steer(text: string, options?: RuntimeInputOptions): Promise<void> {
    requireImageInput(options?.images, this.capabilities.images);
    const result = await this.raw?.steer(text);
    if (result?.response.body.kind !== 'accepted') throw infrastructure(result?.response.body.reason ?? 'dsh steer refused');
  }
  async interrupt(): Promise<void> {
    if (!this.raw || !this.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurn!: () => void;
    const turnSettled = new Promise<void>(resolve => { resolveTurn = resolve; });
    this.interruptWaiters.add(resolveTurn);
    try {
      await Promise.race([
        // The accepted cancel only asks; the native turn end carries the outcome.
        this.raw.abort().then(async ({ response: { body } }) => {
          if (body.kind === 'accepted') await turnSettled;
          // A turn that already ended is a normal race. Any other refusal sent no cancel: fail as an unanswered cancel does.
          else if (body.kind === 'rejected' && body.code !== 'no_active_turn') throw infrastructure(`dsh interrupt refused: ${body.reason}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(infrastructure('dsh interrupt timed out')), this.interruptMs);
        }),
      ]);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
      this.interruptWaiters.delete(resolveTurn);
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    if (!this.closeAttempt) {
      const promise = Promise.resolve().then(async () => {
        try {
          try {
            await this.stopRuntime();
          } finally {
            await this.scratch.release();
          }
        } finally {
          // The turn end can follow the cancel; end the consumer only after disposal drained stdout.
          this.flushPendingUsage();
          this.queue.end();
        }
        this.raw = undefined;
        this.projection = undefined;
        this.exitedNaturally = this.exitedOnItsOwn;
        this.child = undefined;
      });
      this.closeAttempt = promise.catch((error) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }
  private flushPendingUsage(): void {
    const usage = this.projection?.takePendingUsage();
    if (usage) this.queue.push(usage);
  }
}
