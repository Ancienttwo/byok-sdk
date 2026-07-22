import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import {
  PolicyUnsupportedError,
  type ApprovalChannel,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeDetectResult,
  type RuntimeEnvironmentRequirements,
  type Session,
  type TaskContext,
} from '../../types';
import { resolveClaudeBin, type ResolvedBin } from './resolve-bin';
import { resolveApprovalMcpBin, type ResolvedApprovalMcpBin } from './resolve-approval-mcp-bin';
import { mapPermissionPolicyToClaudeArgs } from './permission-mapping';
import { createToolUseCorrelation, mapClaudeMessageToAgentEvents, type ToolUseCorrelation } from './events';
import { ClaudeProcessClient, type SpawnFn } from './process-client';
import { APPROVAL_TOOL_NAME } from '../../bin/approval-mcp-server';

/** The MCP server NAME this adapter registers `byok-approval-mcp` under in the generated `--mcp-config` (arbitrary, local to this file) — combined with {@link APPROVAL_TOOL_NAME} (imported, single-sourced from `bin/approval-mcp-server.ts` so the two can never independently drift) to form the `mcp__<server>__<tool>` identifier `--permission-prompt-tool` expects. */
const APPROVAL_MCP_SERVER_NAME = 'byokapproval';

const execFileAsync = promisify(execFile);

