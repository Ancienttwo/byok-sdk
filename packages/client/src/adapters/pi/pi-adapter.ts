import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path, { isAbsolute } from 'node:path';
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
import { RuntimeDisposalFailure, RuntimeExecutionFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { BYOK_PI_MCP_CONFIG_PATH } from './mcp-config';
import { resolvePiBin, type ResolvedBin } from './resolve-bin';
import { resolvePiExtensions, type ResolvedPiExtensions } from './resolve-extensions';
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

/** Task-owned cleanup is part of the close receipt and must fail visibly. */
async function cleanupMcpConfigDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (cause) {
    throw new RuntimeDisposalFailure({
      stage: 'cleanup',
      reason: 'pi task-scoped MCP configuration could not be removed',
    }, { cause });
  }
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
  /** Override bundled extension resolution — tests use stable fixture paths. */
  resolveExtensions?: () => ResolvedPiExtensions;
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
  macosKeychainPath?: string;
  secretServicePrefix?: string;
}

export function validatePiByokLauncherConfig(
  launcher: PiByokLauncherConfig | undefined,
): void {
  if (launcher === undefined) return;

  for (const [field, value] of [
    ['command', launcher.command],
    ['profileDbPath', launcher.profileDbPath],
    ['sessionDir', launcher.sessionDir],
  ] as const) {
    if (value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
      throw new Error(`DaemonConfig.piByokLauncher.${field} must be a non-empty single-line string`);
    }
  }
  if (!isAbsolute(launcher.profileDbPath) || !isAbsolute(launcher.sessionDir)) {
    throw new Error(
      'DaemonConfig.piByokLauncher profileDbPath and sessionDir must be absolute paths',
    );
  }
  if (launcher.macosKeychainPath !== undefined && (
    launcher.macosKeychainPath.trim().length === 0 ||
    /[\u0000\r\n]/u.test(launcher.macosKeychainPath)
  )) {
    throw new Error(
      'DaemonConfig.piByokLauncher.macosKeychainPath must be a non-empty single-line string',
    );
  }
  if (launcher.macosKeychainPath !== undefined && !isAbsolute(launcher.macosKeychainPath)) {
    throw new Error(
      'DaemonConfig.piByokLauncher.macosKeychainPath must be an absolute path',
    );
  }
  if (launcher.secretServicePrefix !== undefined && (
    launcher.secretServicePrefix.trim().length === 0 ||
    /[\u0000\r\n]/u.test(launcher.secretServicePrefix)
  )) {
    throw new Error(
      'DaemonConfig.piByokLauncher.secretServicePrefix must be a non-empty single-line string',
    );
  }
  const reserved = new Set([
    '--',
    '--pi-bin',
    '--profile-db',
    '--session-dir',
    '--macos-keychain-path',
    '--secret-service-prefix',
    '--provider',
    '--model',
  ]);
  const conflicting = launcher.args?.find((arg) => reserved.has(arg));
  if (conflicting !== undefined) {
    throw new Error(
      `DaemonConfig.piByokLauncher.args must not override reserved launcher argument ${conflicting}`,
    );
  }
  const invalidArg = launcher.args?.find((arg) => arg.length === 0 || /[\u0000\r\n]/u.test(arg));
  if (invalidArg !== undefined) {
    throw new Error('DaemonConfig.piByokLauncher.args must contain only non-empty single-line strings');
  }
}

