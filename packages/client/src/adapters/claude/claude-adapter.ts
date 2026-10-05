import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent, PermissionMode, TaskOfferPayload } from '@byok-sdk/protocol';
import {
  PolicyUnsupportedError,
  SteerUnsupportedError,
  freezeRuntimeAdapterDescriptor,
  type RuntimeAdapter,
  type RuntimeDetectResult,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type McpStdioServerConfig,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';
import { wrapMcpServerWithLaunchCwd } from '../../daemon/trusted-launch-cwd';
import { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { resolveClaudeBin, type ResolvedBin } from './resolve-bin';
import { withoutProviderCredentials } from '../provider-credential-environment';
import { createClaudeControlChannel } from './control-channel';
import { mapPermissionPolicyToClaudeArgs } from './permission-mapping';
import { createToolUseCorrelation, mapClaudeMessageToAgentEvents, type ToolUseCorrelation } from './events';
import { ClaudeProcessClient, type SpawnFn } from './process-client';
import {
  grantFingerprint,
  resolveMcpToolsetGrants,
  resolveReservedMcpToolGrants,
  type McpToolsetGrant,
} from '../mcp-tool-grants';


const execFileAsync = promisify(execFile);

/** Applied to both `detect()` probe calls (`--version`, `auth status --json`) — mirrors codex-adapter.ts's identical `DETECT_TIMEOUT_MS`/rationale exactly (cross-model review finding: these two claude probes previously had NO timeout at all, unlike codex's, so a hung claude CLI could block daemon startup and every `detect()` call indefinitely). `detect()` runs on every allowlist-narrowed task offer, so a small ceiling is cheap insurance against either probe ever unexpectedly hanging. */
const DETECT_TIMEOUT_MS = 5000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Task-owned cleanup is part of the close receipt and must fail visibly. */
async function cleanupMcpConfigDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (cause) {
    throw new RuntimeDisposalFailure({
      stage: 'cleanup',
      reason: 'claude task-scoped MCP configuration could not be removed',
    }, { cause });
  }
}

/** Failed transport/init still owns the process and its task-scoped config. */
async function disposeFailedTransportStart(client: ClaudeProcessClient, mcpConfigDir: string | undefined): Promise<void> {
  const retryDisposal = async () => {
    await client.dispose();
    await cleanupMcpConfigDir(mcpConfigDir);
  };
  try {
    await retryDisposal();
  } catch (cause) {
    throw new RuntimeStartupDisposalFailure(retryDisposal, { cause });
  }
}

export interface ClaudeAdapterOptions {
  /** Override bin resolution — tests substitute the fake-claude fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
  /** Deadline for native interrupt ACK before owned-process termination fallback. */
  interruptTimeoutMs?: number;
}

/**
 * Claude Code runtime adapter (`claude -p --input-format stream-json
 * --output-format stream-json`) — the M2-a counterpart to `../pi/pi-adapter.ts`.
 * Every behavioral claim in this file's own doc comments and its sibling
 * modules (`events.ts`, `permission-mapping.ts`, `process-client.ts`) was
 * empirically reproduced against the real installed `claude` 2.1.212 binary
 * on a logged-in machine (per this task's own "do NOT trust docs over the
 * real binary" mandate — `claude --help` was actively wrong/misleading for
 * `--allowedTools`, see `permission-mapping.ts`) — not inferred from
 * training-data recall or the Claude API/Agent-SDK docs, which describe a
 * DIFFERENT product surface (the Messages API, not this CLI's headless
 * wire format).
 *
 * ## The central finding: claude's headless approval model has no
 * `needs_approval` pause, at all
 *
 * This is the first real use of the `needs_approval` /
 * `Session.resolveApproval` seam any adapter in this codebase has
 * implemented (pi never emits `needs_approval` — see `PiSession
 * .resolveApproval`'s own doc comment) — so this finding directly informs
 * the M2-c protocol-freeze decision on that seam.
 *
 * Empirically (see the M2-a report for the full live-capture evidence):
 * spawning `claude -p` **non-interactively** with a tool call that would
 * normally prompt a human is resolved **synchronously, before the turn
 * continues** — there is no pause, no wait, no later resumption point:
 *
 * - Under `--permission-mode default` (or no flag at all — headless has no
 *   TTY to interactively ask), an unapproved tool call is immediately
 *   AUTO-DENIED with a synthesized `tool_result`
 *   (`"Claude requested permissions to write to <path>, but you haven't
 *   granted it yet."`, `is_error:true`) and the run continues normally to
 *   its own `result` frame — no hang, and nothing this adapter could ever
 *   resume later even if it wanted to.
 * - Under a permissive `--permission-mode` (`acceptEdits`/`bypassPermissions`),
 *   the call is auto-GRANTED, again synchronously, again with nothing to
 *   pause on.
 *
 * There is consequently no claude stream-json frame this adapter could
 * ever map to the protocol's `needs_approval` `AgentEvent` — the decision
 * is always already made by the time any frame reaches this adapter at
 * all. `resolveApproval()` below throws a descriptive error rather than
 * silently no-op'ing, mirroring `PiSession.resolveApproval`'s own
 * documented reasoning exactly: a caller that ever receives
 * `task.approve`/`task.reject` for one of this adapter's tasks implies
 * something upstream expected approval support this adapter genuinely does
 * not have.
 *
 * `PermissionPolicy.mode: 'confirm'` is rejected before runtime side effects.
 * The private approval MCP helper and permission-prompt-tool integration have
 * been removed. The shared needs_approval contract remains for other adapters.
 *
 * ## Steering was also found unsupported (a second, related finding)
 *
 * Live-probed via a persistent `--input-format stream-json` process:
 * writing a second `{"type":"user",...}` message to stdin WHILE a turn is
 * still generating does NOT redirect that in-flight turn — it QUEUES as a
 * separate, subsequent turn, processed only after the first one reaches
 * its own `result`. This is genuinely useful for `followUp()` (a new turn
 * "after [the session] has gone idle" — exactly the queued-after-result
 * case), but it is not what `Session.steer`'s "inject steering text into a
 * running turn (mid-stream)" contract promises. `capabilities().steer` is
 * therefore `false`, and `steer()` throws rather than silently behaving
 * like a queued follow-up under a name that implies live redirection.
 */
export class ClaudeAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'claude',
    supportsDispatchSelection: true,
    // `--allowedTools mcp__<server>__<tool>` names each projected toolset
    // tool explicitly, so this adapter cannot admit a projected server
    // without the daemon's own `tools/list` observation of it.
    requiresMcpToolsetToolObservation: true,
    mcpServerLaunch: 'launcher-wrapped',
    capabilities: {
      steer: false,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
      permissionModes: ['auto', 'readonly', 'plan'],
    },
    environmentRequirements: { credentialNames: [] },
  });

  constructor(private readonly options: ClaudeAdapterOptions = {}) {
    const timeout = options.interruptTimeoutMs ?? 1000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new TypeError('invalid Claude interrupt timeout');
  }

  async detect(): Promise<RuntimeDetectResult> {
    try {
      const bin = this.resolveBin();
      const probe = await probeRuntimeVersion(bin.command, DETECT_TIMEOUT_MS);
      if (probe.kind !== 'available') return probe;
      const version = probe.stdout.trim();
      const authPresent = await this.probeAuthPresent(bin.command);
      return { kind: 'available', version, authPresent };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    // Fail closed BEFORE the mapping: a projected toolset server whose tools
    // were never observed cannot be granted, and an ungranted MCP tool is
    // auto-denied by claude at call time (see permission-mapping.ts) — a
    // pre-claim rejection is strictly better than a claimed task that
    // discovers mid-turn that its only tools are unusable.
    const toolsetGrants = resolveMcpToolsetGrants(input.mcpServers, input.mcpToolsetTools, input.policy.mode);
    if (!toolsetGrants.ok) return { kind: 'reject', reason: `claude adapter cannot grant projected MCP toolset tools: ${toolsetGrants.reason}`, retryable: false };
    // The whole reserved table, never a memory-only slice of it (codex
    // consumes the same call unfiltered, `codex-adapter.ts`). The table is
    // the single authority on which SDK-reserved servers this task projected
    // may be called non-interactively, and claude auto-denies an MCP tool
    // missing from `--allowedTools` (permission-mapping.ts) — so a filter
    // here meant a `messageEgress` offer mounted `byokagentmessage` with a
    // tool the model could list and never call (#180). Which MODES receive
    // the grant is still the mapping's decision, made once for reserved and
    // observed grants together. The approval channel stays out of the table
    // itself (interactive-only), so nothing here can pre-grant a permission
    // decision a human is supposed to make.
    const reservedGrants = resolveReservedMcpToolGrants(input.mcpServers);
    const mapping = mapPermissionPolicyToClaudeArgs(input.policy, [
      ...reservedGrants,
      ...toolsetGrants.grants,
    ]);
    if (!mapping.ok) return { kind: 'reject', reason: mapping.reason ?? 'policy rejected by claude adapter', retryable: false };
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
    return {
      kind: 'prepared',
      operation: {
        start: (startInput) => this.startPrepared(startInput, mapping, modelId, bin, toolsetGrants.grants, input.policy.mode),
      },
    };
  }

  private async startPrepared(
    startInput: RuntimeOperationStartInput,
    initialMapping: ReturnType<typeof mapPermissionPolicyToClaudeArgs>,
    modelId: string | undefined,
    bin: ResolvedBin,
    preparedGrants: readonly McpToolsetGrant[],
    /** The mode the grants were resolved under; re-filtering with any other would compare two different policies. */
    permissionMode: PermissionMode,
  ): Promise<Session> {
    if (!initialMapping.ok) throw new RuntimeExecutionFailure({
      phase: 'start',
      category: 'authority',
      retry: 'non-retryable',
      reason: 'prepared claude permission mapping was invalid',
    });
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
    // The `--allowedTools` grant baked into `initialMapping.args` was computed
    // from the ADMISSION input; the resources handed to start() are a
    // separate object. Comparing the two here keeps a caller from swapping in
    // different MCP authority (or a different tool observation) after the
    // grant that names it was already frozen — the same fail-closed
    // re-check the model selection below gets.
    const startGrants = resolveMcpToolsetGrants(startInput.mcpServers, startInput.mcpToolsetTools, permissionMode);
    if (!startGrants.ok || grantFingerprint(startGrants.grants) !== grantFingerprint(preparedGrants)) {
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: 'authority',
        retry: 'non-retryable',
        reason: 'prepared claude operation received different MCP toolset tool authority than it was admitted with',
      });
    }
    const mapping = { ...initialMapping, args: [...initialMapping.args] };

    // Generate only task-scoped host/reserved MCP config outside the operation workspace.
    let mcpConfigDir: string | undefined;
    const taskMcpServers = startInput.mcpServers ?? {};
    const needsMcpConfig = Object.keys(taskMcpServers).length > 0;

    if (needsMcpConfig) {
      mcpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-mcp-'));
      await fs.chmod(mcpConfigDir, 0o700).catch(() => {});
      const mcpConfigPath = path.join(mcpConfigDir, 'mcp-config.json');
      const mcpServers: Record<string, unknown> = { ...taskMcpServers };
      // The claude CLI spawns every server in this file itself, and
      // `mcpServers` has no per-server cwd field — the child would inherit the
      // CLI's cwd, which is the manifest cwd, which for an Agent task is the
      // Agent home the agent writes by design. A `bun --compile` server binary
      // runs `$cwd/bunfig.toml` `preload` before its own code, so every entry
      // is rewritten through this package's `bin/byok-launch-cwd.mjs`, which
      // chdirs into the daemon's proven-non-writable launch directory and
      // execs the real command with its argv byte-identical.
      //
      // The CLI's OWN cwd is deliberately unchanged: session resume and
      // relative path resolution depend on it (`agent-home-contract.test.ts`).
      //
      const launchBinding = startInput.mcpLaunch;
      if (Object.keys(mcpServers).length > 0
        && (launchBinding === undefined || launchBinding.launcher === undefined)) {
        throw new RuntimeExecutionFailure({
          phase: 'start', category: 'authority', retry: 'non-retryable',
          reason: 'prepared claude operation received MCP servers without a trusted launch directory',
        });
      }
      if (launchBinding?.launcher !== undefined) {
        const wrapped = { cwd: launchBinding.cwd, launcher: launchBinding.launcher };
        for (const [name, server] of Object.entries(mcpServers)) {
          try {
            mcpServers[name] = wrapMcpServerWithLaunchCwd(server as McpStdioServerConfig, wrapped);
          } catch (cause) {
            // A refusal from the launcher wrapper is this adapter's own
            // pre-spawn refusal, exactly like the ones above, and must reach
            // TaskRunner as one: an untyped throw is projected as a generic
            // `runtime adapter contract violation during start`, which hides
            // the `launch_cwd_*` reason the operator needs to fix their MCP
            // server configuration.
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: `prepared claude operation cannot launch an MCP server in the trusted launch directory: ${cause instanceof Error ? cause.message : 'launch_cwd_target_refused'}`,
            }, { cause });
          }
        }
      }
      await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
      mapping.args = [
        ...mapping.args,
        '--mcp-config',
        mcpConfigPath,
        // The generated file is the complete task-scoped MCP authority.
        // Never merge ambient user/project MCP configuration into it.
        '--strict-mcp-config',
      ];
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
      ...(manifestModelId ? ['--model', manifestModelId] : []),
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      ...mapping.args,
    ];

    const control = createClaudeControlChannel(this.options.interruptTimeoutMs ?? 1000);
    let client: ClaudeProcessClient;
    try {
      client = new ClaudeProcessClient({
        command: bin.command,
        args,
        cwd: manifestCwd,
        env: withoutProviderCredentials(startInput.env),
        spawnFn: this.options.spawnFn,
        control,
      });
    } catch (cause) {
      await cleanupMcpConfigDir(mcpConfigDir);
      throw new RuntimeExecutionFailure({
        phase: 'start', category: 'infrastructure', retry: 'retryable',
        reason: 'claude runtime process could not be spawned',
      }, { cause });
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
      await client.writeUserMessage(startInput.instruction);
    } catch (cause) {
      await disposeFailedTransportStart(client, mcpConfigDir);
      throw new RuntimeExecutionFailure({
        phase: 'start', category: 'infrastructure', retry: 'retryable',
        reason: 'claude initial instruction transport failed',
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
      sessionRef = await client.waitForInit();
    } catch (err) {
      await disposeFailedTransportStart(client, mcpConfigDir);
      if (isRuntimeExecutionFailure(err)) throw err;
      throw new RuntimeExecutionFailure({
        phase: 'start', category: 'infrastructure', retry: 'retryable',
        reason: `claude exited before yielding an authoritative session id: ${errorMessage(err)}`,
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
      client.kill();
      await cleanupMcpConfigDir(mcpConfigDir);
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: 'authority',
        retry: 'non-retryable',
        reason: `claude --resume echoed a different session id than requested (requested ${resumeSessionId}, got ${sessionRef})`,
      });
    }

    return new ClaudeSession(
      sessionRef,
      client,
      manifestCwd,
      control,
      mcpConfigDir,
      manifestModelId,
    );
  }

  /**
   * `claude auth status --json` is claude's OWN non-secret login-state
   * signal (see the credential-isolation rule on `RuntimeAdapter` in
   * `../../types.ts`) — empirically confirmed live on this logged-in
   * machine to report `{"loggedIn":true,"authMethod":"claude.ai",
   * "apiProvider":"firstParty","email":"...","orgId":"...","orgName":"...",
   * "subscriptionType":"max"}`, with no token/key material anywhere in it.
   * This spawns the binary and parses ONLY its own reported status — it
   * never reads `~/.claude` or any credential file itself, matching pi's
   * `authPresent` computation being limited to environment-variable
   * *names* (`../pi/pi-adapter.ts`'s `KNOWN_PROVIDER_ENV_VARS`), just via
   * claude's own equivalent non-secret probe instead (claude's auth is
   * OAuth-session-based via `claude auth login`, not primarily an env var,
   * so pi's env-var-presence approach doesn't apply here the same way).
   * A failed/unparseable probe (binary present but not logged in, a future
   * claude release changing this output shape, etc.) fails closed to
   * `false` — this never affects `present`, which is solely about whether
   * `--version` itself succeeded.
   */
  private async probeAuthPresent(command: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(command, ['auth', 'status', '--json'], { timeout: DETECT_TIMEOUT_MS });
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
  selection: TaskOfferPayload['dispatchSelection'],
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

class ClaudeSession implements Session {
  private readonly correlation: ToolUseCorrelation = createToolUseCorrelation();
  private closeAttempt: Promise<void> | undefined;

  constructor(
    public readonly sessionRef: string,
    private readonly client: ClaudeProcessClient,
    private readonly workspaceDir: string,
    private readonly control: ReturnType<typeof createClaudeControlChannel>,
    /** Task-scoped temp `--mcp-config` directory, if any — removed in `close()`. */
    private readonly mcpConfigDir?: string,
    private readonly modelId?: string,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const client = this.client;
    const correlation = this.correlation;
    const workspaceDir = this.workspaceDir;
    const control = this.control;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        const inner = client.events[Symbol.asyncIterator]();
        // A single raw claude frame can map to more than one AgentEvent
        // (e.g. a Write `tool_result` plus a derived `artifact` — see
        // `events.ts`'s `mapUser`) — buffered here and drained before
        // pulling the next raw line, so this iterator still yields exactly
        // one `AgentEvent` per `next()` call like every other adapter's
        // `Session.events`.
        let pending: AgentEvent[] = [];
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
          async next(): Promise<IteratorResult<AgentEvent>> {
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
                }, { cause: client.terminalError });
              }

              if (value.type === 'result') turnSettled = true;

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
              terminalFailure = mapped.terminalFailure ?? terminalFailure;
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
  async steer(): Promise<void> {
    throw new SteerUnsupportedError(
      'claude',
      'claude adapter does not support mid-turn steering: writing to claude\'s stdin while a turn is in flight queues as a separate subsequent turn rather than redirecting the running one (empirically confirmed) — see capabilities().steer',
    );
  }

  async followUp(task: TaskOfferPayload): Promise<void> {
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
    if (!await this.control.interruptAndSettle()) { this.client.kill(); await this.client.dispose(); }
  }

  async close(): Promise<void> {
    if (!this.closeAttempt) {
      const attempt = (async () => {
        await this.client.dispose();
        await cleanupMcpConfigDir(this.mcpConfigDir);
      })();
      this.closeAttempt = attempt.catch((error: unknown) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }

  /** Claude has no interactive approval lane; shared Session contracts remain fail-closed. */
  async resolveApproval(_approved: boolean, _reason?: string): Promise<void> {
    throw new PolicyUnsupportedError('claude adapter does not support interactive approval');
  }
}
