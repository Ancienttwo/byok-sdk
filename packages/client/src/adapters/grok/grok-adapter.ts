import { execFile, spawn, type spawn as nodeSpawn } from 'node:child_process';
import type { RuntimeTaskInput } from '../../types';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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
  type MessageDraftDelta,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeDisposalFailure, isRuntimeExecutionFailure, runtimeFailureClassOf } from '../../runtime-failure';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import { createOwnedTerminalSpawn } from '../../runtime/owned-terminal-process';
import type { AcpRecord, RawAcpSession } from '../../runtime/acp-session-runtime';
import { AsyncQueue } from '../../util/async-queue';
import type { ResolvedBin } from '../codex/resolve-bin';
import { grokAgentPersona } from './agent-persona';
import { GROK_USER_MCP_SERVERS_OFF, grokUserMcpServersRefusal } from './agent-user-mcp-servers';
import { GrokProjection, type GrokTurnOutcome } from './projection';
import { resolveGrokBin } from './resolve-bin';
import { GROK_RUNTIME_CAPABILITIES } from './grok-capabilities';
import { isQualifiedGrokVersion, QUALIFIED_GROK_VERSION } from './grok-version';

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5000;
const DEFAULT_RETAINED_BYTES = 16 * 1024 * 1024;
const DEFAULT_INTERRUPT_MS = 1000;
/** Grok's per-process switches for the Claude and Cursor `agents` and `rules` compatibility cells. */
const COMPAT_INSTRUCTIONS_OFF = Object.freeze({
  GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0',
  GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_RULES_ENABLED: '0',
});

export interface GrokAdapterOptions {
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment Grok and its MCP servers get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** Grok model id for every session (`session/set_model`). Absent: the user's Grok default. */
  model?: string;
  /**
   * `disabled` sets Grok's four Claude and Cursor `agents` and `rules`
   * variables to `0` on the Grok agent process. That turns off its scanning of
   * the named instruction files and rules directories under `~/.claude/` and
   * `~/.cursor/`, and the project `.claude/CLAUDE*.md`, `.claude/rules/` and
   * `.cursor/rules/`. Client-hosted terminal commands do not get the variables;
   * children that Grok starts itself, such as stdio MCP servers and hooks, may
   * inherit them. `$GROK_HOME/AGENTS.md`, `$GROK_HOME/rules/` and
   * `[paths] extra_rule_dirs` still load; Grok has no per-process switch for
   * them. Default `inherit`: the user's Grok settings apply.
   */
  compatInstructions?: 'inherit' | 'disabled';
  /**
   * For an Agent task (`task.offer`), `excluded` sets
   * `GROK_CLAUDE_MCPS_ENABLED`, `GROK_CURSOR_MCPS_ENABLED` and
   * `GROK_MANAGED_MCPS_ENABLED` to `0` on the Grok agent process, then runs
   * `grok inspect --json` in the task cwd with the same environment. The
   * start fails before the agent starts if inspect lists an MCP server that
   * is not disabled, or an enabled plugin that provides MCP servers, or if
   * inspect fails. Grok has no per-process switch for the servers of
   * `~/.grok/config.toml`, project `.grok/config.toml` and `.mcp.json`, or
   * plugins, so a user who has one enabled cannot run Agent tasks with this
   * option. Two sources are not detected: a server turned on while the
   * session runs (a config hot-reload, `/mcps` or `grok mcp enable`), and
   * managed MCP that an administrator pins on. Other tasks are unchanged.
   * Default `inherit`.
   */
  agentUserMcpServers?: 'inherit' | 'excluded';
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  interruptTimeoutMs?: number;
}

/**
 * Grok Build over ACP (`grok agent --always-approve --no-leader stdio`),
 * through the vendored OAR Grok profile. The SDK owns the agent process,
 * every terminal command Grok asks the client to run, the environment, the
 * record budget and the permission policy (requests are cancelled).
 *
 * `grok` is not a frozen wire runtime id, so a task reaches this adapter by
 * the custom-harness identity (`harnessId: 'grok'`). It takes no dispatch
 * selection; the model is the adapter's `model` option.
 */
export class GrokAdapter implements RuntimeAdapter {
  get descriptor() { return freezeRuntimeAdapterDescriptor({
    id: 'grok',
    supportsDispatchSelection: false,
    // Windows has no Grok evidence (`docs/adapter-capabilities.md`).
    platforms: ['darwin', 'linux'],
    capabilities: GROK_RUNTIME_CAPABILITIES,
  }); }

  private readonly environmentPolicy: RuntimeEnvironmentPolicy;

