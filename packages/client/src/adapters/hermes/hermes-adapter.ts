import { randomBytes } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  SteerUnsupportedError,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeDetectResult,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { buildRuntimeEnv } from '../../daemon/environment';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import { AsyncQueue } from '../../util/async-queue';
import { classifyDetectError } from '../detect-outcome';
import type { ResolvedBin } from '../codex/resolve-bin';
import { AcpConnection, AcpMethodNotFound, AcpRpcError } from './acp-connection';
import { identifyHermesGateway, type HermesGatewayIdentity } from './gateway-identity';
import {
  assertHermesModelSelection, createHermesProfile, ensureHermesRoot, removeHermesProfile, sweepStaleHermesProfiles,
} from './hermes-home';
import { hermesVersionLine, isQualifiedHermesVersion, QUALIFIED_HERMES_VERSION } from './hermes-version';
import { HermesProjection } from './projection';
import { resolveHermesBin } from './resolve-bin';

const VERSION_TIMEOUT_MS = 5_000;
const OPEN_REQUEST_TIMEOUT_MS = 60_000;
const GATEWAY_POLL_MS = 100;
/** No fs or terminal methods: Hermes runs every tool inside its own gateway. No elicitation: clarify falls back to a permission request. */
const INITIALIZE_PARAMS = Object.freeze({
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});
/** Hermes ACP mode that auto-allows file edits for the session; sensitive paths still ask. */
const EDIT_MODE = 'dont_ask';

/** Provider choice written into each execution profile. Credentials stay in the environment. */
export interface HermesModelSelection {
  /** Hermes provider id, for example `openrouter`, `anthropic` or `custom`. */
  readonly provider: string;
  readonly model: string;
  /** Endpoint for an OpenAI-compatible `custom` provider. It must not carry credentials. */
  readonly baseUrl?: string;
  /** Name of the environment variable that holds the provider key. The value never enters the file. */
  readonly keyEnv?: string;
}

export interface HermesAdapterOptions {
  /**
   * Absolute path of the Hermes root that this SDK owns, for example under the
   * Host's store directory. Each execution runs in a fresh profile home below
   * it (`hermes-home.ts`). It must not be the user's `~/.hermes`. Give each
   * Host process its own root. The first `detect()` on a new root waits while
   * Hermes builds its environment there.
   */
  home: string;
  /** Provider and model for every execution. Absent: Hermes picks a provider from the credentials in the environment. */
  model?: HermesModelSelection;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  /** Deadline of the `detect()` ACP probe. Covers a first environment build in a new root. Default 180 s. */
  probeTimeoutMs?: number;
  /** Deadline for the owned gateway to report ready. Default 20 s. */
  gatewayReadyTimeoutMs?: number;
  /** Deadline for a cancelled turn to settle before the session fails. Default 1 s. */
  interruptTimeoutMs?: number;
}

function assertDeadline(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) throw new TypeError(`invalid ${label}`);
}

/**
 * The SDK owns the Hermes configuration of a turn, so ambient `HERMES_*`
 * variables are not forwarded. One of them, `HERMES_TUI_GATEWAY_URL`, would
 * send the turn to a remote gateway.
 */
function hermesEnvironment(base: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !/^HERMES_/i.test(name)) env[name] = value;
  }
  env.HERMES_HOME = home;
  return env;
}

function withDeadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(infrastructure('start', 'hermes start was aborted', 'retryable'));
    const timer = setTimeout(() => reject(onTimeout()), ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}

type ProbeFailure = Exclude<RuntimeDetectResult, { kind: 'available' }>;

/**
 * `hermes --version` with the SDK root as `HERMES_HOME`. The shared probe
 * would use the ambient home: Hermes then reads the user's `~/.hermes` config
 * and writes its update-check cache there.
 */
function probeHermesVersion(command: string, env: Record<string, string>): Promise<{ kind: 'available'; line: string } | ProbeFailure> {
  return new Promise((resolve) => {
    try {
      execFile(command, ['--version'], { encoding: 'utf8', env, timeout: VERSION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        if (error === null) resolve({ kind: 'available', line: hermesVersionLine(stdout) || hermesVersionLine(stderr) });
        else if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ kind: 'probe-failed' });
        else if (error.killed === true && error.signal === 'SIGKILL') resolve({ kind: 'timeout' });
        else resolve(classifyDetectError(error));
      });
    } catch (error) {
      resolve(classifyDetectError(error));
    }
  });
}

