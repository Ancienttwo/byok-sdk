import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import {
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeDetectResult,
  type Session,
  type TaskContext,
} from '../../types';
import { resolveClaudeBin, type ResolvedBin } from './resolve-bin';
import { mapPermissionPolicyToClaudeArgs } from './permission-mapping';
import { createToolUseCorrelation, mapClaudeMessageToAgentEvents, type ToolUseCorrelation } from './events';
import { ClaudeProcessClient, type SpawnFn } from './process-client';

const execFileAsync = promisify(execFile);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ClaudeAdapterOptions {
  /** Override bin resolution — tests substitute the fake-claude fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
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
 * "ask a human, then proceed" — is therefore rejected outright at
 * `start()` (fail-closed, see `permission-mapping.ts`), never silently
 * downgraded to auto-accept or auto-deny.
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
      const { stdout } = await execFileAsync(bin.command, ['--version']);
      const version = stdout.trim();
      const authPresent = await this.probeAuthPresent(bin.command);
      return { present: true, version, authPresent };
    } catch {
      return { present: false };
    }
  }

  capabilities(): RuntimeCapabilities {
    return { steer: false, resume: true, permissionModes: ['auto', 'readonly', 'plan'] };
  }

  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('claude adapter only supports string instructions in M2 (no blob-ref fetch yet)');
    }

    const mapping = mapPermissionPolicyToClaudeArgs(ctx.policy);
    if (!mapping.ok) {
      throw new PolicyUnsupportedError(mapping.reason ?? 'policy rejected by claude adapter');
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
      throw err;
    }

    return new ClaudeSession(sessionRef, client, ctx.workspaceDir);
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
      const { stdout } = await execFileAsync(command, ['auth', 'status', '--json']);
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
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            for (;;) {
              const buffered = pending.shift();
              if (buffered) return { value: buffered, done: false };

              const { value, done } = await inner.next();
              if (done) return { value: undefined as never, done: true };

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
  }

  async resolveApproval(): Promise<void> {
    throw new Error(
      'claude adapter does not support approval resume: claude never emits needs_approval — every permission decision in headless mode is resolved synchronously (auto-denied under a restrictive --permission-mode, auto-granted under a permissive one) before this adapter ever sees the corresponding frame, so there is nothing to resume later',
    );
  }
}