  constructor(private readonly options: GrokAdapterOptions = {}) {
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'GrokAdapterOptions.runtimeEnvironment');
    const retained = options.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES;
    if (!Number.isSafeInteger(retained) || retained < 1) throw new TypeError('invalid Grok retention budget');
    const interrupt = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_MS;
    if (!Number.isFinite(interrupt) || interrupt <= 0 || interrupt > 2_147_483_647) throw new TypeError('invalid Grok interrupt timeout');
    if (options.model !== undefined && options.model.trim() === '') throw new TypeError('GrokAdapterOptions.model must not be blank');
    if (options.compatInstructions !== undefined && options.compatInstructions !== 'inherit' && options.compatInstructions !== 'disabled')
      throw new TypeError('GrokAdapterOptions.compatInstructions must be inherit or disabled');
    if (options.agentUserMcpServers !== undefined && options.agentUserMcpServers !== 'inherit' && options.agentUserMcpServers !== 'excluded')
      throw new TypeError('GrokAdapterOptions.agentUserMcpServers must be inherit or excluded');
    this.options = { ...options };
  }

  runtimeEnvironment(): Promise<Record<string, string>> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }

  /** Reads the version, probes ACP mode and looks for a login signal. It never opens a session or writes Grok's home. */
  async detect(): Promise<RuntimeDetectResult> {
    try {
      const env = await this.runtimeEnvironment();
      const command = (this.options.resolveBin ?? resolveGrokBin)().command;
      const version = await probeRuntimeVersion(command, DETECT_TIMEOUT_MS, env);
      if (version.kind !== 'available') return version;
      const text = version.stdout.trim() || version.stderr.trim();
      try {
        await execFileAsync(command, ['agent', 'stdio', '--help'], {
          timeout: DETECT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          env,
        });
      } catch {
        return { kind: 'refused', reason: 'acp_unavailable' };
      }
      return {
        kind: 'available',
        version: text,
        authPresent: grokAuthPresent(env),
        ...(!isQualifiedGrokVersion(text)
          ? { advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: QUALIFIED_GROK_VERSION } as const }
          : {}),
      };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    if (input.offer.dispatchSelection !== undefined)
      return { kind: 'reject', reason: 'grok cannot execute a dispatch selection', retryable: false };
    const detected = await this.detect();
    if (detected.kind !== 'available')
      return {
        kind: 'reject',
        reason: `grok installation refused: ${detected.kind === 'refused' ? detected.reason : detected.kind}`,
        retryable: false,
      };
    const command = (this.options.resolveBin ?? resolveGrokBin)().command;
    return { kind: 'prepared', operation: { start: (start) => this.start(start, command) } };
  }

  private async start(input: RuntimeOperationStartInput, command: string): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string')
      throw authority('grok requires a resolved instruction');
    if (input.manifest.dispatchSelection !== undefined)
      throw authority('prepared grok operation received a manifest with a dispatch selection');
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('grok manifest has no sealed cwd');
    const persona = await grokAgentPersona(input.manifest);
    const env = { ...input.env, ...input.scratch.env } as Record<string, string>;
    const excludeUserMcp = this.options.agentUserMcpServers === 'excluded' && input.manifest.agentRef !== undefined;
    // Set on the agent; its own children may inherit them. Hosted terminal commands keep the task env.
    const agentEnv = {
      ...(this.options.compatInstructions === 'disabled' ? COMPAT_INSTRUCTIONS_OFF : {}),
      ...(excludeUserMcp ? GROK_USER_MCP_SERVERS_OFF : {}),
    };
    if (excludeUserMcp) {
      const refusal = await grokUserMcpServersRefusal(this.options.spawnFn ?? spawn, command, cwd, { ...env, ...agentEnv });
      if (refusal !== undefined) throw authority(refusal);
    }
    // As OAR: the servers go in the ACP mcpServers of session/new or session/resume.
    const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
    const spawnAgent = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'grok agent' });
    const spawnTerminal = createOwnedTerminalSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn });
    // The ACP stack and its protocol SDK load only when a Grok session starts.
    const acp = await import('#byok-acp-runtime');
    const session = new GrokSession(
      input.scratch,
      this.options.model,
      this.options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_MS,
      this.options.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES,
      input.manifest.sessionRef,
    );
    try {
      const raw = await acp.grokSession(
        (bin, args, options) => {
          const child = spawnAgent(bin, args, { ...options, env: { ...options.env, ...agentEnv } });
          session.own(child);
          void child.exited.then(() => session.exited(), (error) => session.fail(error));
          return session.gate(child);
        },
        spawnTerminal,
        { kind: 'available', via: 'executable', command },
        {
          cwd,
          ...(persona === undefined ? {} : { appendSystemPrompt: persona }),
          env,
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          ...(input.manifest.sessionRef === undefined ? {} : { resume: input.manifest.sessionRef }),
        },
        {
          onReady: (id) => session.ready(id),
          // A kernel observer: the kernel swallows its errors, so record() fails the session itself.
          onRecord: (record) => session.record(record),
        },
      );
      session.bind(raw);
      if (input.signal?.aborted) throw infrastructure('grok start was aborted');
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
      // A missing session, a refused login or a refused model cannot succeed on retry: fail closed.
      if (error instanceof acp.SessionNotFoundError)
        throw new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason: error.message });
      if (error instanceof acp.RuntimeFailureError)
        throw new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason: error.message,
          failure: { class: runtimeFailureClassOf(error.failure) } });
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: isRuntimeExecutionFailure(error) ? error.category : 'infrastructure',
        retry: isRuntimeExecutionFailure(error) ? error.retry : 'retryable',
        reason: error instanceof Error ? error.message : 'grok open failed',
        failure: isRuntimeExecutionFailure(error) ? error.failure : { class: session.exitedOnItsOwn ? 'runtime_exited' : 'unknown' },
      });
    }
  }
}

