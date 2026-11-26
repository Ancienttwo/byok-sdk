import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits.js';
import { requireRuntimeApiKey } from '../resolve-runtime-api-key.js';
import { createRuntimeReaders } from '../../runtime/runtime-readers.js';
import type { RuntimeListModelsOptions, RuntimeModelCatalog, RuntimeReadOptions, RuntimeAccountUsage } from '../../runtime/runtime-reader-types.js';
import { offerSelection, type RuntimeTaskInput } from '../../types.js';
import { createClaudeMcpIdentityResolver } from './mcp-identity.js';
import { CLAUDE_RUNTIME_CAPABILITIES } from './claude-capabilities.js';
import { claudeAgentUserContextSettings } from './agent-user-context.js';
import type { ExecutionScratch } from '../../daemon/retention/scratch.js';
import { classifyDetectError, probeRuntimeVersion, probeTimeouts, runDetectCommand } from '../detect-outcome.js';
import { bindVerifiedDetection, registerAdmissionDetect, takeVerifiedDetection } from '../../runtime-detection.js';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, HarnessSelection } from '@byok-sdk/protocol';
import {
  PolicyUnsupportedError,
  SteerUnsupportedError,
  freezeRuntimeAdapterDescriptor,
  type MessageDraftDelta,
  type RuntimeAdapter,
  type RuntimeDetectResult,
  type RuntimeVersionPolicy,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type PreparedRuntimeOperation,
  type RuntimeLaunchResources,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types.js';
import { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeDisposalFailure, isRuntimeExecutionFailure, isRuntimeStartupDisposalFailure } from '../../runtime-failure.js';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironmentConflictRule, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment.js';
import { resolveClaudeBin, type ResolvedBin } from './resolve-bin.js';
import { resolveRuntimeInvocation, runtimeInvocationHost, type RuntimeInvocation } from '../runtime-invocation.js';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable.js';
import { resolveManagedRuntime } from '../managed-runtime-path.js';
import { ClaudeToolAuthorizationBridge } from './tool-authorization.js';
import { ClaudeNativeInteractionBridge, CLAUDE_NATIVE_INTERACTION_CAPABILITIES } from './native-interactions.js';
import { snapshotNativeInteractionHostOptions, type NativeInteractionHostOptions, type NativeInteractionChannel } from '../../native-interactions.js';
import { AssistantMessageTracker, mapClaudeMessageToAgentEvents, type ClaudeFrame, type ClaudeStreamMessage, type ToolUseCorrelation } from './projection.js';
import { ClaudeFailureEvidence } from './failure-evidence.js';
import { requireImageInput } from '../input-images.js';
import { claudeSessionCapabilities, sessionCredentialRedactor, type ClaudeCredentialRedactor } from '../../runtime/claude-session-runtime.js';
import { ClaudeStreamSession } from './stream-session.js';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import type { spawn } from 'node:child_process';
import { withoutProviderCredentials } from '../provider-credential-environment.js';
import { resolveRuntimeApiKey } from '../resolve-runtime-api-key.js';
import { PI_PROVIDER_ENV_KEYS } from '../pi/pi-provider-env.generated.js';
import { servedModelName } from '../served-model.js';
import { CLAUDE_VERSION_POLICY, claudeVersionToken } from './claude-version.js';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy.js';


/** Bounds a hung `claude --version` so it cannot block daemon startup or a task offer. */
const DETECT_VERSION_TIMEOUT_MS = 10_000;
/**
 * `claude auth status --json` reads the macOS keychain through `/usr/bin/security`;
 * under host load a background service measured 18 s (#2468). The vendored OAR
 * reader allows 20 s. A deadline is no answer, never a confirmed sign-out.
 */
const AUTH_STATUS_TIMEOUT_MS = 25_000;
/** Test seam only: no package entry exports it. */
export const claudeProbeTimeouts = probeTimeouts({ version: DETECT_VERSION_TIMEOUT_MS, authStatus: AUTH_STATUS_TIMEOUT_MS });
const AUTH_STATUS_TIMEOUT_REASON = 'Claude login status did not answer before its deadline';
const SUBSCRIPTION_REQUIRED = 'Claude subscription selection requires a Claude.ai login';
type ClaudeAuthStatus = { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown; apiKeySource?: unknown };
type ClaudeAuthStatusRead = { readonly kind: 'ok'; readonly status: ClaudeAuthStatus } | { readonly kind: 'timeout' } | { readonly kind: 'failed' };
interface ClaudeSubscriptionLaunch extends RuntimeLaunchResources {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Claude asks for MCP elicitation (`form` or `url`) over the same control
 * channel. No Host surface answers it, so it is declined at once: unanswered
 * it would hang an unattended run, and the native-interaction bridge would
 * treat it as an unknown request and end the task.
 */
function declineElicitation(message: ClaudeStreamMessage, respond: (reply: Record<string, unknown>) => Promise<void>): boolean {
  const request = message.request as { subtype?: unknown } | undefined;
  if (message.type !== 'control_request' || typeof message.request_id !== 'string' || request?.subtype !== 'elicitation') return false;
  // A failed write means the session already halted or the process is gone; that failure surfaces on its own path.
  void respond({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { action: 'decline' } } }).catch(() => undefined);
  return true;
}

function claudeCredentialEnvironment(base: Readonly<Record<string, string>>): Record<string, string> {
  const env = withoutProviderCredentials(base);
  for (const name of Object.keys(env)) {
    if (/^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/i.test(name)) delete env[name];
  }
  return env;
}

export type SpawnFn = typeof spawn;

function redactClaudeFailure(error: unknown, credentials: ClaudeCredentialRedactor): Error {
  const safe = credentials.redactValue(error);
  if (safe === error && safe instanceof Error) return safe;
  // OAR copies Error diagnostics when redaction changes them. Rebuild the SDK
  // failures with their original typed control facts and the sanitized cause.
  const cause = safe instanceof Error ? safe.cause : undefined;
  if (isRuntimeExecutionFailure(error)) {
    return new RuntimeExecutionFailure({ phase: error.phase, retry: error.retry, failure: error.failure,
      reason: credentials.redact(error.message) }, { cause });
  }
  if (isRuntimeDisposalFailure(error)) {
    return new RuntimeDisposalFailure({ stage: error.stage, reason: credentials.redact(error.message) }, { cause });
  }
  return safe instanceof Error ? safe : new Error(typeof safe === 'string' ? safe : 'Claude operation failed', { cause: safe });
}

/** One owner covers process teardown and task config on every failed start. */
async function rejectOwnedStartup(cause: unknown, credentials: ClaudeCredentialRedactor, stream: ClaudeStreamSession | undefined, scratch: ExecutionScratch, retainPendingDisposal = false): Promise<never> {
  const safe = redactClaudeFailure(cause, credentials);
  const failure = isRuntimeExecutionFailure(safe) ? safe : new RuntimeExecutionFailure({
    phase: 'start', retry: 'retryable',
    reason: 'claude runtime startup failed',
  }, { cause: safe });
  let disposalAttempt: Promise<void> | undefined;
  const retryDisposal = (): Promise<void> => {
    if (!disposalAttempt) {
      const attempt = (async () => {
        // Construction/adoption may already hold a cleanup receipt without
        // having returned a client. Preserve that owner, rather than guessing
        // that a thrown constructor means no process was spawned.
        if (isRuntimeStartupDisposalFailure(cause)) await cause.retryDisposal();
        else await stream?.dispose();
        await scratch.release();
      })();
      disposalAttempt = attempt.catch(error => {
        disposalAttempt = undefined;
        throw redactClaudeFailure(error, credentials);
      });
    }
    return disposalAttempt;
  };
  if (retainPendingDisposal) {
    // Cancellation must expose its owner even while teardown is pending.
    // The same callback joins this attempt and retries it only after failure.
    void retryDisposal().catch(() => {});
    throw new RuntimeStartupDisposalFailure(retryDisposal, { cause: failure });
  }
  try {
    await retryDisposal();
  } catch (disposalError) {
    throw new RuntimeStartupDisposalFailure(retryDisposal, {
      cause: new AggregateError([failure, disposalError], 'claude startup failed and owned disposal did not complete'),
    });
  }
  throw failure;
}

export interface ClaudeAdapterOptions {
  /** SDK install root in which to find a managed runtime. */
  runtimeInstallRoot?: string;
  /** Host API key for this pi-ai catalog provider, resolved just before each spawn. */
  byok?: Readonly<{ providerId: string; resolveKey: () => Promise<string> }>;
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment Claude and its MCP servers get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** Override bin resolution — tests substitute the fake-claude fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
  /** Deadline for native interrupt ACK before owned-process termination fallback. */
  interruptTimeoutMs?: number;
  /** Native and tool payload bytes the session retains; past it the oldest are elided and the task continues. Default 16 MiB. Text and reasoning have their own 16 MiB limit. */
  maxRetainedBytes?: number;
  /** Local Host callbacks for native stdio requests; never enables remote boolean approvals. */
  nativeInteractions?: NativeInteractionHostOptions;
  /**
   * For an Agent task (`task.offer`), `excluded` starts Claude with
   * `--strict-mcp-config`, so only the task's and the SDK's MCP servers load,
   * and with a `--settings` file that excludes the `CLAUDE.md`,
   * `CLAUDE.local.md` and rules of the Claude config directory and of every
   * directory above the Agent home, turns off Claude auto memory and sets
   * the default output style. The user's settings, deny rules, hooks,
   * skills, model and env still apply, so hook output and skill listings
   * still reach the model. It affects
   * new sessions only: a resumed session keeps its history. Other tasks are
   * unchanged. Default `inherit`.
   */
  agentUserContext?: 'inherit' | 'excluded';
  /**
   * For an Agent task (`task.offer`), `disabled` starts Claude with
   * `--no-session-persistence`, so Claude does not save the session
   * transcript under `<config dir>/projects/`. Such a session cannot be
   * resumed: the descriptor declares `resume: false`, so the daemon declines
   * an offer carrying a `sessionRef` before claim with the non-retryable
   * reason `runtime "claude" cannot resume a session`. Follow-ups in the same
   * task still work. Other tasks are unchanged. Default `enabled`.
   */
  agentSessionPersistence?: 'enabled' | 'disabled';
  /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
}

/**
 * Claude Code stream-json adapter.
 *
 * An ordinary session runs with `--dangerously-skip-permissions`, as in OAR:
 * in embedded use there is no human at an approval prompt, so a permission
 * gate is a hang, not safety. Claude keeps its own guardrails (the user's
 * `~/.claude` settings and deny rules).
 *
 * Explicit nativeInteractions opts into the Agent SDK stdio control handshake
 * (`--permission-prompt-tool stdio`) instead of the skip flag so that
 * AskUserQuestion reaches the local Host UI. Every other can_use_tool request
 * is allowed by the SDK at once: tool permission is decided only by the task's
 * `auto | all` mode (the PreToolUse gate), never by a second native prompt.
 * Remote boolean approvals remain unsupported, as does mid-turn steering.
 */
/**
 * A provider the Host passes (`pass`) replaces whatever provider the user's
 * shell selects: the inherited Bedrock/Vertex switches, OAuth token and other
 * `ANTHROPIC_*` settings would otherwise override or mix with it.
 */
const CLAUDE_PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
const CLAUDE_PROVIDER_NAMES = ['ANTHROPIC_BASE_URL', ...CLAUDE_PROVIDER_KEYS];

function claudeProviderCredentials(env: Readonly<Record<string, string | undefined>>): string[] {
  const credentials: string[] = [];
  for (const [name, key] of Object.entries(env)) {
    const providerKey = CLAUDE_PROVIDER_KEYS.find(candidate => process.platform === 'win32' ? candidate === name.toUpperCase() : candidate === name);
    if (providerKey !== undefined && key !== undefined) credentials.push(requireRuntimeApiKey(key, `Claude ${providerKey}`));
  }
  return credentials;
}
const claudeEnvironmentConflicts: RuntimeEnvironmentConflictRule = (passed) =>
  CLAUDE_PROVIDER_NAMES.some((name) => passed.has(name))
    ? ['ANTHROPIC_*', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']
    : [];

export class ClaudeAdapter implements RuntimeAdapter {
  #runtimeReaders?: ReturnType<typeof createRuntimeReaders>;

  private get readers() {
    return this.#runtimeReaders ??= createRuntimeReaders(this, {
      nativeAssetRoot: this.options.nativeAssetRoot,
      spawnFn: this.options.spawnFn,
      command: (_env) => resolveRuntimeCommand(this.options.resolveBin, resolveClaudeBin, () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'claude')).bin.command,
      version: claudeVersionToken,
      environment: env => ({ env: claudeCredentialEnvironment(env), credentials: claudeProviderCredentials(env) }),
    });
  }

  listModels(options: RuntimeListModelsOptions = {}): Promise<RuntimeModelCatalog> {
    return this.readers.listModels(options, async (installation, reader) => {
      const { claudeListModels } = await import('#byok-oar-readers');
      return claudeListModels(installation, reader);
    });
  }

  accountUsage(options: RuntimeReadOptions = {}): Promise<RuntimeAccountUsage> {
    return this.readers.accountUsage(options, async (installation, reader) => {
      const { claudeAccountUsage } = await import('#byok-oar-readers');
      return claudeAccountUsage(installation, reader);
    });
  }

  readonly descriptor;
  private readonly byok?: NonNullable<ClaudeAdapterOptions['byok']>;
  private readonly nativeOptions?: NativeInteractionHostOptions;
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  private readonly effectiveVersionPolicy: RuntimeVersionPolicy | undefined;
  private readonly interruptTimeoutMs: number;
  private readonly maxRetainedBytes: number;

  constructor(private readonly options: ClaudeAdapterOptions = {}) {
    registerAdmissionDetect(this, ClaudeAdapter.prototype.detect, signal => this.#detectInstallation({ checkAuth: false, signal }));
    this.interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs, 'Claude');
    this.maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'Claude');
    if (options.agentUserContext !== undefined && options.agentUserContext !== 'inherit' && options.agentUserContext !== 'excluded')
      throw new TypeError('ClaudeAdapterOptions.agentUserContext must be inherit or excluded');
    if (options.agentSessionPersistence !== undefined && options.agentSessionPersistence !== 'enabled' && options.agentSessionPersistence !== 'disabled')
      throw new TypeError('ClaudeAdapterOptions.agentSessionPersistence must be enabled or disabled');
    this.nativeOptions = options.nativeInteractions === undefined ? undefined : snapshotNativeInteractionHostOptions(options.nativeInteractions);
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'ClaudeAdapterOptions.runtimeEnvironment');
    this.effectiveVersionPolicy = resolveRuntimeVersionPolicy(CLAUDE_VERSION_POLICY, options.versionPolicy);
    if (options.byok !== undefined) {
      if (!Object.hasOwn(PI_PROVIDER_ENV_KEYS, options.byok.providerId) || typeof options.byok.resolveKey !== 'function') {
        throw new TypeError('ClaudeAdapterOptions.byok requires a pi-ai catalog providerId and a resolveKey function');
      }
      this.byok = Object.freeze({ ...options.byok });
    }
    this.descriptor = freezeRuntimeAdapterDescriptor({
      id: 'claude',
      selectionModes: ['device-default', 'subscription', ...(this.byok === undefined ? [] : ['byok' as const])],
      ...(this.byok === undefined ? {} : { byokProviderId: this.byok.providerId }),
      supportsEffort: true,
      // `progress` events are complete text blocks, never deltas, and
      // `progressStartsMessage` joins the blocks of one message, so the
      // closing reply is the last assistant message. A run that repeats its
      // answer in a later model call with no tool between (#501) then
      // publishes it once.
      progressMessageBoundary: 'session',
      platforms: ['darwin', 'linux', 'win32'],
      capabilities: {
        ...CLAUDE_RUNTIME_CAPABILITIES,
        ...(options.agentSessionPersistence === 'disabled' ? { resume: false } : {}),
        isolation: {
          ...CLAUDE_RUNTIME_CAPABILITIES.isolation!,
          ...(options.agentUserContext === 'excluded' ? {} : {
            userInstructions: false, userOutputStyle: false, userMemory: false, userMcpServers: false,
          }),
          ...(options.agentSessionPersistence === 'disabled' ? {} : { sessionPersistence: false }),
        },
        ...(this.nativeOptions === undefined ? {} : { nativeInteractions: CLAUDE_NATIVE_INTERACTION_CAPABILITIES }),
      },
      ...(this.effectiveVersionPolicy === undefined ? {} : { versionPolicy: this.effectiveVersionPolicy }),
    });
  }

  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy, claudeEnvironmentConflicts);
  }

  async detect(signal?: AbortSignal): Promise<RuntimeDetectResult> {
    return this.#detectInstallation({ checkAuth: true, signal });
  }

  /**
   * `checkAuth: false` (task admission) omits `authPresent` (unmeasured): a
   * subscription launch reads the login itself, in its exact launch context.
   * A caller abort rethrows its reason.
   */
  async #detectInstallation(options: { readonly checkAuth: boolean; readonly signal?: AbortSignal }): Promise<RuntimeDetectResult> {
    const { checkAuth, signal } = options;
    signal?.throwIfAborted();
    try {
      const { env: rawEnv } = await this.runtimeEnvironment();
      claudeProviderCredentials(rawEnv);
      const env = claudeCredentialEnvironment(rawEnv);
      const resolved = resolveRuntimeCommand(this.options.resolveBin, resolveClaudeBin, () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'claude'));
      const invocation = resolveRuntimeInvocation(resolved.bin.command, runtimeInvocationHost(env));
      const probe = await probeRuntimeVersion(invocation.command, claudeProbeTimeouts.of(this).version, env, invocation.args, signal);
      if (probe.kind !== 'available') return probe;
      const version = probe.stdout.trim();
      let authPresent: boolean | undefined;
      if (checkAuth) {
        const auth = await this.#readAuthStatus(invocation, env, undefined, signal);
        if (auth.kind === 'timeout') return { kind: 'timeout' };
        authPresent = auth.kind === 'ok' && auth.status.loggedIn === true;
      }
      return bindVerifiedDetection(this, {
        kind: 'available', version, ...(authPresent === undefined ? {} : { authPresent }),
        sessionCapabilities: { ...claudeSessionCapabilities(), steer: this.descriptor.capabilities.steer },
        ...runtimeExecutableFields(resolved, invocation.executable),
        ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, claudeVersionToken(version)),
      }, invocation);
    } catch (error) {
      signal?.throwIfAborted();
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const { effort } = input.offer;
    const requested = offerSelection(input.offer.target);
    if (requested?.mode === 'byok' && (requested.modelId === undefined || requested.modelId.trim() === '')) {
      return { kind: 'reject', code: 'invalid_request', reason: 'Claude requires an explicit BYOK model ID', retryable: false };
    }
    let selection: ClaudeSelection;
    try {
      selection = this.executionSelection(requested);
    } catch (error) {
      return { kind: 'reject', reason: error instanceof Error ? error.message : String(error), retryable: false };
    }
    input.signal?.throwIfAborted();
    // Launch the invocation this offer's admission observation probed, when
    // this adapter made it; otherwise resolve the installation here.
    let invocation = takeVerifiedDetection<RuntimeInvocation>(this, input.detected);
    const detected = invocation === undefined ? undefined : input.detected as Extract<RuntimeDetectResult, { kind: 'available' }>;
    if (invocation === undefined) {
      let bin: { command: string };
      try {
        bin = this.resolveBin();
      } catch (error) {
        return { kind: 'reject', reason: error instanceof Error ? error.message : String(error), retryable: true };
      }
      try {
        invocation = resolveRuntimeInvocation(bin.command, runtimeInvocationHost((await this.runtimeEnvironment()).env));
      } catch (error) {
        // As Codex: the reason names the detect kind only, never a local path.
        return { kind: 'reject', reason: `claude installation refused: ${classifyDetectError(error).kind}`, retryable: false };
      }
    }
    const launched = invocation;
    let admittedLaunch: ClaudeSubscriptionLaunch | undefined;
    const operation: PreparedRuntimeOperation = {
      start: startInput => this.startPrepared(startInput, selection, launched, effort, admittedLaunch),
    };
    if (selection.mode === 'subscription') {
      operation.resolveRuntimeLaunch = async ({ cwd, env, scratch, signal = input.signal }) => {
        if (admittedLaunch !== undefined) throw invalidClaudeRequest('Claude subscription launch was already resolved');
        const launchEnv = Object.freeze(claudeCredentialEnvironment({ ...env, ...scratch.env }));
        const auth = await this.#readAuthStatus(launched, launchEnv, cwd, signal);
        signal?.throwIfAborted();
        requireClaudeSubscription(auth);
        admittedLaunch = Object.freeze({ cwd, env: launchEnv, scratch, release: () => scratch.release() });
        return admittedLaunch;
      };
    }
    if (detected === undefined) return { kind: 'prepared', operation };
    const { version, executableSource, versionVerdict } = detected;
    return { kind: 'prepared', operation, detected: { version, executableSource, versionVerdict } };
  }

  private executionSelection(input: HarnessSelection | undefined): ClaudeSelection {
    if (input === undefined || input.mode === 'device-default') return { mode: 'device-default' };
    if (input.mode === 'subscription') return { mode: 'subscription', modelId: input.modelId };
    if (input.mode === 'byok' && input.providerId === this.byok?.providerId) {
      return { mode: 'byok', providerId: input.providerId, modelId: input.modelId };
    }
    throw new PolicyUnsupportedError('Claude does not support the selected credential source or provider');
  }

  private async startPrepared(
    startInput: RuntimeOperationStartInput,
    selection: ClaudeSelection,
    invocation: RuntimeInvocation,
    effort: string | undefined,
    admittedLaunch: ClaudeSubscriptionLaunch | undefined,
  ): Promise<Session> {
    const signal = startInput.signal;
    const rawEnv = { ...startInput.env, ...startInput.scratch.env };
    const env = admittedLaunch === undefined ? claudeCredentialEnvironment(rawEnv) : { ...admittedLaunch.env };
    const taskMcpServers = startInput.mcpServers ?? {};
    const credentials = sessionCredentialRedactor({ env: rawEnv, mcpServers: Object.entries(taskMcpServers).map(([name, server]) => ({ name, ...server })) });
    const cancellationFailure = () => new RuntimeExecutionFailure({
      phase: 'start', retry: 'retryable',
      reason: 'claude runtime startup was cancelled',
    }, { cause: signal?.reason });
    if (signal?.aborted) {
      for (const [name, key] of Object.entries(rawEnv)) {
        if (key !== undefined && key.length > 0 && CLAUDE_PROVIDER_KEYS.some(candidate => process.platform === 'win32' ? candidate === name.toUpperCase() : candidate === name)) {
          credentials.addExplicit(key);
        }
      }
      throw redactClaudeFailure(cancellationFailure(), credentials);
    }
    // This adapter has no prepared-input lane: a frozen provider request is
    // compiled against the pi runtime's own verified closure, and claude cannot
    // be told to send someone else's bytes. Refused by name rather than
    // ignored, so a prepared Execution routed here fails visibly instead of
    // running as an ordinary turn with no instruction at all.
    if (startInput.kind !== 'instruction') {
      throw new RuntimeExecutionFailure({
        phase: 'start',
        retry: 'non-retryable',
        reason: 'the claude adapter has no prepared-input lane',
      });
    }
    if (typeof startInput.instruction !== 'string') {
      throw new RuntimeExecutionFailure({
        phase: 'start',
        retry: 'non-retryable',
        reason: 'prepared claude operation requires a resolved string instruction',
      });
    }
    const mcpArgs: string[] = [];

    // Generate only task-scoped host/reserved MCP config outside the operation workspace.
    let stream: ClaudeStreamSession | undefined;
    let gate: ClaudeToolAuthorizationBridge | undefined;
    let native: ClaudeNativeInteractionBridge | undefined;
    // A halted or failed process answers nothing more: both bridges end with it.
    const closeBridges = () => { native?.close(); gate?.close(); };
    let cancellation: RuntimeExecutionFailure | undefined;
    let rejectCancellation!: (failure: RuntimeExecutionFailure) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    // Aborts can arrive during awaited config work, before either race starts.
    void cancelled.catch(() => {});
    const onAbort = () => {
      cancellation ??= cancellationFailure();
      closeBridges();
      stream?.halt(cancellation);
      rejectCancellation(cancellation);
    };
    const throwIfCancelled = () => {
      if (signal?.aborted && !cancellation) onAbort();
      if (cancellation) {
        // Also covers an abort inside spawnFn, before the stream was assigned.
        closeBridges();
        stream?.halt(cancellation);
        throw cancellation;
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (const credential of claudeProviderCredentials(rawEnv)) credentials.addExplicit(credential);
      throwIfCancelled();
      const persistSession = startInput.manifest.agentRef === undefined || this.options.agentSessionPersistence !== 'disabled';
      // Built before any write, so a refusal leaves no file behind.
      const userContextSettings = this.options.agentUserContext === 'excluded' && startInput.manifest.agentRef !== undefined
        ? claudeAgentUserContextSettings(startInput.manifest, startInput.env, process.platform, os.homedir, dir => {
          // A directory that does not resolve holds no files to keep.
          try { return realpathSync.native(dir); } catch { return dir; }
        })
        : undefined;
      const needsMcpConfig = Object.keys(taskMcpServers).length > 0;
      const sdkDir = startInput.scratch.sdkDir;
      if (needsMcpConfig || userContextSettings) {
        throwIfCancelled();
      }
      // Under `agentUserContext: 'excluded'` an Agent task gets exactly the
      // `--mcp-config` servers, or none. Otherwise they are added to the
      // user's own MCP configuration. The user's settings, deny rules and
      // hooks load either way, as in OAR.
      if (userContextSettings) mcpArgs.push('--strict-mcp-config');
      if (needsMcpConfig) {
        const mcpConfigPath = path.join(sdkDir, 'mcp-config.json');
        // The claude CLI spawns these servers itself, in its own cwd: the
        // session workspace or the Agent home, as in OAR.
        await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: taskMcpServers }), { mode: 0o600 });
        throwIfCancelled();
        mcpArgs.push('--mcp-config', mcpConfigPath);
      }
      if (userContextSettings) {
        // A file, not inline JSON: Windows command-shim quoting and length.
        const settingsPath = path.join(sdkDir, 'claude-settings.json');
        await fs.writeFile(settingsPath, JSON.stringify(userContextSettings), { mode: 0o600 });
        throwIfCancelled();
        mcpArgs.push('--settings', settingsPath);
      }

      const resumeSessionId = startInput.manifest.sessionRef;
      let manifestSelection: ClaudeSelection;
      try {
        manifestSelection = this.executionSelection(startInput.manifest.selection);
      } catch (cause) {
        throw new RuntimeExecutionFailure({
          phase: 'start',
          retry: 'non-retryable',
          reason: 'prepared claude operation received an invalid runtime selection manifest',
        }, { cause });
      }
      const manifestModelId = manifestSelection.mode === 'device-default' ? undefined : manifestSelection.modelId;
      const modelId = selection.mode === 'device-default' ? undefined : selection.modelId;
      if (manifestSelection.mode !== selection.mode || manifestModelId !== modelId || startInput.manifest.effort !== effort) {
        throw new RuntimeExecutionFailure({
          phase: 'start',
          retry: 'non-retryable',
          reason: 'prepared claude operation received a manifest with different runtime selection',
        });
      }
      const manifestCwd = startInput.manifest.cwd;
      if (manifestCwd === undefined) {
        throw new RuntimeExecutionFailure({
          phase: 'start', retry: 'non-retryable',
          reason: 'prepared claude operation received a manifest without a sealed cwd',
        });
      }
      if (selection.mode === 'subscription' && (admittedLaunch === undefined || admittedLaunch !== startInput.runtimeLaunch
        || admittedLaunch.cwd !== manifestCwd || admittedLaunch.scratch !== startInput.scratch)) {
        throw invalidClaudeRequest('Claude subscription start requires its exact admitted launch');
      }
      let launchModel = manifestModelId;
      if (effort !== undefined) {
        let catalog: RuntimeModelCatalog;
        try {
          catalog = await this.listModels({ signal });
        } catch (cause) {
          throwIfCancelled();
          throw invalidClaudeRequest('claude_effort_catalog_unavailable', cause);
        }
        throwIfCancelled();
        if (catalog.kind !== 'ok') throw invalidClaudeRequest('claude_effort_catalog_unavailable');
        const model = manifestModelId === undefined
          ? catalog.models.find(entry => entry.default === true || entry.id === 'default')
          : catalog.models.find(entry => entry.id === manifestModelId) ?? catalog.models.find(entry => entry.resolvedId === manifestModelId);
        if (model?.effortLevels === undefined || model.disabled !== undefined) throw invalidClaudeRequest('claude_effort_menu_unavailable');
        if (!model.effortLevels.includes(effort)) throw invalidClaudeRequest('claude_effort_unsupported');
        // Pin the model whose menu admitted the effort, including on resume.
        launchModel ??= model.resolvedId ?? model.id;
      }
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        // REQUIRED alongside `--output-format stream-json` in `--print` mode —
        // empirically confirmed: omitting this exits 1 immediately with
        // "Error: When using --print, --output-format=stream-json requires
        // --verbose", before spawning any model call.
        '--verbose',
        // Text deltas for the display-only draft (`stream_event` frames).
        '--include-partial-messages',
        ...(persistSession ? [] : ['--no-session-persistence']),
        ...(launchModel === undefined ? [] : ['--model', launchModel]),
        ...(effort === undefined ? [] : ['--effort', effort]),
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        // YOLO by default, as in OAR (`runtimes/claude/session.ts`). Native
        // interactions need the stdio prompt tool to relay AskUserQuestion;
        // the bridge passes every other request through (see the class doc).
        ...(this.nativeOptions === undefined
          ? ['--dangerously-skip-permissions']
          : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'acceptEdits']),
        ...mcpArgs,
      ];

      throwIfCancelled();
      const mcpIdentity = createClaudeMcpIdentityResolver(() => stream?.mcpStatus() ?? Promise.resolve(undefined), new Map(Object.entries(taskMcpServers)));
      gate = startInput.toolAuthorization === undefined ? undefined
        : new ClaudeToolAuthorizationBridge(startInput.toolAuthorization, error => { closeBridges(); stream?.fail(error); }, mcpIdentity.resolve);
      native = this.nativeOptions === undefined ? undefined : new ClaudeNativeInteractionBridge({
        ...this.nativeOptions,
        // The adapter, never the host callback, owns fatal process termination.
        onFatal: error => { closeBridges(); stream?.fail(error); },
      }, resumeSessionId);
      if (selection.mode === 'byok') {
        const key = await resolveRuntimeApiKey('claude', this.byok!.resolveKey, signal);
        throwIfCancelled();
        env.ANTHROPIC_API_KEY = key;
        credentials.addExplicit(key);
      }
      const spawnLineProcess = createOwnedLineProcessSpawn({
        nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'claude', stderrRedactor: credentials,
      });
      try {
        stream = new ClaudeStreamSession(spawnLineProcess(invocation.command, [...invocation.args, ...args], { cwd: manifestCwd, env }), credentials);
      } catch (cause) {
        throw new RuntimeExecutionFailure({
          phase: 'start', retry: 'retryable',
          reason: 'claude runtime process could not be spawned',
        }, { cause });
      }
      const opened = stream;

      throwIfCancelled();
      try {
        await Promise.race([opened.open({
          effort,
          ...(resumeSessionId === undefined ? {} : { resume: resumeSessionId }),
          maxRetainedBytes: this.maxRetainedBytes,
          ...(native === undefined && gate === undefined ? {} : { initialize: { hooks: gate?.hooks ?? null } }),
          onFrame: frame => native?.receive(frame),
          onExit: () => { native?.close(); gate?.close(); },
          // A request no bridge takes is never answered: no default allow.
          onAppRequest: (message, respond) => {
            if (gate?.receive(message, respond) || declineElicitation(message, respond)) return;
            native?.request(message, respond);
          },
        }), cancelled]);
      } catch (cause) {
        if (isRuntimeStartupDisposalFailure(cause) || isRuntimeExecutionFailure(cause)) throw cause;
        throw new RuntimeExecutionFailure({
          phase: 'start', retry: 'retryable',
          reason: 'claude runtime process could not be opened',
          failure: opened.startupExit(),
        }, { cause });
      }
      throwIfCancelled();
      // No prompt is sent unless the runtime confirms the gate is registered.
      if (gate !== undefined && opened.hooksApplied !== true) throw new RuntimeExecutionFailure({
        phase: 'start', retry: 'non-retryable',
        reason: 'tool_authorization_unsupported: Claude did not confirm registration of the PreToolUse authorization hook',
      });
      native?.beginTurn();
      // `--input-format stream-json` takes the first turn's instruction on
      // stdin, as every follow-up: one send path. Claude's `system/init`
      // after it carries the session id.
      let sessionRef: string;
      try {
        requireImageInput(startInput.images, opened.raw.capabilities.images === true);
        const prompted = await Promise.race([opened.prompt(startInput.instruction, startInput.images), cancelled]);
        if (prompted.response.body.kind !== 'accepted') {
          throw new RuntimeExecutionFailure({
            phase: 'start', retry: 'retryable',
            reason: `claude initial instruction transport failed: ${prompted.response.body.reason ?? prompted.response.body.kind}`,
            failure: opened.startupExit(),
          });
        }
        // Claude reports its real `session_id` on the first `system/init`,
        // resume or fresh alike. An unresolvable `--resume` target never
        // emits one and exits: fail closed, never a fabricated sessionRef.
        sessionRef = await Promise.race([opened.sessionRef, cancelled]);
      } catch (err) {
        if (isRuntimeStartupDisposalFailure(err)) throw err;
        if (isRuntimeExecutionFailure(err)) throw err;
        throw new RuntimeExecutionFailure({
          phase: 'start', retry: 'retryable',
          reason: `claude exited before yielding an authoritative session id: ${errorMessage(err)}`,
          failure: opened.startupExit(),
        }, { cause: err });
      }

      // A resume that reports another session would run the task against
      // the wrong history: fail closed instead of trusting the echo.
      if (resumeSessionId !== undefined && sessionRef !== resumeSessionId) {
        throw new RuntimeExecutionFailure({
          phase: 'start',
          retry: 'non-retryable',
          reason: 'claude --resume echoed a different session id than requested',
        });
      }

      throwIfCancelled();
      return new ClaudeSession(
        sessionRef,
        opened,
        manifestCwd,
        this.interruptTimeoutMs,
        startInput.scratch,
        mcpIdentity,
        manifestSelection,
        native,
        gate,
      );
    } catch (cause) {
      gate?.close();
      return rejectOwnedStartup(cause, credentials, stream, startInput.scratch, cancellation !== undefined);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Read only the CLI's native login status. Admission supplies the task cwd and launch environment.
   * The CLI answers with exit 0 when logged in and 1 when logged out (as OAR's `auth-status.ts`);
   * a caller abort rethrows its reason.
   */
  async #readAuthStatus(invocation: RuntimeInvocation, env: Readonly<Record<string, string>>, cwd?: string, signal?: AbortSignal): Promise<ClaudeAuthStatusRead> {
    const outcome = await runDetectCommand(invocation.command, [...invocation.args, 'auth', 'status', '--json'], {
      timeoutMs: claudeProbeTimeouts.of(this).authStatus, env, cwd, signal,
    });
    if (outcome.kind === 'aborted') throw outcome.reason;
    if (outcome.kind === 'timeout') return { kind: 'timeout' };
    if (outcome.kind === 'failed' || (outcome.kind === 'nonzero' && outcome.exitCode !== 1)) return { kind: 'failed' };
    let status: unknown;
    try {
      status = JSON.parse(outcome.stdout);
    } catch {
      return { kind: 'failed' };
    }
    if (status === null || typeof status !== 'object' || Array.isArray(status)) return { kind: 'failed' };
    const { loggedIn, authMethod, apiProvider, apiKeySource } = status as ClaudeAuthStatus;
    return { kind: 'ok', status: { loggedIn, authMethod, apiProvider, apiKeySource } };
  }

  private resolveBin(): { command: string } {
    return resolveRuntimeCommand(this.options.resolveBin, resolveClaudeBin, () => resolveManagedRuntime(this.options.runtimeInstallRoot, 'claude')).bin;
  }
}

