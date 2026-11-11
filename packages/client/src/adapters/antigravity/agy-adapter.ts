import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits';
import type { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { oarStartClassifier, runtimeStartFailure } from '../runtime-start-failure';
import type { AgentEvent, TaskFailure } from '@byok-sdk/protocol';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import type { McpEventIdentities } from '../../mcp/event-identity';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeDetectResult,
  type RuntimeOperationManifest,
  type RuntimeOperationStartInput,
  type RuntimeTaskInput,
  type RuntimeVersionPolicy,
  type Session,
} from '../../types';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import type { AcpPermissionRequest, AcpPermissionResponse, AcpRecord, RawAcpSession } from '../../runtime/acp-session-runtime';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import { createOwnedTerminalSpawn } from '../../runtime/owned-terminal-process';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy';
import { AsyncQueue } from '../../util/async-queue';
import { RetainedRecordBudget, haltGate, SettleWaiters, raceDeadline, oarCancelSettled, RetryableOnce } from '../session-kit';
import { comparablePath } from '../../util/comparable-path';
import { agentPersona } from '../agent-persona';
import { agyEndpointOf } from './agy-endpoint';
import { startAgyGeminiProxy, type AgyGeminiProxy } from './agy-gemini-proxy';
import { agyPermissionDecision, type AgyReaderScope } from './permissions';
import { acquireAgySessionRetention, brandAgySessionStore } from '../../util/agy-session-retention';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable';
import type { ResolvedBin } from '../codex/resolve-bin';
import { AGY_RUNTIME_CAPABILITIES } from './agy-capabilities';
import { agyEnvironment, agyNativeHome, agyStoreDir, ensureAgyHome } from './agy-profile';
import { AGY_VERSION_POLICY, agyHasNativeAcp, agyVersionToken } from './agy-version';
import { AgyProjection, agyMcpEventIdentities, type AgyTurnOutcome } from './projection';
import { resolveAgyBin } from './resolve-bin';

/** Upstream's bound: the CLI can read its update state before it prints the version. */
const VERSION_TIMEOUT_MS = 30_000;

export interface AgyAdapterOptions {
  /**
   * Absolute path of the OS home (`HOME`, `USERPROFILE`) this SDK owns for the
   * agy process and every tool it starts. It must persist across executions:
   * agy keeps its conversations below it, and resume reads them back. It must
   * not be the user's home or anything under the user's `~/.gemini`.
   */
  home: string;
  /** Model id for every session, set again on each resume. Absent: the CLI default. */
  model?: string;
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment agy and its tools get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  /** Deadline for a cancelled turn to settle before the session fails. Default 1 s. */
  interruptTimeoutMs?: number;
}

const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason });
const infrastructure = (reason: string, failure?: TaskFailure) =>
  new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason, failure });

/**
 * The Antigravity CLI over its native ACP
 * (`agy acp --dangerously-skip-permissions --process-per-session`), through
 * the vendored OAR Antigravity profile. The SDK owns the process, the OS home
 * it runs in, the record budget and the permission policy.
 *
 * `agy` is not a frozen wire runtime id, so a task reaches this adapter by the
 * custom-harness identity (`harnessId: 'agy'`).
 */
