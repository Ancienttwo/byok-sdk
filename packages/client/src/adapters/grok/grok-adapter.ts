import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits.js';
import { createRuntimeReaders } from '../../runtime/runtime-readers.js';
import type { RuntimeListModelsOptions, RuntimeModelCatalog, RuntimeReadOptions, RuntimeAccountUsage } from '../../runtime/runtime-reader-types.js';
import { spawn, type spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { requireImageInput } from '../input-images.js';
import type { RuntimeInputImage, RuntimeInputOptions } from '../../types.js';
import { offerSelection, type RuntimeTaskInput } from '../../types.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { oarStartClassifier, runtimeStartFailure } from '../runtime-start-failure.js';
import type { AgentEvent, TaskFailure } from '@byok-sdk/protocol';
import type { ExecutionScratch } from '../../daemon/retention/scratch.js';
import { HELD_LOGIN_RESOLUTION, heldLogins } from './held-login.js';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  SteerUnsupportedError,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeDetectResult,
  type RuntimeVersionPolicy,
  type MessageDraftDelta,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types.js';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure.js';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment.js';
import { classifyDetectError, probeRuntimeVersion, runDetectCommand } from '../detect-outcome.js';
import { bindVerifiedDetection, takeVerifiedDetection } from '../../runtime-detection.js';
import { sessionCredentialRedactor } from '../../runtime/claude-session-runtime.js';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process.js';
import { createOwnedTerminalSpawn } from '../../runtime/owned-terminal-process.js';
import type { AcpRecord, RawAcpSession } from '../../runtime/acp-session-runtime.js';
import { AsyncQueue } from '../../util/async-queue.js';
import { haltGate, SettleWaiters, raceDeadline, oarCancelSettled, RetryableOnce } from '../session-kit.js';
import type { ResolvedBin } from '../codex/resolve-bin.js';
import { agentPersona } from '../agent-persona.js';
import { GROK_INSPECT_FAILED, GROK_USER_MCP_SERVERS_OFF, grokInspectRefusal } from './agent-user-mcp-servers.js';
import { GROK_USER_CONTEXT_INSPECT_FAILED, createGrokAgentHome, grokUserInstructionsRefusal } from './agent-user-context.js';
import { runGrokInspect } from './inspect.js';
import { GrokProjection, type GrokTurnOutcome } from './projection.js';
import { resolveGrokBin } from './resolve-bin.js';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable.js';
import { withoutProviderCredentials } from '../provider-credential-environment.js';
import { GROK_RUNTIME_CAPABILITIES } from './grok-capabilities.js';
import { GROK_VERSION_POLICY, grokVersionToken } from './grok-version.js';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy.js';

const DETECT_TIMEOUT_MS = 5000;
const PERMISSION_STOP_REASON = 'grok ended the turn as cancelled without an SDK cancel (a permission request answered cancelled)';
/** Grok's per-process switches for the Claude and Cursor `agents` and `rules` compatibility cells. */
const COMPAT_INSTRUCTIONS_OFF = Object.freeze({
  GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0',
  GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_RULES_ENABLED: '0',
});
/**
 * Grok's documented process switch for its updater. Started from a managed
 * install with `GROK_HOME` at that install, Grok's stdio agent runs the
 * update module and writes into the install's `bin/` (#2269). An SDK task
 * never updates or edits the user's install; Grok run by the user still does.
 */
const AUTO_UPDATE_OFF = Object.freeze({ GROK_DISABLE_AUTOUPDATER: '1' });

export interface GrokAdapterOptions {
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment Grok and its MCP servers get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** Grok model id for every session (`session/set_model`). Absent: the user's Grok default. */
  model?: string;
  /**
   * `disabled` sets Grok's four Claude and Cursor `agents` and `rules`
   * variables to `0` on the Grok agent process. That turns off its scanning of
   * the named instruction files and rules directories under `~/.claude/` and
   * `~/.cursor/`, and the project `.claude/CLAUDE*.md`, `.claude/rules/` and
   * `.cursor/rules/`. Client-hosted terminal commands do not get the variables;
   * children that Grok starts itself, such as stdio MCP servers and hooks, may
   * inherit them. `$GROK_HOME/AGENTS.md`, `$GROK_HOME/rules/` and
   * `[paths] extra_rule_dirs` still load; Grok has no per-process switch for
   * them, and `agentUserContext: 'excluded'` keeps them out of Agent tasks.
   * Default `inherit`: the user's Grok settings apply.
   */
  compatInstructions?: 'inherit' | 'disabled';
  /**
   * For an Agent task (`task.offer`), `excluded` runs Grok with `GROK_HOME`
   * set to `<execution scratch>/grok-home`, which holds symbolic links only:
   * to the user's `auth.json`, `config.toml`, `trusted_folders.toml` and
   * `hooks/`, and `sessions/` to the Agent's own store in
   * `<Agent home>/.byok/grok/`. The user's `AGENTS.md`, `rules/`, skills,
   * memory, plugins and sessions stay out. It also sets the four Claude and
   * Cursor `agents` and `rules` variables of `compatInstructions: 'disabled'`
   * on the Grok agent process, then runs `grok inspect --json` with that
   * environment. The start fails before the agent starts if inspect still
   * lists a user instruction file (such as an `[paths] extra_rule_dirs`
   * file) or fails, if the task has no sealed Agent home, or if the user
   * `GROK_HOME` has no `auth.json` and `XAI_API_KEY` is not set. It controls
   * which user context Grok loads; it is not a filesystem boundary. Other
   * tasks are unchanged. Default `inherit`.
   */
  agentUserContext?: 'inherit' | 'excluded';
  /**
   * For an Agent task (`task.offer`), `excluded` sets
   * `GROK_CLAUDE_MCPS_ENABLED`, `GROK_CURSOR_MCPS_ENABLED` and
   * `GROK_MANAGED_MCPS_ENABLED` to `0` on the Grok agent process, then runs
   * `grok inspect --json` in the task cwd with the same environment. The
   * start fails before the agent starts if inspect lists an MCP server that
   * is not disabled, or an enabled plugin that provides MCP servers, or if
   * inspect fails. Grok has no per-process switch for the servers of
   * `~/.grok/config.toml`, project `.grok/config.toml` and `.mcp.json`, or
   * plugins, so a user who has one enabled cannot run Agent tasks with this
   * option. Two sources are not detected: a server turned on while the
   * session runs (a config hot-reload, `/mcps` or `grok mcp enable`), and
   * managed MCP that an administrator pins on. Other tasks are unchanged.
   * Default `inherit`.
   */
  agentUserMcpServers?: 'inherit' | 'excluded';
  /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  interruptTimeoutMs?: number;
}

/**
 * Grok Build over ACP (`grok agent --always-approve --no-leader stdio`),
 * through the vendored OAR Grok profile. The SDK owns the agent process,
 * every terminal command Grok asks the client to run, the environment, the
 * record budget and the permission policy (requests are cancelled, and a
 * turn that ends on one fails).
 *
 * `grok` is not a frozen wire runtime id, so a task reaches this adapter by
 * the custom-harness identity (`harnessId: 'grok'`). It takes no dispatch
 * selection; the model is the adapter's `model` option.
 */
export class GrokAdapter implements RuntimeAdapter {
  #runtimeReaders?: ReturnType<typeof createRuntimeReaders>;

  private get readers() {
    return this.#runtimeReaders ??= createRuntimeReaders(this, {
      nativeAssetRoot: this.options.nativeAssetRoot,
      spawnFn: this.options.spawnFn,
      command: (_env) => resolveRuntimeCommand(this.options.resolveBin, resolveGrokBin).bin.command,
      version: grokVersionToken,
      environment: env => ({ env: { ...withoutProviderCredentials(env), ...AUTO_UPDATE_OFF } }),
    });
  }

  listModels(options: RuntimeListModelsOptions = {}): Promise<RuntimeModelCatalog> {
    return this.readers.listModels(options, async (installation, reader) => (await import('#byok-acp-runtime')).grokListModels(installation, reader));
  }

  accountUsage(options: RuntimeReadOptions = {}): Promise<RuntimeAccountUsage> {
    return this.readers.accountUsage(options, async (installation, reader) => (await import('#byok-acp-runtime')).grokAccountUsage(installation, reader));
  }

  get descriptor() { return freezeRuntimeAdapterDescriptor({
    id: 'grok',
    selectionModes: ['device-default', 'adapter-model'],
    ...(this.options.model === undefined ? {} : { defaultModelModes: ['adapter-model'] }),
    supportsEffort: true,
    // Windows has no Grok evidence (`docs/adapter-capabilities.md`).
    platforms: ['darwin', 'linux'],
    capabilities: {
      ...GROK_RUNTIME_CAPABILITIES,
      isolation: {
        ...GROK_RUNTIME_CAPABILITIES.isolation!,
        ...(this.options.agentUserMcpServers === 'excluded' ? {} : { userMcpServers: false }),
        ...(this.options.agentUserContext === 'excluded' ? {} : { userInstructions: false }),
      },
    },
    ...(this.effectiveVersionPolicy === undefined ? {} : { versionPolicy: this.effectiveVersionPolicy }),
  }); }

  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  private readonly effectiveVersionPolicy: RuntimeVersionPolicy | undefined;
  private readonly interruptTimeoutMs: number;
  private readonly maxRetainedBytes: number;

  constructor(private readonly options: GrokAdapterOptions = {}) {
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'GrokAdapterOptions.runtimeEnvironment');
    this.maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'Grok');
    this.interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs, 'Grok');
    if (options.model !== undefined && options.model.trim() === '') throw new TypeError('GrokAdapterOptions.model must not be blank');
    if (options.compatInstructions !== undefined && options.compatInstructions !== 'inherit' && options.compatInstructions !== 'disabled')
      throw new TypeError('GrokAdapterOptions.compatInstructions must be inherit or disabled');
    if (options.agentUserMcpServers !== undefined && options.agentUserMcpServers !== 'inherit' && options.agentUserMcpServers !== 'excluded')
      throw new TypeError('GrokAdapterOptions.agentUserMcpServers must be inherit or excluded');
    if (options.agentUserContext !== undefined && options.agentUserContext !== 'inherit' && options.agentUserContext !== 'excluded')
      throw new TypeError('GrokAdapterOptions.agentUserContext must be inherit or excluded');
    this.effectiveVersionPolicy = resolveRuntimeVersionPolicy(GROK_VERSION_POLICY, options.versionPolicy);
    this.options = { ...options };
  }

  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }

  /**
   * Reads the version, probes ACP mode and looks for a login signal. It never
   * opens a session or writes Grok's home. A caller abort rethrows its reason.
   * An `available` observation carries the probed command for this adapter's `prepare()`.
   */
  async detect(signal?: AbortSignal): Promise<RuntimeDetectResult> {
    signal?.throwIfAborted();
    try {
      const env = withoutProviderCredentials((await this.runtimeEnvironment()).env);
      const resolved = resolveRuntimeCommand(this.options.resolveBin, resolveGrokBin);
      const command = resolved.bin.command;
      const version = await probeRuntimeVersion(command, DETECT_TIMEOUT_MS, env, [], signal);
      if (version.kind !== 'available') return version;
      const text = version.stdout.trim() || version.stderr.trim();
      const help = await runDetectCommand(command, ['agent', 'stdio', '--help'], { timeoutMs: DETECT_TIMEOUT_MS, env, signal });
      if (help.kind === 'aborted') throw help.reason;
      if (help.kind !== 'ok') return { kind: 'refused', reason: 'acp_unavailable' };
      return bindVerifiedDetection(this, {
        kind: 'available' as const,
        sessionCapabilities: { ...(await import('#byok-acp-runtime')).grokSessionCapabilities(), steer: this.descriptor.capabilities.steer },
        version: text,
        authPresent: grokAuthPresent(env),
        ...runtimeExecutableFields(resolved, command),
        ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, grokVersionToken(text)),
      }, command);
    } catch (error) {
      signal?.throwIfAborted();
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const { effort, target } = input.offer;
    const selection = offerSelection(target);
    if (target.lane === 'harness' && (target.harnessId !== 'grok' || (selection?.mode !== 'device-default' && selection?.mode !== 'adapter-model'))) {
      return { kind: 'reject', reason: 'Grok does not support the requested selection', retryable: false };
    }
    const offeredModel = selection?.mode === 'adapter-model' ? selection.modelId : undefined;
    const modelId = offeredModel ?? this.options.model;
    if (selection?.mode === 'adapter-model' && (modelId === undefined || modelId.trim() === '')) {
      return { kind: 'reject', code: 'invalid_request', reason: 'Grok requires a model ID when no default is configured', retryable: false };
    }
    input.signal?.throwIfAborted();
    // Launch the command an observation of this adapter probed: this offer's
    // admission observation when this adapter made it, else a fresh one.
    let detected = input.detected;
    let command = takeVerifiedDetection<string>(this, detected);
    if (command === undefined) {
      detected = await this.detect(input.signal);
      if (detected.kind !== 'available')
        return {
          kind: 'reject',
          reason: `grok installation refused: ${detected.kind === 'refused' ? detected.reason : detected.kind}`,
          retryable: false,
        };
      command = takeVerifiedDetection<string>(this, detected);
      if (command === undefined) return { kind: 'reject', reason: 'grok installation refused: unverified detection', retryable: false };
    }
    const { version, executableSource, versionVerdict } = detected as Extract<RuntimeDetectResult, { kind: 'available' }>;
    return { kind: 'prepared', detected: { version, executableSource, versionVerdict }, operation: { start: start => {
      const actual = start.manifest.selection;
      if (actual?.mode !== selection?.mode || (actual?.mode === 'adapter-model' && actual.modelId !== offeredModel) || start.manifest.effort !== effort) {
        throw authority('prepared Grok operation received a manifest with different runtime selection');
      }
      return this.start(start, command, modelId, effort);
    } } };
  }

  private async start(input: RuntimeOperationStartInput, command: string, model: string | undefined, effort: string | undefined): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string')
      throw authority('grok requires a resolved instruction');
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('grok manifest has no sealed cwd');
    // Every Grok task shares the user's login, which may be stale while a refreshed one is held.
    const held = await heldLogins(input.scratch.sdkDir);
    if (held.length > 0) {
      throw authority(`grok start refused: a login Grok wrote over the linked auth.json is held at ${held[0]}${held.length > 1 ? ` and ${held.length - 1} more` : ''}; ${HELD_LOGIN_RESOLUTION}; until then every Grok task on this device refuses`);
    }
    const persona = await agentPersona('grok', input.manifest);
    const env = withoutProviderCredentials({ ...input.env, ...input.scratch.env });
    const agentTask = input.manifest.agentRef !== undefined;
    const excludeUserMcp = this.options.agentUserMcpServers === 'excluded' && agentTask;
    const excludeUserContext = this.options.agentUserContext === 'excluded' && agentTask;
    // Set on the agent; its own children may inherit them. Hosted terminal commands keep the task env.
    const agentEnv = {
      ...(this.options.compatInstructions === 'disabled' || excludeUserContext ? COMPAT_INSTRUCTIONS_OFF : {}),
      ...(excludeUserMcp ? GROK_USER_MCP_SERVERS_OFF : {}),
      ...(excludeUserContext ? { GROK_HOME: await createGrokAgentHome(env, input.scratch.sdkDir, input.manifest.lease?.canonicalHome) } : {}),
      ...AUTO_UPDATE_OFF,
    };
    if (excludeUserMcp || excludeUserContext) {
      // One inspect judges both options, with the environment the agent gets.
      const inspected = await runGrokInspect(this.options.spawnFn ?? spawn, command, cwd, { ...env, ...agentEnv });
      if (excludeUserContext) {
        const refusal = inspected === undefined ? GROK_USER_CONTEXT_INSPECT_FAILED : await grokUserInstructionsRefusal(inspected);
        if (refusal !== undefined) throw authority(refusal);
      }
      if (excludeUserMcp) {
        const refusal = inspected === undefined ? GROK_INSPECT_FAILED : grokInspectRefusal(inspected);
        if (refusal !== undefined) throw authority(refusal);
      }
    }
    // As OAR: the servers go in the ACP mcpServers of session/new or session/resume.
    const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
    const redactor = sessionCredentialRedactor({ env: { ...env, ...agentEnv }, mcpServers });
    const spawnAgent = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'grok agent', stderrRedactor: redactor });
    const spawnTerminal = createOwnedTerminalSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn });
    // The ACP stack and its protocol SDK load only when a Grok session starts.
    const acp = await import('#byok-acp-runtime');
    const session = new GrokSession(
      input.scratch,
      model,
      effort,
      this.interruptTimeoutMs,
      input.manifest.sessionRef,
    );
    try {
      const raw = await acp.grokSession(
        (bin, args, options) => {
          const child = spawnAgent(bin, args, { ...options, env: { ...options.env, ...agentEnv } });
          session.own(child);
          void child.exited.then(() => session.exited(), (error) => session.fail(error));
          return haltGate(child, () => session.halted !== undefined);
        },
        spawnTerminal,
        { kind: 'available', via: 'executable', command },
        {
          cwd,
          ...(persona === undefined ? {} : { appendSystemPrompt: persona }),
          env,
          retainedBytes: this.maxRetainedBytes,
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          ...(input.manifest.sessionRef === undefined ? {} : { resume: input.manifest.sessionRef }),
        },
        {
          onReady: (id) => session.ready(id),
          // A kernel observer: the kernel swallows its errors, so record() fails the session itself.
          onRecord: (record) => session.record(record),
        },
      );
      session.bind(raw);
      if (input.signal?.aborted) throw infrastructure('grok start was aborted');
      await session.prompt(input.instruction, input.images);
      return session;
    } catch (thrown) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal });
      }
      throw runtimeStartFailure(session.halted ?? thrown, { classify: oarStartClassifier(acp), exitedOnItsOwn: session.exitedOnItsOwn, runtime: 'grok' });
    }
  }
}