/** Applied to both `detect()` probe calls (`--version`, `auth status --json`) — mirrors codex-adapter.ts's identical `DETECT_TIMEOUT_MS`/rationale exactly (cross-model review finding: these two claude probes previously had NO timeout at all, unlike codex's, so a hung claude CLI could block daemon startup and every `detect()` call indefinitely). `detect()` runs on every allowlist-narrowed task offer, so a small ceiling is cheap insurance against either probe ever unexpectedly hanging. */
const DETECT_TIMEOUT_MS = 5000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort teardown of the temp `--mcp-config` directory `start()` creates for `confirm` mode (see its own doc comment) — never throws, since a cleanup failure must never mask the real error/result it's cleaning up after. No-ops when `dir` is `undefined` (every mode other than `confirm`). */
async function cleanupApprovalMcpConfigDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export interface ClaudeAdapterOptions {
  /** Override bin resolution — tests substitute the fake-claude fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
  /** M4 Phase 3: override `byok-approval-mcp` bin resolution — tests substitute a fixture script instead of computing a real dist path. Mirrors `resolveBin` above. */
  resolveApprovalMcpBin?: () => ResolvedApprovalMcpBin;
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
 * `PermissionPolicy.mode: 'confirm'` — the policy mode whose whole point is
 * "ask a human, then proceed" — was therefore rejected outright at
 * `start()` through M2/M3 (fail-closed, see `permission-mapping.ts`), never
 * silently downgraded to auto-accept or auto-deny.
 *
 * ## M4 Phase 3 update: a genuine out-of-band pause DOES exist — it is
 * just invisible to everything written above
 *
 * `--permission-prompt-tool` (a DIFFERENT flag from `--permission-mode`,
 * undocumented in `claude --help`'s own output on the installed 2.1.216
 * binary but empirically confirmed accepted — an unrecognized flag is
 * rejected outright with `error: unknown option`, this one is not) makes
 * claude block a turn on a real MCP round-trip to a server it spawns
 * itself, waiting for that server to answer allow/deny before continuing —
 * genuinely pausing, for real wall-clock time (live-verified: an instant
 * allow/deny, AND a deliberate multi-second delayed answer, both worked
 * identically; only a permission-prompt-tool call that never answers AT
 * ALL was found to make claude abandon the turn on its own, after roughly
 * 1.5s — never actually reachable by this design, since the bundled
 * `bin/byok-approval-mcp.ts` always eventually answers within its own
 * configured ceiling).
 *
 * Everything above this section remains true and is NOT superseded by
 * this: claude's own stream-json output still emits nothing while this
 * pause is in progress — the gap between a `tool_use` frame and its
 * `tool_result` is indistinguishable from ordinary model latency on the
 * wire, and there is still no `needs_approval`-shaped frame this adapter's
 * event mapper could ever produce. The pause is real, but it is invisible
 * to `ClaudeSession.events` and to `task-runner.ts`'s `pump()` entirely —
 * it is only ever observable from OUTSIDE this adapter's own process, by
 * the separate MCP-server child process claude itself spawns. This is why
 * `confirm` mode's daemon-side wiring (`task-runner.ts`'s `requestApproval`,
 * `types.ts`'s `ApprovalChannel`) is driven from the control socket, not
 * from any `AgentEvent` — see those files' own doc comments for the full
 * design this finding drove. `confirm` is now SUPPORTED (see
 * `permission-mapping.ts` and `resolveApproval()` below), still fail-closed
 * whenever no approval channel was actually wired up for this session.
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
  readonly id = 'claude';

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async detect(): Promise<RuntimeDetectResult> {
    const bin = this.resolveBin();
    try {
      // Empirically confirmed (unlike pi, which prints to stderr — see
      // ../pi/pi-adapter.ts's own doc comment on that): claude 2.1.212
      // prints `--version` output to STDOUT.
      const { stdout } = await execFileAsync(bin.command, ['--version'], { timeout: DETECT_TIMEOUT_MS });
      const version = stdout.trim();
      const authPresent = await this.probeAuthPresent(bin.command);
      return { present: true, version, authPresent };
    } catch {
      return { present: false };
    }
  }

  capabilities(): RuntimeCapabilities {
    // M4 Phase 3: 'confirm' added — see permission-mapping.ts's confirm-mode
    // doc comment for the empirical basis (`--permission-prompt-tool`,
    // live-verified against the real installed binary).
    return { steer: false, resume: true, permissionModes: ['auto', 'readonly', 'plan', 'confirm'] };
  }

  /**
   * M5: deliberate product-boundary decision, not an oversight — byok's
   * current ToS posture for claude is login-state-only (`claude auth
   * login`'s own OAuth session — see `probeAuthPresent` below), so this
   * adapter declares NO credential env vars at all; env-based API-key
   * passthrough for claude is a separate, still-pending product decision.
   * A product that genuinely needs it can opt in locally per-device via
   * `DaemonConfig.runtimeEnvironment.claude.allow` (`create-daemon.ts`).
   * `baseNames` is empty too: nothing in this adapter reads a
   * claude-specific config-discovery variable (e.g. `CLAUDE_CONFIG_DIR`)
   * today — if a future version of this adapter starts reading one, it
   * belongs here, not left to rely on the platform baseline alone.
   */
  environmentRequirements(): RuntimeEnvironmentRequirements {
    return { credentialNames: [] };
  }

  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('claude adapter only supports string instructions in M2 (no blob-ref fetch yet)');
    }

    const mapping = mapPermissionPolicyToClaudeArgs(ctx.policy);
    if (!mapping.ok) {
      throw new PolicyUnsupportedError(mapping.reason ?? 'policy rejected by claude adapter');
    }

    // M4 Phase 3: `confirm` mode's approval channel. Generating the
    // temp --mcp-config file is a real filesystem side effect (see
    // permission-mapping.ts's `needsApprovalMcp` doc comment for why this
    // lives here, in start(), rather than in the pure mapping function) —
    // deliberately OUTSIDE ctx.workspaceDir (a fresh, 0700 os.tmpdir()
    // subdirectory instead) so it never shows up to the agent's own
    // workspace-scoped Read/Glob/Grep, even though its contents (a storeDir
    // path, productId, and this taskId — no secret/token material at all;
    // the actual control-socket auth token stays under storeDir, unrelated
    // to this file) would be low-value to an agent that found it anyway.
    let approvalMcpConfigDir: string | undefined;
    if (mapping.needsApprovalMcp) {
      if (!ctx.approvalChannel) {
        // Internal-consistency fail-closed: TaskRunner always populates this
        // (see task-runner.ts's handleOffer) — a missing one here means
        // something upstream is badly wired, not a normal policy rejection.
        throw new PolicyUnsupportedError(
          'claude adapter requires policy.mode "confirm" to be started with an approval channel (TaskContext.approvalChannel) — none was provided',
        );
      }
      const approvalMcpBin = (this.options.resolveApprovalMcpBin ?? resolveApprovalMcpBin)();
      approvalMcpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-approval-mcp-'));
      await fs.chmod(approvalMcpConfigDir, 0o700).catch(() => {});
      const mcpConfigPath = path.join(approvalMcpConfigDir, 'mcp-config.json');
      const mcpConfig = {
        mcpServers: {
          [APPROVAL_MCP_SERVER_NAME]: {
            command: approvalMcpBin.command,
            args: approvalMcpBin.args,
            env: {
              BYOK_STORE_DIR: ctx.approvalChannel.storeDir,
              BYOK_PRODUCT_ID: ctx.approvalChannel.productId,
              BYOK_TASK_ID: ctx.approvalChannel.taskId,
              BYOK_APPROVAL_TIMEOUT_MS: String(ctx.approvalChannel.timeoutMs),
            },
          },
        },
      };
      await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
      mapping.args = [
        ...mapping.args,
        '--permission-prompt-tool',
        `mcp__${APPROVAL_MCP_SERVER_NAME}__${APPROVAL_TOOL_NAME}`,
        '--mcp-config',
        mcpConfigPath,
        // Never let this task's confirm-mode run pick up some OTHER MCP
        // server from ambient project/user config — the approval channel is
        // the only MCP server this invocation should ever see.
        '--strict-mcp-config',
      ];
    }

    const bin = this.resolveBin();
    const resumeSessionId = task.sessionRef;
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
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      ...mapping.args,
    ];

    const client = new ClaudeProcessClient({
      command: bin.command,
      args,
      cwd: ctx.workspaceDir,
      env: ctx.env,
      spawnFn: this.options.spawnFn,
    });

    // `--input-format stream-json` expects the first turn's instruction on
    // stdin too, not as a positional CLI argument — empirically confirmed
    // live (this task's persistent-process multi-turn probes never passed
    // a positional prompt at all, relying entirely on this same write for
    // turn one). Using the identical mechanism for turn one and every
    // `followUp()` afterward (see `ClaudeSession.followUp` /
    // `ClaudeProcessClient.writeUserMessage`) avoids two different
    // send-a-prompt code paths.
    client.writeUserMessage(task.instruction);

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
      client.kill();
      await cleanupApprovalMcpConfigDir(approvalMcpConfigDir);
      throw err;
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
      await cleanupApprovalMcpConfigDir(approvalMcpConfigDir);
      throw new Error(
        `claude --resume echoed a different session id than requested (requested ${resumeSessionId}, got ${sessionRef}) — refusing to continue in a possibly-wrong session (fail-closed)`,
      );
    }

    return new ClaudeSession(sessionRef, client, ctx.workspaceDir, ctx.approvalChannel, approvalMcpConfigDir);
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