/** A deadline is retryable: the login is unconfirmed, not refused. */
function requireClaudeSubscription(auth: ClaudeAuthStatusRead): void {
  if (auth.kind === 'timeout') throw new RuntimeExecutionFailure({ phase: 'start', retry: 'retryable', reason: AUTH_STATUS_TIMEOUT_REASON });
  if (auth.kind !== 'ok' || !claudeHasSubscription(auth.status)) throw invalidClaudeRequest(SUBSCRIPTION_REQUIRED);
}

function claudeHasSubscription(status: ClaudeAuthStatus): boolean {
  return status.loggedIn === true && status.authMethod === 'claude.ai'
    && (status.apiProvider === undefined || status.apiProvider === 'firstParty')
    && (status.apiKeySource === undefined || status.apiKeySource === null || status.apiKeySource === '');
}

function invalidClaudeRequest(reason: string, cause?: unknown): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason, failure: { class: 'invalid_request' } }, { cause });
}

type ClaudeSelection = Extract<HarnessSelection, { mode: 'device-default' | 'subscription' | 'byok' }>;

/** Whether an assistant frame calls a Claude MCP tool (`mcp__…`) the session has no identity for yet. */
function callsUnresolvedMcpTool(message: ClaudeStreamMessage, correlation: ToolUseCorrelation): boolean {
  if (message.type !== 'assistant') return false;
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) && content.some((block: { type?: unknown; name?: unknown }) =>
    block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith('mcp__')
    && correlation.mcpIdentities?.has(block.name) !== true);
}

