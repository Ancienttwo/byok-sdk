import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits.js';
import { createRuntimeReaders } from '../../runtime/runtime-readers.js';
import type { RuntimeListModelsOptions, RuntimeModelCatalog, RuntimeReadOptions, RuntimeAccountUsage } from '../../runtime/runtime-reader-types.js';
import { CODEX_MCP_TOOL_ALLOWLIST_REFUSAL, supportsCodexMcpToolAllowlist, withCodexMcpToolGrants } from './reserved-mcp-tool-grants.js';
import { assertCodexMcpHubQualified } from './hub-tool-grants.js';
import type { ExecutionScratch } from '../../daemon/retention/scratch.js';
import { requireImageInput } from '../input-images.js';
import type { RuntimeInputImage, RuntimeInputOptions } from '../../types.js';
import { offerSelection, type RuntimeTaskInput } from '../../types.js';
import { snapshotNativeInteractionHostOptions, type NativeInteractionHostOptions, type NativeInteractionChannel } from '../../native-interactions.js';
import { CodexNativeInteractions } from './native-interactions.js';
import { type spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as codexRuntime from '../../runtime/codex-session-runtime.js';
import { oarStartClassifier, runtimeStartFailure } from '../runtime-start-failure.js';
import type {
  AgentEvent,
  HarnessSelection,
  TaskFailure,
} from '@byok-sdk/protocol';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeDetectResult,
  type RuntimeVersionPolicy,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type MessageDraftDelta,
  type PreparedRuntimeOperation,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types.js';
import {
  RuntimeExecutionFailure,
  runtimeFailureClassOf,
  RuntimeStartupDisposalFailure,
  isRuntimeExecutionFailure,
} from '../../runtime-failure.js';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment.js';
import { classifyDetectError, probeRuntimeVersion, probeTimeouts, runDetectCommand } from '../detect-outcome.js';
import { bindVerifiedDetection, registerAdmissionDetect, takeVerifiedDetection } from '../../runtime-detection.js';
import { sessionCredentialRedactor } from '../../runtime/claude-session-runtime.js';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import { withoutProviderCredentials } from '../provider-credential-environment.js';
import { readProcessTable } from '../../runtime/oar-process-tree.js';
import { objectRecord as recordOf } from '../shared-rules.js';
import { CodexProjection, type CodexRecord } from './projection.js';
import { AsyncQueue } from '../../util/async-queue.js';
import { haltGate, SettleWaiters, raceDeadline, RetryableOnce } from '../session-kit.js';
import { resolveCodexBin, type ResolvedBin } from './resolve-bin.js';
import { findRuntimeCommandOnPath, resolveRuntimeInvocation, runtimeInvocationHost, type RuntimeInvocation } from '../runtime-invocation.js';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable.js';
import { resolveManagedRuntime } from '../managed-runtime-path.js';
import { CODEX_RUNTIME_CAPABILITIES } from './codex-capabilities.js';
import { CODEX_VERSION_POLICY, codexVersionToken } from './codex-version.js';
import { compareRuntimeSemver } from '../../runtime/compare-runtime-semver.js';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy.js';
import { codexUserMcpServerNames, verifyCodexUserMcpServersExcluded, withCodexUserMcpServersExcluded } from './agent-user-mcp-servers.js';
import { assertCodexFileCredentials, createCodexAgentHome } from './agent-user-context.js';
import { ownedRuntimeHomeLinksAvailable } from '../owned-runtime-home.js';

const DETECT_VERSION_TIMEOUT_MS = 10_000;
const APP_SERVER_HELP_TIMEOUT_MS = 10_000;
/** `login status` and `account/read` read the credential store; a loaded background service needs headroom (#2468). */
const AUTH_STATUS_TIMEOUT_MS = 25_000;
/** Test seam only: no package entry exports it. */
export const codexProbeTimeouts = probeTimeouts({
  version: DETECT_VERSION_TIMEOUT_MS, appServerHelp: APP_SERVER_HELP_TIMEOUT_MS, authStatus: AUTH_STATUS_TIMEOUT_MS,
});
const DEFAULT_OPERATION_MS = 30_000;
type VerifiedCodexInstallation = { readonly invocation: RuntimeInvocation; readonly version: string };
type CodexInstallation =
  | { readonly detected: Exclude<RuntimeDetectResult, { kind: 'available' }> }
  | (VerifiedCodexInstallation & { readonly detected: Extract<RuntimeDetectResult, { kind: 'available' }> });
const SUBSCRIPTION_REQUIRED = 'Codex subscription selection requires a ChatGPT login';
type CodexLaunchInput = Parameters<NonNullable<PreparedRuntimeOperation['resolveRuntimeLaunch']>>[0];
/** A Codex `sandbox_mode`, or `inherit` to pass no override so the user's `config.toml` applies. */
export type CodexSandboxSetting = 'read-only' | 'workspace-write' | 'danger-full-access' | 'inherit';
const CODEX_SANDBOX_SETTINGS: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access', 'inherit'];

/** Throws a TypeError unless `value` is a {@link CodexSandboxSetting}. */
export function assertCodexSandboxSetting(value: unknown, label: string): asserts value is CodexSandboxSetting {
  if (typeof value !== 'string' || !CODEX_SANDBOX_SETTINGS.includes(value)) {
    throw new TypeError(`${label} must be one of ${CODEX_SANDBOX_SETTINGS.join(', ')}`);
  }
}

export interface CodexAdapterOptions {
  /** SDK install root in which to find a managed runtime. */
  runtimeInstallRoot?: string;
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment Codex and its MCP servers get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /**
   * Codex sandbox for every session, as OAR's `OAR_CODEX_SANDBOX`. Default
   * `danger-full-access`: no human answers an approval prompt, so a sandbox
   * denial is a stalled task. `inherit` lets the user's own `config.toml` win.
   */
  sandbox?: CodexSandboxSetting;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  interruptTimeoutMs?: number;
  /**
   * Deadline in milliseconds for the session open, each prompt and each steer.
   * Default 30000. On expiry the session fails and the app-server is killed.
   */
  operationTimeoutMs?: number;
  /** Opt-in local Host UI. Requires a verified Codex version of 0.107.0 or later. */
  nativeInteractions?: NativeInteractionHostOptions;
  /**
   * For an Agent task (`task.offer`), `excluded` gives the Codex
   * thread only the task's and the SDK's MCP servers. Before the thread
   * opens, the adapter reads Codex's effective configuration for the task cwd
   * (`config/read`), sets `enabled = false` on every other `mcp_servers`
   * entry, and turns off the `apps` (connectors) and `plugins` features for
   * the thread. Plugin exclusion also applies at app-server launch, before
   * startup plugin sync. The thread then has no plugins at all, not only no plugin
   * MCP servers. After the open it reads the thread's MCP server status
   * back, and the start fails if any other server is not disabled, or if a
   * user server has the name of a task or SDK server. The user's
   * login, model, sandbox setting and other configuration still apply, and
   * so does the user's `AGENTS.md` unless `agentUserContext` is `excluded`. It covers new and resumed threads. On a resume, Codex may start a
   * queued turn before the read-back: that turn already runs with the
   * overrides, and a failed read-back stops the app server. Other tasks are
   * unchanged. Default `inherit`.
   */
  agentUserMcpServers?: 'inherit' | 'excluded';
  /**
   * For an Agent task (`task.offer`), `excluded` runs Codex in an SDK-owned
   * `CODEX_HOME` in the execution's scratch, so the user's `AGENTS.md`,
   * `AGENTS.override.md`, `skills/`, `memories/` and threads stay out, and
   * plugins and the memory pipeline are off. The home holds symbolic links to
   * the user's `auth.json`, `config.toml`, `hooks.json` and `rules/`, and its
   * `sessions/` and `archived_sessions/` link to the Agent's own store in
   * `<Agent home>/.byok/codex/`. Threads made under `inherit` are not
   * resumable under `excluded`. The start fails without a sealed Agent home,
   * unless Codex's effective `cli_auth_credentials_store` is `file`, without
   * the user's `auth.json`, and on Windows when the account may not create
   * symbolic links. MCP servers are `agentUserMcpServers`' concern. Default
   * `inherit`.
   */
  agentUserContext?: 'inherit' | 'excluded';
  /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
}

/**
 * Codex reads `AGENTS.md` from its project root down to `cwd`, and finds the
 * project root by the `project_root_markers` config (default `[".git"]`).
 * When no ancestor has a marker, it reads `cwd` only. A `memory-reader` cwd is
 * `<home>/.byok/runs/<taskId>/`, so Codex would miss the persona in the home.
 * The home always holds the SDK-owned `.byok/`, so this marker makes the home
 * the project root. The run directory itself has no `.byok/`.
 */
const READER_PROJECT_ROOT_ARGS = Object.freeze(['-c', 'project_root_markers=[".byok"]']);
const DISABLE_PLUGINS_ARGS = ['-c', 'features.plugins=false'] as const;
const DISABLE_MEMORIES_ARGS = ['-c', 'features.memories=false'] as const;
const NATIVE_INTERACTIONS_MINIMUM_VERSION = '0.107.0';
const DEFAULT_MODE_USER_INPUT_ARGS = ['-c', 'features.default_mode_request_user_input=true'] as const;

/** Codex app-server is experimental and has no exec compatibility path. Version policy: `codex-version.ts`. */
export class CodexAdapter implements RuntimeAdapter {
  #runtimeReaders?: ReturnType<typeof createRuntimeReaders>;

  private get readers() {
    return this.#runtimeReaders ??= createRuntimeReaders(this, {
      nativeAssetRoot: this.options.nativeAssetRoot,
      spawnFn: this.options.spawnFn,
      command: (_env) => resolveRuntimeCommand(this.options.resolveBin, resolveCodexBin, () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'codex')).bin.command,
      version: codexVersionToken,
      environment: env => ({ env: withoutProviderCredentials(env) }),
    });
  }

  listModels(options: RuntimeListModelsOptions = {}): Promise<RuntimeModelCatalog> {
    return this.readers.listModels(options, async (installation, reader) => {
      const { codexListModels } = await import('#byok-oar-readers');
      return codexListModels(installation, reader);
    });
  }

  accountUsage(options: RuntimeReadOptions = {}): Promise<RuntimeAccountUsage> {
    return this.readers.accountUsage(options, async (installation, reader) => {
      const { codexAccountUsage } = await import('#byok-oar-readers');
      return codexAccountUsage(installation, reader);
    });
  }

  get descriptor() { return freezeRuntimeAdapterDescriptor({
    id: 'codex',
    selectionModes: ['device-default', 'subscription'],
    supportsEffort: true,
    progressMessageBoundary: 'event',
    platforms: ['darwin', 'linux', 'win32'],
    mcpToolApprovals: true,
    capabilities: {
      ...CODEX_RUNTIME_CAPABILITIES,
      isolation: {
        ...CODEX_RUNTIME_CAPABILITIES.isolation!,
        ...(this.options.agentUserContext === 'excluded' ? {} : {
          userInstructions: false, userMemory: false,
        }),
        ...(this.options.agentUserMcpServers === 'excluded' ? {} : { userMcpServers: false }),
      },
      // Questions only: tool permission is the SDK `auto | all` decision.
      ...(this.options.nativeInteractions === undefined ? {} : { nativeInteractions: { approvalDecisions: [], structuredQuestions: true } }),
    },
    ...(this.effectiveVersionPolicy === undefined ? {} : { versionPolicy: this.effectiveVersionPolicy }),
  }); }
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  private readonly effectiveVersionPolicy: RuntimeVersionPolicy | undefined;
  private readonly interruptTimeoutMs: number;
  private readonly maxRetainedBytes: number;
  constructor(private readonly options: CodexAdapterOptions = {}) {
    registerAdmissionDetect(this, CodexAdapter.prototype.detect, async signal => (await this.detectInstallation({ checkAuth: false, signal })).detected);
    if (options.sandbox !== undefined) assertCodexSandboxSetting(options.sandbox, 'CodexAdapterOptions.sandbox');
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'CodexAdapterOptions.runtimeEnvironment');
    if (options.agentUserMcpServers !== undefined && options.agentUserMcpServers !== 'inherit' && options.agentUserMcpServers !== 'excluded')
      throw new TypeError('CodexAdapterOptions.agentUserMcpServers must be inherit or excluded');
    if (options.agentUserContext !== undefined && options.agentUserContext !== 'inherit' && options.agentUserContext !== 'excluded')
      throw new TypeError('CodexAdapterOptions.agentUserContext must be inherit or excluded');
    this.options = { ...options, ...(options.nativeInteractions === undefined ? {} : { nativeInteractions: snapshotNativeInteractionHostOptions(options.nativeInteractions) }) };
    this.maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'Codex');
    this.interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs, 'Codex');
    if (
      !Number.isFinite(options.operationTimeoutMs ?? DEFAULT_OPERATION_MS) ||
      (options.operationTimeoutMs ?? DEFAULT_OPERATION_MS) <= 0 ||
      (options.operationTimeoutMs ?? DEFAULT_OPERATION_MS) > 2_147_483_647
    )
      throw new TypeError('invalid Codex operation timeout');
    this.effectiveVersionPolicy = resolveRuntimeVersionPolicy(CODEX_VERSION_POLICY, options.versionPolicy);
  }
  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }
  async detect(signal?: AbortSignal): Promise<RuntimeDetectResult> {
    return (await this.detectInstallation({ checkAuth: true, signal })).detected;
  }

  /**
   * `checkAuth: false` (task admission and prepare()) omits `authPresent` (unmeasured):
   * neither reads it, and a subscription launch confirms the account itself
   * (`#readSubscription`), so `login status` would only spend the admission deadline.
   * A caller abort rethrows its reason, also before PATH lookup. An
   * `available` observation carries its verified invocation
   * (`bindVerifiedDetection`) for this adapter's `prepare()`.
   */
  private async detectInstallation(options: { readonly checkAuth: boolean; readonly signal?: AbortSignal }): Promise<CodexInstallation> {
    const { checkAuth, signal } = options;
    signal?.throwIfAborted();
    try {
      const env = withoutProviderCredentials((await this.runtimeEnvironment()).env);
      const resolved = resolveRuntimeCommand(this.options.resolveBin, resolveCodexBin, () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'codex'));
      const host = runtimeInvocationHost(env);
      const named = resolved.bin.command;
      const explicitlyPathed = named.includes('/') || (host.platform === 'win32' && named.includes('\\'));
      const executableCommand = explicitlyPathed || path.isAbsolute(named) ? path.resolve(named) : findRuntimeCommandOnPath(named, host);
      if (executableCommand === undefined) return { detected: { kind: 'not-found' } };
      const resolvedInvocation = resolveRuntimeInvocation(executableCommand, host);
      const invocation = { ...resolvedInvocation, command: path.resolve(resolvedInvocation.command) };
      const { command, args, executable } = invocation;
      const timeouts = codexProbeTimeouts.of(this);
      const version = await probeRuntimeVersion(command, timeouts.version, env, args, signal);
      if (version.kind !== 'available') return { detected: version };
      const text = version.stdout.trim() || version.stderr.trim();
      const appServer = await runDetectCommand(command, [...args, 'app-server', '--help'], { timeoutMs: timeouts.appServerHelp, env, signal });
      if (appServer.kind === 'aborted') throw appServer.reason;
      if (appServer.kind === 'timeout') return { detected: { kind: 'timeout' } };
      if (appServer.kind !== 'ok') return { detected: { kind: 'refused', reason: 'app_server_unavailable' } };
      if (this.options.agentUserContext === 'excluded') {
        let linksAvailable: boolean;
        try {
          linksAvailable = await ownedRuntimeHomeLinksAvailable();
        } catch {
          return { detected: { kind: 'probe-failed' } };
        }
        // Refuses the whole runtime: the option is per adapter, and detection precedes every offer.
        if (!linksAvailable) return { detected: { kind: 'refused', reason: 'agent_user_context_unavailable' } };
      }
      let authPresent: boolean | undefined;
      if (checkAuth) {
        const login = await runDetectCommand(command, [...args, 'login', 'status'], { timeoutMs: timeouts.authStatus, env, signal });
        if (login.kind === 'aborted') throw login.reason;
        if (login.kind === 'timeout') return { detected: { kind: 'timeout' } };
        // Codex reports configured credentials with exit 0; its display text is not a contract.
        // Any other end, such as an unreadable credential store, leaves auth presence unconfirmed.
        authPresent = login.kind === 'ok';
      }
      const verified: VerifiedCodexInstallation = { invocation, version: text };
      return { ...verified, detected: bindVerifiedDetection(this, {
        kind: 'available' as const,
        sessionCapabilities: codexRuntime.codexSessionCapabilities(),
        version: text,
        ...(authPresent === undefined ? {} : { authPresent }),
        ...runtimeExecutableFields(resolved, host.platform === 'win32' ? executable : named),
        ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, codexVersionToken(text)),
      }, verified) };
    } catch (error) {
      signal?.throwIfAborted();
      return { detected: classifyDetectError(error) };
    }
  }
  async prepare(
    input: RuntimeAdapterPrepareInput,
  ): Promise<RuntimeAdapterPrepareResult> {
    const { effort } = input.offer;
    let model: string | undefined;
    try {
      model = subscriptionModel(offerSelection(input.offer.target));
    } catch (error) {
      return {
        kind: 'reject',
        reason:
          error instanceof Error ? error.message : 'unsupported selection',
        retryable: false,
      };
    }
    input.signal?.throwIfAborted();
    // This offer's admission observation, when this adapter verified it, carries
    // the invocation its probes ran; otherwise probe now and launch what that probe ran.
    const verified = takeVerifiedDetection<VerifiedCodexInstallation>(this, input.detected);
    const installation: CodexInstallation = verified === undefined
      ? await this.detectInstallation({ checkAuth: false, signal: input.signal })
      : { ...verified, detected: input.detected as Extract<RuntimeDetectResult, { kind: 'available' }> };
    const { detected } = installation;
    if (!('invocation' in installation))
      return {
        kind: 'reject',
        reason: `codex installation refused: ${detected.kind === 'refused' ? detected.reason : detected.kind}`,
        // A probe deadline is no verdict on the installation.
        retryable: detected.kind === 'timeout',
      };
    const { invocation, version, detected: { executableSource, versionVerdict } } = installation;
    if (this.options.nativeInteractions !== undefined) {
      const order = compareRuntimeSemver(codexVersionToken(version), NATIVE_INTERACTIONS_MINIMUM_VERSION);
      if (order === null || order < 0) {
        const detail = order === null ? 'the installed version could not be confirmed' : 'the installed version is below the minimum';
        return {
          kind: 'reject',
          code: 'runtime_unavailable',
          reason: `Codex nativeInteractions requires Codex ${NATIVE_INTERACTIONS_MINIMUM_VERSION} or later (${detail})`,
          retryable: false,
        };
      }
    }
    const mcpAllowlistSupported = supportsCodexMcpToolAllowlist(version);
    if (!mcpAllowlistSupported && (input.requiredToolsetIds.length > 0 || Object.keys(input.mcpServers ?? {}).length > 0)) {
      return { kind: 'reject', reason: CODEX_MCP_TOOL_ALLOWLIST_REFUSAL, retryable: false };
    }
    let admittedLaunch: CodexAppServerLaunch | undefined;
    return {
      kind: 'prepared',
      detected: { version, executableSource, versionVerdict },
      operation: {
        ...(model === undefined ? {} : { resolveRuntimeLaunch: async (resources: CodexLaunchInput) => {
          if (admittedLaunch !== undefined) throw authority('Codex subscription launch was already resolved');
          const signal = resources.signal ?? input.signal;
          signal?.throwIfAborted();
          const launch = await this.#appServerLaunch(resources);
          let subscribed: boolean;
          try { subscribed = await this.#readSubscription(invocation, launch, signal); }
          catch {
            signal?.throwIfAborted();
            throw retryable('Codex could not confirm the CLI account type');
          }
          if (!subscribed) throw codexSubscriptionRequired();
          admittedLaunch = launch;
          return launch;
        } }),
        start: start => this.start(start, invocation, model, effort, mcpAllowlistSupported, admittedLaunch),
      },
    };
  }

  async #appServerLaunch(resources: CodexLaunchInput): Promise<CodexAppServerLaunch> {
    const { cwd, agentHome, scratch } = resources;
    const excludeUserMcp = this.options.agentUserMcpServers === 'excluded' && agentHome !== undefined;
    const excludeUserContext = this.options.agentUserContext === 'excluded' && agentHome !== undefined;
    const env = withoutProviderCredentials({ ...resources.env, ...scratch.env });
    if (excludeUserContext) env.CODEX_HOME = await createCodexAgentHome(resources.env, scratch.sdkDir, agentHome.canonicalHome);
    const sandbox = this.options.sandbox ?? 'danger-full-access';
    const launchArgs = [
      ...(sandbox === 'inherit' ? [] : ['-c', `sandbox_mode="${sandbox}"`]),
      ...(agentHome?.access === 'memory-reader' ? READER_PROJECT_ROOT_ARGS : []),
      // Plugin sync and memory processing can start before the first thread opens.
      ...(excludeUserMcp || excludeUserContext ? DISABLE_PLUGINS_ARGS : []),
      ...(excludeUserContext ? DISABLE_MEMORIES_ARGS : []),
    ];
    return Object.freeze({ cwd, agentHome: agentHome === undefined ? undefined : Object.freeze({ ...agentHome }), scratch,
      env: Object.freeze(env), launchArgs: Object.freeze(launchArgs), excludeUserMcp, excludeUserContext, release: () => scratch.release() });
  }

  async #readSubscription(invocation: RuntimeInvocation, launch: CodexAppServerLaunch, signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(codexProbeTimeouts.of(this).authStatus);
    const deadline = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    deadline.throwIfAborted();
    const redactor = sessionCredentialRedactor({ env: launch.env });
    const spawn = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'codex account read', stderrRedactor: redactor });
    let child: ReturnType<typeof spawn> | undefined;
    // account/read needs neither feature. Suppress their startup work even when the task inherits it.
    const launchArgs = [
      ...launch.launchArgs,
      ...(launch.excludeUserMcp || launch.excludeUserContext ? [] : DISABLE_PLUGINS_ARGS),
      ...(launch.excludeUserContext ? [] : DISABLE_MEMORIES_ARGS),
    ];
    try {
      const client = codexRuntime.startAppServerClient((bin, args, options) => {
        child = spawn(bin, [...invocation.args, ...args], options);
        return child;
      }, invocation.command, launch.env, {}, launch.cwd, { launchArgs, redact: redactor.redact });
      client.handle({ onNotification() {}, onServerRequest() {} });
      const stop = () => client.kill();
      deadline.addEventListener('abort', stop, { once: true });
      try {
        deadline.throwIfAborted();
        await client.spawned;
        deadline.throwIfAborted();
        await client.request('initialize', { clientInfo: { name: 'byok-sdk', version: '0.0.0' } });
        deadline.throwIfAborted();
        client.notify('initialized', {});
        return codexHasSubscription(await client.request('account/read', {}));
      } finally {
        deadline.removeEventListener('abort', stop);
      }
    } finally {
      await child?.dispose();
    }
  }

  private async start(
    input: RuntimeOperationStartInput,
    invocation: RuntimeInvocation,
    model: string | undefined,
    effort: string | undefined,
    mcpAllowlistSupported: boolean,
    admittedLaunch: CodexAppServerLaunch | undefined,
  ): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string')
      throw authority('codex requires a resolved instruction');
    assertCodexMcpHubQualified(input);
    if (subscriptionModel(input.manifest.selection) !== model || input.manifest.effort !== effort)
      throw authority(
        'prepared codex operation received a manifest with different runtime selection',
      );
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('codex manifest has no sealed cwd');
    const agentHome = input.manifest.agentRef === undefined ? undefined : {
      canonicalHome: input.manifest.lease?.canonicalHome ?? '', access: input.manifest.homeAccess ?? 'writer' as const,
    };
    if (model !== undefined && (admittedLaunch === undefined || admittedLaunch !== input.runtimeLaunch
      || admittedLaunch.cwd !== cwd || admittedLaunch.scratch !== input.scratch
      || admittedLaunch.agentHome?.canonicalHome !== agentHome?.canonicalHome || admittedLaunch.agentHome?.access !== agentHome?.access)) {
      throw authority('Codex subscription start requires its exact admitted launch');
    }
    const workspace = await fs.realpath(cwd);
    // As OAR: the servers go in the thread/start or thread/resume config.
    const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
    const taskServers = mcpServers.map(server => server.name);
    if (taskServers.length > 0 && !mcpAllowlistSupported) throw authority(CODEX_MCP_TOOL_ALLOWLIST_REFUSAL);
    const excludeUserMcp = this.options.agentUserMcpServers === 'excluded' && input.manifest.agentRef !== undefined;
    const session = new CodexSession(
      input.scratch,
      workspace,
      model,
      effort,
      this.interruptTimeoutMs,
      this.options.operationTimeoutMs ?? DEFAULT_OPERATION_MS,
      input.manifest.sessionRef === undefined,
      this.options.nativeInteractions,
      input.manifest.sessionRef,
    );
    let rootPid: number | undefined;
    const cleanupOnAbort = process.platform !== 'win32';
    try {
      const launch = admittedLaunch ?? await this.#appServerLaunch({ kind: input.kind, cwd, env: input.env, scratch: input.scratch, agentHome });
      const { excludeUserMcp, excludeUserContext } = launch;
      const redactor = sessionCredentialRedactor({ env: launch.env, mcpServers });
      const spawned = createOwnedLineProcessSpawn({
        nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, stderrRedactor: redactor,
      });
      // The open deadline covers spawn, initialize, the thread open and its read-back.
      const raw = await session.within('open', retryable, codexRuntime.codexSession(
        (bin, args, options) => {
          const child = spawned(bin, [...invocation.args, ...args], options);
          rootPid = child.pid;
          session.own(child);
          void child.exited.then(
            () => session.exited(),
            (error) => session.fail(error),
          );
          return haltGate(child, () => session.halted !== undefined);
        },
        { kind: 'available', via: 'executable', command: invocation.command },
        {
          cwd: launch.cwd,
          env: launch.env,
          retainedBytes: this.maxRetainedBytes,
          endTurnProcessesOnAbort: cleanupOnAbort,
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          // The shared launch arguments already contain the SDK's sandbox override.
          sandboxMode: 'inherit',
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          // Outside plan mode Codex refuses request_user_input unless this feature is on (Codex >= 0.107.0 asks and resolves).
          launchArgs: this.options.nativeInteractions === undefined ? launch.launchArgs : [...launch.launchArgs, ...DEFAULT_MODE_USER_INPUT_ARGS],
          ...(input.manifest.sessionRef === undefined
            ? {}
            : { resume: input.manifest.sessionRef }),
        },
        1000,
        {
          ...(cleanupOnAbort ? { turnProcessReader: {
            rootPid: () => rootPid,
            readProcessTable: () => readProcessTable('ps'),
          } } : {}),
          onReady: (id) => session.ready(id),
          beforeOpen: async (request, params) => {
            const inspectUserMcp = excludeUserMcp || taskServers.length > 0;
            const effective = inspectUserMcp || excludeUserContext ? await request('config/read', { cwd, includeLayers: false }) : undefined;
            if (model !== undefined && !codexHasSubscription(await request('account/read', {}))) {
              throw codexSubscriptionRequired();
            }
            if (excludeUserContext) assertCodexFileCredentials(effective!);
            const userServerNames = inspectUserMcp ? codexUserMcpServerNames(effective!, taskServers) : [];
            return withCodexMcpToolGrants(
              excludeUserMcp ? withCodexUserMcpServersExcluded(params, userServerNames) : params,
              taskServers,
              input.mcpToolApprovals,
            );
          },
          ...(excludeUserMcp ? {
            afterOpen: (request, threadId) => verifyCodexUserMcpServersExcluded(request, threadId, taskServers),
          } : {}),
          ...(this.options.nativeInteractions === undefined ? {} : {
            onServerRequest: session.serverRequest.bind(session),
            onNativeIdentity: (method: string, identity: Record<string, unknown>) => session.nativeIdentity(method, identity),
          }),
          // A kernel observer: the kernel swallows its errors, so record() fails the session itself.
          onRecord: (record) => session.record(record),
        },
      ));
      session.bind(raw);
      if (
        input.manifest.sessionRef !== undefined &&
        raw.id !== input.manifest.sessionRef
      )
        throw authority('codex resume returned a different thread id');
      if (input.signal?.aborted)
        throw infrastructure('codex start was aborted');
      await session.prompt(input.instruction, input.images);
      return session;
    } catch (thrown) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), {
          cause: disposal,
        });
      }
      throw runtimeStartFailure(session.halted ?? thrown, { classify: oarStartClassifier(codexRuntime), exitedOnItsOwn: session.exitedOnItsOwn, runtime: 'codex' });
    }
  }
}
interface CodexAppServerLaunch {
  readonly cwd: string;
  readonly agentHome?: CodexLaunchInput['agentHome'];
  readonly scratch: ExecutionScratch;
  readonly env: Readonly<Record<string, string>>;
  readonly launchArgs: readonly string[];
  readonly excludeUserMcp: boolean;
  readonly excludeUserContext: boolean;
  release(): Promise<void>;
}

