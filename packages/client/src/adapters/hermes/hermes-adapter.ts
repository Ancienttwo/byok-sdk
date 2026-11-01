import { ownHermesLauncher, prepareHermesCustody, hermesCustodyArgs, type HermesByokLauncher, type PreparedHermesCustody } from './hermes-custody';
import type { RuntimeTaskInput } from '../../types';
export type { HermesByokLauncher } from './hermes-custody';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { AgentEvent } from '@byok-sdk/protocol';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  SteerUnsupportedError,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeDetectResult,
  type RuntimeVersionPolicy,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { assertRuntimeEnvironmentPolicy, buildAllowlistedEnv, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import { classifyDetectError } from '../detect-outcome';
import type { ResolvedBin } from '../codex/resolve-bin';
import { AcpConnection, AcpMethodNotFound, AcpRpcError } from '../../runtime/acp-connection';
import { identifyHermesGateway, servesHermesHome, type HermesGatewayIdentity, type IdentifyHermesGatewayOptions } from './gateway-identity';
import { mayStopForeignHermesGateway, ownsHermesGatewayPid } from './gateway-ownership';
import {
  assertHermesModelSelection, createHermesProfile, ensureHermesRoot, removeHermesProfile, sweepStaleHermesProfiles,
} from './hermes-home';
import { HERMES_RUNTIME_CAPABILITIES } from './hermes-capabilities';
import { HERMES_VERSION_POLICY, hermesVersionLine, hermesVersionToken } from './hermes-version';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy';
import { resolveHermesBin } from './resolve-bin';
import { comparablePath } from '../../util/comparable-path';

const VERSION_TIMEOUT_MS = 5_000;
const OPEN_REQUEST_TIMEOUT_MS = 60_000;
/** Bound for the Windows process-table read before a foreign gateway is stopped; a cold read measured 3.5 s. */
const FOREIGN_GATEWAY_CHECK_MS = 10_000;
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
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment Hermes and its MCP servers get (#1095). Default: the login-shell snapshot. A `byokLauncher` narrows it further. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /**
   * Absolute path of the Hermes root that this SDK owns, for example under the
   * Host's store directory. Each execution runs in a fresh profile home below
   * it (`hermes-home.ts`). It must not be the user's Hermes home: `~/.hermes`,
   * or on Windows Hermes's default `%LOCALAPPDATA%\hermes`. Give each
   * Host process its own root. The first `detect()` on a new root waits while
   * Hermes builds its environment there.
   */
  home: string;
  /** Provider and model for every execution. Absent: Hermes picks a provider from the credentials in the environment. */
  model?: HermesModelSelection;
  /** Optional separate-process credential custody. Mutually exclusive with model; local Host profile selection never enters dispatchSelection. */
  byokLauncher?: HermesByokLauncher;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  /** Deadline of the `detect()` ACP probe. Covers a first environment build in a new root. Default 180 s. */
  probeTimeoutMs?: number;
  /** Deadline for the owned gateway to report ready. Default 20 s. */
  gatewayReadyTimeoutMs?: number;
  /** Deadline for a cancelled turn to settle before the session fails. Default 1 s. */
  interruptTimeoutMs?: number;
  /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
  /** Internal: `createDaemon` marks a `DaemonConfig.runtimes.<id>.versionPolicy` so the resolver reports its source. */
  versionPolicySource?: 'adapter-option' | 'daemon-config';
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

/** A busy gateway can miss one `identify` deadline; ask a few times before treating it as gone. */
async function identifyAfterAttach(home: string, options: IdentifyHermesGatewayOptions): Promise<HermesGatewayIdentity | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const identity = await identifyHermesGateway(home, options).catch(() => undefined);
    if (identity !== undefined) return identity;
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_POLL_MS));
  }
  return undefined;
}