/** The one model served to the root agent (`parent_tool_use_id: null`) this turn; `<synthetic>` frames are Claude's own. */
class ClaudeServedModel {
  private readonly models = new Set<string>();
  private unknown = false;

  observe(msg: ClaudeStreamMessage): void {
    if (msg.type !== 'assistant' || msg.parent_tool_use_id !== null) return;
    const reported = (msg.message as { model?: unknown } | undefined)?.model;
    if (reported === '<synthetic>') return;
    const model = servedModelName(reported);
    if (model === undefined) this.unknown = true;
    else this.models.add(model);
  }

  takeTurnModel(): string | undefined {
    const [only, ...rest] = this.models;
    const model = this.unknown || rest.length > 0 ? undefined : only;
    this.models.clear();
    this.unknown = false;
    return model;
  }
}

class ClaudeSession implements Session {
  declare readonly interactions?: NativeInteractionChannel;
  private readonly correlation: ToolUseCorrelation;
  private readonly assistantMessages = new AssistantMessageTracker();
  private readonly servedModel = new ClaudeServedModel();
  private readonly failureEvidence = new ClaudeFailureEvidence();
  private closeAttempt: Promise<void> | undefined;

  constructor(
    public readonly sessionRef: string,
    private readonly stream: ClaudeStreamSession,
    private readonly workspaceDir: string,
    private readonly interruptTimeoutMs: number,
    /** Task-scoped temp `--mcp-config` directory, if any — removed in `close()`. */
    private readonly scratch: ExecutionScratch,
    private readonly mcpIdentity: ReturnType<typeof createClaudeMcpIdentityResolver>,
    private readonly selection: ClaudeSelection,
    private readonly native?: ClaudeNativeInteractionBridge,
    private readonly gate?: ClaudeToolAuthorizationBridge,
  ) { this.correlation = { toolNameByUseId: new Map(), mcpIdentities: this.mcpIdentity.identities }; if (native !== undefined) this.interactions = native.channel; }