class ClaudeSession implements Session {
  private readonly correlation: ToolUseCorrelation = createToolUseCorrelation();

  constructor(
    public readonly sessionRef: string,
    private readonly client: ClaudeProcessClient,
    private readonly workspaceDir: string,
    /** M4 Phase 3: set only when this session was started under `policy.mode: 'confirm'` — see `resolveApproval()`. */
    private readonly approvalChannel?: ApprovalChannel,
    /** M4 Phase 3: the temp `--mcp-config` directory `start()` created for this session, if any — removed in `close()`. */
    private readonly approvalMcpConfigDir?: string,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const client = this.client;
    const correlation = this.correlation;
    const workspaceDir = this.workspaceDir;
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

              if (turnSettled) return { value: undefined as never, done: true };

              const { value, done } = await inner.next();
              if (done) return { value: undefined as never, done: true };

              if (value.type === 'result') turnSettled = true;

              const mapped = mapClaudeMessageToAgentEvents(value, correlation, { workspaceDir });
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
    throw new Error(
      'claude adapter does not support mid-turn steering: writing to claude\'s stdin while a turn is in flight queues as a separate subsequent turn rather than redirecting the running one (empirically confirmed) — see capabilities().steer',
    );
  }

  async followUp(task: TaskOfferPayload): Promise<void> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('claude adapter only supports string instructions in M2 (no blob-ref fetch yet)');
    }
    // Writes onto the SAME persistent process this session already has
    // open — empirically confirmed live that claude keeps a
    // `--input-format stream-json` process alive across sequential turns,
    // reusing the identical `session_id`, until stdin closes or the
    // process is killed (see `ClaudeProcessClient.writeUserMessage`'s doc
    // comment).
    this.client.writeUserMessage(task.instruction);
  }

  /**
   * Real claude has no distinct "abort but stay alive" primitive the way
   * pi's RPC mode does (`{type:'abort'}`, after which pi keeps running and
   * stays queryable) — nothing in `claude --help` exposes one, and this
   * task's probes found none. SIGTERM (via `ClaudeProcessClient.kill()`)
   * is the only verified way to stop an in-flight turn, so `interrupt()`
   * and `close()` both resolve to the same underlying action here. This is
   * consistent with how they are actually used together: `task-runner.ts`'s
   * `handleCancel` always calls `interrupt()` immediately followed by
   * `close()` on the same task, never `interrupt()` alone expecting the
   * session to remain usable afterward.
   */
  async interrupt(): Promise<void> {
    this.client.kill();
  }

  async close(): Promise<void> {
    this.client.kill();
    await cleanupApprovalMcpConfigDir(this.approvalMcpConfigDir);
  }

  /**
   * M4 Phase 3: routes into the out-of-band approval channel `start()`
   * threaded through from `TaskContext.approvalChannel` — see that type's
   * own doc comment (`../../types.ts`) for the full design, and
   * `permission-mapping.ts`'s `confirm`-mode doc comment for the empirical
   * basis. `approved`/`reason` map directly onto `ApprovalChannel.resolve`'s
   * own parameters, which in turn resolve the SAME `ApprovalRegistry` entry
   * `bin/byok-approval-mcp.ts`'s pending `approvals.request` control call is
   * awaiting — answering that call is what lets claude's own blocked
   * `tools/call` (and therefore the paused turn) proceed.
   *
   * Still throws when no channel is present — every adapter/session that
   * ISN'T running under `confirm` mode (the overwhelming majority) has
   * nothing to resolve, and a caller receiving `task.approve`/`task.reject`
   * for one of those implies something upstream expected approval support
   * that isn't there, exactly as this method's doc comment always said.
   * `ApprovalChannel.resolve` itself throws the equally-descriptive "no
   * pending approval" error for the narrower case (confirm mode, but nothing
   * currently pending) — this method doesn't need its own separate check for
   * that.
   */
  async resolveApproval(approved: boolean, reason?: string): Promise<void> {
    if (!this.approvalChannel) {
      throw new Error(
        'claude adapter has no approval channel for this session (not running under policy.mode "confirm") — under every other mode, claude resolves every permission decision synchronously (auto-denied under a restrictive --permission-mode, auto-granted under a permissive one) before this adapter ever sees the corresponding frame, so there is nothing to resume later',
      );
    }
    await this.approvalChannel.resolve(approved, reason);
  }
}
