import type { spawn as nodeSpawn } from 'node:child_process';
import { bindVerifiedDetection, registerAdmissionDetect, takeVerifiedDetection } from '../../runtime-detection.js';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../../runtime-failure.js';
import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment.js';
import { createRuntimeReaders } from '../../runtime/runtime-readers.js';
import type { RuntimeListModelsOptions, RuntimeModelCatalog } from '../../runtime/runtime-reader-types.js';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields } from '../../runtime-version-policy.js';
import { freezeRuntimeAdapterDescriptor, offerSelection, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type RuntimeOperationStartInput, type RuntimeVersionPolicy, type Session } from '../../types.js';
import type { ResolvedBin } from '../codex/resolve-bin.js';
import { classifyDetectError, probeRuntimeVersion, runDetectCommand } from '../detect-outcome.js';
import { withoutProviderCredentials } from '../provider-credential-environment.js';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../runtime-executable.js';
import { resolveRuntimeInvocation, runtimeInvocationHost } from '../runtime-invocation.js';
import { oarStartClassifier, runtimeStartFailure } from '../runtime-start-failure.js';
import { resolveInterruptTimeoutMs, resolveMaxRetainedBytes } from '../session-limits.js';
import { objectRecord } from '../shared-rules.js';
import { CURSOR_RUNTIME_CAPABILITIES } from './cursor-capabilities.js';
import { cursorAuthFailure, cursorMcpHasCredentials, unsupportedCursorOption } from './cursor-policy.js';
import { CursorSession } from './cursor-session.js';
import { cursorVersionToken, resolveCursorBin } from './resolve-bin.js';

export interface CursorAdapterOptions {
  /** Default Host model. If absent, device-default uses the CLI's current model. */
  model?: string;
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** Host version policy for Cursor's CalVer token. Phase 1 has no qualified pin. */
  versionPolicy?: RuntimeVersionPolicy;
  resolveBin?: () => ResolvedBin;
  nativeAssetRoot?: string;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  interruptTimeoutMs?: number;
}

const PLATFORMS = ['darwin', 'linux'] as const;
const DETECT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
// Leave time for ACP's 10 s cancel fallback and process-tree cleanup.
const INTERRUPT_TIMEOUT_MS = 15_000;
const CREDENTIALED_MCP = 'Cursor refuses credentialed task MCP servers';
const authority = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason });
const reject = (reason: string) => ({ kind: 'reject' as const, reason, retryable: false });

function mcpRefusal(servers: RuntimeAdapterPrepareInput['mcpServers']): string | undefined {
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (cursorMcpHasCredentials(server)) return CREDENTIALED_MCP;
    if (!name || typeof server.command !== 'string' || !server.command.trim() || server.args?.some(arg => typeof arg !== 'string')) {
      return 'invalid Cursor Host MCP server';
    }
  }
  return undefined;
}

function authPresent(stdout: string): boolean {
  try { return objectRecord(JSON.parse(stdout))?.isAuthenticated === true; }
  catch { return false; }
}

/** User-installed Cursor Agent CLI over ACP, using the CLI's existing login. */
export class CursorAdapter implements RuntimeAdapter {
  private readonly options: CursorAdapterOptions;
  private readonly environment: RuntimeEnvironmentPolicy;
  private readonly policy?: RuntimeVersionPolicy;
  private readonly maxRetainedBytes: number;
  private readonly interruptTimeoutMs: number;
  #runtimeReaders?: ReturnType<typeof createRuntimeReaders>;