function codexSubscriptionRequired(): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason: SUBSCRIPTION_REQUIRED,
    failure: { class: 'invalid_request' } });
}

function codexHasSubscription(result: Readonly<Record<string, unknown>>): boolean {
  const account = result.account;
  return account !== null && typeof account === 'object' && 'type' in account
    && account.type === 'chatgpt' && result.requiresOpenaiAuth !== false;
}

const authority = (reason: string) =>
  new RuntimeExecutionFailure({
    phase: 'start',
    retry: 'non-retryable',
    reason,
  });
const infrastructure = (reason: string, failure?: TaskFailure) =>
  new RuntimeExecutionFailure({
    phase: 'run',
    retry: 'non-retryable',
    reason,
    failure,
  });
/** An open that timed out may succeed on a fresh app-server, as before the deadline moved here. */
const retryable = (reason: string) =>
  new RuntimeExecutionFailure({
    phase: 'start',
    retry: 'retryable',
    reason,
  });
class CodexSession implements Session {
  sessionRef = '';
  private raw?: codexRuntime.RawCodexSession;
  private child?: { dispose(): Promise<void>; kill(): void };
  private exit?: { readonly exitedOnItsOwn: boolean };
  private projection?: CodexProjection;
  private readonly stream = {};
  private readonly queue = new AsyncQueue<AgentEvent | MessageDraftDelta>();
  private failure?: RuntimeExecutionFailure;
  private active = false;
  private readonly turnWaiters = new SettleWaiters();
  private stopping = false;
  private readonly closeOnce = new RetryableOnce();
  /** Set when the record consumer failed: no later line reaches the client, so the kernel retains no more of them. */
  halted?: RuntimeExecutionFailure;
  private readonly native?: CodexNativeInteractions;
  declare readonly interactions?: NativeInteractionChannel;
  constructor(
    private readonly scratch: ExecutionScratch,
    private readonly workspace: string,
    private readonly model: string | undefined,
    private readonly effort: string | undefined,
    private readonly interruptMs: number,
    private readonly operationMs: number,
    private readonly fresh: boolean,
    interactions?: NativeInteractionHostOptions,
    private readonly expectedSessionRef?: string,
  ) {
    if (interactions) {
      this.native = new CodexNativeInteractions(() => this.sessionRef, interactions, () => this.fail(infrastructure('codex native interaction transport failed')));
      this.interactions = this.native.channel;
    }
  }
  serverRequest(id: string | number, method: string, params: Record<string, unknown>, reply: import('./native-interactions.js').CodexNativeReply): void {
    this.native!.receive(id, method, params, reply);
  }
  nativeIdentity(method: string, identity: Record<string, unknown>): void {
    this.native?.notification(method, identity);
  }
  own(child: { dispose(): Promise<void>; kill(): void; readonly exitedOnItsOwn: boolean }): void {
    this.child = child;
    this.exit = child;
  }
  get exitedOnItsOwn(): boolean {
    return this.exit?.exitedOnItsOwn === true;
  }
  /** Fails the session and kills the app-server when `work` outlives the operation deadline. */
  async within<T>(
    operation: string,
    failure: (reason: string) => RuntimeExecutionFailure,
    work: Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = failure(`codex ${operation} timed out after ${this.operationMs}ms`);
            this.fail(error);
            reject(error);
          }, this.operationMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  ready(id: string): void {
    if (this.expectedSessionRef !== undefined && id !== this.expectedSessionRef) throw authority('codex resume returned a different thread id');
    this.sessionRef = id;
    this.projection = new CodexProjection(this.workspace, id, this.fresh);
  }
  bind(raw: codexRuntime.RawCodexSession): void {
    this.raw = raw;
  }
  record(record: CodexRecord): void {
    if (this.halted !== undefined) return;
    try {
      const body = recordOf(record.body);
      const rootRecord = typeof body?.byokRoot === 'boolean' ? body.byokRoot : record.sessionId === this.sessionRef;
      if (record.kind === 'frame' && rootRecord && body?.type === 'turn/completed' && body.origin !== 'byok-native' && Array.isArray(body.events)) {
        const ended = body.events.map(recordOf).find(event => event?.kind === 'turn_ended');
        const outcome = recordOf(ended?.outcome);
        if (outcome === undefined) return;
        this.active = false;
        this.turnWaiters.settleAll();
        const nativeTurn = recordOf(recordOf(body.native)?.turn);
        if (outcome.kind === 'failed' && (body.byokTurnStatus ?? nativeTurn?.status) === 'failed') {
          // Establish the typed terminal before a required SDK record consumer can throw.
          const nativeError = recordOf(nativeTurn?.error);
          const reason = typeof nativeError?.message === 'string' ? nativeError.message
            : typeof outcome.reason === 'string' ? outcome.reason : 'codex turn failed';
          const failure = outcome.fromText === true ? 'unknown' : runtimeFailureClassOf(outcome.failure);
          this.fail(new RuntimeExecutionFailure({
            phase: 'run',
            retry: 'non-retryable',
            reason,
            failure: failure === 'quota' && typeof outcome.resetsAt === 'string'
              ? { class: 'quota', resetsAt: outcome.resetsAt } : { class: failure },
          }));
        }
      }
      this.projection?.consume(this.stream, record, (event) =>
        this.queue.push(event),
      );
    } catch (error) {
      // After an exit the app-server made on its own, a failing record is one that exit produced
      // (its exit record, or a control it settled as exited): the exit stays the class.
      this.fail(this.exitedOnItsOwn
        ? infrastructure(error instanceof Error ? error.message : 'codex runtime failed', { class: 'runtime_exited' })
        : error);
      this.halted = this.failure;
      throw error;
    }
  }
  fail(error: unknown): void {
    this.native?.close("process-exited");
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure(
          error instanceof Error ? error.message : 'codex runtime failed',
        );
    this.flushPendingUsage();
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) {
      this.fail(infrastructure('codex app-server exited', { class: this.exitedOnItsOwn ? 'runtime_exited' : 'unknown' }));
    }
  }
  get events(): AsyncIterable<AgentEvent | MessageDraftDelta> {
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
    if (!this.raw) throw infrastructure('codex session is not open');
    requireImageInput(images, this.capabilities.images);
    if (this.active) throw infrastructure('codex turn is already active');
    this.active = true;
    this.native?.beginTurn();
    try {
      const result = await this.within('prompt', infrastructure, this.raw.prompt(input, { images }));
      if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'codex prompt refused');
    } catch (error) {
      this.active = false;
      this.native?.interrupt();
      throw error;
    }
  }
  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string')
      throw new PolicyUnsupportedError('codex requires a string instruction');
    if (task.effort !== undefined && task.effort !== this.effort) {
      throw new PolicyUnsupportedError('codex persistent session cannot change effort');
    }
    const model = subscriptionModel(offerSelection(task.target));
    if (model !== undefined && model !== this.model)
      throw new PolicyUnsupportedError(
        'codex persistent session cannot change model',
      );
    await this.prompt(task.instruction, task.images);
  }
  async steer(text: string, options?: RuntimeInputOptions): Promise<void> {
    const result = this.raw === undefined ? undefined : await this.within('steer', infrastructure, this.raw.steer(text, options));
    if (result?.response.body.kind !== 'accepted')
      throw infrastructure(
        result?.response.body.reason ?? 'codex steer refused',
      );
  }
  async interrupt(): Promise<void> {
    this.native?.interrupt();
    if (!this.raw || !this.active) return;
    // The runner's cancel bound may finalize before this interrupt or close()
    // settles; usage observed so far must reach it now. A later final frame
    // supersedes it (terminal usage is last-observed).
    this.flushPendingUsage();
    const waiter = this.turnWaiters.wait();
    try {
      await raceDeadline(this.raw.abort().then(async result => {
        // The final turn frame carries usage after the interrupt acknowledgement.
        if (result.response.body.kind === 'accepted') await waiter.settled;
      }), this.interruptMs, () => infrastructure('codex late interrupt timed out'));
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      waiter.release();
    }
  }
  async close(): Promise<void> {
    this.native?.close();
    this.stopping = true;
    await this.closeOnce.run(async () => {
      try {
        try {
          await this.raw?.dispose();
        } catch (error) {
          if (!this.failure) throw error;
        } finally {
          await this.child?.dispose();
          await this.scratch.release();
        }
      } finally {
        // Stdout may contain final native frames after the interrupt ACK.
        // End the consumer only after disposal has drained that transport.
        this.flushPendingUsage();
        this.queue.end();
      }
      this.raw = undefined;
      this.projection = undefined;
      this.child = undefined;
    });
  }
  private flushPendingUsage(): void {
    const usage = this.projection?.takePendingUsage(this.stream);
    if (usage) this.queue.push(usage);
  }
}
function subscriptionModel(
  selection: HarnessSelection | undefined,
): string | undefined {
  if (selection === undefined || selection.mode === 'device-default') return undefined;
  if (selection.mode !== 'subscription')
    throw new PolicyUnsupportedError(
      'codex cannot execute this runtime selection',
    );
  return selection.modelId;
}