/** Grok's own login file. Existence only. */
function grokAuthPresent(env: NodeJS.ProcessEnv): boolean {
  const home = env.GROK_HOME || path.join(homedir(), '.grok');
  return existsSync(path.join(home, 'auth.json'));
}

const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason });
const infrastructure = (reason: string, failure?: TaskFailure) =>
  new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason, failure });

class GrokSession implements Session {
  sessionRef = '';
  private raw?: RawAcpSession;
  private child?: { dispose(): Promise<void>; kill(): void };
  private exit?: { readonly exitedOnItsOwn: boolean };
  private projection?: GrokProjection;
  private readonly queue = new AsyncQueue<AgentEvent | MessageDraftDelta>();
  private failure?: RuntimeExecutionFailure;
  private active = false;
  /** The input id of the SDK prompt OAR holds until Grok's own turn closes. */
  private held?: string;
  /** The prompt in flight, its queue request included; an interrupt waits for its answer so it can take the input back. */
  private sending?: Promise<void>;
  /** The SDK asked for the active turn's cancel. Grok also ends a turn as cancelled on its own, on a permission request answered `cancelled`. */
  private interruptRequested = false;
  private readonly turnWaiters = new SettleWaiters();
  private stopping = false;
  private readonly closeOnce = new RetryableOnce();
  /** Set when the record consumer failed: no later line reaches the ACP stream, so the kernel retains no more of them. */
  halted?: RuntimeExecutionFailure;