export class AgyAdapter implements RuntimeAdapter {
  private readonly root: string;
  private readonly options: AgyAdapterOptions;
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;
  private readonly effectiveVersionPolicy: RuntimeVersionPolicy | undefined;
  private readonly interruptTimeoutMs: number;
  private readonly maxRetainedBytes: number;

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({
      id: 'agy',
      supportsDispatchSelection: false,
      requiresMcpToolsetToolObservation: true,
      platforms: ['darwin', 'linux', 'win32'],
      capabilities: AGY_RUNTIME_CAPABILITIES,
      ...(this.effectiveVersionPolicy === undefined ? {} : { versionPolicy: this.effectiveVersionPolicy }),
    });
  }

  constructor(options: AgyAdapterOptions) {
    if (typeof options?.home !== 'string' || !path.isAbsolute(options.home)) throw new TypeError('AgyAdapterOptions.home must be an absolute path');
    const root = path.resolve(options.home);
    const candidate = comparablePath(root);
    const userNative = comparablePath(agyNativeHome(os.homedir()));
    if (candidate === comparablePath(os.homedir()) || candidate === userNative || candidate.startsWith(`${userNative}${path.sep}`))
      throw new TypeError('AgyAdapterOptions.home must not be the user\'s home or ~/.gemini');
    if (options.model !== undefined && options.model.trim() === '') throw new TypeError('AgyAdapterOptions.model must not be blank');
    this.maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'agy');
    this.interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs, 'agy');
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'AgyAdapterOptions.runtimeEnvironment');
    this.effectiveVersionPolicy = resolveRuntimeVersionPolicy(AGY_VERSION_POLICY, options.versionPolicy);
    this.root = root;
    this.options = { ...options };
    brandAgySessionStore(this, agyStoreDir(root));
  }

  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }

  /** Reads the version. `authPresent` is whether the runtime environment carries `GEMINI_API_KEY`; the key is not checked against the provider. */
  async detect(): Promise<RuntimeDetectResult> {
    try {
      const { env: base } = await this.runtimeEnvironment();
      const resolved = resolveRuntimeCommand(this.options.resolveBin, () => resolveAgyBin(base));
      const command = resolved.bin.command;
      await ensureAgyHome(this.root);
      const version = await probeRuntimeVersion(command, VERSION_TIMEOUT_MS, agyEnvironment(base, this.root));
      if (version.kind !== 'available') return version;
      const token = agyVersionToken(version.stdout);
      if (!agyHasNativeAcp(token)) return { kind: 'refused', reason: 'acp_unavailable' };
      return {
        kind: 'available',
        version: token,
        authPresent: Boolean(base.GEMINI_API_KEY),
        ...runtimeExecutableFields(resolved, command),
        ...runtimeVersionDetectionFields(this.effectiveVersionPolicy, token),
      };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const detected = await this.detect();
    if (detected.kind !== 'available') {
      return { kind: 'reject', reason: `agy installation refused: ${detected.kind === 'refused' ? detected.reason : detected.kind}`, retryable: false };
    }
    const { env: base } = await this.runtimeEnvironment();
    const command = resolveRuntimeCommand(this.options.resolveBin, () => resolveAgyBin(base)).bin.command;
    return { kind: 'prepared', operation: {
      acquireSessionLease: (sessionRef) => acquireAgySessionRetention(agyStoreDir(this.root), sessionRef),
      start: (start) => this.start(start, command),
    } };
  }

  private async start(input: RuntimeOperationStartInput, command: string): Promise<Session> {
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string') throw authority('agy requires a resolved instruction');
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('agy manifest has no sealed cwd');
    const apiKey = input.env.GEMINI_API_KEY;
    if (!apiKey) throw authority('agy requires GEMINI_API_KEY in its runtime environment');
    const resume = input.manifest.sessionRef;
    // A writer runs in the Agent home, where agy reads AGENTS.md itself. A reader runs in `.byok/runs/<task>`, which agy
    // only walks up from when the home has `.git`, and that reader sees the persona twice; there is no root-marker option.
    // agy replaces its append on every resume and drops it when omitted, so the reader's persona goes in every open.
    const persona = input.manifest.homeAccess === 'memory-reader'
      ? await agentPersona('agy', input.manifest, { reappliesOnResume: true })
      : undefined;
    const reader = readerScope(input.manifest);
    const session = new AgySession(
      input.scratch,
      this.options.model,
      this.interruptTimeoutMs,
      this.maxRetainedBytes,
      agyMcpEventIdentities(input.mcpToolsetTools),
      resume,
      reader,
    );
    // The ACP stack and its protocol SDK load only when an agy session starts.
    const acp = await import('#byok-acp-runtime');
    try {
      await ensureAgyHome(this.root);
      const proxy = await startAgyGeminiProxy({ apiKey, environment: input.env, upstreamOrigin: agyEndpointOf(this) });
      session.useProxy(proxy);
      const env = agyEnvironment({ ...input.env, ...input.scratch.env }, this.root, proxy);
      const mcpServers = Object.entries(input.mcpServers ?? {}).map(([name, server]) => ({ name, ...server }));
      const spawnAgent = createOwnedLineProcessSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn, label: 'agy acp' });
      const raw = await acp.antigravitySession(
        (bin, args, options) => {
          const child = spawnAgent(bin, args, options);
          session.own(child);
          void child.exited.then(() => session.exited(), (error) => session.fail(error));
          return haltGate(child, () => session.halted !== undefined);
        },
        // agy runs its own commands and never asks for a client terminal; the stack still requires the seam.
        createOwnedTerminalSpawn({ nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn }),
        { kind: 'available', via: 'executable', command },
        {
          cwd,
          env,
          // Without it agy reports to play.googleapis.com, the one host beside the model endpoint it contacts.
          launchArgs: ['--disable-telemetry'],
          ...(persona === undefined ? {} : { appendSystemPrompt: persona }),
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          ...(resume === undefined ? {} : { resume }),
        },
        {
          onReady: (id) => session.ready(id),
          // A kernel observer: the kernel swallows its errors, so record() fails the session itself.
          onRecord: (record) => session.record(record),
          onPermission: (request) => session.permission(request),
        },
      );
      session.bind(raw);
      if (input.signal?.aborted) throw infrastructure('agy start was aborted');
      await session.prompt(input.instruction);
      return session;
    } catch (thrown) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal });
      }
      throw runtimeStartFailure(session.halted ?? thrown, { classify: oarStartClassifier(acp), exitedOnItsOwn: session.exitedOnItsOwn, runtime: 'agy' });
    }
  }
}

