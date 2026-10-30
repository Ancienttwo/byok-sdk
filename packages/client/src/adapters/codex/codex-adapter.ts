import { withCodexMcpToolGrants } from './reserved-mcp-tool-grants';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import type { RuntimeTaskInput } from '../../types';
import { snapshotNativeInteractionHostOptions, type NativeInteractionHostOptions, type NativeInteractionChannel } from '../../native-interactions';
import { CodexNativeInteractions } from './native-interactions';
import { execFile, type spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import type {
  AgentEvent,
  TaskFailure,
} from '@byok-sdk/protocol';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeDetectResult,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type MessageDraftDelta,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';
import {
  RuntimeExecutionFailure,
  RuntimeStartupDisposalFailure,
  isRuntimeExecutionFailure,
} from '../../runtime-failure';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import {
  codexSession,
  SessionNotFoundError,
  type RawCodexSession,
} from '../../runtime/codex-session-runtime';
import { codexFailure } from '../../runtime/oar-failure-runtime';
import { CodexProjection, type CodexRecord } from './projection';
import { AsyncQueue } from '../../util/async-queue';
import { resolveCodexBin, type ResolvedBin } from './resolve-bin';
import { resolveRuntimeInvocation, runtimeInvocationHost, type RuntimeInvocation } from '../runtime-invocation';
import { CODEX_RUNTIME_CAPABILITIES } from './codex-capabilities';
import { isQualifiedCodexVersion, QUALIFIED_CODEX_VERSION } from './codex-version';
import { verifyCodexUserMcpServersExcluded, withCodexUserMcpServersExcluded } from './agent-user-mcp-servers';

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5000;
const DEFAULT_RETAINED_BYTES = 16 * 1024 * 1024;
const DEFAULT_OPERATION_MS = 30_000;
/** A Codex `sandbox_mode`, or `inherit` to pass no override so the user's `config.toml` applies. */
export type CodexSandboxSetting = 'read-only' | 'workspace-write' | 'danger-full-access' | 'inherit';
const CODEX_SANDBOX_SETTINGS: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access', 'inherit'];

/** Throws a TypeError unless `value` is a {@link CodexSandboxSetting}. */
export function assertCodexSandboxSetting(value: unknown, label: string): asserts value is CodexSandboxSetting {
  if (typeof value !== 'string' || !CODEX_SANDBOX_SETTINGS.includes(value)) {
    throw new TypeError(`${label} must be one of ${CODEX_SANDBOX_SETTINGS.join(', ')}`);
  }
}

export interface CodexAdapterOptions {
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment Codex and its MCP servers get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /**
   * Codex sandbox for every session, as OAR's `OAR_CODEX_SANDBOX`. Default
   * `danger-full-access`: no human answers an approval prompt, so a sandbox
   * denial is a stalled task. `inherit` lets the user's own `config.toml` win.
   */
  sandbox?: CodexSandboxSetting;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  interruptTimeoutMs?: number;
  /**
   * Deadline in milliseconds for the session open, each prompt and each steer.
   * Default 30000. On expiry the session fails and the app-server is killed.
   */
  operationTimeoutMs?: number;
  /** Opt-in local Host UI; independent of the remote boolean approval lane. */
  nativeInteractions?: NativeInteractionHostOptions;
  /**
   * For an Agent task (`task.offer`), `excluded` gives the Codex
   * thread only the task's and the SDK's MCP servers. Before the thread
   * opens, the adapter reads Codex's effective configuration for the task cwd
   * (`config/read`), sets `enabled = false` on every other `mcp_servers`
   * entry, and turns off the `apps` (connectors) and `plugins` features for
   * the thread. Plugin exclusion also applies at app-server launch, before
   * startup plugin sync. The thread then has no plugins at all, not only no plugin
   * MCP servers. After the open it reads the thread's MCP server status
   * back, and the start fails if any other server is not disabled, or if a
   * user server has the name of a task or SDK server. The user's
   * `AGENTS.md`, login, model, sandbox setting and other configuration still
   * apply. It covers new and resumed threads. On a resume, Codex may start a
   * queued turn before the read-back: that turn already runs with the
   * overrides, and a failed read-back stops the app server. Other tasks are
   * unchanged. Default `inherit`.
   */
  agentUserMcpServers?: 'inherit' | 'excluded';
}

/**
 * Codex reads `AGENTS.md` from its project root down to `cwd`, and finds the
 * project root by the `project_root_markers` config (default `[".git"]`).
 * When no ancestor has a marker, it reads `cwd` only. A `memory-reader` cwd is
 * `<home>/.byok/runs/<taskId>/`, so Codex would miss the persona in the home.
 * The home always holds the SDK-owned `.byok/`, so this marker makes the home
 * the project root. The run directory itself has no `.byok/`.
 */
const READER_PROJECT_ROOT_ARGS = Object.freeze(['-c', 'project_root_markers=[".byok"]']);

/** Codex app-server is experimental and has no exec compatibility path. Version policy: `codex-version.ts`. */
export class CodexAdapter implements RuntimeAdapter {
  get descriptor() { return freezeRuntimeAdapterDescriptor({
    id: 'codex',
    supportsDispatchSelection: true,
    progressEventsAreMessages: true,
    platforms: ['darwin', 'linux', 'win32'],
    mcpToolApprovals: true,
    capabilities: {
      ...CODEX_RUNTIME_CAPABILITIES,
      // Questions only: tool permission is the SDK `auto | all` decision.
      ...(this.options.nativeInteractions === undefined ? {} : { nativeInteractions: { approvalDecisions: [], structuredQuestions: true } }),
    },
  }); }
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  constructor(private readonly options: CodexAdapterOptions = {}) {
    if (options.sandbox !== undefined) assertCodexSandboxSetting(options.sandbox, 'CodexAdapterOptions.sandbox');
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'CodexAdapterOptions.runtimeEnvironment');
    if (options.agentUserMcpServers !== undefined && options.agentUserMcpServers !== 'inherit' && options.agentUserMcpServers !== 'excluded')
      throw new TypeError('CodexAdapterOptions.agentUserMcpServers must be inherit or excluded');
    this.options = { ...options, ...(options.nativeInteractions === undefined ? {} : { nativeInteractions: snapshotNativeInteractionHostOptions(options.nativeInteractions) }) };
    if (
      !Number.isSafeInteger(options.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES) ||
      (options.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES) < 1
    )
      throw new TypeError('invalid Codex retention budget');
    if (
      !Number.isFinite(options.interruptTimeoutMs ?? 1000) ||
      (options.interruptTimeoutMs ?? 1000) <= 0 ||
      (options.interruptTimeoutMs ?? 1000) > 2_147_483_647
    )
      throw new TypeError('invalid Codex interrupt timeout');
    if (
      !Number.isFinite(options.operationTimeoutMs ?? DEFAULT_OPERATION_MS) ||
      (options.operationTimeoutMs ?? DEFAULT_OPERATION_MS) <= 0 ||
      (options.operationTimeoutMs ?? DEFAULT_OPERATION_MS) > 2_147_483_647
    )
      throw new TypeError('invalid Codex operation timeout');
  }
  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }
  async detect(): Promise<RuntimeDetectResult> {
    try {
      const { env } = await this.runtimeEnvironment();
      const { command, args } = resolveRuntimeInvocation((this.options.resolveBin ?? resolveCodexBin)().command, runtimeInvocationHost(env));
      const version = await probeRuntimeVersion(command, DETECT_TIMEOUT_MS, env, args);
      if (version.kind !== 'available') return version;
      const text = version.stdout.trim() || version.stderr.trim();
      try {
        await execFileAsync(command, [...args, 'app-server', '--help'], {
          timeout: DETECT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          env,
        });
      } catch {
        return { kind: 'refused', reason: 'app_server_unavailable' };
      }
      let authPresent = false;
      try {
        await execFileAsync(command, [...args, 'login', 'status'], {
          timeout: DETECT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          env,
        });
        // Codex reports configured credentials with exit 0; its display text is not a contract.
        authPresent = true;
      } catch {}
      return {
        kind: 'available',
        version: text,
        authPresent,
        ...(!isQualifiedCodexVersion(text)
          ? { advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: QUALIFIED_CODEX_VERSION } as const }
          : {}),
      };
    } catch (error) {
      return classifyDetectError(error);
    }
  }
  async prepare(
    input: RuntimeAdapterPrepareInput,
  ): Promise<RuntimeAdapterPrepareResult> {
    let model: string | undefined;
    try {
      model = subscriptionModel(input.offer.dispatchSelection);
    } catch (error) {
      return {
        kind: 'reject',
        reason:
          error instanceof Error ? error.message : 'unsupported selection',
        retryable: false,
      };
    }
    const detected = await this.detect();
    if (detected.kind !== 'available')
      return {
        kind: 'reject',
        reason: `codex installation refused: ${detected.kind === 'refused' ? detected.reason : detected.kind}`,
        retryable: false,
      };
    let invocation: RuntimeInvocation;
    try {
      invocation = resolveRuntimeInvocation((this.options.resolveBin ?? resolveCodexBin)().command, runtimeInvocationHost((await this.runtimeEnvironment()).env));
    } catch (error) {
      return { kind: 'reject', reason: `codex installation refused: ${classifyDetectError(error).kind}`, retryable: false };
    }
    return {
      kind: 'prepared',
      operation: {
        start: (start) => this.start(start, invocation, model),
      },
    };
  }
  private async start(
    input: RuntimeOperationStartInput,
    invocation: RuntimeInvocation,
    model: string | undefined,
  ): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string')
      throw authority('codex requires a resolved instruction');
    if (subscriptionModel(input.manifest.dispatchSelection) !== model)
      throw authority(
        'prepared codex operation received a manifest with different runtime selection',
      );
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('codex manifest has no sealed cwd');
    const workspace = await fs.realpath(cwd);
    // As OAR: the servers go in the thread/start or thread/resume config.
    const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
    const taskServers = mcpServers.map(server => server.name);
    const excludeUserMcp = this.options.agentUserMcpServers === 'excluded' && input.manifest.agentRef !== undefined;
    const spawned = createOwnedLineProcessSpawn({
      nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn,
    });
    const session = new CodexSession(
      input.scratch,
      workspace,
      model,
      this.options.interruptTimeoutMs ?? 1000,
      this.options.operationTimeoutMs ?? DEFAULT_OPERATION_MS,
      this.options.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES,
      input.manifest.sessionRef === undefined,
      this.options.nativeInteractions,
      input.manifest.sessionRef,
    );
    try {
      // The open deadline covers spawn, initialize, the thread open and its read-back.
      const raw = await session.within('open', retryable, codexSession(
        (bin, args, options) => {
          const child = spawned(bin, [...invocation.args, ...args], options);
          session.own(child);
          void child.exited.then(
            () => session.exited(),
            (error) => session.fail(error),
          );
          return session.gate(child);
        },
        { kind: 'available', via: 'executable', command: invocation.command },
        {
          cwd,
          env: { ...input.env, ...input.scratch.env } as Record<string, string>,
          ...(model === undefined ? {} : { model }),
          sandboxMode: this.options.sandbox ?? 'danger-full-access',
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          launchArgs: [
            ...(input.manifest.homeAccess === 'memory-reader' ? READER_PROJECT_ROOT_ARGS : []),
            // Startup plugin sync precedes beforeOpen and the thread's feature overrides.
            ...(excludeUserMcp ? ['-c', 'features.plugins=false'] : []),
          ],
          ...(input.manifest.sessionRef === undefined
            ? {}
            : { resume: input.manifest.sessionRef }),
        },
        1000,
        {
          onReady: (id) => session.ready(id),
          beforeOpen: async (request, params) => withCodexMcpToolGrants(
            excludeUserMcp
              ? withCodexUserMcpServersExcluded(params, await request('config/read', { cwd, includeLayers: false }), taskServers)
              : params,
            taskServers,
            input.mcpToolApprovals,
          ),
          ...(excludeUserMcp ? {
            afterOpen: (request, threadId) => verifyCodexUserMcpServersExcluded(request, threadId, taskServers),
          } : {}),
          ...(this.options.nativeInteractions === undefined ? {} : { onServerRequest: session.serverRequest.bind(session) }),
          // A kernel observer: the kernel swallows its errors, so record() fails the session itself.
          onRecord: (record) => session.record(record),
        },
      ));
      session.bind(raw);
      if (
        input.manifest.sessionRef !== undefined &&
        raw.id !== input.manifest.sessionRef
      )
        throw authority('codex resume returned a different thread id');
      if (input.signal?.aborted)
        throw infrastructure('codex start was aborted');
      await session.prompt(input.instruction);
      return session;
    } catch (thrown) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), {
          cause: disposal,
        });
      }
      // A failed record stream is the cause; the open or prompt error is its consequence.
      const error = session.halted ?? thrown;
      // A resume of a missing thread cannot succeed on retry: fail closed.
      if (error instanceof SessionNotFoundError)
        throw new RuntimeExecutionFailure({
          phase: 'start',
          category: 'authority',
          retry: 'non-retryable',
          reason: error.message,
        });
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: isRuntimeExecutionFailure(error)
          ? error.category
          : 'infrastructure',
        retry: isRuntimeExecutionFailure(error) ? error.retry : 'retryable',
        reason: error instanceof Error ? error.message : 'codex open failed',
        failure: isRuntimeExecutionFailure(error)
          ? error.failure
          : { class: session.exitedOnItsOwn ? 'runtime_exited' : 'unknown' },
      });
    }
  }
}
const authority = (reason: string) =>
  new RuntimeExecutionFailure({
    phase: 'start',
    category: 'authority',
    retry: 'non-retryable',
    reason,
  });
