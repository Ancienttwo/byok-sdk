import { execFile, type spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  SteerUnsupportedError,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeDetectResult,
  type RuntimeOperationStartInput,
  type RuntimeTaskInput,
  type RuntimeVersionPolicy,
  type Session,
} from '../../types';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import { AcpConnection, AcpMethodNotFound, AcpRpcError } from '../../runtime/acp-connection';
import { AcpProjection } from '../../runtime/acp-projection';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy';
import { AsyncQueue } from '../../util/async-queue';
import { comparablePath } from '../../util/comparable-path';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import type { ResolvedBin } from '../codex/resolve-bin';
import { DSH_RUNTIME_CAPABILITIES } from './dsh-capabilities';
import { assertDshModelSelection, assertDshSandboxMode, dshAgentsHome, dshEnvironment, dshPatch, dshRoute } from './dsh-profile';
import { DSH_VERSION_POLICY, dshVersionToken } from './dsh-version';
import { resolveDshBin } from './resolve-bin';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable';

/**
 * Provider and model for every dsh execution (#1258 O4). Credentials stay in
 * the environment: `keyEnv` names the variable, its value never enters the
 * patch file.
 */
export interface DshModelSelection {
  /**
   * `deepseek` routes through dsh's own DeepSeek API plugin
   * (`deepseek-official`). `custom` is an OpenAI-compatible endpoint at
   * `baseUrl`. Any other value is a pi-ai catalog provider id dsh ships, for
   * example `openai`, `anthropic` or `openrouter`.
   */
  readonly provider: string;
  readonly model: string;
  /** Endpoint for `custom` (required) or a catalog provider (optional). Not allowed for `deepseek`. It must not carry credentials. */
  readonly baseUrl?: string;
  /**
   * The environment variable that holds the provider key. Its name must
   * contain `KEY`, `TOKEN`, `SECRET` or `PASSWORD`: dsh removes such names
   * from every tool process it starts, so the key never reaches the model's
   * shell. It must not be `DEEPSEEK_API_KEY`, which dsh's `web_search` tool
   * also reads, nor start with `BYOK_` (the runtime environment drops those)
   * or `DSH_` (the adapter owns them).
   */
  readonly keyEnv: string;
}

/** dsh's own sandbox modes (`DSH_PERMISSION_MODE`). `danger-full-access` also sets approval to `never`; the other two ask, and the adapter cancels every ask. */
export type DshSandboxMode = 'danger-full-access' | 'workspace-write' | 'read-only';

const VERSION_TIMEOUT_MS = 5_000;
/** `dsh --profile acp --help` boots the launcher and, on a new root, writes the acp profile: about 1.7 s measured. */
const PROFILE_PROBE_TIMEOUT_MS = 30_000;
const OPEN_REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_INTERRUPT_MS = 1_000;
const PATCH_FILE = 'dsh.patch.yml';
/** No client filesystem or terminal: dsh runs every tool itself, under its own sandbox. */
const INITIALIZE_PARAMS = Object.freeze({
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});

export interface DshAdapterOptions {
  /**
   * Absolute path of the dsh home (`DSH_HOME`) this SDK owns, for example
   * under the Host's store directory. It must persist across executions:
   * dsh keeps its sessions there, and resume reads them back. It must not be
   * the user's dsh home (`~/.dsh`): dsh's stored credentials outrank the
   * environment, and the user's profile patches and plugins would change the
   * composition the SDK relies on.
   */
  home: string;
  /** Provider, model and key variable of every execution. */
  model: DshModelSelection;
  /**
   * dsh's sandbox for every session (`DSH_PERMISSION_MODE`). Default
   * `danger-full-access`, as for Codex: no human answers a dsh approval, so
   * every escalation the narrower modes ask for is cancelled.
   */
  sandbox?: DshSandboxMode;
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment dsh and its MCP servers get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
  /** Internal: `createDaemon` marks a `DaemonConfig.runtimes.<id>.versionPolicy` so the resolver reports its source. */
  versionPolicySource?: 'adapter-option' | 'daemon-config';
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  /** Deadline for a cancelled turn to settle before the session fails. Default 1 s. */
  interruptTimeoutMs?: number;
}

const infrastructure = (phase: 'start' | 'run', reason: string, retry: 'retryable' | 'non-retryable' = 'non-retryable') =>
  new RuntimeExecutionFailure({ phase, category: 'infrastructure', retry, reason });
const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });

function withDeadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(infrastructure('start', 'dsh start was aborted', 'retryable'));
    const timer = setTimeout(() => reject(onTimeout()), ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}