/**
 * Real path of the nearest existing ancestor plus the rest, so a symlink or a
 * case variant cannot hide `~/.hermes`, even below a directory not yet created.
 */
function canonicalPath(value: string): string {
  let existing = path.resolve(value);
  const rest: string[] = [];
  for (;;) {
    try {
      existing = realpathSync.native(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = path.join(existing, ...rest);
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** A busy gateway can miss one `identify` deadline; ask a few times before treating it as gone. */
async function identifyAfterAttach(home: string): Promise<HermesGatewayIdentity | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const identity = await identifyHermesGateway(home);
    if (identity !== undefined) return identity;
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_POLL_MS));
  }
  return undefined;
}

/** SIGKILL to a detached Hermes gateway's own process group (it starts in a new session), else to the pid. */
function stopProcessGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

const infrastructure = (phase: 'start' | 'run', reason: string, retry: 'retryable' | 'non-retryable' = 'non-retryable') =>
  new RuntimeExecutionFailure({ phase, category: 'infrastructure', retry, reason });
const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });

/**
 * Hermes Agent over ACP stdio (`hermes acp`). The `hermes acp` process is a
 * viewer: tools, MCP servers and the model loop run in a Hermes gateway. A
 * viewer that finds no gateway starts a detached one that outlives it, so the
 * adapter starts the gateway itself as an owned process tree, waits until the
 * gateway names that pid as ready, and only then starts the viewer. Both
 * trees are disposed at `close()`.
 */