const infrastructure = (reason: string, failure?: TaskFailure) =>
  new RuntimeExecutionFailure({
    phase: 'run',
    category: 'infrastructure',
    retry: 'non-retryable',
    reason,
    failure,
  });
/** An open that timed out may succeed on a fresh app-server, as before the deadline moved here. */
const retryable = (reason: string) =>
  new RuntimeExecutionFailure({
    phase: 'start',
    category: 'infrastructure',
    retry: 'retryable',
    reason,
  });
class CodexSession implements Session {
  sessionRef = '';
  private raw?: RawCodexSession;
  private child?: { dispose(): Promise<void>; kill(): void };
  private exit?: { readonly exitedOnItsOwn: boolean };
  private projection?: CodexProjection;
  private readonly stream = {};
  private readonly queue = new AsyncQueue<AgentEvent | MessageDraftDelta>();
  private failure?: RuntimeExecutionFailure;
  private active = false;
  private readonly interruptWaiters = new Set<() => void>();
  private stopping = false;
  private closeAttempt?: Promise<void>;
  private retainedBytes = 0;
  /** Set when the record consumer failed: no later line reaches the client, so the kernel retains no more of them. */
  halted?: RuntimeExecutionFailure;
  private readonly native?: CodexNativeInteractions;
  declare readonly interactions?: NativeInteractionChannel;
  constructor(
    private readonly scratch: ExecutionScratch,
    private readonly workspace: string,
    private readonly model: string | undefined,
    private readonly interruptMs: number,
    private readonly operationMs: number,
    private readonly maxRetainedBytes: number,
    private readonly fresh: boolean,
    interactions?: NativeInteractionHostOptions,
    private readonly expectedSessionRef?: string,
  ) {
    if (interactions) {
      this.native = new CodexNativeInteractions(() => this.sessionRef, interactions, () => this.fail(infrastructure('codex native interaction transport failed')));
      this.interactions = this.native.channel;
    }
  }
  serverRequest(id: string | number, method: string, params: Record<string, unknown>, reply: import('./native-interactions').CodexNativeReply): void {
    this.native!.receive(id, method, params, reply);
  }
  own(child: { dispose(): Promise<void>; kill(): void; readonly exitedOnItsOwn: boolean }): void {
    this.child = child;
    this.exit = child;
  }
  get exitedOnItsOwn(): boolean {
    return this.exit?.exitedOnItsOwn === true;
  }
  /** The app-server's lines stop at the transport once the record stream halted. */
  gate<T extends { onLine(handler: (line: string) => void): void }>(child: T): T {
    return {
      ...child,
      onLine: (handler: (line: string) => void) => child.onLine((line) => {
        if (this.halted === undefined) handler(line);
      }),
    };
  }
  /** Fails the session and kills the app-server when `work` outlives the operation deadline. */
  async within<T>(
    operation: string,
    failure: (reason: string) => RuntimeExecutionFailure,
    work: Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = failure(`codex ${operation} timed out after ${this.operationMs}ms`);
            this.fail(error);
            reject(error);
          }, this.operationMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  ready(id: string): void {
    if (this.expectedSessionRef !== undefined && id !== this.expectedSessionRef) throw authority('codex resume returned a different thread id');
    this.sessionRef = id;
    this.projection = new CodexProjection(this.workspace, id, this.fresh);
  }
  bind(raw: RawCodexSession): void {
    this.raw = raw;
  }
  record(record: CodexRecord): void {
    if (this.halted !== undefined) return;
    try {
      // The observer receives the redacted, retained record: measure what the kernel keeps.
      this.retainedBytes += Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (this.retainedBytes > this.maxRetainedBytes)
        throw infrastructure('codex retained record byte budget exceeded');
      const nativeFrame = record.body as { origin?: string; type?: string; native?: Record<string, unknown> };
      if (record.kind === 'frame' && nativeFrame.origin === 'byok-native' && nativeFrame.type && nativeFrame.native) this.native?.notification(nativeFrame.type, nativeFrame.native);
      this.projection?.consume(this.stream, record, (event) =>
        this.queue.push(event),
      );
      const body = record.body as {
        origin?: string;
        type?: string;
        native?: {
          threadId?: string;
          turn?: { status?: string; error?: { message?: string; codexErrorInfo?: unknown } };
        };
      };
      if (
        record.kind === 'frame' &&
        body.origin === 'byok-native' &&
        body.type === 'turn/completed' &&
        (body.native?.threadId === undefined ||
          body.native.threadId === this.sessionRef)
      ) {
        this.active = false;
        for (const resolve of this.interruptWaiters) resolve();
        if (body.native?.turn?.status === 'failed') {
          const reason = body.native.turn.error?.message ?? 'codex turn failed';
          // The native frame precedes the fold, which classifies the same `turn.error`.
          // A class OAR took from error text is not structured evidence: send `unknown`.
          const classified = codexFailure(reason, body.native.turn.error);
          this.fail(
            new RuntimeExecutionFailure({
              phase: 'run',
              category: 'semantic',
              retry: 'non-retryable',
              reason,
              failure: { class: classified.fromText ? 'unknown' : classified.failure },
            }),
          );
        }
      }
    } catch (error) {
      // After an exit the app-server made on its own, a failing record is one that exit produced
      // (its exit record, or a control it settled as exited): the exit stays the class.
      this.fail(this.exitedOnItsOwn
        ? infrastructure(error instanceof Error ? error.message : 'codex runtime failed', { class: 'runtime_exited' })
        : error);
      this.halted = this.failure;
      throw error;
    }
  }
  fail(error: unknown): void {
    this.native?.close("process-exited");
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure(
          error instanceof Error ? error.message : 'codex runtime failed',
        );
    this.flushPendingUsage();
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) {
      this.fail(infrastructure('codex app-server exited', { class: this.exitedOnItsOwn ? 'runtime_exited' : 'unknown' }));
    }
  }
  get events(): AsyncIterable<AgentEvent | MessageDraftDelta> {
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
    if (!this.raw) throw infrastructure('codex session is not open');
    if (this.active) throw infrastructure('codex turn is already active');
    this.active = true;
    this.native?.beginTurn();
    try {
      const result = await this.within('prompt', infrastructure, this.raw.prompt(input));
      if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'codex prompt refused');
    } catch (error) {
      this.active = false;
      this.native?.interrupt();
      throw error;
    }
  }
  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string')
      throw new PolicyUnsupportedError('codex requires a string instruction');
    const model = subscriptionModel(task.dispatchSelection);
    if (model !== undefined && model !== this.model)
      throw new PolicyUnsupportedError(
        'codex persistent session cannot change model',
      );
    await this.prompt(task.instruction);
  }
  async steer(text: string): Promise<void> {
    const result = this.raw === undefined ? undefined : await this.within('steer', infrastructure, this.raw.steer(text));
    if (result?.response.body.kind !== 'accepted')
      throw infrastructure(
        result?.response.body.reason ?? 'codex steer refused',
      );
  }
  async interrupt(): Promise<void> {
    this.native?.interrupt();
    if (!this.raw || !this.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurn!: () => void;
    const turnSettled = new Promise<void>(resolve => { resolveTurn = resolve; });
    this.interruptWaiters.add(resolveTurn);
    try {
      await Promise.race([
        this.raw.abort().then(async result => {
          // turn/interrupt ACK accepts the command; turn/completed carries
          // final usage/outcome. Closing at ACK discards those native frames.
          if (result.response.body.kind === 'accepted') await turnSettled;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(infrastructure('codex late interrupt timed out')),
            this.interruptMs,
          );
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
    this.native?.close();
    this.stopping = true;
    if (!this.closeAttempt) {
      const promise = Promise.resolve().then(async () => {
        try {
          try {
            await this.raw?.dispose();
          } catch (error) {
            if (!this.failure) throw error;
          } finally {
            await this.child?.dispose();
            await this.scratch.release();
          }
        } finally {
          // Stdout may contain final native frames after the interrupt ACK.
          // End the consumer only after disposal has drained that transport.
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
    const usage = this.projection?.takePendingUsage(this.stream);
    if (usage) this.queue.push(usage);
  }
}
function subscriptionModel(
  selection: RuntimeTaskInput['dispatchSelection'],
): string | undefined {
  if (!selection) return undefined;
  if (selection.lane !== 'subscription' || selection.runtimeId !== 'codex')
    throw new PolicyUnsupportedError(
      'codex cannot execute this runtime selection',
    );
  return selection.modelId;
}