/** `dsh --profile acp --help` exits 0 when the acp profile resolves; it also writes that profile into a new root. */
function probeAcpProfile(command: string, root: string, env: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(command, ['--profile', 'acp', '--help'], { cwd: root, env, timeout: PROFILE_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 },
        (error) => resolve(error === null));
    } catch {
      resolve(false);
    }
  });
}

/** The `model` config option's current value, which dsh encodes as a JSON `[route, model]` pair. */
function selectedModel(result: unknown): unknown {
  const options = (result as { configOptions?: unknown } | null)?.configOptions;
  if (!Array.isArray(options)) return undefined;
  return (options.find((option) => (option as { id?: unknown } | null)?.id === 'model') as { currentValue?: unknown } | undefined)?.currentValue;
}

/**
 * DeepSeek Harness over ACP stdio (`dsh --profile acp`). Each session runs one
 * dsh process in an SDK-owned `DSH_HOME`, with a per-execution `--patch`
 * overlay that names the provider route, its key variable and the model. The
 * process starts in the execution scratch directory, not the workspace, so
 * dsh does not load a workspace `.env`; the workspace is the ACP session cwd.
 *
 * `dsh` is not a frozen wire runtime id, so a task reaches this adapter by the
 * custom-harness identity (`harnessId: 'dsh'`).
 */