/** Grok's own login file, or an API key in the runtime env. Existence only; the file is never read. */
function grokAuthPresent(env: NodeJS.ProcessEnv): boolean {
  if (env.XAI_API_KEY) return true;
  const home = env.GROK_HOME || path.join(homedir(), '.grok');
  return existsSync(path.join(home, 'auth.json'));
}

const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });
const infrastructure = (reason: string, failure?: TaskFailure) =>
  new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure', retry: 'non-retryable', reason, failure });

class GrokSession implements Session {
  sessionRef = '';
  private raw?: RawAcpSession;
  private child?: { dispose(): Promise<void>; kill(): void };
  private exit?: { readonly exitedOnItsOwn: boolean };
  private projection?: GrokProjection;
  private readonly queue = new AsyncQueue<AgentEvent | MessageDraftDelta>();
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
    private readonly model: string | undefined,
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
    if (this.expectedSessionRef !== undefined && id !== this.expectedSessionRef) throw authority('grok resume returned a different session id');
    this.sessionRef = id;
    this.projection = new GrokProjection(id);
  }
  bind(raw: RawAcpSession): void {
    this.raw = raw;
  }
  record(record: AcpRecord): void {
    if (this.halted !== undefined) return;
    try {
      // The observer receives the redacted, retained record: measure what the kernel keeps.
      this.retainedBytes += Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (this.retainedBytes > this.maxRetainedBytes)
        throw infrastructure('grok retained record byte budget exceeded');
      this.projection?.consume(record, (event) => this.queue.push(event), (turn) => this.turnEnded(turn));
    } catch (error) {
      this.fail(error);
      this.halted = this.failure;
      throw error;
    }
  }
  private turnEnded(turn: GrokTurnOutcome): void {
    this.active = false;
    for (const resolve of this.interruptWaiters) resolve();
    if (turn.kind === 'failed')
      this.fail(new RuntimeExecutionFailure({
        phase: 'run',
        category: 'semantic',
        retry: turn.failure === 'rate_limited' ? 'retryable' : 'non-retryable',
        reason: turn.reason,
        // A class OAR took from error text is not structured evidence (docs/spec.md runtime failure class).
        failure: { class: turn.fromText ? 'unknown' : turn.failure },
      }));
  }
  fail(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure(error instanceof Error ? error.message : 'grok runtime failed');
    this.flushPendingUsage();
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) {
      this.fail(infrastructure('grok agent exited', { class: this.exitedOnItsOwn ? 'runtime_exited' : 'unknown' }));
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
    if (!this.raw) throw infrastructure('grok session is not open');
    if (this.active) throw infrastructure('grok turn is already active');
    this.active = true;
    try {
      const result = await this.raw.prompt(input);
      if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'grok prompt refused');
    } catch (error) {
      this.active = false;
      throw error;
    }
  }
  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string') throw new PolicyUnsupportedError('grok requires a string instruction');
    if (task.dispatchSelection !== undefined) throw new PolicyUnsupportedError(`grok persistent session runs ${this.model ?? 'the default model'} and takes no dispatch selection`);
    await this.prompt(task.instruction);
  }
  async steer(): Promise<void> {
    // Grok's `_meta.sendNow` cancels the running prompt and re-runs its tool calls: not an injection.
    throw new SteerUnsupportedError('grok', 'grok cannot inject into an active turn');
  }
  async interrupt(): Promise<void> {
    if (!this.raw || !this.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurn!: () => void;
    const turnSettled = new Promise<void>(resolve => { resolveTurn = resolve; });
    this.interruptWaiters.add(resolveTurn);
    try {
      await Promise.race([
        // session/cancel is a notification; the cancelled prompt answer carries the final usage and outcome.
        this.raw.abort().then(async result => { if (result.response.body.kind === 'accepted') await turnSettled; }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(infrastructure('grok interrupt timed out')), this.interruptMs);
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
            await this.raw?.dispose();
          } catch (error) {
            // A failed reap of Grok's terminal trees is always reported: a later close retries it.
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
