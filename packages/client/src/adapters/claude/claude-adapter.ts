import { isReservedMcpServerName } from '../../sdk-reserved-mcp';
import type { RuntimeTaskInput } from '../../types';
import { claudeMcpEventIdentities } from './mcp-identity';
import { claudeAgentUserContextSettings } from './agent-user-context';
import type { McpEventIdentity } from '../../mcp/event-identity';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { execFile } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent } from '@byok-sdk/protocol';
import {
  PolicyUnsupportedError,
  SteerUnsupportedError,
  freezeRuntimeAdapterDescriptor,
  type McpStdioServerConfig,
  type MessageDraftDelta,
  type RuntimeAdapter,
  type RuntimeDetectResult,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';
import { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeExecutionFailure, isRuntimeStartupDisposalFailure } from '../../runtime-failure';
import { buildRuntimeEnv } from '../../daemon/environment';
import { resolveClaudeBin, type ResolvedBin } from './resolve-bin';
import { resolveRuntimeInvocation, type RuntimeInvocation } from '../runtime-invocation';
import { createClaudeControlChannel } from './control-channel';
import { ClaudeNativeInteractionBridge, CLAUDE_NATIVE_INTERACTION_CAPABILITIES } from './native-interactions';
import { snapshotNativeInteractionHostOptions, type NativeInteractionHostOptions, type NativeInteractionChannel } from '../../native-interactions';
import { AssistantMessageTracker, createToolUseCorrelation, mapClaudeMessageToAgentEvents, type ClaudeStreamMessage, type ToolUseCorrelation } from './events';
import { ClaudeFailureEvidence } from './failure-evidence';
import { ClaudeProcessClient, type SpawnFn } from './process-client';


const execFileAsync = promisify(execFile);

/** Applied to both `detect()` probe calls (`--version`, `auth status --json`) — mirrors codex-adapter.ts's identical `DETECT_TIMEOUT_MS`/rationale exactly (cross-model review finding: these two claude probes previously had NO timeout at all, unlike codex's, so a hung claude CLI could block daemon startup and every `detect()` call indefinitely). `detect()` runs on every allowlist-narrowed task offer, so a small ceiling is cheap insurance against either probe ever unexpectedly hanging. */
const DETECT_TIMEOUT_MS = 5000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A start step claude's own exit ended, before any adoption, transport or spawn failure, is `runtime_exited`. */
function startupExit(client: ClaudeProcessClient) {
  return client.processExited ? { class: 'runtime_exited' as const } : undefined;
}

/** One owner covers process teardown and task config on every failed start. */
async function rejectOwnedStartup(cause: unknown, client: ClaudeProcessClient | undefined, scratch: ExecutionScratch, retainPendingDisposal = false): Promise<never> {
  const failure = isRuntimeExecutionFailure(cause) ? cause : new RuntimeExecutionFailure({
    phase: 'start', category: 'infrastructure', retry: 'retryable',
    reason: 'claude runtime startup failed',
  }, { cause });
  let disposalAttempt: Promise<void> | undefined;
  const retryDisposal = (): Promise<void> => {
    if (!disposalAttempt) {
      const attempt = (async () => {
        // Construction/adoption may already hold a cleanup receipt without
        // having returned a client. Preserve that owner, rather than guessing
        // that a thrown constructor means no process was spawned.
        if (isRuntimeStartupDisposalFailure(cause)) await cause.retryDisposal();
        else await client?.dispose();
        await scratch.release();
      })();
      disposalAttempt = attempt.catch(error => { disposalAttempt = undefined; throw error; });
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
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** Override bin resolution — tests substitute the fake-claude fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
  /** Deadline for native interrupt ACK before owned-process termination fallback. */
  interruptTimeoutMs?: number;
  /** Local Host callbacks for native stdio requests; never enables remote boolean approvals. */
  nativeInteractions?: NativeInteractionHostOptions;
  /**
   * For an Agent task (`task.offer`), `excluded` starts Claude with
   * `--strict-mcp-config`, so only the task's and the SDK's MCP servers load,
   * and with a `--settings` file that excludes the `CLAUDE.md`,
   * `CLAUDE.local.md` and rules of the Claude config directory and of every
   * directory above the Agent home, and turns off Claude auto memory. The
   * user's settings, deny rules, hooks, model and env still apply. It affects
   * new sessions only: a resumed session keeps its history. Other tasks are
   * unchanged. Default `inherit`.
   */
  agentUserContext?: 'inherit' | 'excluded';
  /**
   * For an Agent task (`task.offer`), `disabled` starts Claude with
   * `--no-session-persistence`, so Claude does not save the session
   * transcript under `<config dir>/projects/`. Such a session cannot be
   * resumed: an Agent task that carries a `sessionRef` fails before Claude
   * starts. Follow-ups in the same task still work. Other tasks are
   * unchanged. Default `enabled`.
   */
  agentSessionPersistence?: 'enabled' | 'disabled';
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
 * (`--permission-prompt-tool stdio`) instead of the skip flag: the local Host
 * UI answers each request the CLI forwards to can_use_tool, including
 * AskUserQuestion. Existing allow rules may bypass that callback; this is not a
 * blanket all-tools confirmation policy. Remote boolean approvals remain
 * unsupported, as does mid-turn steering.
 */
export class ClaudeAdapter implements RuntimeAdapter {
  readonly descriptor;
  private readonly nativeOptions?: NativeInteractionHostOptions;

  constructor(private readonly options: ClaudeAdapterOptions = {}) {
    const timeout = options.interruptTimeoutMs ?? 1000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new TypeError('invalid Claude interrupt timeout');
    if (options.agentUserContext !== undefined && options.agentUserContext !== 'inherit' && options.agentUserContext !== 'excluded')
      throw new TypeError('ClaudeAdapterOptions.agentUserContext must be inherit or excluded');
    if (options.agentSessionPersistence !== undefined && options.agentSessionPersistence !== 'enabled' && options.agentSessionPersistence !== 'disabled')
      throw new TypeError('ClaudeAdapterOptions.agentSessionPersistence must be enabled or disabled');
    this.nativeOptions = options.nativeInteractions === undefined ? undefined : snapshotNativeInteractionHostOptions(options.nativeInteractions);
    this.descriptor = freezeRuntimeAdapterDescriptor({
      id: 'claude',
      supportsDispatchSelection: true,
      // `progress` events are complete text blocks, never deltas, and
      // `progressStartsMessage` joins the blocks of one message, so the
      // closing reply is the last assistant message. A run that repeats its
      // answer in a later model call with no tool between (#501) then
      // publishes it once.
      progressEventsAreMessages: true,
      platforms: ['darwin', 'linux', 'win32'],
      capabilities: {
        steer: false,
        resume: true,
        approvalInteractive: false,
        mcpToolsets: true,
        messageDraft: true,
        ...(this.nativeOptions === undefined ? {} : { nativeInteractions: CLAUDE_NATIVE_INTERACTION_CAPABILITIES }),
      },
    });
  }

  async detect(): Promise<RuntimeDetectResult> {
    try {
      const invocation = resolveRuntimeInvocation(this.resolveBin().command);
      const probe = await probeRuntimeVersion(invocation.command, DETECT_TIMEOUT_MS, invocation.args);
      if (probe.kind !== 'available') return probe;
      const version = probe.stdout.trim();
      const authPresent = await this.probeAuthPresent(invocation);
      return { kind: 'available', version, authPresent };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    let modelId: string | undefined;
    try {
      modelId = subscriptionModel(input.offer.dispatchSelection, 'claude');
    } catch (error) {
      return { kind: 'reject', reason: error instanceof Error ? error.message : String(error), retryable: false };
    }
    let bin: ResolvedBin;
    try {
      bin = this.resolveBin();
    } catch (error) {
      return { kind: 'reject', reason: error instanceof Error ? error.message : String(error), retryable: true };
    }
    let invocation: RuntimeInvocation;
    try {
      invocation = resolveRuntimeInvocation(bin.command);
    } catch (error) {
      // As Codex: the reason names the detect kind only, never a local path.
      return { kind: 'reject', reason: `claude installation refused: ${classifyDetectError(error).kind}`, retryable: false };
    }
    return {
      kind: 'prepared',
      operation: {
        start: (startInput) => this.startPrepared(startInput, modelId, invocation),
      },
    };
  }

  private async startPrepared(
    startInput: RuntimeOperationStartInput,
    modelId: string | undefined,
    invocation: RuntimeInvocation,
  ): Promise<Session> {
    const signal = startInput.signal;
    const cancellationFailure = () => new RuntimeExecutionFailure({
      phase: 'start', category: 'infrastructure', retry: 'retryable',
      reason: 'claude runtime startup was cancelled',
    }, { cause: signal?.reason });
    if (signal?.aborted) throw cancellationFailure();
    // This adapter has no prepared-input lane: a frozen provider request is
    // compiled against the pi runtime's own verified closure, and claude cannot
    // be told to send someone else's bytes. Refused by name rather than
    // ignored, so a prepared Execution routed here fails visibly instead of
    // running as an ordinary turn with no instruction at all.
    if (startInput.kind !== 'instruction') {
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: 'authority',
        retry: 'non-retryable',
        reason: 'the claude adapter has no prepared-input lane',
      });
    }
    if (typeof startInput.instruction !== 'string') {
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: 'authority',
        retry: 'non-retryable',
        reason: 'prepared claude operation requires a resolved string instruction',
      });
    }
    const mcpArgs: string[] = [];

    // Generate only task-scoped host/reserved MCP config outside the operation workspace.
    let client: ClaudeProcessClient | undefined;
    let cancellation: RuntimeExecutionFailure | undefined;
    let rejectCancellation!: (failure: RuntimeExecutionFailure) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    // Aborts can arrive during awaited config work, before either race starts.
    void cancelled.catch(() => {});
    const onAbort = () => {
      cancellation ??= cancellationFailure();
      client?.abortStartup(cancellation);
      rejectCancellation(cancellation);
    };
    const throwIfCancelled = () => {
      if (signal?.aborted && !cancellation) onAbort();
      if (cancellation) {
        // Also covers an abort inside spawnFn, before client was assigned.
        client?.abortStartup(cancellation);
        throw cancellation;
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      throwIfCancelled();
      const persistSession = startInput.manifest.agentRef === undefined || this.options.agentSessionPersistence !== 'disabled';
      // With persistence off, Claude saved no transcript to resume. Refused
      // before any write, so the task never runs as a silent fresh session.
      if (!persistSession && startInput.manifest.sessionRef !== undefined) {
        throw new RuntimeExecutionFailure({
          phase: 'start', category: 'authority', retry: 'non-retryable',
          reason: 'claude Agent session persistence is disabled, so the task cannot resume a session',
        });
      }
      // Built before any write, so a refusal leaves no file behind.
      const userContextSettings = this.options.agentUserContext === 'excluded' && startInput.manifest.agentRef !== undefined
        ? claudeAgentUserContextSettings(startInput.manifest, startInput.env, process.platform, os.homedir, dir => {
          // A directory that does not resolve holds no files to keep.
          try { return realpathSync.native(dir); } catch { return dir; }
        })
        : undefined;
      const taskMcpServers = startInput.mcpServers ?? {};
      const needsMcpConfig = Object.keys(taskMcpServers).length > 0;
      const sdkDir = startInput.scratch.sdkDir;
      if (needsMcpConfig || userContextSettings) {
        await fs.chmod(sdkDir, 0o700).catch(() => {});
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
      let manifestModelId: string | undefined;
      try {
        manifestModelId = subscriptionModel(startInput.manifest.dispatchSelection, 'claude');
      } catch (cause) {
        throw new RuntimeExecutionFailure({
          phase: 'start',
          category: 'authority',
          retry: 'non-retryable',
          reason: 'prepared claude operation received an invalid runtime selection manifest',
        }, { cause });
      }
      if (manifestModelId !== modelId) {
        throw new RuntimeExecutionFailure({
          phase: 'start',
          category: 'authority',
          retry: 'non-retryable',
          reason: 'prepared claude operation received a manifest with different runtime selection',
        });
      }
      const manifestCwd = startInput.manifest.cwd;
      if (manifestCwd === undefined) {
        throw new RuntimeExecutionFailure({
          phase: 'start', category: 'authority', retry: 'non-retryable',
          reason: 'prepared claude operation received a manifest without a sealed cwd',
        });
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
        ...(manifestModelId ? ['--model', manifestModelId] : []),
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        // YOLO by default, as in OAR (`runtimes/claude/session.ts`): no human
        // sits at an approval prompt, so a permission gate is a hang, not
        // safety. A Host that opted into native interactions answers each
        // request in its own UI instead. Under `acceptEdits` with no
        // per-tool grant, that includes every MCP tool call — the SDK's
        // reserved memory and message tools too.
        ...(this.nativeOptions === undefined
          ? ['--dangerously-skip-permissions']
          : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'acceptEdits']),
        ...mcpArgs,
      ];

      throwIfCancelled();
      const control = createClaudeControlChannel(this.options.interruptTimeoutMs ?? 1000);
      const native = this.nativeOptions === undefined ? undefined : new ClaudeNativeInteractionBridge({
        ...this.nativeOptions,
        // The adapter, never the host callback, owns fatal process termination.
        onFatal: error => client?.abortStartup(error),
      }, resumeSessionId);
      try {
        client = new ClaudeProcessClient({
          command: invocation.command,
          args: [...invocation.args, ...args],
          cwd: manifestCwd,
          env: { ...startInput.env, ...startInput.scratch.env },
          nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn,
          control: native === undefined ? control : {
            bind: write => { control.bind(write); native.bind(write); },
            receive: message => { control.receive(message); native.receive(message); },
            closed: () => { control.closed(); native.close(); },
          },
        });
      } catch (cause) {
        if (isRuntimeStartupDisposalFailure(cause)) throw cause;
        throw new RuntimeExecutionFailure({
          phase: 'start', category: 'infrastructure', retry: 'retryable',
          reason: 'claude runtime process could not be spawned',
        }, { cause });
      }

      throwIfCancelled();
      if (native !== undefined) {
        const initialized = await Promise.race([control.initialize(), cancelled]);
        throwIfCancelled();
        if (!initialized) throw new RuntimeExecutionFailure({
          phase: 'start', category: 'infrastructure', retry: 'retryable',
          reason: 'Claude native control initialization failed',
          failure: startupExit(client),
        });
        throwIfCancelled();
        native.beginTurn();
      }
      // `--input-format stream-json` expects the first turn's instruction on
      // stdin too, not as a positional CLI argument — empirically confirmed
      // live (this task's persistent-process multi-turn probes never passed
      // a positional prompt at all, relying entirely on this same write for
      // turn one). Using the identical mechanism for turn one and every
      // `followUp()` afterward (see `ClaudeSession.followUp` /
      // `ClaudeProcessClient.writeUserMessage`) avoids two different
      // send-a-prompt code paths.
      try {
        await Promise.race([client.writeUserMessage(startInput.instruction), cancelled]);
      } catch (cause) {
        if (isRuntimeStartupDisposalFailure(cause) || isRuntimeExecutionFailure(cause)) throw cause;
        throw new RuntimeExecutionFailure({
          phase: 'start', category: 'infrastructure', retry: 'retryable',
          reason: 'claude initial instruction transport failed',
          failure: startupExit(client),
        }, { cause });
      }

      let sessionRef: string;
      try {
        // Resolves with claude's own real `session_id` off its `system/init`
        // frame — see `ClaudeProcessClient.waitForInit`'s doc comment for why
        // this is needed at all (claude's stream-json protocol has no
        // request/response ack the way pi's RPC mode does) and why, unlike
        // pi's `resolveFreshSessionId`, no separate follow-up round-trip is
        // needed: claude always surfaces `session_id` directly on the very
        // first frame of a successful run, resume or fresh alike (confirmed:
        // a `--resume <id>` run's own `system/init.session_id` always equals
        // the requested id). An unresolvable `--resume` target (or any other
        // immediate failure) never emits an `init` frame at all and instead
        // exits promptly — `waitForInit()` rejects with the enriched exit
        // error in that case (see `process-client.ts`), which is exactly
        // what should make `start()` fail here, fail-closed, never a
        // fabricated sessionRef.
        sessionRef = await Promise.race([client.waitForInit(), cancelled]);
      } catch (err) {
        if (isRuntimeStartupDisposalFailure(err)) throw err;
        if (isRuntimeExecutionFailure(err)) throw err;
        throw new RuntimeExecutionFailure({
          phase: 'start', category: 'infrastructure', retry: 'retryable',
          reason: `claude exited before yielding an authoritative session id: ${errorMessage(err)}`,
          failure: startupExit(client),
        }, { cause: err });
      }

      // Cross-model review finding: the doc comment above states this is
      // "confirmed" to always hold empirically — but nothing actually verified
      // it in code, so a future/unobserved claude behavior (or a bug) silently
      // resuming a DIFFERENT session than `task.sessionRef` asked for would
      // have gone completely unnoticed: this adapter would return a
      // `ClaudeSession` for whatever `sessionRef` claude happened to report,
      // running the task against the wrong workspace/history with no signal
      // to the caller at all. Fail closed instead of trusting the assumption.
      if (resumeSessionId !== undefined && sessionRef !== resumeSessionId) {
        throw new RuntimeExecutionFailure({
          phase: 'start',
          category: 'authority',
          retry: 'non-retryable',
          reason: `claude --resume echoed a different session id than requested (requested ${resumeSessionId}, got ${sessionRef})`,
        });
      }

      throwIfCancelled();
      return new ClaudeSession(
        sessionRef,
        client,
        manifestCwd,
        control,
        startInput.scratch,
        manifestModelId,
        native,
        new Map(Object.entries(taskMcpServers).filter(([name]) => !isReservedMcpServerName(name))),
      );
    } catch (cause) {
      return rejectOwnedStartup(cause, client, startInput.scratch, cancellation !== undefined);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * `claude auth status --json` is claude's OWN non-secret login-state
   * signal (see the credential-isolation rule on `RuntimeAdapter` in
   * `../../types.ts`) — empirically confirmed live on this logged-in
   * machine to report `{"loggedIn":true,"authMethod":"claude.ai",
   * "apiProvider":"firstParty","email":"...","orgId":"...","orgName":"...",
   * "subscriptionType":"max"}`, with no token/key material anywhere in it.
   * This spawns the binary and parses ONLY its own reported status — it
   * never reads `~/.claude` or any credential file itself. Pi's `auth check`
   * needs an explicit provider and a single-file product exposes no pi CLI,
   * so pi's equivalent (`../pi/auth-presence.ts`) checks env-var *names* and
   * the shape of its agent-dir login records instead.
   * A failed/unparseable probe (binary present but not logged in, a future
   * claude release changing this output shape, etc.) fails closed to
   * `false` — this never affects `present`, which is solely about whether
   * `--version` itself succeeded.
   */
  private async probeAuthPresent(invocation: RuntimeInvocation): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(invocation.command, [...invocation.args, 'auth', 'status', '--json'], {
        timeout: DETECT_TIMEOUT_MS,
        env: buildRuntimeEnv({ ambient: process.env }),
      });
      const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
      return parsed.loggedIn === true;
    } catch {
      return false;
    }
  }

  private resolveBin(): ResolvedBin {
    return (this.options.resolveBin ?? resolveClaudeBin)();
  }
}

function subscriptionModel(
  selection: RuntimeTaskInput['dispatchSelection'],
  runtimeId: 'claude',
): string | undefined {
  if (selection === undefined) return undefined;
  if (selection.lane !== 'subscription' || selection.runtimeId !== runtimeId) {
    throw new PolicyUnsupportedError(
      `claude adapter cannot execute ${selection.lane} selection for runtime ${selection.runtimeId}`,
    );
  }
  return selection.modelId;
}

/** Whether an assistant frame calls a Claude MCP tool (`mcp__…`) the session has no identity for yet. */
function callsUnresolvedMcpTool(message: ClaudeStreamMessage, correlation: ToolUseCorrelation): boolean {
  if (message.type !== 'assistant') return false;
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) && content.some((block: { type?: unknown; name?: unknown }) =>
    block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith('mcp__')
    && correlation.mcpIdentities?.has(block.name) !== true);
}

class ClaudeSession implements Session {
  declare readonly interactions?: NativeInteractionChannel;
  private readonly correlation: ToolUseCorrelation;
  private readonly assistantMessages = new AssistantMessageTracker();
  private readonly failureEvidence = new ClaudeFailureEvidence();
  private closeAttempt: Promise<void> | undefined;
  /** Filled once from Claude's own `mcp_status` answer (`./mcp-identity.ts`). */
  private readonly mcpIdentities = new Map<string, McpEventIdentity>();
  private mcpStatusRequested = false;

  constructor(
    public readonly sessionRef: string,
    private readonly client: ClaudeProcessClient,
    private readonly workspaceDir: string,
    private readonly control: ReturnType<typeof createClaudeControlChannel>,
    /** Task-scoped temp `--mcp-config` directory, if any — removed in `close()`. */
    private readonly scratch: ExecutionScratch,
    private readonly modelId?: string,
    private readonly native?: ClaudeNativeInteractionBridge,
    /** Task-projected toolset servers in `--mcp-config`; only these receive event MCP identity. */
    private readonly toolsetServers: ReadonlyMap<string, McpStdioServerConfig> = new Map(),
  ) { this.correlation = createToolUseCorrelation(this.mcpIdentities); if (native !== undefined) this.interactions = native.channel; }

  get events(): AsyncIterable<AgentEvent | MessageDraftDelta> {
    const client = this.client;
    const correlation = this.correlation;
    const assistantMessages = this.assistantMessages;
    const failureEvidence = this.failureEvidence;
    const workspaceDir = this.workspaceDir;
    const control = this.control;
    const toolsetServers = this.toolsetServers;
    const mcpIdentities = this.mcpIdentities;
    const session = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent | MessageDraftDelta> {
        const inner = client.events[Symbol.asyncIterator]();
        // A single raw claude frame can map to more than one AgentEvent
        // (e.g. a Write `tool_result` plus a derived `artifact` — see
        // `events.ts`'s `mapUser`) — buffered here and drained before
        // pulling the next raw line, so this iterator still yields exactly
        // one `AgentEvent` per `next()` call like every other adapter's
        // `Session.events`.
        let pending: Array<AgentEvent | MessageDraftDelta> = [];
        let terminalFailure: RuntimeExecutionFailure | undefined;
        // Cross-model re-review finding (P1 regression, the "claude-hang
        // class"): set once THIS turn's own `result` frame has been read off
        // `inner` — `result` is claude's real "whole run settled" signal and
        // is always the LAST frame of a turn, success or failure alike (see
        // `events.ts`'s `mapResult` doc comment). On the SUCCESS path
        // (`turn_end`) this is inert: `task-runner.ts`'s `pump()` returns the
        // instant it sees `turn_end`, so no further `next()` call ever
        // happens. It matters on the FAILURE/malformed path: `mapResult`
        // maps a non-success result to a plain `error` AgentEvent with no
        // `turn_end` — and unlike codex (one process per turn, whose own
        // process-close watcher ends the queue — see codex-adapter.ts's
        // `runCodexTurn`), claude's process is PERSISTENT: it stays alive
        // after `result`, awaiting a possible `followUp()` write on stdin
        // (see process-client.ts's own doc comment). Nothing would otherwise
        // ever end this iterator, so `task-runner.ts`'s `pump()` would await
        // a raw line that never arrives — a real, confirmed hang, not just a
        // theoretical one. Once `turnSettled` is true and `pending` has been
        // fully drained (every event from the `result` frame delivered),
        // this iterator ends itself (`done:true`) WITHOUT pulling `inner`
        // again — ending only THIS TURN's own exposed event stream, never
        // the underlying session-lifetime `client.events` queue a future
        // `followUp()` still needs, and never killing the process itself
        // (that stays this session's `close()`/`interrupt()`'s job). This is
        // exactly what lets `pump()`'s existing "iterable ended without
        // turn_end" branch report the task as Failed instead of hanging.
        let turnSettled = false;
        return {
          async next(): Promise<IteratorResult<AgentEvent | MessageDraftDelta>> {
            for (;;) {
              const buffered = pending.shift();
              if (buffered) return { value: buffered, done: false };

              if (terminalFailure) throw terminalFailure;

              if (turnSettled) {
                return { value: undefined as never, done: true };
              }

              let raw: IteratorResult<import('./events').ClaudeStreamMessage>;
              try {
                raw = await inner.next();
              } catch (cause) {
                throw new RuntimeExecutionFailure({
                  phase: 'run',
                  category: 'infrastructure',
                  retry: 'retryable',
                  reason: 'claude runtime event transport failed',
                }, { cause });
              }
              const { value, done } = raw;
              if (done) {
                throw new RuntimeExecutionFailure({
                  phase: 'run',
                  category: 'infrastructure',
                  retry: 'retryable',
                  reason: 'claude runtime process ended before a terminal result frame',
                  failure: { class: client.processExited ? 'runtime_exited' : 'unknown' },
                }, { cause: client.terminalError });
              }

              if (value.type === 'result') turnSettled = true;
              failureEvidence.observe(value);

              if (!session.mcpStatusRequested && toolsetServers.size > 0 && callsUnresolvedMcpTool(value, correlation)) {
                // Asked at the first MCP call, when Claude has connected its
                // servers: an earlier answer reports them `pending` with no
                // tools. One lookup per process; a failure leaves `mcp` absent.
                session.mcpStatusRequested = true;
                for (const [name, identity] of claudeMcpEventIdentities(await control.mcpStatus(), toolsetServers)) mcpIdentities.set(name, identity);
              }
              const mapped = mapClaudeMessageToAgentEvents(value, correlation, { workspaceDir });
              if (value.type === 'result' && control.contextWindow !== null) {
                const usage = mapped.events.find(event => event.type === 'usage');
                if (usage?.type === 'usage') {
                  usage.contextWindow = control.contextWindow;
                  usage.contextSource = 'provider';
                } else {
                  mapped.events.unshift({ type: 'usage', contextWindow: control.contextWindow, contextSource: 'provider' });
                }
              }
              assistantMessages.observe(value, mapped.events);
              if (mapped.terminalFailure !== undefined) terminalFailure = failureEvidence.attach(value, mapped.terminalFailure);
              if (mapped.unmappedLabel) {
                client.recordUnmappedFrame(mapped.unmappedLabel);
              }
              if (mapped.events.length > 0) {
                pending = mapped.events;
              }
              // Nothing to yield yet (routine frame, or an unmapped one) —
              // loop around and pull the next raw line.
            }
          },
        };
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

  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('claude adapter only supports string instructions in M2 (no blob-ref fetch yet)');
    }
    const requestedModel = subscriptionModel(task.dispatchSelection, 'claude');
    if (requestedModel !== undefined && requestedModel !== this.modelId) {
      throw new PolicyUnsupportedError(
        `claude persistent session cannot change model from ${this.modelId ?? '(legacy default)'} to ${requestedModel}`,
      );
    }
    // Writes onto the SAME persistent process this session already has
    // open — empirically confirmed live that claude keeps a
    // `--input-format stream-json` process alive across sequential turns,
    // reusing the identical `session_id`, until stdin closes or the
    // process is killed (see `ClaudeProcessClient.writeUserMessage`'s doc
    // comment).
    try {
      this.native?.beginTurn();
      await this.client.writeUserMessage(task.instruction);
    } catch (cause) {
      throw new RuntimeExecutionFailure({
        phase: 'run', category: 'infrastructure', retry: 'retryable',
        reason: 'claude follow-up instruction transport failed',
      }, { cause });
    }
  }

  /** Native interrupt ACK is bounded; TaskRunner still closes after cancellation acknowledgment. */
  async interrupt(): Promise<void> {
    this.native?.endTurn('interrupted');
    if (!await this.control.interruptAndSettle()) { this.client.kill(); await this.client.dispose(); }
  }

  async close(): Promise<void> {
    this.native?.close('closed');
    if (!this.closeAttempt) {
      const attempt = (async () => {
        await this.client.dispose();
        await this.scratch.release();
      })();
      this.closeAttempt = attempt.catch((error: unknown) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }

  /** The legacy remote boolean approval lane remains unsupported, even with local native interactions. */
  async resolveApproval(_approved: boolean, _reason?: string): Promise<void> {
    throw new PolicyUnsupportedError('claude adapter does not support interactive approval');
  }
}