export class DshAdapter implements RuntimeAdapter {
  private readonly root: string;
  private readonly options: DshAdapterOptions;
  private readonly sandbox: DshSandboxMode;
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  private readonly effectiveVersionPolicy: RuntimeVersionPolicy | undefined;

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({
      id: 'dsh',
      supportsDispatchSelection: false,
      // dsh ships no win32 build of its native addon (docs/plans/2026-11-01-dsh-adapter.md §1.9).
      platforms: ['darwin', 'linux'],
      capabilities: DSH_RUNTIME_CAPABILITIES,
      // Each `agent_message_chunk` is one committed assistant message.
      progressEventsAreMessages: true,
      ...(this.effectiveVersionPolicy === undefined ? {} : { versionPolicy: this.effectiveVersionPolicy }),
    });
  }

  constructor(options: DshAdapterOptions) {
    if (typeof options?.home !== 'string' || !path.isAbsolute(options.home)) throw new TypeError('DshAdapterOptions.home must be an absolute path');
    const root = path.resolve(options.home);
    const candidate = comparablePath(root);
    const userHome = comparablePath(path.join(os.homedir(), '.dsh'));
    if (candidate === userHome || candidate.startsWith(`${userHome}${path.sep}`)) throw new TypeError('DshAdapterOptions.home must not be the user\'s dsh home (~/.dsh)');
    assertDshModelSelection(options.model, 'DshAdapterOptions.model');
    const sandbox = options.sandbox ?? 'danger-full-access';
    assertDshSandboxMode(sandbox, 'DshAdapterOptions.sandbox');
    const interrupt = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_MS;
    if (!Number.isSafeInteger(interrupt) || interrupt <= 0 || interrupt > 2_147_483_647) throw new TypeError('invalid dsh interrupt timeout');
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'DshAdapterOptions.runtimeEnvironment');
    this.effectiveVersionPolicy = resolveRuntimeVersionPolicy({
      descriptor: DSH_VERSION_POLICY,
      ...(options.versionPolicy === undefined ? {} : options.versionPolicySource === 'daemon-config'
        ? { daemonConfig: options.versionPolicy }
        : { adapterOption: options.versionPolicy }),
    }).policy;
    this.root = root;
    this.sandbox = sandbox;
    this.options = { ...options, model: Object.freeze({ ...options.model }) };
  }

  private command(): string {
    return resolveRuntimeCommand(this.options.resolveBin, resolveDshBin).bin.command;
  }

  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(dshAgentsHome(this.root), { recursive: true, mode: 0o700 });
  }

  /**
   * Prepares the SDK root, reads `dsh --version`, then resolves the acp
   * profile (which writes it into a new root). `authPresent` is whether the
   * runtime environment carries the `model.keyEnv` variable; the key is not
   * checked against the provider.
   */
  async detect(): Promise<RuntimeDetectResult> {
    try {
      const resolved = resolveRuntimeCommand(this.options.resolveBin, resolveDshBin);
      const command = resolved.bin.command;
      const { env: base } = await this.runtimeEnvironment();
      const env = dshEnvironment(base, this.root, this.sandbox);
      await this.ensureRoot();
      const version = await probeRuntimeVersion(command, VERSION_TIMEOUT_MS, env);
      if (version.kind !== 'available') return version;
      const token = dshVersionToken(version.stdout);
      if (!await probeAcpProfile(command, this.root, env)) return { kind: 'refused', reason: 'acp_unavailable' };
      const key = base[this.options.model.keyEnv];
      return {
        kind: 'available',
        version: token,
        authPresent: typeof key === 'string' && key.length > 0,
        ...runtimeExecutableFields(resolved, command),
        ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, token),
      };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  /** Cheap admission, as Hermes: the version probe only. The acp profile probe belongs to `detect()`. */
  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    if (input.offer.dispatchSelection !== undefined) return { kind: 'reject', reason: 'dsh does not accept a dispatch selection; the Host configures its model', retryable: false };
    const command = this.command();
    const { env: base } = await this.runtimeEnvironment();
    const version = await probeRuntimeVersion(command, VERSION_TIMEOUT_MS, dshEnvironment(base, this.root, this.sandbox));
    if (version.kind !== 'available') {
      return { kind: 'reject', reason: `dsh installation refused: ${version.kind === 'refused' ? version.reason : version.kind}`, retryable: false };
    }
    return { kind: 'prepared', operation: { start: (start) => this.start(start, command) } };
  }

  private async start(input: RuntimeOperationStartInput, command: string): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('dsh requires a resolved instruction');
    if (input.manifest.dispatchSelection !== undefined) throw authority('prepared dsh operation received a manifest with a dispatch selection');
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('dsh manifest has no sealed cwd');
    const session = new DshSession(input.scratch, this.options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_MS);
    try {
      // dsh compares the canonical workspace on resume.
      const workspace = await fs.realpath(cwd);
      await this.ensureRoot();
      const patch = path.join(input.scratch.sdkDir, PATCH_FILE);
      await fs.writeFile(patch, dshPatch(this.options.model), { mode: 0o600 });
      const env = dshEnvironment({ ...input.env, ...input.scratch.env }, this.root, this.sandbox);
      const child = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'dsh acp' })(
        command, ['--profile', 'acp', '--patch', patch], { cwd: input.scratch.sdkDir, env },
      );
      const connection = session.own(child);
      const open = <T>(method: string, params: Record<string, unknown>) => withDeadline(
        connection.request(method, params) as Promise<T>, OPEN_REQUEST_TIMEOUT_MS, input.signal,
        () => infrastructure('start', `dsh ${method} timed out`, 'retryable'),
      );
      await withDeadline(child.spawned, OPEN_REQUEST_TIMEOUT_MS, input.signal, () => infrastructure('start', 'dsh acp did not spawn', 'retryable'));
      const initialized = await open<{ protocolVersion?: unknown }>('initialize', INITIALIZE_PARAMS);
      if (initialized?.protocolVersion !== 1) throw infrastructure('start', 'dsh acp did not negotiate ACP protocol version 1');
      const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({
        name,
        command: server.command,
        args: [...(server.args ?? [])],
        env: Object.entries(server.env ?? {}).map(([variable, value]) => ({ name: variable, value })),
      }));
      const resume = input.manifest.sessionRef;
      let opened: unknown;
      let sessionId: string;
      if (resume !== undefined) {
        // Unknown id and another workspace both answer -32602 with only a message: neither can succeed on retry.
        opened = await open('session/resume', { sessionId: resume, cwd: workspace, mcpServers }).catch((error: unknown) => {
          throw error instanceof AcpRpcError ? authority(`dsh could not resume session ${resume}: ${error.message}`) : error;
        });
        sessionId = resume;
      } else {
        opened = await open<{ sessionId?: unknown }>('session/new', { cwd: workspace, mcpServers });
        const id = (opened as { sessionId?: unknown } | null)?.sessionId;
        if (typeof id !== 'string' || id.length === 0) throw infrastructure('start', 'dsh session/new returned no session id');
        sessionId = id;
      }
      // The patch is the only model authority: a session on any other route means the overlay did not apply.
      if (selectedModel(opened) !== JSON.stringify([dshRoute(this.options.model), this.options.model.model]))
        throw authority('dsh session does not run the configured provider route and model');
      session.ready(sessionId);
      if (input.signal?.aborted) throw infrastructure('start', 'dsh start was aborted', 'retryable');
      session.prompt(input.instruction);
      return session;
    } catch (error) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal });
      }
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: isRuntimeExecutionFailure(error) ? error.category : 'infrastructure',
        retry: isRuntimeExecutionFailure(error) ? error.retry : error instanceof AcpRpcError ? 'non-retryable' : 'retryable',
        reason: error instanceof Error ? error.message : 'dsh open failed',
        failure: isRuntimeExecutionFailure(error) ? error.failure : { class: session.exitedOnItsOwn ? 'runtime_exited' : 'unknown' },
      });
    }
  }
}

