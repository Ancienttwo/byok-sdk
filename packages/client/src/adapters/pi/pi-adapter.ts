import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import {
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeDetectResult,
  type RuntimeEnvironmentRequirements,
  type Session,
  type TaskContext,
} from '../../types';
import { resolvePiBin, type ResolvedBin } from './resolve-bin';
import { mapPermissionPolicyToPiArgs } from './permission-mapping';
import { mapPiMessageToAgentEvent, ROUTINE_PI_EVENT_TYPES } from './events';
import { PiRpcClient, type PiRpcMessage, type SpawnFn } from './rpc-client';

const execFileAsync = promisify(execFile);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Known provider credential env var *names* (never values) — see the
 * credential-isolation rule on `RuntimeAdapter`. `detect()` only checks
 * whether one of these names is set; it never reads pi's own auth storage
 * (`~/.pi/...`) or any file contents. Not exhaustive (pi supports ~30
 * providers); covers the common ones for a useful `authPresent` signal.
 */
const KNOWN_PROVIDER_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  // Confirmed against the installed pi's own docs/providers.md ("ZAI |
  // `ZAI_API_KEY` | `zai`") and exercised live against real GLM traffic
  // during this task's acceptance run — omitting it made `authPresent`
  // silently false for a perfectly valid, working z.ai/GLM setup.
  'ZAI_API_KEY',
] as const;

export interface PiAdapterOptions {
  /** Override bin resolution — tests substitute the fake-pi fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
}

export class PiAdapter implements RuntimeAdapter {
  readonly id = 'pi';

  constructor(private readonly options: PiAdapterOptions = {}) {}

  async detect(): Promise<RuntimeDetectResult> {
    const bin = this.resolveBin();
    try {
      // Empirically, pi (0.74.2 and 0.80.7) prints `--version` output to
      // STDERR, not stdout — confirmed with an explicit stdout/stderr probe,
      // not assumed. Check both so this doesn't silently regress if a future
      // pi release moves it back to stdout.
      const { stdout, stderr } = await execFileAsync(bin.command, ['--version']);
      const version = stdout.trim() || stderr.trim();
      const authPresent = KNOWN_PROVIDER_ENV_VARS.some((name) => process.env[name] !== undefined);
      return { present: true, version, authPresent };
    } catch {
      return { present: false };
    }
  }

  capabilities(): RuntimeCapabilities {
    return { steer: true, resume: true, permissionModes: ['auto', 'readonly'] };
  }

  /**
   * M5: pi authenticates to its ~30 supported providers via env-var API
   * keys — `detect()`'s own `authPresent` probe above checks this identical
   * list — so these MUST keep flowing into pi's spawned process or pi auth
   * breaks entirely. `KNOWN_PROVIDER_ENV_VARS` above is the single source
   * of truth, reused here rather than duplicated. No `baseNames`: nothing
   * in this adapter or `rpc-client.ts` reads a pi-specific config-discovery
   * variable beyond the platform baseline (`daemon/environment.ts`).
   */
  environmentRequirements(): RuntimeEnvironmentRequirements {
    return { credentialNames: KNOWN_PROVIDER_ENV_VARS };
  }

  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('pi adapter only supports string instructions in M0 (no blob-ref fetch yet)');
    }

    const mapping = mapPermissionPolicyToPiArgs(ctx.policy);
    if (!mapping.ok) {
      throw new PolicyUnsupportedError(mapping.reason ?? 'policy rejected by pi adapter');
    }

    const bin = this.resolveBin();
    // BLOCKING BUG FOUND + FIXED DURING THE 2026-07-16 LIVE pi x GLM e2e run:
    // this used to pass `--session-id <ref>` to `pi --mode rpc`, but that flag
    // does not exist on the real installed pi CLI (confirmed against both
    // `pi --help` and the package's own bundled `docs/rpc.md` for 0.74.2 —
    // only `--session <path|id>` (resume-only, errors "No session found..."
    // for a fresh/unknown id), `--session-dir`, `--no-session`, `--continue`,
    // `--resume` exist). It crashed EVERY real pi invocation unconditionally
    // (`Error: Unknown option: --session-id`, exit code 1) before reaching any
    // model call — never caught by this repo's own test suite because
    // `fake-pi.mjs` never inspected argv beyond `--version` (now fixed
    // alongside this task — see fake-pi.mjs). Not GLM/z.ai specific; this
    // broke 100% of real-pi task dispatch for any provider.
    //
    // Finding #3 (session/workspace continuity) follow-up, now implemented:
    // `task.sessionRef` is only ever non-empty here when `task-runner.ts`
    // has (a) found a recorded workspace for this exact sessionRef in its
    // `SessionWorkspaceStore` and (b) spawned this adapter with
    // `ctx.workspaceDir` set to that SAME directory — see task-runner.ts's
    // `handleOffer`. That matters because pi's real `--session <id>` resume
    // is scoped to the cwd/project a session was created under: resuming
    // from a *different* cwd prompts an interactive "Session found in
    // different project: ... Fork this session into current directory?
    // [y/N]" pi cannot answer headlessly, and resuming an id pi never
    // minted fails outright (`No session found matching '<id>'`, exit 1 —
    // empirically confirmed against real pi, both live-probed during this
    // task). An absent `sessionRef` always means "start fresh" — pi mints
    // its own session id, which this adapter reads back via `get_state`
    // below and reports as `Session.sessionRef` so a *future* follow-up can
    // resume it. `TaskOfferPayload.workspaceHint` remains unimplemented (no
    // caller populates `DispatchInput` with it yet, and its intended
    // semantics — e.g. does it override or merely suggest a workspace
    // relative to the sessionRef mapping? — are still undesigned; see
    // docs/protocol.md §2's note on this field for the explicit
    // reserved/ignored status); a real implementation is a genuine
    // follow-on design task, not a mechanical fix, and is intentionally
    // left alone here.
    const resumeSessionId = task.sessionRef;
    const args = ['--mode', 'rpc', ...(resumeSessionId ? ['--session', resumeSessionId] : []), ...mapping.args];

    const rpc = new PiRpcClient({
      command: bin.command,
      args,
      cwd: ctx.workspaceDir,
      env: ctx.env,
      spawnFn: this.options.spawnFn,
    });

    const response = await rpc.send({ type: 'prompt', message: task.instruction });
    if (response.success === false) {
      rpc.kill();
      throw new Error(typeof response.error === 'string' ? response.error : 'pi rejected the initial prompt');
    }

    let sessionRef: string;
    if (resumeSessionId) {
      sessionRef = resumeSessionId;
    } else {
      try {
        sessionRef = await resolveFreshSessionId(rpc);
      } catch (err) {
        // Finding F8: fail closed, not a fabricated id — and don't leak the
        // process this adapter just spawned (the `response.success===false`
        // branch above already kills it on ITS failure path; this mirrors
        // that for get_state's).
        rpc.kill();
        throw err;
      }
    }
    return new PiSession(sessionRef, rpc);
  }

  private resolveBin(): ResolvedBin {
    return (this.options.resolveBin ?? resolvePiBin)();
  }
}