export class PiAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi',
    supportsDispatchSelection: true,
    capabilities: {
      steer: true,
      resume: true,
      mcpToolsets: true,
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly'],
    },
    environmentRequirements: { credentialNames: PROVIDER_CREDENTIAL_ENV_NAMES },
  });

  constructor(private readonly options: PiAdapterOptions = {}) {
    validatePiByokLauncherConfig(options.byokLauncher);
  }

  async detect(): Promise<RuntimeDetectResult> {
    try {
      const bin = this.resolveBin();
      // Empirically, pi 0.84.2 prints `--version` to stdout. Check stderr too
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
    if (input.requiredToolsetIds.length > 0 && input.policy.mode !== 'auto') {
      return {
        kind: 'reject',
        reason: 'pi MCP toolsets require permission mode "auto" because pi-mcp-adapter exposes one proxy across read and mutation tools',
        retryable: false,
      };
    }

    const bin = this.resolveBin();
    const extensions = (this.options.resolveExtensions ?? resolvePiExtensions)();
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
    // left alone here. pi 0.84.2 also offers `--session-id`, but that flag
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
        ...(launcher.macosKeychainPath !== undefined
          ? ['--macos-keychain-path', launcher.macosKeychainPath]
          : []),
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
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation received a manifest with different runtime selection',
            });
          }
          if (typeof startInput.instruction !== 'string') {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation requires a resolved string instruction',
            });
          }
          const resumeSessionId = startInput.manifest.sessionRef;
          const manifestCwd = startInput.manifest.cwd;
          if (manifestCwd === undefined) {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation received a manifest without a sealed cwd',
            });
          }
          let mcpConfigDir: string | undefined;
          let runtimeEnv = manifestSelection === undefined ? startInput.env : withoutProviderCredentials(startInput.env);
          const taskMcpServers = startInput.mcpServers ?? {};
          const hasMcpServers = Object.keys(taskMcpServers).length > 0;
          if (hasMcpServers) {
            mcpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-mcp-'));
            await fs.chmod(mcpConfigDir, 0o700).catch(() => {});
            const mcpConfigPath = path.join(mcpConfigDir, 'mcp-config.json');
            await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: taskMcpServers }), { mode: 0o600 });
            runtimeEnv = { ...runtimeEnv, [BYOK_PI_MCP_CONFIG_PATH]: mcpConfigPath };
          }
          const piArgs = [
            '--mode',
            'rpc',
            '--extension',
            extensions.webAccess,
            ...(hasMcpServers ? ['--extension', extensions.mcpAdapter] : []),
            ...(resumeSessionId ? ['--session', resumeSessionId] : []),
            ...mapping.args,
          ];
          const args = launcherArgs === undefined ? piArgs : [...launcherArgs, '--', ...piArgs];
          let rpc: PiRpcClient;
          try {
            rpc = new PiRpcClient({
              command,
              args,
              cwd: manifestCwd,
              env: runtimeEnv,
              spawnFn: this.options.spawnFn,
            });
          } catch (cause) {
            await cleanupMcpConfigDir(mcpConfigDir);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'infrastructure', retry: 'retryable',
              reason: 'pi runtime process could not be spawned',
            }, { cause });
          }

          let response: PiRpcMessage;
          try {
            response = await rpc.send({ type: 'prompt', message: startInput.instruction });
          } catch (cause) {
            rpc.kill();
            await cleanupMcpConfigDir(mcpConfigDir);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'infrastructure', retry: 'retryable',
              reason: `pi initial prompt transport failed: ${errorMessage(cause)}`,
            }, { cause });
          }
          if (response.success === false) {
            rpc.kill();
            await cleanupMcpConfigDir(mcpConfigDir);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'semantic', retry: 'non-retryable',
              reason: typeof response.error === 'string' ? response.error : 'pi rejected the initial prompt',
            });
          }

          let sessionRef: string;
          try {
            sessionRef = await resolveAuthoritativeSessionId(rpc);
          } catch (err) {
            rpc.kill();
            await cleanupMcpConfigDir(mcpConfigDir);
            throw err;
          }
          if (resumeSessionId !== undefined && sessionRef !== resumeSessionId) {
            rpc.kill();
            await cleanupMcpConfigDir(mcpConfigDir);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'pi resumed a different authoritative session than requested',
            });
          }
          return new PiSession(sessionRef, rpc, manifestSelection, mcpConfigDir);
        },
      },
    };
  }

  private resolveBin(): ResolvedBin {
    return (this.options.resolveBin ?? resolvePiBin)();
  }
}

/**
 * Compare two dispatch selections field-for-field within their own lane.
 *
 * The lanes do not share an identity shape: `subscription` and `byok` pin a
 * flat `providerId`/`modelId` pair, while `byok-profile` pins an exact local
 * provider profile (ref, revision, hash, model, and the capabilities the task
 * requires). Comparing only the fields one lane happens to expose would let a
 * manifest carrying a *different* profile pass the start-time authority check,
 * so each lane is compared on everything that lane seals — including
 * `requiredCapabilities` in order, since the sealed array is the exact value
 * the manifest froze rather than a set.
 */
