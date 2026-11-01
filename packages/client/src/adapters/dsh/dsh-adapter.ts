import { execFile, type spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, TaskFailure } from '@byok-sdk/protocol';
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
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import type { AcpRecord, RawAcpSession } from '../../runtime/acp-session-runtime';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import { createOwnedTerminalSpawn } from '../../runtime/owned-terminal-process';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy';
import { AsyncQueue } from '../../util/async-queue';
import { comparablePath } from '../../util/comparable-path';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable';
import type { ResolvedBin } from '../codex/resolve-bin';
import { DSH_RUNTIME_CAPABILITIES } from './dsh-capabilities';
import { assertDshModelSelection, assertDshSandboxMode, dshAgentsHome, dshEnvironment, dshPatch, dshRoute } from './dsh-profile';
import { DSH_VERSION_POLICY, dshVersionToken } from './dsh-version';
import { DshProjection, type DshTurnOutcome } from './projection';
import { resolveDshBin } from './resolve-bin';

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

/** dsh's own sandbox modes (`DSH_PERMISSION_MODE`). `danger-full-access` also sets approval to `never`; the other two ask, and every ask is cancelled. */
export type DshSandboxMode = 'danger-full-access' | 'workspace-write' | 'read-only';

const VERSION_TIMEOUT_MS = 5_000;
/** `dsh --profile acp --help` boots the launcher and, on a new root, writes the acp profile: about 1.7 s measured. */
const PROFILE_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_RETAINED_BYTES = 16 * 1024 * 1024;
const DEFAULT_INTERRUPT_MS = 1_000;
const PATCH_FILE = 'dsh.patch.yml';

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
  maxRetainedBytes?: number;
  /** Deadline for a cancelled turn to settle before the session fails. Default 1 s. */
  interruptTimeoutMs?: number;
}

const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });
const infrastructure = (reason: string, failure?: TaskFailure) =>
  new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure', retry: 'non-retryable', reason, failure });

/** The JSON-RPC error code an ACP request was answered with, as the vendored stack rethrows it. */
function rpcErrorCode(error: unknown): number | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
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