function readerScope(manifest: RuntimeOperationManifest): AgyReaderScope | undefined {
  if (manifest.homeAccess !== 'memory-reader') return undefined;
  const home = manifest.lease?.canonicalHome;
  if (!home || !manifest.cwd) throw authority('agy reader requires a sealed home and run directory');
  return { home, run: manifest.cwd };
}

class AgySession implements Session {
  sessionRef = '';
  private raw?: RawAcpSession;
  private child?: { dispose(): Promise<void>; kill(): void; observeDescendants(): void };
  private proxy?: AgyGeminiProxy;
  private exit?: { readonly exitedOnItsOwn: boolean };
  private stopAttempt?: Promise<void>;
  /** The refused permission no model output has followed yet: agy ends the turn on it, and that is no success. */
  private refused?: { readonly toolCallId: string; readonly reason: string };
  private projection?: AgyProjection;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private failure?: RuntimeExecutionFailure;
  private active = false;
  private readonly turnWaiters = new SettleWaiters();
  private stopping = false;
  private readonly closeOnce = new RetryableOnce();
  private readonly recordBudget: RetainedRecordBudget;
  /** Set when the record consumer failed: no later line reaches the ACP stream, so the kernel retains no more of them. */
  halted?: RuntimeExecutionFailure;

  constructor(
    private readonly scratch: ExecutionScratch,
    private readonly model: string | undefined,
    private readonly interruptMs: number,
    maxRetainedBytes: number,
    private readonly identities: McpEventIdentities,
    private readonly expectedSessionRef?: string,
    private readonly reader?: AgyReaderScope,
  ) { this.recordBudget = new RetainedRecordBudget(maxRetainedBytes, 'agy'); }