function sameDispatchSelection(
  left: TaskOfferPayload['dispatchSelection'],
  right: TaskOfferPayload['dispatchSelection'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.lane === 'byok-profile' || right.lane === 'byok-profile') {
    if (left.lane !== 'byok-profile' || right.lane !== 'byok-profile') return false;
    if (left.runtimeId !== right.runtimeId) return false;
    const leftProfile = left.providerProfile;
    const rightProfile = right.providerProfile;
    return leftProfile.profileRef === rightProfile.profileRef &&
      leftProfile.profileRevision === rightProfile.profileRevision &&
      leftProfile.profileHash === rightProfile.profileHash &&
      leftProfile.modelId === rightProfile.modelId &&
      leftProfile.requiredCapabilities.length === rightProfile.requiredCapabilities.length &&
      leftProfile.requiredCapabilities.every(
        (capability, index) => capability === rightProfile.requiredCapabilities[index],
      );
  }
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
async function resolveAuthoritativeSessionId(rpc: PiRpcClient): Promise<string> {
  let state: PiRpcMessage;
  try {
    state = await rpc.send({ type: 'get_state' });
  } catch (err) {
    if (isRuntimeExecutionFailure(err)) throw err;
    throw new RuntimeExecutionFailure({
      phase: 'start',
      category: 'infrastructure',
      retry: 'retryable',
      reason: `pi transport ended before yielding an authoritative session id: ${errorMessage(err)}`,
    }, {
      cause: err,
    });
  }

  if (state.success === false) {
    const reason = typeof state.error === 'string' ? state.error : 'get_state reported failure';
    throw new RuntimeExecutionFailure({
      phase: 'start',
      category: 'authority',
      retry: 'non-retryable',
      reason: `pi did not yield an authoritative session id: ${reason}`,
    });
  }

  const data = state.data as { sessionId?: unknown } | undefined;
  if (typeof data?.sessionId === 'string' && data.sessionId.length > 0) {
    return data.sessionId;
  }

  throw new RuntimeExecutionFailure({
    phase: 'start',
    category: 'authority',
    retry: 'non-retryable',
    reason: 'pi get_state reported no authoritative session id',
  });
}

class PiSession implements Session {
  private closeAttempt: Promise<void> | undefined;

  constructor(
    public readonly sessionRef: string,
    private readonly rpc: PiRpcClient,
    private readonly selection: TaskOfferPayload['dispatchSelection'],
    /** Task-scoped isolated pi-mcp-adapter configuration, removed in close(). */
    private readonly mcpConfigDir?: string,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const rpc = this.rpc;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        const inner = rpc.events[Symbol.asyncIterator]();
        let terminalFailure: RuntimeExecutionFailure | undefined;
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            for (;;) {
              if (terminalFailure) throw terminalFailure;
              let result: IteratorResult<PiRpcMessage>;
              try {
                result = await inner.next();
              } catch (cause) {
                throw new RuntimeExecutionFailure({
                  phase: 'run',
                  category: 'infrastructure',
                  retry: 'retryable',
                  reason: 'pi runtime event transport failed',
                }, { cause });
              }
              const { value, done } = result;
              if (done) {
                throw new RuntimeExecutionFailure({
                  phase: 'run',
                  category: 'infrastructure',
                  retry: 'retryable',
                  reason: 'pi runtime process ended before agent_settled',
                }, { cause: rpc.terminalError });
              }
              const mapped = mapPiMessageToAgentEvent(value);
              if (value.type === 'auto_retry_end' && value.success === false) {
                terminalFailure = new RuntimeExecutionFailure({
                  phase: 'run',
                  category: 'semantic',
                  retry: 'non-retryable',
                  reason: 'pi exhausted its native retry policy',
                });
              }
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
    if (!this.closeAttempt) {
      const attempt = (async () => {
        await this.rpc.dispose();
        await cleanupMcpConfigDir(this.mcpConfigDir);
      })();
      this.closeAttempt = attempt.catch((error: unknown) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
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