/**
 * DeepSeek Harness over ACP (`dsh --profile acp`), through the SDK's dsh
 * profile on the vendored OAR ACP stack. Each session runs one dsh process
 * in an SDK-owned `DSH_HOME`, with a per-execution `--patch` overlay that
 * names the provider route, its key variable and the model. The process
 * starts in the execution scratch directory, not the workspace, so dsh does
 * not load a workspace `.env`; the workspace is the ACP session cwd. The SDK
 * owns the process, the environment, the record budget and the permission
 * policy (requests are cancelled).
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
    const retained = options.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES;
    if (!Number.isSafeInteger(retained) || retained < 1) throw new TypeError('invalid dsh retention budget');
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
    const command = resolveRuntimeCommand(this.options.resolveBin, resolveDshBin).bin.command;
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
    const resume = input.manifest.sessionRef;
    const session = new DshSession(
      input.scratch,
      this.options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_MS,
      this.options.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES,
      resume,
    );
    // The ACP stack and its protocol SDK load only when a dsh session starts.
    const acp = await import('#byok-acp-runtime');
    let opened = false;
    try {
      // dsh compares the canonical workspace on resume.
      const workspace = await fs.realpath(cwd);
      await this.ensureRoot();
      const patch = path.join(input.scratch.sdkDir, PATCH_FILE);
      await fs.writeFile(patch, dshPatch(this.options.model), { mode: 0o600 });
      const env = dshEnvironment({ ...input.env, ...input.scratch.env }, this.root, this.sandbox);
      const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
      const spawnAgent = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'dsh acp' });
      const raw = await acp.dshSession(
        (bin, args, options) => {
          // The process runs in the scratch directory, so dsh reads no workspace `.env`; the workspace stays the ACP cwd.
          const child = spawnAgent(bin, args, { ...options, cwd: input.scratch.sdkDir });
          session.own(child);
          void child.exited.then(() => session.exited(), (error) => session.fail(error));
          return session.gate(child);
        },
        // dsh implements no client terminal (dsh `packages/acp/acp/README.md`); the stack still requires the seam.
        createOwnedTerminalSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn }),
        { kind: 'available', via: 'executable', command },
        {
          cwd: workspace,
          env,
          launchArgs: ['--patch', patch],
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          ...(resume === undefined ? {} : { resume }),
        },
        {
          onReady: (id) => session.ready(id),
          // A kernel observer: the kernel swallows its errors, so record() fails the session itself.
          onRecord: (record) => session.record(record),
        },
      );
      opened = true;
      session.bind(raw);
      // The patch is the only model authority: a session on any other route means the overlay did not apply.
      if (session.openedModel !== JSON.stringify([dshRoute(this.options.model), this.options.model.model]))
        throw authority('dsh session does not run the configured provider route and model');
      if (input.signal?.aborted) throw infrastructure('dsh start was aborted');
      await session.prompt(input.instruction);
      return session;
    } catch (thrown) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal });
      }
      // A failed record stream is the cause; the open or prompt error is its consequence.
      const error = session.halted ?? thrown;
      // dsh refuses a resume with a JSON-RPC error that names no reason in its code (an unknown session and another
      // workspace both answer -32602), so any refusal is authority. A failure without an answer is not a refusal.
      if (resume !== undefined && !opened && rpcErrorCode(error) !== undefined)
        throw authority(`dsh could not resume session ${resume}: ${error instanceof Error ? error.message : 'refused'}`);
      if (error instanceof acp.RuntimeFailureError) throw authority(error.message);
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: isRuntimeExecutionFailure(error) ? error.category : 'infrastructure',
        retry: isRuntimeExecutionFailure(error) ? error.retry : 'retryable',
        reason: error instanceof Error ? error.message : 'dsh open failed',
        failure: isRuntimeExecutionFailure(error) ? error.failure : { class: session.exitedOnItsOwn ? 'runtime_exited' : 'unknown' },
      });
    }
  }
}

class DshSession implements Session {
  sessionRef = '';
  private raw?: RawAcpSession;
  private child?: { dispose(): Promise<void>; kill(): void };
  private exit?: { readonly exitedOnItsOwn: boolean };
  private projection?: DshProjection;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private failure?: RuntimeExecutionFailure;
  private active = false;
  private readonly interruptWaiters = new Set<() => void>();
  private stopping = false;
  private closeAttempt?: Promise<void>;
  private retainedBytes = 0;
  /** Set when the record consumer failed: no later line reaches the ACP stream, so the kernel retains no more of them. */
  halted?: RuntimeExecutionFailure;

  constructor(
    private readonly scratch: ExecutionScratch,
    private readonly interruptMs: number,
    private readonly maxRetainedBytes: number,
    private readonly expectedSessionRef?: string,
  ) {}

  own(child: { dispose(): Promise<void>; kill(): void; readonly exitedOnItsOwn: boolean }): void {
    this.child = child;
    this.exit = child;
  }
  get exitedOnItsOwn(): boolean {
    return this.exit?.exitedOnItsOwn === true;
  }
  get openedModel(): string | undefined {
    return this.projection?.openedModel;
  }
  /** The agent's lines stop at the transport once the record stream halted. */
  gate<T extends { onLine(handler: (line: string) => void): void }>(child: T): T {
    return {
      ...child,
      onLine: (handler: (line: string) => void) => child.onLine((line) => {
        if (this.halted === undefined) handler(line);
      }),
    };
  }
  ready(id: string): void {
    if (this.expectedSessionRef !== undefined && id !== this.expectedSessionRef) throw authority('dsh resume returned a different session id');
    this.sessionRef = id;
    this.projection = new DshProjection(id);
  }
  bind(raw: RawAcpSession): void {
    this.raw = raw;
  }
  record(record: AcpRecord): void {
    if (this.halted !== undefined) return;
    try {
      // The observer receives the redacted, retained record: measure what the kernel keeps.
      this.retainedBytes += Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (this.retainedBytes > this.maxRetainedBytes) throw infrastructure('dsh retained record byte budget exceeded');
      this.projection?.consume(record, (event) => this.queue.push(event), (turn) => this.turnEnded(turn));
    } catch (error) {
      this.fail(error);
      this.halted = this.failure;
      throw error;
    }
  }
  private turnEnded(turn: DshTurnOutcome): void {
    this.active = false;
    for (const resolve of this.interruptWaiters) resolve();
    if (turn.kind === 'failed')
      this.fail(new RuntimeExecutionFailure({
        phase: 'run',
        category: 'semantic',
        // dsh fails a turn with text only; a class OAR took from that text is not structured evidence (#1258 O6),
        // so it neither names the class nor makes the failure retryable.
        retry: !turn.fromText && turn.failure === 'rate_limited' ? 'retryable' : 'non-retryable',
        reason: turn.reason,
        failure: { class: turn.fromText ? 'unknown' : turn.failure },
      }));
  }
  fail(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure(error instanceof Error ? error.message : 'dsh runtime failed');
    this.flushPendingUsage();
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) this.fail(infrastructure('dsh acp exited', { class: this.exitedOnItsOwn ? 'runtime_exited' : 'unknown' }));
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
  async prompt(input: string): Promise<void> {
    if (!this.raw) throw infrastructure('dsh session is not open');
    if (this.active) throw infrastructure('dsh turn is already active');
    this.active = true;
    try {
      const result = await this.raw.prompt(input);
      if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'dsh prompt refused');
    } catch (error) {
      this.active = false;
      throw error;
    }
  }
  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string') throw new PolicyUnsupportedError('dsh requires a string instruction');
    if (task.dispatchSelection !== undefined) throw new PolicyUnsupportedError('dsh persistent session runs the Host-configured model and takes no dispatch selection');
    await this.prompt(task.instruction);
  }
  async steer(): Promise<void> {
    throw new SteerUnsupportedError('dsh', 'dsh ACP has no steer');
  }
  async interrupt(): Promise<void> {
    if (!this.raw || !this.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurn!: () => void;
    const turnSettled = new Promise<void>(resolve => { resolveTurn = resolve; });
    this.interruptWaiters.add(resolveTurn);
    try {
      await Promise.race([
        // session/cancel is a notification; the cancelled prompt answer carries the outcome.
        this.raw.abort().then(async result => { if (result.response.body.kind === 'accepted') await turnSettled; }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(infrastructure('dsh interrupt timed out')), this.interruptMs);
        }),
      ]);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
      this.interruptWaiters.delete(resolveTurn);
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    if (!this.closeAttempt) {
      const promise = Promise.resolve().then(async () => {
        try {
          try {
            // OAR sends session/close, which dsh advertises, before it releases the process.
            await this.raw?.dispose();
          } catch (error) {
            if (!this.failure || isRuntimeDisposalFailure(error)) throw error;
          } finally {
            await this.child?.dispose();
            await this.scratch.release();
          }
        } finally {
          // The cancelled prompt answer can follow the cancel; end the consumer only after disposal drained stdout.
          this.flushPendingUsage();
          this.queue.end();
        }
        this.raw = undefined;
        this.projection = undefined;
        this.child = undefined;
      });
      this.closeAttempt = promise.catch((error) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }
  private flushPendingUsage(): void {
    const usage = this.projection?.takePendingUsage();
    if (usage) this.queue.push(usage);
  }
}