/** SIGKILL to a detached Hermes gateway's own process group (it starts in a new session), else to the pid (always on Windows). */
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
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  private readonly effectiveVersionPolicy: RuntimeVersionPolicy | undefined;
  /** Profile homes of this adapter's open sessions; the stale-profile sweep keeps them. */
  private readonly liveHomes = new Set<string>();

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({
      id: 'hermes',
      supportsDispatchSelection: false,
      platforms: ['darwin', 'linux', 'win32'],
      capabilities: HERMES_RUNTIME_CAPABILITIES,
      ...(this.effectiveVersionPolicy === undefined ? {} : { versionPolicy: this.effectiveVersionPolicy }),
    });
  }

  constructor(options: HermesAdapterOptions) {
    if (typeof options?.home !== 'string' || !path.isAbsolute(options.home)) throw new TypeError('HermesAdapterOptions.home must be an absolute path');
    const root = path.resolve(options.home);
    const candidate = comparablePath(root);
    const userHomes = [path.join(os.homedir(), '.hermes'), ...(process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')] : [])];
    for (const userHome of userHomes.map(comparablePath)) {
      if (candidate === userHome || candidate.startsWith(`${userHome}${path.sep}`)) throw new TypeError('HermesAdapterOptions.home must not be the user\'s Hermes home (~/.hermes, %LOCALAPPDATA%\\hermes)');
    }
    if (options.byokLauncher !== undefined && options.model !== undefined) throw new TypeError('Hermes model and byokLauncher are mutually exclusive');
    if (options.model !== undefined) assertHermesModelSelection(options.model, 'HermesAdapterOptions.model');
    assertDeadline(options.probeTimeoutMs, 'Hermes probe timeout');
    assertDeadline(options.gatewayReadyTimeoutMs, 'Hermes gateway ready timeout');
    assertDeadline(options.interruptTimeoutMs, 'Hermes interrupt timeout');
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'HermesAdapterOptions.runtimeEnvironment');
    this.effectiveVersionPolicy = resolveRuntimeVersionPolicy({
      descriptor: HERMES_VERSION_POLICY,
      ...(options.versionPolicy === undefined ? {} : options.versionPolicySource === 'daemon-config'
        ? { daemonConfig: options.versionPolicy }
        : { adapterOption: options.versionPolicy }),
    }).policy;
    this.root = root;
    this.options = { ...options, ...(options.byokLauncher === undefined ? {} : { byokLauncher: ownHermesLauncher(options.byokLauncher) }), ...(options.model === undefined ? {} : { model: Object.freeze({ ...options.model }) }) };
  }

  private command(): string {
    return (this.options.resolveBin ?? resolveHermesBin)().command;
  }

  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }

  /** The custody launcher's lane is the platform baseline of the runtime environment. */
  private async launchEnvironment(): Promise<Record<string, string>> {
    const { env } = await this.runtimeEnvironment();
    return this.options.byokLauncher ? buildAllowlistedEnv({ ambient: env }) : env;
  }

  private async rootEnvironment(): Promise<Record<string, string>> {
    return hermesEnvironment(await this.launchEnvironment(), this.root);
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
      await sweepStaleHermesProfiles(this.root, this.liveHomes, Date.now(), this.options.nativeAssetRoot);
      const version = await probeHermesVersion(command, await this.rootEnvironment());
      if (version.kind !== 'available') return version;
      const probe = await this.probeAcp(command, signal);
      if (probe.kind !== 'available') return probe;
      return {
        kind: 'available',
        version: version.line,
        authPresent: probe.authPresent,
        ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, hermesVersionToken(version.line)),
      };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  private async probeAcp(command: string, signal: AbortSignal | undefined): Promise<{ kind: 'available'; authPresent: boolean } | ProbeFailure> {
    const launchEnv = await this.launchEnvironment();
    const home = await createHermesProfile(this.root, `detect-${randomBytes(6).toString('hex')}`, this.options.model);
    const child = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn })(command, ['acp'], {
      cwd: home, env: hermesEnvironment(launchEnv, home),
    });
    let timedOut = false;
    try {
      await child.spawned;
      const connection = new AcpConnection(child, {
        notification: () => {},
        request: (method) => { throw new AcpMethodNotFound(method); },
      }, 'Hermes');
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
    const version = await probeHermesVersion(command, await this.rootEnvironment());
    if (version.kind !== 'available') {
      return { kind: 'reject', reason: `hermes installation refused: ${version.kind === 'refused' ? version.reason : version.kind}`, retryable: false };
    }
    let custody: PreparedHermesCustody | undefined;
    if (this.options.byokLauncher) {
      if (!path.isAbsolute(command)) return { kind: 'reject', reason: 'Hermes custody requires an absolute Hermes executable', retryable: false };
      try { custody = await prepareHermesCustody(this.options.byokLauncher, input.offer); }
      catch { return { kind: 'reject', reason: 'Hermes custody admission failed', retryable: false }; }
    }
    return { kind: 'prepared', operation: { start: (start) => this.start(start, command, custody) } };
  }

  private async start(input: RuntimeOperationStartInput, command: string, custody?: PreparedHermesCustody): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('hermes requires a resolved instruction');
    if (input.manifest.sessionRef !== undefined) throw authority('hermes does not resume native sessions');
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('hermes manifest has no sealed cwd');
    const workspace = await fs.realpath(cwd);
    const { createHermesSession } = await import('#byok-hermes-session');
    const session = createHermesSession(input.scratch, this.root, this.liveHomes, this.options.interruptTimeoutMs ?? 1_000, {
      AcpConnection, AcpMethodNotFound, AcpRpcError, RuntimeExecutionFailure, RuntimeDisposalFailure,
      PolicyUnsupportedError, SteerUnsupportedError, isRuntimeExecutionFailure, infrastructure,
      identifyHermesGateway: (home, options) => identifyHermesGateway(home, { ...options, nativeAssetRoot: this.options.nativeAssetRoot }),
      servesHermesHome, ownsHermesGatewayPid, removeHermesProfile,
    });
    try {
      const home = await createHermesProfile(this.root, input.scratch.token, custody?.model ?? this.options.model);
      session.ownHome(home);
      const ambient = { ...input.env, ...input.scratch.env };
      const env = hermesEnvironment(custody ? buildAllowlistedEnv({ ambient }) : ambient, home);
      const launch = (role: 'gateway' | 'viewer', args: string[]) => custody ? {
        command: this.options.byokLauncher!.command,
        args: hermesCustodyArgs(this.options.byokLauncher!, custody.binding, { hermesBin: command, home, role }),
      } : { command, args };
      let gatewayChild: ChildProcess | undefined;
      const spawnGateway = createOwnedLineProcessSpawn({
        nativeAssetRoot: this.options.nativeAssetRoot,
        spawnFn: (bin, args, options) => (gatewayChild = (this.options.spawnFn ?? nodeSpawn)(bin, [...args], options)),
      });
      const gatewayLaunch = launch('gateway', ['gateway', 'run', '--quiet', '--external-supervisor', '--force']);
      const gateway = spawnGateway(gatewayLaunch.command, gatewayLaunch.args, { cwd: home, env });
      session.ownGateway(gateway);
      await withDeadline(gateway.spawned, OPEN_REQUEST_TIMEOUT_MS, input.signal, () => infrastructure('start', 'hermes gateway did not spawn', 'retryable'));
      // The custody launcher starts Hermes only after this byte, so Hermes never runs outside the adopted tree.
      if (custody) gateway.write('\n');
      const gatewayRoot = gatewayChild?.pid;
      if (gatewayRoot === undefined) throw infrastructure('start', 'hermes gateway has no process id', 'retryable');
      const gatewayPid = await session.awaitGatewayReady(home, gatewayRoot, this.options.gatewayReadyTimeoutMs ?? 20_000, input.signal);
      // A gateway that exited after ready already closed the session; a viewer started now would start its own.
      session.assertOpen();
      const viewerLaunch = launch('viewer', ['--yolo', 'acp']);
      let viewerChild: ChildProcess | undefined;
      const viewer = createOwnedLineProcessSpawn({
        nativeAssetRoot: this.options.nativeAssetRoot,
        spawnFn: (bin, args, options) => (viewerChild = (this.options.spawnFn ?? nodeSpawn)(bin, [...args], options)),
      })(viewerLaunch.command, viewerLaunch.args, { cwd: workspace, env });
      const connection = session.ownViewer(viewer);
      const open = <T>(method: string, params: Record<string, unknown>) => withDeadline(
        connection.request(method, params) as Promise<T>, OPEN_REQUEST_TIMEOUT_MS, input.signal,
        () => infrastructure('start', `hermes ${method} timed out`, 'retryable'),
      );
      await withDeadline(viewer.spawned, OPEN_REQUEST_TIMEOUT_MS, input.signal, () => infrastructure('start', 'hermes acp did not spawn', 'retryable'));
      if (custody) viewer.write('\n');
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
      const attached = await identifyAfterAttach(home, { owned: (pid) => pid === gatewayPid, nativeAssetRoot: this.options.nativeAssetRoot });
      if (attached === undefined) throw infrastructure('start', 'hermes gateway did not answer identify after attach', 'retryable');
      if (attached.pid !== gatewayPid || attached.state === 'mismatch') {
        if (await mayStopForeignHermesGateway(attached, await fs.realpath(home), viewerChild?.pid, AbortSignal.any([AbortSignal.timeout(FOREIGN_GATEWAY_CHECK_MS), ...(input.signal ? [input.signal] : [])]))) stopProcessGroup(attached.pid);
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
        failure: isRuntimeExecutionFailure(error) ? error.failure : { class: 'unknown' },
      });
    }
  }
}