  constructor(options: CursorAdapterOptions = {}) {
    if (options.model !== undefined && (typeof options.model !== 'string' || !options.model.trim())) {
      throw new TypeError('CursorAdapterOptions.model must be a nonblank model ID');
    }
    this.options = { ...options };
    this.environment = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'CursorAdapterOptions.runtimeEnvironment');
    this.policy = resolveRuntimeVersionPolicy(undefined, options.versionPolicy);
    this.maxRetainedBytes = resolveMaxRetainedBytes(options.maxRetainedBytes, 'Cursor');
    this.interruptTimeoutMs = resolveInterruptTimeoutMs(options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS, 'Cursor');
    registerAdmissionDetect(this, CursorAdapter.prototype.detect, signal => this.probe(false, signal));
  }

  get descriptor() {
    return freezeRuntimeAdapterDescriptor({ id: 'cursor', selectionModes: ['device-default', 'adapter-model'],
      ...(this.options.model === undefined ? {} : { defaultModelModes: ['adapter-model'] }),
      supportsEffort: true, platforms: PLATFORMS, capabilities: CURSOR_RUNTIME_CAPABILITIES,
      ...(this.policy === undefined ? {} : { versionPolicy: this.policy }),
    });
  }

  runtimeEnvironment() { return buildRuntimeEnvironment(this.environment); }

  private resolveCommand(env: Readonly<Record<string, string>>) {
    return resolveRuntimeCommand(this.options.resolveBin, () => resolveCursorBin(env));
  }

  listModels(options: RuntimeListModelsOptions = {}): Promise<RuntimeModelCatalog> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      return Promise.resolve({ kind: 'unsupported', reason: 'Cursor ACP is unavailable on this platform' });
    }
    this.#runtimeReaders ??= createRuntimeReaders(this, {
      nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn,
      command: env => this.resolveCommand(env).bin.command,
      version: cursorVersionToken,
      environment: env => ({ env: withoutProviderCredentials(env) }),
    });
    return this.#runtimeReaders.listModels(options, async (installation, reader) => (await import('#byok-acp-runtime')).cursorListModels(installation, reader));
  }

  detect(signal?: AbortSignal): Promise<RuntimeDetectResult> { return this.probe(true, signal); }

  private async probe(checkAuth: boolean, signal?: AbortSignal): Promise<RuntimeDetectResult> {
    signal?.throwIfAborted();
    if (process.platform !== 'darwin' && process.platform !== 'linux') return { kind: 'refused', reason: 'platform_unsupported' };
    try {
      const env = withoutProviderCredentials((await this.runtimeEnvironment()).env);
      const resolved = this.resolveCommand(env);
      const { command, args, executable } = resolveRuntimeInvocation(resolved.bin.command, runtimeInvocationHost(env));
      const version = await probeRuntimeVersion(command, DETECT_TIMEOUT_MS, env, args, signal);
      if (version.kind !== 'available') return version;
      const token = cursorVersionToken(version.stdout) ?? cursorVersionToken(version.stderr);
      if (token === undefined) return { kind: 'refused', reason: 'acp_unavailable' };
      const help = await runDetectCommand(command, [...args, 'acp', '--help'], { timeoutMs: DETECT_TIMEOUT_MS, env, signal });
      if (help.kind === 'aborted') throw help.reason;
      if (help.kind !== 'ok') return { kind: 'refused', reason: 'acp_unavailable' };
      const status = checkAuth ? await runDetectCommand(command, [...args, 'status', '--format', 'json'], { timeoutMs: STATUS_TIMEOUT_MS, env, signal }) : undefined;
      if (status?.kind === 'aborted') throw status.reason;
      return bindVerifiedDetection(this, {
        kind: 'available' as const, version: token, rawVersion: version.stdout,
        ...(status === undefined ? {} : { authPresent: status.kind === 'ok' && authPresent(status.stdout) }),
        ...runtimeExecutableFields(resolved, executable), ...runtimeVersionDetectionFields(this.policy, token),
      }, resolved.bin.command);
    } catch (error) {
      signal?.throwIfAborted();
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    input.signal?.throwIfAborted();
    const { target, effort } = input.offer;
    const selection = offerSelection(target);
    if (target.lane === 'harness' && (target.harnessId !== 'cursor' || (selection?.mode !== 'device-default' && selection?.mode !== 'adapter-model'))) {
      return reject('Cursor does not support the requested selection');
    }
    const unsupported = unsupportedCursorOption(input.offer);
    if (unsupported !== undefined) return reject(`Cursor does not support ${unsupported}`);
    const offeredModel = selection?.mode === 'adapter-model' ? selection.modelId : undefined;
    const model = offeredModel ?? this.options.model;
    if (selection?.mode === 'adapter-model' && (model === undefined || !model.trim())) {
      return { ...reject('Cursor requires a model ID when no default is configured'), code: 'invalid_request' };
    }
    const refusal = mcpRefusal(input.mcpServers);
    if (refusal !== undefined) return reject(refusal);
    const observed = takeVerifiedDetection<string>(this, input.detected);
    const detected = observed === undefined ? await this.probe(false, input.signal) : input.detected;
    if (detected === undefined) return reject('cursor installation refused: unverified detection');
    if (detected.kind !== 'available') return reject(`cursor installation refused: ${detected.kind === 'refused' ? detected.reason : detected.kind}`);
    const command = observed ?? takeVerifiedDetection<string>(this, detected);
    if (command === undefined) return reject('cursor installation refused: unverified detection');
    const { version, executableSource, versionVerdict } = detected;
    return { kind: 'prepared', detected: { version, executableSource, versionVerdict }, operation: { start: start => {
      const actual = start.manifest.selection;
      if (actual?.mode !== selection?.mode || (actual?.mode === 'adapter-model' && actual.modelId !== offeredModel) || start.manifest.effort !== effort) {
        throw authority('prepared Cursor operation received a manifest with different runtime selection');
      }
      return this.start(start, command, model, effort);
    } } };
  }

  private async start(input: RuntimeOperationStartInput, command: string, model: string | undefined, effort: string | undefined): Promise<Session> {
    input.signal?.throwIfAborted();
    if (input.kind !== 'instruction') throw authority('Cursor does not support the prepared lane');
    if (typeof input.instruction !== 'string' || !input.manifest.cwd) throw authority('Cursor requires a resolved instruction and sealed cwd');
    if (input.manifest.homeAccess === 'memory-reader') throw authority('Cursor ACP has no transient system prompt for Agent readers');
    if (input.toolAuthorization !== undefined) throw authority('Cursor does not support automatic tool authorization');
    const unsupported = unsupportedCursorOption(input) ?? unsupportedCursorOption(input.manifest);
    if (unsupported !== undefined) throw authority(`Cursor does not support ${unsupported}`);
    const refusal = mcpRefusal(input.mcpServers);
    if (refusal !== undefined) throw authority(refusal);
    const acp = await import('#byok-acp-runtime');
    const session = new CursorSession(input, input.manifest.cwd, model, effort, this.interruptTimeoutMs);
    try {
      await session.open(acp.cursorSession, command, this.options, this.maxRetainedBytes);
      await session.prompt(input.instruction, input.images);
      return session;
    } catch (error) {
      try { await session.close(); }
      catch (disposal) { throw new RuntimeStartupDisposalFailure(() => session.close(), { cause: disposal }); }
      if (error instanceof acp.RuntimeFailureError && error.failure === 'auth') throw cursorAuthFailure();
      throw runtimeStartFailure(error, { classify: oarStartClassifier(acp), exitedOnItsOwn: session.exitedOnItsOwn, runtime: 'cursor' });
    }
  }
}