type OwnedLineProcess = ReturnType<ReturnType<typeof createOwnedLineProcessSpawn>>;

class DshSession implements Session {
  sessionRef = '';
  private child?: OwnedLineProcess;
  private connection?: AcpConnection;
  private readonly projection = new AcpProjection();
  private readonly queue = new AsyncQueue<AgentEvent>();
  private failure?: RuntimeExecutionFailure;
  private turn?: Promise<void>;
  private stopping = false;
  private closeAttempt?: Promise<void>;

  constructor(private readonly scratch: ExecutionScratch, private readonly interruptMs: number) {}

  get exitedOnItsOwn(): boolean {
    return this.child?.exitedOnItsOwn === true;
  }

  own(child: OwnedLineProcess): AcpConnection {
    this.child = child;
    this.connection = new AcpConnection(child, {
      notification: (method, params) => {
        if (method !== 'session/update' || params.sessionId !== this.sessionRef) return;
        const update = params.update;
        if (update !== null && typeof update === 'object' && !Array.isArray(update)) {
          this.projection.update(update as Record<string, unknown>, (event) => this.queue.push(event));
        }
      },
      request: (method) => {
        // dsh asks only for a sandbox escalation (or a hook a user composition adds). No human can answer,
        // so the request is cancelled: that one tool fails and the turn continues.
        if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
        throw new AcpMethodNotFound(method);
      },
    }, 'dsh');
    void child.exited.then(() => this.exited(), (error) => this.fail(error));
    return this.connection;
  }

  ready(sessionId: string): void {
    this.sessionRef = sessionId;
  }

  /** Sends one `session/prompt`. Its answer, not the send, ends the turn. */
  prompt(text: string): void {
    if (!this.connection || !this.sessionRef) throw infrastructure('run', 'dsh session is not open');
    if (this.turn) throw infrastructure('run', 'dsh turn is already active');
    const turn = this.connection.request('session/prompt', { sessionId: this.sessionRef, prompt: [{ type: 'text', text }] }).then(
      (result) => this.projection.turnEnded(result, (event) => this.queue.push(event)),
      (error) => {
        // close() rejects the pending prompt on purpose; that is not a turn failure.
        if (this.stopping) return;
        // A failed turn is a JSON-RPC error with text only: no structured class (#1258 O6).
        this.fail(error instanceof AcpRpcError
          ? new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: `dsh turn failed: ${error.message}` })
          : error);
      },
    ).finally(() => {
      if (this.turn === turn) this.turn = undefined;
    });
    this.turn = turn;
  }

  get events(): AsyncIterable<AgentEvent> {
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

  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string') throw new PolicyUnsupportedError('dsh requires a string instruction');
    if (task.dispatchSelection !== undefined) throw new PolicyUnsupportedError('dsh does not accept a dispatch selection');
    this.prompt(task.instruction);
  }

  async steer(): Promise<void> {
    throw new SteerUnsupportedError('dsh', 'dsh runs one prompt at a time and cannot inject into an active turn');
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!this.connection || !turn) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.connection.notify('session/cancel', { sessionId: this.sessionRef });
      await Promise.race([
        turn,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(infrastructure('run', 'dsh cancel timed out')), this.interruptMs);
        }),
      ]);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  fail(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure('run', error instanceof Error ? error.message : 'dsh runtime failed');
    this.queue.end();
    void this.close().catch(() => {});
  }

  private exited(): void {
    if (!this.stopping) this.fail(new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure', retry: 'non-retryable',
      reason: 'dsh acp exited', failure: { class: 'runtime_exited' } }));
  }

  /**
   * `session/close` first, so dsh cancels the turn, drains its output and
   * flushes the session log that a later resume reads; then the owned process
   * tree is disposed whatever that answer was.
   */
  async close(): Promise<void> {
    const graceful = !this.stopping && this.failure === undefined;
    this.stopping = true;
    if (!this.closeAttempt) {
      const attempt = (async () => {
        try {
          if (graceful && this.connection && this.sessionRef) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              this.connection.request('session/close', { sessionId: this.sessionRef }),
              new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_REQUEST_TIMEOUT_MS); }),
            ]).catch(() => {}).finally(() => clearTimeout(timer));
          }
          this.connection?.close(this.failure ?? infrastructure('run', 'dsh session closed'));
          try {
            await this.child?.dispose();
          } finally {
            await this.scratch.release();
          }
        } finally {
          this.queue.end();
        }
        this.connection = undefined;
        this.child = undefined;
      })();
      this.closeAttempt = attempt.catch((error) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }
}
