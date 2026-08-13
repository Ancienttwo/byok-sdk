import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import {
  PolicyUnsupportedError,
  freezeRuntimeAdapterDescriptor,
  type RuntimeAdapter,
  type RuntimeDetectResult,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';
import { resolvePiBin, type ResolvedBin } from './resolve-bin';
import { mapPermissionPolicyToPiArgs } from './permission-mapping';
import { mapPiMessageToAgentEvent, ROUTINE_PI_EVENT_TYPES } from './events';
import { PiRpcClient, type PiRpcMessage, type SpawnFn } from './rpc-client';
import {
  PROVIDER_CREDENTIAL_ENV_NAMES,
  withoutProviderCredentials,
} from '../provider-credential-environment';

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5_000;

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
export interface PiAdapterOptions {
  /** Override bin resolution — tests substitute the fake-pi fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
  /**
   * Separate-process BYOK credential boundary. The launcher receives only
   * non-secret selection/config paths, resolves the OS credential itself,
   * and transparently proxies the pinned Pi RPC process.
   */
  byokLauncher?: PiByokLauncherConfig;
}

export interface PiByokLauncherConfig {
  command: string;
  /** Optional fixed launcher arguments, before BYOK's required arguments. */
  args?: string[];
  profileDbPath: string;
  sessionDir: string;
  secretServicePrefix?: string;
}

export class PiAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi',
    supportsDispatchSelection: true,
    capabilities: {
      steer: true,
      resume: true,
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly'],
    },
    environmentRequirements: { credentialNames: PROVIDER_CREDENTIAL_ENV_NAMES },
  });

  constructor(private readonly options: PiAdapterOptions = {}) {}

  async detect(): Promise<RuntimeDetectResult> {
    try {
      const bin = this.resolveBin();
      // Empirically, pi 0.84.1 prints `--version` to stdout. Check stderr too
      // so detection remains accurate if a future pinned release moves it.
      const { stdout, stderr } = await execFileAsync(bin.command, ['--version'], { timeout: DETECT_TIMEOUT_MS });
      const version = stdout.trim() || stderr.trim();
      const authPresent = PROVIDER_CREDENTIAL_ENV_NAMES.some((name) => process.env[name] !== undefined);
      return { present: true, version, authPresent };
    } catch {
      return { present: false };
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const mapping = mapPermissionPolicyToPiArgs(input.policy);
    if (!mapping.ok) {
      return { kind: 'reject', reason: mapping.reason ?? 'policy rejected by pi adapter', retryable: false };
    }

    const bin = this.resolveBin();
    // Session/workspace continuity:
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
    // left alone here. pi 0.84.1 also offers `--session-id`, but that flag
    // creates a missing session. BYOK deliberately uses `--session` so a
    // lost/unknown authoritative sessionRef fails closed instead of silently
    // starting a new history under the requested id.
    const selection = input.offer.dispatchSelection;
    const pinnedSelection = selection === undefined ? undefined : Object.freeze({ ...selection });
    let command = bin.command;
    let launcherArgs: string[] | undefined;
    if (pinnedSelection !== undefined) {
      if (pinnedSelection.lane !== 'byok' || pinnedSelection.runtimeId !== 'pi') {
        return { kind: 'reject', reason: `pi adapter cannot execute ${pinnedSelection.lane} selection for runtime ${pinnedSelection.runtimeId}`, retryable: false };
      }
      const launcher = this.options.byokLauncher;
      if (launcher === undefined) {
        return { kind: 'reject', reason: 'pi BYOK selection requires a configured credential-custody launcher', retryable: false };
      }
      command = launcher.command;
      launcherArgs = [
        ...(launcher.args ?? []),
        '--pi-bin',
        bin.command,
        '--profile-db',
        launcher.profileDbPath,
        '--session-dir',
        launcher.sessionDir,
        ...(launcher.secretServicePrefix
          ? ['--secret-service-prefix', launcher.secretServicePrefix]
          : []),
        '--provider',
        pinnedSelection.providerId,
        '--model',
        pinnedSelection.modelId,
      ];
    }

    return {
      kind: 'prepared',
      operation: {
        start: async (startInput: RuntimeOperationStartInput): Promise<Session> => {
          const manifestSelection = startInput.manifest.dispatchSelection;
          if (!sameDispatchSelection(manifestSelection, pinnedSelection)) {
            throw new PolicyUnsupportedError('prepared pi operation received a manifest with different runtime selection');
          }
          if (typeof startInput.instruction !== 'string') {
            throw new PolicyUnsupportedError('prepared pi operation requires a resolved string instruction');
          }
          const resumeSessionId = startInput.manifest.sessionRef;
          const piArgs = ['--mode', 'rpc', ...(resumeSessionId ? ['--session', resumeSessionId] : []), ...mapping.args];
          const args = launcherArgs === undefined ? piArgs : [...launcherArgs, '--', ...piArgs];
          const rpc = new PiRpcClient({
            command,
            args,
            cwd: startInput.manifest.workspace.workspaceDir,
            env: manifestSelection === undefined ? startInput.env : withoutProviderCredentials(startInput.env),
            spawnFn: this.options.spawnFn,
          });

          const response = await rpc.send({ type: 'prompt', message: startInput.instruction });
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
              rpc.kill();
              throw err;
            }
          }
          return new PiSession(sessionRef, rpc, manifestSelection);
        },
      },
    };
  }

  private resolveBin(): ResolvedBin {
    return (this.options.resolveBin ?? resolvePiBin)();
  }
}

function sameDispatchSelection(
  left: TaskOfferPayload['dispatchSelection'],
  right: TaskOfferPayload['dispatchSelection'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.lane === right.lane &&
    left.runtimeId === right.runtimeId &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId;
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
    private readonly selection: TaskOfferPayload['dispatchSelection'],
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
    const requestedSelection = task.dispatchSelection;
    if (requestedSelection !== undefined && (
      this.selection?.lane !== 'byok' ||
      requestedSelection.lane !== 'byok' ||
      requestedSelection.runtimeId !== 'pi' ||
      requestedSelection.providerId !== this.selection.providerId ||
      requestedSelection.modelId !== this.selection.modelId
    )) {
      throw new PolicyUnsupportedError(
        'pi persistent session cannot change its authoritative BYOK provider/model selection',
      );
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