  useProxy(proxy: AgyGeminiProxy): void {
    this.proxy = proxy;
  }
  own(child: { dispose(): Promise<void>; kill(): void; observeDescendants(): void; readonly exitedOnItsOwn: boolean }): void {
    this.child = child;
    this.exit = child;
  }
  get exitedOnItsOwn(): boolean {
    return this.exit?.exitedOnItsOwn === true;
  }
  ready(id: string): void {
    if (this.expectedSessionRef !== undefined && id !== this.expectedSessionRef) throw authority('agy resume returned a different session id');
    this.sessionRef = id;
    this.projection = new AgyProjection(id, this.identities);
  }
  bind(raw: RawAcpSession): void {
    this.raw = raw;
  }
  record(record: AcpRecord): void {
    if (this.halted !== undefined) return;
    try {
      // The observer receives the redacted, retained record: measure what the kernel keeps.
      this.recordBudget.add(record);
      this.projection?.consume(record, (event) => this.emit(event), (turn) => this.turnEnded(turn));
    } catch (error) {
      this.fail(error);
      this.halted = this.failure;
      throw error;
    }
  }
  permission(request: AcpPermissionRequest): AcpPermissionResponse {
    const decision = agyPermissionDecision(request, this.reader);
    const option = request.options.find(candidate => candidate.kind === decision);
    const { toolCallId } = request.toolCall;
    if (option === undefined) {
      const reason = `agy offered no ${decision} option`;
      this.refused = { toolCallId, reason };
      throw new Error(reason);
    }
    if (decision === 'reject_once') this.refused = { toolCallId, reason: 'agy ended the turn on a refused write below the Agent home' };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
  private emit(event: AgentEvent): void {
    if (event.type === 'progress' || (event.type === 'tool_use' && event.toolCallId !== this.refused?.toolCallId)) this.refused = undefined;
    this.queue.push(event);
  }
  /**
   * agy's subagents and schedules
   * run in the background and report no ACP frame, so nothing of agy's may
   * outlive the turn: the tree goes before the terminal is decided and before
   * the home lease is released. Resume reads what agy already persisted.
   */
  private turnEnded(turn: AgyTurnOutcome): void {
    this.active = false;
    const refused = this.refused;
    void this.stopRuntime().then(() => {
      if (turn.kind === 'failed') {
        this.fail(new RuntimeExecutionFailure({
          phase: 'run',
          retry: !turn.fromText && turn.failure === 'rate_limited' ? 'retryable' : 'non-retryable',
          reason: turn.reason,
          // A class OAR took from error text is not structured evidence (docs/spec.md runtime failure class).
          failure: { class: turn.fromText ? 'unknown' : turn.failure },
        }));
      } else if (turn.kind === 'completed' && refused !== undefined) {
        this.fail(new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason: refused.reason }));
      } else {
        this.queue.push({ type: 'turn_end' });
      }
    }, (error: unknown) => this.fail(error)).finally(() => {
      this.turnWaiters.settleAll();
    });
  }
  /** OAR sends session/close, which agy advertises, before it releases the process. */
  private stopRuntime(): Promise<void> {
    this.stopping = true;
    this.stopAttempt ??= Promise.resolve().then(async () => {
      try {
        try {
          // session/close ends the worker, and a daemon command that left its group would then have no parent to be found under.
          this.child?.observeDescendants();
        } finally {
          await this.raw?.dispose();
        }
      } catch (error) {
        if (!this.failure || isRuntimeDisposalFailure(error)) throw error;
      } finally {
        try {
          await this.child?.dispose();
        } finally {
          await this.proxy?.close();
        }
      }
    }).catch((error: unknown) => {
      this.stopAttempt = undefined;
      throw error;
    });
    return this.stopAttempt;
  }
  fail(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure(error instanceof Error ? error.message : 'agy runtime failed');
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) this.fail(infrastructure('agy acp exited', { class: this.exitedOnItsOwn ? 'runtime_exited' : 'unknown' }));
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
    if (!this.raw) throw infrastructure('agy session is not open');
    if (this.active) throw infrastructure('agy turn is already active');
    this.active = true;
    try {
      const result = await this.raw.prompt(input);
      if (result.response.body.kind !== 'accepted') throw infrastructure(result.response.body.reason ?? 'agy prompt refused');
    } catch (error) {
      this.active = false;
      throw error;
    }
  }
  async followUp(): Promise<void> {
    throw new PolicyUnsupportedError('agy runs one turn per process; a later turn resumes the session');
  }
  async steer(text: string): Promise<void> {
    const result = await this.raw?.steer?.(text);
    if (result?.response.body.kind !== 'accepted') throw infrastructure(result?.response.body.reason ?? 'agy steer refused');
  }
  async interrupt(): Promise<void> {
    if (!this.raw || !this.active) return;
    const waiter = this.turnWaiters.wait();
    try {
      await raceDeadline(oarCancelSettled(this.raw.abort(), waiter.settled, 'agy'), this.interruptMs, () => infrastructure('agy interrupt timed out'));
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      waiter.release();
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    await this.closeOnce.run(async () => {
      try {
        try {
          await this.stopRuntime();
        } finally {
          await this.scratch.release();
        }
      } finally {
        // The cancelled prompt answer can follow the cancel; end the consumer only after disposal drained stdout.
        this.queue.end();
      }
      this.raw = undefined;
      this.projection = undefined;
      this.child = undefined;
    });
  }
}