export class HermesAdapter implements RuntimeAdapter {
  private readonly root: string;
  private readonly options: HermesAdapterOptions;
  /** Profile homes of this adapter's open sessions; the stale-profile sweep keeps them. */
  private readonly liveHomes = new Set<string>();

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({
      id: 'hermes',
      supportsDispatchSelection: false,
      // The gateway control channel is a named pipe on Windows. It has no evidence yet.
      platforms: ['darwin', 'linux'],
      capabilities: { steer: false, resume: false, approvalInteractive: false, mcpToolsets: true },
    });
  }

  constructor(options: HermesAdapterOptions) {
    if (typeof options?.home !== 'string' || !path.isAbsolute(options.home)) throw new TypeError('HermesAdapterOptions.home must be an absolute path');
    const root = path.resolve(options.home);
    const candidate = canonicalPath(root);
    const userHome = canonicalPath(path.join(os.homedir(), '.hermes'));
    if (candidate === userHome || candidate.startsWith(`${userHome}${path.sep}`)) throw new TypeError('HermesAdapterOptions.home must not be the user\'s ~/.hermes');
    if (options.model !== undefined) assertHermesModelSelection(options.model, 'HermesAdapterOptions.model');
    assertDeadline(options.probeTimeoutMs, 'Hermes probe timeout');
    assertDeadline(options.gatewayReadyTimeoutMs, 'Hermes gateway ready timeout');
    assertDeadline(options.interruptTimeoutMs, 'Hermes interrupt timeout');
    this.root = root;
    this.options = { ...options, ...(options.model === undefined ? {} : { model: Object.freeze({ ...options.model }) }) };
  }

  private command(): string {
    return (this.options.resolveBin ?? resolveHermesBin)().command;
  }

  private rootEnvironment(): Record<string, string> {
    return hermesEnvironment(buildRuntimeEnv({ ambient: process.env }), this.root);
  }

  /**
   * Prepares the SDK root, deletes profiles a dead Host left, runs
   * `hermes --version`, then one ACP `initialize` in a throwaway profile with
   * the same config and environment a turn gets. `initialize` does not reach
   * the gateway. `authPresent` is true when Hermes offers a provider auth
   * method, which it does only when that provider's credentials resolve. On a
   * new root the probe waits while Hermes builds its Python environment.
   */
  async detect(signal?: AbortSignal): Promise<RuntimeDetectResult> {
    try {
      const command = this.command();
      await ensureHermesRoot(this.root);
      await sweepStaleHermesProfiles(this.root, this.liveHomes);
      const version = await probeHermesVersion(command, this.rootEnvironment());
      if (version.kind !== 'available') return version;
      const probe = await this.probeAcp(command, signal);
      if (probe.kind !== 'available') return probe;
      return {
        kind: 'available',
        version: version.line,
        authPresent: probe.authPresent,
        ...(isQualifiedHermesVersion(version.line) ? {} : { advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: QUALIFIED_HERMES_VERSION } as const }),
      };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  private async probeAcp(command: string, signal: AbortSignal | undefined): Promise<{ kind: 'available'; authPresent: boolean } | ProbeFailure> {
    const home = await createHermesProfile(this.root, `detect-${randomBytes(6).toString('hex')}`, this.options.model);
    const child = createOwnedLineProcessSpawn({ spawnFn: this.options.spawnFn })(command, ['acp'], {
      cwd: home, env: hermesEnvironment(buildRuntimeEnv({ ambient: process.env }), home),
    });
    let timedOut = false;
    try {
      await child.spawned;
      const connection = new AcpConnection(child, {
        notification: () => {},
        request: (method) => { throw new AcpMethodNotFound(method); },
      });
      child.onExit(() => connection.close(new Error('hermes acp exited during the probe')));
      const result = await withDeadline(
        connection.request('initialize', INITIALIZE_PARAMS),
        this.options.probeTimeoutMs ?? 180_000,
        signal,
        () => { timedOut = true; return new Error('timeout'); },
      ) as { protocolVersion?: unknown; authMethods?: unknown } | null;
      if (result?.protocolVersion !== 1) return { kind: 'probe-failed' };
      const methods = Array.isArray(result.authMethods) ? result.authMethods as Array<{ id?: unknown; type?: unknown }> : [];
      return { kind: 'available', authPresent: methods.some((method) => method.type === undefined && typeof method.id === 'string' && method.id !== 'hermes-setup') };
    } catch {
      return timedOut ? { kind: 'timeout' } : { kind: 'probe-failed' };
    } finally {
      await child.dispose().catch(() => {});
      await removeHermesProfile(this.root, home).catch(() => {});
    }
  }

  /** Cheap admission, as Codex: the version probe only. The ACP probe and root build belong to `detect()`. */
  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    if (input.offer.dispatchSelection !== undefined) return { kind: 'reject', reason: 'hermes does not accept a dispatch selection; the Host configures its model', retryable: false };
    if (input.offer.sessionRef !== undefined) return { kind: 'reject', reason: 'hermes does not resume native sessions', retryable: false };
    const command = this.command();
    await ensureHermesRoot(this.root);
    const version = await probeHermesVersion(command, this.rootEnvironment());
    if (version.kind !== 'available') {
      return { kind: 'reject', reason: `hermes installation refused: ${version.kind === 'refused' ? version.reason : version.kind}`, retryable: false };
    }
    return { kind: 'prepared', operation: { start: (start) => this.start(start, command) } };
  }

  private async start(input: RuntimeOperationStartInput, command: string): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('hermes requires a resolved instruction');
    if (input.manifest.sessionRef !== undefined) throw authority('hermes does not resume native sessions');
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('hermes manifest has no sealed cwd');
    const workspace = await fs.realpath(cwd);
    const session = new HermesSession(input.scratch, this.root, this.liveHomes, this.options.interruptTimeoutMs ?? 1_000);
    try {
      const home = await createHermesProfile(this.root, input.scratch.token, this.options.model);
      session.ownHome(home);
      const env = hermesEnvironment({ ...input.env, ...input.scratch.env }, home);
      let gatewayChild: ChildProcess | undefined;
      const spawnGateway = createOwnedLineProcessSpawn({
        spawnFn: (bin, args, options) => (gatewayChild = (this.options.spawnFn ?? nodeSpawn)(bin, [...args], options)),
      });
      const gateway = spawnGateway(command, ['gateway', 'run', '--quiet', '--external-supervisor', '--force'], { cwd: home, env });
      session.ownGateway(gateway);
      await withDeadline(gateway.spawned, OPEN_REQUEST_TIMEOUT_MS, input.signal, () => infrastructure('start', 'hermes gateway did not spawn', 'retryable'));
      const gatewayPid = gatewayChild?.pid;
      if (gatewayPid === undefined) throw infrastructure('start', 'hermes gateway has no process id', 'retryable');
      await session.awaitGatewayReady(home, gatewayPid, this.options.gatewayReadyTimeoutMs ?? 20_000, input.signal);
      // A gateway that exited after ready already closed the session; a viewer started now would start its own.
      session.assertOpen();
      const viewer = createOwnedLineProcessSpawn({ spawnFn: this.options.spawnFn })(command, ['--yolo', 'acp'], { cwd: workspace, env });
      const connection = session.ownViewer(viewer);
      const open = <T>(method: string, params: Record<string, unknown>) => withDeadline(
        connection.request(method, params) as Promise<T>, OPEN_REQUEST_TIMEOUT_MS, input.signal,
        () => infrastructure('start', `hermes ${method} timed out`, 'retryable'),
      );
      await withDeadline(viewer.spawned, OPEN_REQUEST_TIMEOUT_MS, input.signal, () => infrastructure('start', 'hermes acp did not spawn', 'retryable'));
      const initialized = await open<{ protocolVersion?: unknown }>('initialize', INITIALIZE_PARAMS);
      if (initialized?.protocolVersion !== 1) throw infrastructure('start', 'hermes acp did not negotiate ACP protocol version 1');
      const opened = await open<{ sessionId?: unknown }>('session/new', {
        cwd: workspace,
        mcpServers: Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({
          name,
          command: server.command,
          args: [...(server.args ?? [])],
          env: Object.entries(server.env ?? {}).map(([variable, value]) => ({ name: variable, value })),
        })),
      });
      if (typeof opened?.sessionId !== 'string' || opened.sessionId.length === 0) throw infrastructure('start', 'hermes session/new returned no session id');
      session.ready(opened.sessionId);
      await open('session/set_mode', { sessionId: opened.sessionId, modeId: EDIT_MODE });
      // The viewer must have attached to the owned gateway, not to one it started itself.
      const attached = await identifyAfterAttach(home);
      if (attached === undefined) throw infrastructure('start', 'hermes gateway did not answer identify after attach', 'retryable');
      if (attached.pid !== gatewayPid) {
        // Only this execution uses the fresh profile, so a gateway that serves it was started for it.
        if (attached.servedHomes.includes(await fs.realpath(home))) stopProcessGroup(attached.pid);
        throw infrastructure('start', 'hermes acp attached to a gateway this session does not own');
      }
      if (input.signal?.aborted) throw infrastructure('start', 'hermes start was aborted', 'retryable');
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
        reason: error instanceof Error ? error.message : 'hermes open failed',
      });
    }
  }
}