  get events(): AsyncIterable<AgentEvent | MessageDraftDelta> {
    const stream = this.stream;
    const correlation = this.correlation;
    const assistantMessages = this.assistantMessages;
    const servedModel = this.servedModel;
    const failureEvidence = this.failureEvidence;
    const workspaceDir = this.workspaceDir;
    const mcpIdentity = this.mcpIdentity;
    const redactFailure = (error: unknown): never => { throw redactClaudeFailure(error, stream.credentials); };
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent | MessageDraftDelta> {
        const inner = stream.frames[Symbol.asyncIterator]();
        // A single raw claude frame can map to more than one AgentEvent
        // (e.g. a Write `tool_result` plus a derived `artifact` — see
        // `projection.ts`'s `mapUser`) — buffered here and drained before
        // pulling the next raw line, so this iterator still yields exactly
        // one `AgentEvent` per `next()` call like every other adapter's
        // `Session.events`.
        let pending: Array<AgentEvent | MessageDraftDelta> = [];
        let terminalFailure: RuntimeExecutionFailure | undefined;
        // Cross-model re-review finding (P1 regression, the "claude-hang
        // class"): set once THIS turn's own `result` frame has been read off
        // `inner` — `result` is claude's real "whole run settled" signal and
        // is always the LAST frame of a turn, success or failure alike (see
        // `projection.ts`'s `mapResult` doc comment). On the SUCCESS path
        // (`turn_end`) this is inert: `task-runner.ts`'s `pump()` returns the
        // instant it sees `turn_end`, so no further `next()` call ever
        // happens. It matters on the FAILURE/malformed path: `mapResult`
        // maps a non-success result to a plain `error` AgentEvent with no
        // `turn_end` — and unlike codex (one process per turn, whose own
        // process-close watcher ends the queue — see codex-adapter.ts's
        // `runCodexTurn`), claude's process is PERSISTENT: it stays alive
        // after `result`, awaiting a possible `followUp()` write on stdin.
        // Nothing would otherwise
        // ever end this iterator, so `task-runner.ts`'s `pump()` would await
        // a raw line that never arrives — a real, confirmed hang, not just a
        // theoretical one. Once `turnSettled` is true and `pending` has been
        // fully drained (every event from the `result` frame delivered),
        // this iterator ends itself (`done:true`) WITHOUT pulling `inner`
        // again — ending only THIS TURN's own exposed event stream, never
        // the underlying session-lifetime `stream.frames` queue a future
        // `followUp()` still needs, and never killing the process itself
        // (that stays this session's `close()`/`interrupt()`'s job). This is
        // exactly what lets `pump()`'s existing "iterable ended without
        // turn_end" branch report the task as Failed instead of hanging.
        let turnSettled = false;
        const iterator = {
          async next(): Promise<IteratorResult<AgentEvent | MessageDraftDelta>> {
            for (;;) {
              const buffered = pending.shift();
              if (buffered) return { value: buffered, done: false };

              if (terminalFailure) throw terminalFailure;

              if (turnSettled) {
                return { value: undefined as never, done: true };
              }

              let raw: IteratorResult<ClaudeFrame>;
              try {
                raw = await inner.next();
              } catch (cause) {
                throw new RuntimeExecutionFailure({
                  phase: 'run',
                  retry: 'retryable',
                  reason: 'claude runtime event transport failed',
                }, { cause });
              }
              const { value: frame, done } = raw;
              if (done) {
                throw new RuntimeExecutionFailure({
                  phase: 'run',
                  retry: 'retryable',
                  reason: 'claude runtime process ended before a terminal result frame',
                  failure: { class: stream.processExited ? 'runtime_exited' : 'unknown' },
                }, { cause: stream.terminalError });
              }

              const { native: value, agentPath, context, textTail } = frame;
              const root = agentPath.length === 0;
              if (root && value.type === 'result') turnSettled = true;
              if (root) failureEvidence.observe(value);

              if (callsUnresolvedMcpTool(value, correlation)) {
                // Asked at the first MCP call, when Claude has connected its
                // servers: an earlier answer reports them `pending` with no
                // tools. One lookup per process; a failure leaves `mcp` absent.
                await mcpIdentity.observe();
              }
              const mapped = mapClaudeMessageToAgentEvents(value, correlation, {
                workspaceDir, agentPath, context, initModel: root ? stream.initModel : undefined, redactDiagnostic: stream.redactDiagnostic,
              });
              if (root) {
                servedModel.observe(value);
                if (value.type === 'result') {
                  const model = servedModel.takeTurnModel();
                  if (model !== undefined) {
                    const usage = mapped.events.find(event => event.type === 'usage');
                    if (usage?.type === 'usage') usage.model = model;
                    else mapped.events.unshift({ type: 'usage', model });
                  }
                }
                assistantMessages.observe(value, mapped.events);
              }
              if (mapped.terminalFailure !== undefined) terminalFailure = failureEvidence.attach(value, mapped.terminalFailure);
              if (mapped.unmappedLabel) {
                stream.recordUnmappedFrame(mapped.unmappedLabel);
              }
              pending = mapped.events;
              if (textTail !== undefined) {
                const continuation: AgentEvent = { type: 'progress', text: textTail.text, ...(root ? {} : { agentPath: [...agentPath] }) };
                if (textTail.continues) assistantMessages.continueMessage(continuation);
                pending.unshift(continuation);
              }
              // Nothing to yield yet (routine frame, or an unmapped one) —
              // loop around and pull the next raw line.
            }
          },
        };
        return { next: () => iterator.next().catch(redactFailure) };
      },
    };
  }

  /**
   * Not supported — see the class-level doc comment on `ClaudeAdapter` for
   * the full empirical basis (a message written to stdin mid-turn was
   * proven to queue as a follow-up turn, not redirect the running one).
   * `capabilities().steer` reports `false` for exactly this reason; this
   * throws rather than silently behaving like `followUp()` under the
   * `steer()` name, which would promise live redirection it cannot deliver.
   */
  progressStartsMessage(event: Extract<AgentEvent, { type: 'progress' }>): boolean {
    return this.assistantMessages.startsMessage(event);
  }

  async steer(): Promise<void> {
    throw new SteerUnsupportedError(
      'claude',
      'claude adapter does not support mid-turn steering: writing to claude\'s stdin while a turn is in flight queues as a separate subsequent turn rather than redirecting the running one (empirically confirmed) — see capabilities().steer',
    );
  }

  followUp(task: RuntimeTaskInput): Promise<void> {
    return this.#followUp(task).catch(error => { throw redactClaudeFailure(error, this.stream.credentials); });
  }

  async #followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('claude adapter only supports string instructions in M2 (no blob-ref fetch yet)');
    }
    if (task.effort !== undefined && task.effort !== this.stream.effort) {
      throw new PolicyUnsupportedError('claude persistent session cannot change effort');
    }
    const selection = offerSelection(task.target);
    if (selection !== undefined && (selection.mode !== this.selection.mode ||
      ('modelId' in selection && (!('modelId' in this.selection) || selection.modelId !== this.selection.modelId)) ||
      (selection.mode === 'byok' && (this.selection.mode !== 'byok' || selection.providerId !== this.selection.providerId)))) {
      throw new PolicyUnsupportedError('claude persistent session cannot change its explicit selection');
    }
    // A prompt on the SAME persistent process: claude keeps a
    // `--input-format stream-json` process alive across sequential turns,
    // reusing the identical `session_id`, until stdin closes or the
    // process is killed. OAR refuses a prompt as busy while Claude runs a
    // turn of its own (a background task wake); OAR then holds it and
    // sends it when that turn ends.
    requireImageInput(task.images, this.stream.raw.capabilities.images === true);
    let refusal: unknown;
    try {
      this.native?.beginTurn();
      let prompted = await this.stream.prompt(task.instruction, task.images);
      if (prompted.response.body.code === 'busy') prompted = await this.stream.queue(task.instruction, task.images);
      if (prompted.response.body.kind === 'accepted') return;
      refusal = prompted.response.body;
    } catch (cause) {
      refusal = cause;
    }
    throw new RuntimeExecutionFailure({
      phase: 'run', retry: 'retryable',
      reason: 'claude follow-up instruction transport failed',
    }, { cause: refusal });
  }

  /** Native interrupt ACK is bounded; TaskRunner still closes after cancellation acknowledgment. */
  async interrupt(): Promise<void> {
    try {
      this.native?.endTurn('interrupted');
      if (!await this.stream.interruptAndSettle(this.interruptTimeoutMs)) await this.stream.dispose();
    } catch (error) {
      throw redactClaudeFailure(error, this.stream.credentials);
    }
  }

  async close(): Promise<void> {
    this.native?.close('closed');
    this.gate?.close();
    if (!this.closeAttempt) {
      const attempt = (async () => {
        // OAR records the dispose request and, on close, the exit; the owned
        // process tree's disposal, which that request starts, is the receipt.
        void this.stream.raw.dispose().catch(() => {});
        await this.stream.dispose();
        await this.scratch.release();
      })();
      this.closeAttempt = attempt.catch((error: unknown) => {
        this.closeAttempt = undefined;
        throw redactClaudeFailure(error, this.stream.credentials);
      });
    }
    await this.closeAttempt;
  }
}