  constructor(
    private readonly scratch: ExecutionScratch,
    private readonly model: string | undefined,
    private readonly effort: string | undefined,
    private readonly interruptMs: number,
    private readonly expectedSessionRef?: string,
  ) {}

  own(child: { dispose(): Promise<void>; kill(): void; readonly exitedOnItsOwn: boolean }): void {
    this.child = child;
    this.exit = child;
  }
  get exitedOnItsOwn(): boolean {
    return this.exit?.exitedOnItsOwn === true;
  }
  ready(id: string): void {
    if (this.expectedSessionRef !== undefined && id !== this.expectedSessionRef) throw authority('grok resume returned a different session id');
    this.sessionRef = id;
    this.projection = new GrokProjection(id);
  }
  bind(raw: RawAcpSession): void {
    this.raw = raw;
  }
  record(record: AcpRecord): void {
    if (this.halted !== undefined) return;
    try {
      this.projection?.consume(record, (event) => this.queue.push(event), (turn) => this.turnEnded(turn));
    } catch (error) {
      this.fail(error);
      this.halted = this.failure;
      throw error;
    }
  }
  private turnEnded(turn: GrokTurnOutcome): void {
    if (!this.active) {
      this.fail(infrastructure('grok reported a turn end with no turn open'));
      return;
    }
    this.held = undefined;
    this.projection?.endSdkTurn();
    const cancelledBySdk = this.interruptRequested || this.stopping;
    this.active = false;
    this.interruptRequested = false;
    this.turnWaiters.settleAll();
    if (turn.kind === 'failed')
      this.fail(new RuntimeExecutionFailure({
        phase: 'run',
        retry: turn.failure === 'rate_limited' ? 'retryable' : 'non-retryable',
        reason: turn.reason,
        // A class OAR took from error text is not structured evidence (docs/spec.md runtime failure class).
        failure: { class: turn.fromText ? 'unknown' : turn.failure },
      }));
    // Grok 1.0.52 calls no model after the refusal, so the turn did not do the work. A `reject_once` answer ends it the same way.
    else if (turn.kind === 'aborted' && !cancelledBySdk)
      this.fail(new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason: PERMISSION_STOP_REASON }));
    else this.queue.push({ type: 'turn_end' });
  }
  fail(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure(error instanceof Error ? error.message : 'grok runtime failed');
    this.flushPendingUsage();
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) {
      this.fail(infrastructure('grok agent exited', { class: this.exitedOnItsOwn ? 'runtime_exited' : 'unknown' }));
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
    if (!this.raw) throw infrastructure('grok session is not open');
    requireImageInput(images, this.capabilities.images);
    if (this.active) throw infrastructure('grok turn is already active');
    this.active = true;
    const inputId = randomUUID();
    this.projection?.beginSdkTurn(inputId);
    // Marked from the first await: an interrupt in the same tick must not cancel a Grok turn OAR adopted meanwhile.
    const sending = this.send(this.raw, input, { inputId, images });
    this.sending = sending;
    try {
      await sending;
    } catch (error) {
      this.active = false;
      this.projection?.endSdkTurn();
      throw error;
    } finally {
      this.sending = undefined;
    }
  }
  private async send(raw: RawAcpSession, input: string, options: RuntimeInputOptions & { inputId: string }): Promise<void> {
    const grokTurnsClosed = this.projection?.grokTurnsClosed;
    let result = await raw.prompt(input, options);
    // OAR adopted a turn Grok runs on its own and refuses the prompt as busy: hold it until that turn closes.
    // A Grok turn that closed while the busy answer was in flight still holds: the drain then sends it at once.
    if (result.response.body.code === 'busy' && (this.projection?.grokTurnOpen === true || this.projection?.grokTurnsClosed !== grokTurnsClosed)) {
      result = await raw.queue(input, options);
      if (result.response.body.kind === 'accepted') this.held = options.inputId;
    }
    if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'grok prompt refused');
  }
  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string') throw new PolicyUnsupportedError('grok requires a string instruction');
    if ((task.modelId !== undefined && task.modelId !== this.model) || (task.effort !== undefined && task.effort !== this.effort)) {
      throw new PolicyUnsupportedError('grok persistent session cannot change model or effort');
    }
    const selection = offerSelection(task.target);
    if (selection !== undefined && selection.mode !== 'device-default' && selection.mode !== 'adapter-model') {
      throw new PolicyUnsupportedError('grok persistent session cannot change credential source');
    }
    await this.prompt(task.instruction, task.images);
  }
  async steer(): Promise<void> {
    // The bridge exposes no Grok steer: OAR's `_x.ai/interject` steer is not qualified for the SDK.
    throw new SteerUnsupportedError('grok', 'grok cannot inject into an active turn');
  }
  async interrupt(): Promise<void> {
    if (!this.raw || !this.active) return;
    this.interruptRequested = true;
    if (this.sending !== undefined) {
      await this.sending.catch(() => {});
      // A refused prompt opened no turn; a directly accepted one may already have ended.
      if (!this.active) {
        this.interruptRequested = false;
        return;
      }
    }
    if (this.held !== undefined) {
      // Taken back before the drain sends it, no prompt for this task reaches Grok; once sent, it is cancelled below.
      if (!this.raw.withdraw) throw infrastructure('grok session cannot take held input back');
      const withdrawn = await this.raw.withdraw(this.held);
      if (withdrawn.response.body.kind === 'accepted') {
        this.turnEnded({ kind: 'aborted' });
        return;
      }
      this.held = undefined;
      // The drained turn may already have ended; an abort now would reach a Grok turn adopted after it.
      if (!this.active) return;
    }
    const waiter = this.turnWaiters.wait();
    // Grok already ended the task's prompt and runs another one; the session-wide cancel would stop that one instead (#1942).
    const ended = this.projection?.sdkPromptSuperseded === true ? waiter.settled : oarCancelSettled(this.raw.abort(), waiter.settled, 'grok');
    try {
      await raceDeadline(ended, this.interruptMs, () => infrastructure('grok interrupt timed out'));
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
          await this.raw?.dispose();
        } catch (error) {
          // A failed reap of Grok's terminal trees is always reported: a later close retries it.
          if (!this.failure || isRuntimeDisposalFailure(error)) throw error;
        } finally {
          await this.child?.dispose();
          await this.scratch.release();
        }
      } finally {
        // The cancelled prompt answer can follow the cancel; end the consumer only after disposal drained stdout.
        this.flushPendingUsage();
        this.queue.end();
      }
      this.raw = undefined;
      this.projection = undefined;
      this.child = undefined;
    });
  }
  private flushPendingUsage(): void {
    this.projection?.flushChildren(event => this.queue.push(event));
    const usage = this.projection?.takePendingUsage();
    if (usage) this.queue.push(usage);
  }
}