/**
 * Learn pi's own real session id for a freshly-started (non-resume) run, so
 * `Session.sessionRef` reports something a *future* follow-up can actually
 * resume via `--session <id>`. `get_state.data.sessionId` is populated from
 * the moment pi's RPC process boots (confirmed live: present even before
 * any prompt is sent, with `messageCount: 0`), so this is safe to call
 * right after the initial prompt is accepted.
 *
 * Finding F8 (fabricated sessionRef): this used to fall back to
 * `crypto.randomUUID()` whenever `get_state` failed, timed out, or omitted
 * `sessionId` — minting an id pi itself never knew about, which could never
 * actually be resumed and silently looked like a legitimate, resumable
 * session to every caller (`TaskRunner`'s `SessionWorkspaceStore`, a future
 * follow-up's `task.offer.sessionRef`, etc). Fail closed instead: if pi
 * doesn't hand back an authoritative session id, `start()` itself fails
 * with the real underlying error (stderr context is already folded in when
 * the rejection comes from the process exiting — see
 * `PiRpcClient.buildExitError`), exactly like any other adapter start()
 * failure `task-runner.ts` already knows how to report as `task.fail`.
 */
async function resolveFreshSessionId(rpc: PiRpcClient): Promise<string> {
  let state: PiRpcMessage;
  try {
    state = await rpc.send({ type: 'get_state' });
  } catch (err) {
    throw new Error(`pi did not yield an authoritative session id (get_state failed): ${errorMessage(err)}`, {
      cause: err,
    });
  }

  if (state.success === false) {
    const reason = typeof state.error === 'string' ? state.error : 'get_state reported failure';
    throw new Error(`pi did not yield an authoritative session id (get_state failed): ${reason}`);
  }

  const data = state.data as { sessionId?: unknown } | undefined;
  if (typeof data?.sessionId === 'string' && data.sessionId.length > 0) {
    return data.sessionId;
  }

  throw new Error(
    'pi did not yield an authoritative session id (get_state succeeded but reported no sessionId) — cannot mint a resumable session',
  );
}

class PiSession implements Session {
  constructor(
    public readonly sessionRef: string,
    private readonly rpc: PiRpcClient,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const rpc = this.rpc;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        const inner = rpc.events[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            for (;;) {
              const { value, done } = await inner.next();
              if (done) return { value: undefined as never, done: true };
              const mapped = mapPiMessageToAgentEvent(value);
              if (mapped) return { value: mapped, done: false };
              // Unmapped pi message: routine bookkeeping (compaction/retry/
              // session events — see ROUTINE_PI_EVENT_TYPES) is silently
              // ignored, same as before; anything else is genuinely
              // unexpected traffic worth flagging (see recordUnmappedFrame's
              // doc comment) — keep pulling either way, never surfaced.
              if (!ROUTINE_PI_EVENT_TYPES.has(value.type)) {
                rpc.recordUnmappedFrame(value.type);
              }
            }
          },
        };
      },
    };
  }

  async steer(text: string): Promise<void> {
    await this.rpc.send({ type: 'steer', message: text });
  }

  async followUp(task: TaskOfferPayload): Promise<void> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('pi adapter only supports string instructions in M0 (no blob-ref fetch yet)');
    }
    await this.rpc.send({ type: 'prompt', message: task.instruction, streamingBehavior: 'followUp' });
  }

  async interrupt(): Promise<void> {
    await this.rpc.send({ type: 'abort' });
  }

  async close(): Promise<void> {
    this.rpc.kill();
  }

  async resolveApproval(): Promise<void> {
    // pi has no built-in per-call approval gate (see permission-mapping.ts)
    // and never emits `needs_approval` in M0/M1, so this should be
    // unreachable in practice. Kept as an explicit, descriptive failure
    // rather than a silent no-op so a future caller (or a misbehaving
    // server) gets a clear error instead of a hang.
    throw new Error('pi adapter does not support approval resume: pi never emits needs_approval in M0/M1');
  }
}