type OwnedLineProcess = ReturnType<ReturnType<typeof createOwnedLineProcessSpawn>>;

class HermesSession implements Session {
  sessionRef = '';
  private home?: string;
  private gateway?: OwnedLineProcess;
  private viewer?: OwnedLineProcess;
  private connection?: AcpConnection;
  private readonly projection = new HermesProjection();
  private readonly queue = new AsyncQueue<AgentEvent>();
  private failure?: RuntimeExecutionFailure;
  private turn?: Promise<void>;
  private stopping = false;
  private closeAttempt?: Promise<void>;

  constructor(
    private readonly scratch: ExecutionScratch,
    private readonly root: string,
    private readonly liveHomes: Set<string>,
    private readonly interruptMs: number,
  ) {}

  ownHome(home: string): void {
    this.home = home;
    this.liveHomes.add(home);
  }

  assertOpen(): void {
    if (this.stopping) throw this.failure ?? infrastructure('start', 'hermes session closed during start');
  }

  ownGateway(gateway: OwnedLineProcess): void {
    this.gateway = gateway;
    // The gateway's stdout is a banner, not a protocol. Drain it.
    gateway.onLine(() => {});
    void gateway.exited.then(() => this.exited('gateway'), (error) => this.fail(error));
  }

  ownViewer(viewer: OwnedLineProcess): AcpConnection {
    this.viewer = viewer;
    this.connection = new AcpConnection(viewer, {
      notification: (method, params) => {
        if (method !== 'session/update' || params.sessionId !== this.sessionRef) return;
        const update = params.update;
        if (update !== null && typeof update === 'object' && !Array.isArray(update)) {
          this.projection.update(update as Record<string, unknown>, (event) => this.queue.push(event));
        }
      },
      request: (method) => {
        // Edits run in `dont_ask` mode and commands under `--yolo`. What still
        // asks is Hermes's own guard (sensitive paths). No human can answer,
        // so the guard stands: the request is cancelled, never allowed.
        if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
        throw new AcpMethodNotFound(method);
      },
    });
    void viewer.exited.then(() => this.exited('acp viewer'), (error) => this.fail(error));
    return this.connection;
  }

  /** Waits until the gateway serving `home` is the owned process and reports ready. */
  async awaitGatewayReady(home: string, pid: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
    const served = await fs.realpath(home);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.failure) throw this.failure;
      if (signal?.aborted) throw infrastructure('start', 'hermes start was aborted', 'retryable');
      const identity = await identifyHermesGateway(home);
      if (identity !== undefined) {
        if (identity.pid !== pid) throw infrastructure('start', 'another Hermes gateway serves the execution profile');
        if (identity.state === 'ready' && identity.servedHomes.includes(served)) return;
      }
      if (Date.now() >= deadline) throw infrastructure('start', 'hermes gateway did not report ready in time', 'retryable');
      await new Promise((resolve) => setTimeout(resolve, GATEWAY_POLL_MS));
    }
  }

  ready(sessionId: string): void {
    this.sessionRef = sessionId;
  }

  /** Sends one `session/prompt`. Its answer, not the send, ends the turn. */
  prompt(text: string): void {
    if (!this.connection || !this.sessionRef) throw infrastructure('run', 'hermes session is not open');
    if (this.turn) throw infrastructure('run', 'hermes turn is already active');
    const turn = this.connection.request('session/prompt', { sessionId: this.sessionRef, prompt: [{ type: 'text', text }] }).then(
      (result) => this.projection.turnEnded(result, (event) => this.queue.push(event)),
      (error) => {
        // close() rejects the pending prompt on purpose; that is not a turn failure.
        if (this.stopping) return;
        this.fail(error instanceof AcpRpcError && error.details === 'admitted_turn_failed'
          ? new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: 'hermes turn failed' })
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

  async followUp(task: TaskOfferPayload): Promise<void> {
    if (typeof task.instruction !== 'string') throw new PolicyUnsupportedError('hermes requires a string instruction');
    if (task.dispatchSelection !== undefined) throw new PolicyUnsupportedError('hermes does not accept a dispatch selection');
    this.prompt(task.instruction);
  }

  async steer(): Promise<void> {
    throw new SteerUnsupportedError('hermes', 'hermes adapter does not support mid-turn steering');
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
          timer = setTimeout(() => reject(infrastructure('run', 'hermes cancel timed out')), this.interruptMs);
        }),
      ]);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveApproval(): Promise<void> {
    throw new PolicyUnsupportedError('Hermes has no interactive approval product lane');
  }

  fail(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure('run', error instanceof Error ? error.message : 'hermes runtime failed');
    this.queue.end();
    void this.close().catch(() => {});
  }

  private exited(which: string): void {
    if (!this.stopping) this.fail(infrastructure('run', `hermes ${which} exited`));
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (!this.closeAttempt) {
      const attempt = (async () => {
        try {
          this.connection?.close(infrastructure('run', 'hermes session closed'));
          try {
            try {
              await this.viewer?.dispose();
            } finally {
              await this.gateway?.dispose();
            }
          } finally {
            if (this.home !== undefined) {
              await removeHermesProfile(this.root, this.home).catch((cause: unknown) => {
                throw new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'hermes execution profile removal did not complete' }, { cause });
              });
              this.liveHomes.delete(this.home);
            }
            await this.scratch.release();
          }
        } finally {
          this.queue.end();
        }
        this.connection = undefined;
        this.viewer = undefined;
        this.gateway = undefined;
        this.home = undefined;
      })();
      this.closeAttempt = attempt.catch((error) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }
}
