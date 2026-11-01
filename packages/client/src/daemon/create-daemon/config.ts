import { assertDaemonConfigValid, DaemonConfigInvalidError, removedFieldError } from '../config-schema/errors';
import type { DaemonMemoryHelperResolution } from '../config-schema/effective';
import { resolveAgentMemoryFilesystemHelper } from '../../util/agent-memory-helper-release';
import { resolveSdkReservedHelperBin } from '../../sdk-reserved-helper-host';
import { isAgentMemoryFilesystemHelperSupported } from '../agent-memory-fs-helper';
import { isAgentMemorySecureFilesystemAvailable } from '../agent-memory';
import { resolveAgentMemoryMcpBin, resolveAgentMemoryDescribeBin } from '../resolve-agent-memory-mcp-bin';
import { resolveLocalAgentReleaseIdentity } from '../../release-identity';
import { LocalStorageConfigError } from '../retention/config';
import { McpToolsetRegistry } from '../toolset-registry';
import { validatePiByokLauncherConfig } from '../../adapters/pi/pi-adapter';
import { DEFAULT_MAX_TASK_OUTPUT_BYTES, DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME, DEFAULT_MAX_CONCURRENT_TASKS } from '../task-runner';
import { MIN_MAX_INLINE_EVENT_BYTES, DEFAULT_MAX_INLINE_EVENT_BYTES } from '../event-spill';
import { validateProgressBatcherOptions } from '../progress-batcher';
import type { DaemonStatus } from '../create-daemon';
import type { DaemonInputs } from './scope';
import { foldNameAliases } from '../../util/fold-name-aliases';
import {
  FileScopePolicyError, parseToolAuthorizationPolicy, toolAuthorizationResolver as deriveToolAuthorizationResolver,
  type ToolAuthorizationPolicy, type ToolAuthorizationResolver,
} from '../../tool-authorization';

function admitToolAuthorizationPolicy(value: unknown): ToolAuthorizationPolicy {
  try {
    return parseToolAuthorizationPolicy(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const fileScope = error instanceof FileScopePolicyError;
    throw new DaemonConfigInvalidError([{
      severity: 'error', code: fileScope ? error.code : 'invalid_value',
      path: fileScope ? 'toolAuthorization.fileScope' : 'toolAuthorization', message: error.message,
    }]);
  }
}

/**
 * The first stage of `buildDaemonWithAdapters` (#926): validates
 * `DaemonConfig` and `DaemonOverrides`, and resolves the values derived from
 * them alone — the Agent memory helper binaries and their admission, the local
 * Agent release identity and the MCP toolset registry.
 */
export function resolveDaemonConfig(input: Pick<DaemonInputs, 'overrides' | 'config'>) {
  const { overrides, config } = input;
  if (overrides.deviceCredentials !== undefined && config.deviceCredentials !== undefined) {
    throw new TypeError('configure OS deviceCredentials or inject a credential backend, not both');
  }
  const configWarnings = assertDaemonConfigValid(config);
  if (Object.hasOwn(overrides, 'hostedJournal')) throw removedFieldError('hostedJournal');
  if (Object.hasOwn(overrides, 'gitWorkspace')) throw removedFieldError('gitWorkspace');
  // The one parser admits both a config file's object and an embedded Host's
  // object at construction; the task runner receives only the derived
  // resolver, so no offer can see an invalid policy.
  const toolAuthorization = config.toolAuthorization === undefined
    ? undefined : admitToolAuthorizationPolicy(config.toolAuthorization);
  const toolAuthorizationResolver: ToolAuthorizationResolver | undefined = toolAuthorization === undefined
    ? undefined : deriveToolAuthorizationResolver(toolAuthorization);
  if (config.providerProvisioning !== undefined && typeof config.providerProvisioning !== 'function') {
    throw new Error('DaemonConfig.providerProvisioning must be a handler function when present');
  }
  if (
    config.agentMemoryIntents !== undefined &&
    (config.agentMemoryIntents === null ||
      typeof config.agentMemoryIntents !== 'object' ||
      typeof config.agentMemoryIntents.fetch !== 'function' ||
      typeof config.agentMemoryIntents.complete !== 'function')
  ) {
    throw new Error('DaemonConfig.agentMemoryIntents must be a transport with fetch and complete functions when present');
  }
  if (config.agentMemoryExport === true && config.agentHome === undefined) {
    throw new Error('DaemonConfig.agentMemoryExport requires agentHome');
  }
  const agentMemoryMcpEnabled = config.agentMemoryMcp !== 'off';
  if (config.agentMemory !== undefined && config.agentHome === undefined) {
    throw new Error('DaemonConfig.agentMemory requires DaemonConfig.agentHome for the exact Agent memory authority');
  }
  if (config.agentMemoryHelperAssetRoot !== undefined) {
    if (config.agentHome === undefined) throw new Error('DaemonConfig.agentMemoryHelperAssetRoot requires agentHome');
    // Explicit configuration must fail closed even without projection or intent transport.
    resolveAgentMemoryFilesystemHelper(config.agentMemoryHelperAssetRoot);
  }
  if (config.sdkHelperHost !== undefined) {
    resolveSdkReservedHelperBin('agent-message-mcp', config.sdkHelperHost);
  }
  // Platform support alone cannot admit memory. Compiled products and ordinary
  // JS builds can have Agent homes without the SDK native release assets.
  let resolveAgentMemoryFilesystemHelperBin: (() => string) | undefined;
  // What the effective-config report says about the helper (#603, #614).
  let memoryHelper: DaemonMemoryHelperResolution;
  const memoryWanted = config.agentHome !== undefined
    && (agentMemoryMcpEnabled || config.agentMemory !== undefined || config.agentMemoryIntents !== undefined || config.agentMemoryExport === true);
  if (!memoryWanted) {
    memoryHelper = { state: 'not-needed' };
  } else if (isAgentMemoryFilesystemHelperSupported()) {
    try {
      const helperPath = resolveAgentMemoryFilesystemHelper(config.agentMemoryHelperAssetRoot);
      resolveAgentMemoryFilesystemHelperBin = () => resolveAgentMemoryFilesystemHelper(config.agentMemoryHelperAssetRoot);
      memoryHelper = { state: 'resolved', path: helperPath };
    } catch (error) {
      if (config.agentMemoryHelperAssetRoot !== undefined || config.agentMemory !== undefined || config.agentMemoryIntents !== undefined || config.agentMemoryExport === true) throw error;
      memoryHelper = { state: 'missing', reason: error instanceof Error ? error.message : String(error) };
    }
  } else {
    memoryHelper = isAgentMemorySecureFilesystemAvailable(false) ? { state: 'native' } : { state: 'unsupported-platform' };
  }
  const externalAgentMemoryFilesystem = resolveAgentMemoryFilesystemHelperBin !== undefined;
  if (config.agentMemory !== undefined && !isAgentMemorySecureFilesystemAvailable(externalAgentMemoryFilesystem)) {
    throw new Error('DaemonConfig.agentMemory requires a platform with safe descriptor-relative filesystem operations');
  }
  if (config.agentMemoryExport === true && !isAgentMemorySecureFilesystemAvailable(externalAgentMemoryFilesystem)) {
    throw new Error('DaemonConfig.agentMemoryExport requires a secure Linux, macOS or Windows x64 memory backend');
  }
  const agentMemoryMcpBin = !agentMemoryMcpEnabled || config.agentHome === undefined
    ? undefined
    : resolveAgentMemoryMcpBin(externalAgentMemoryFilesystem, config.sdkHelperHost);
  const agentMemoryDescribeBin = !agentMemoryMcpEnabled || config.agentHome === undefined
    ? undefined
    : resolveAgentMemoryDescribeBin(externalAgentMemoryFilesystem, config.sdkHelperHost);
  // The same daemon-level facts the task runner checks before it binds the memory MCP.
  const agentMemoryMcpAdmission: DaemonStatus['agentMemoryMcp'] = !agentMemoryMcpEnabled
    ? 'off'
    : agentMemoryMcpBin !== undefined && isAgentMemorySecureFilesystemAvailable(externalAgentMemoryFilesystem)
      ? 'admitted'
      : 'unavailable';
  const localAgentRelease = resolveLocalAgentReleaseIdentity(config.localAgentRelease);
  const suppliedJournal = overrides.journal;
  if (suppliedJournal !== undefined && (typeof suppliedJournal.listPrunableConfirmedTasks !== 'function' || typeof suppliedJournal.pruneConfirmedJournalTask !== 'function')) throw new LocalStorageConfigError('config', 'requires the journal confirmed-retention ports');
  const toolsetRegistry = new McpToolsetRegistry(config.mcpToolsets);
  validatePiByokLauncherConfig(config.piByokLauncher);
  // The launcher writes sessions here and retention sweeps it; both use this spelling.
  const piByokLauncher = config.piByokLauncher === undefined ? undefined
    : Object.freeze({ ...config.piByokLauncher, sessionDir: foldNameAliases(config.piByokLauncher.sessionDir) });
  if (config.durablePi === true && (!config.agentHome || !config.piByokLauncher)) throw new Error('durablePi requires Agent home and Pi custody launcher');
  if (config.durablePi === true && process.platform === 'win32') throw new Error('durablePi is unavailable on Windows until parent-death Job Object recovery is validated');
  // M5 batch-3 (workstream 2): validated synchronously, up front — see
  // `DaemonConfig.maxTaskOutputBytes`'s own doc comment for the full
  // zero/negative-is-an-error / `Number.POSITIVE_INFINITY`-is-the-real-
  // opt-out pin. `configured > 0` is `false` for `NaN`, `0`, and any
  // negative number, and `true` for `Number.POSITIVE_INFINITY` — exactly the
  // three-way split this config wants.
  if (config.startupTimeoutMs !== undefined && (!Number.isSafeInteger(config.startupTimeoutMs) || config.startupTimeoutMs <= 0)) throw new Error('startupTimeoutMs must be a positive safe integer');
  if (config.artifactLimits !== undefined) {
    for (const value of [config.artifactLimits.maxFileBytes, config.artifactLimits.maxTaskBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('artifactLimits must contain positive safe integer byte budgets');
    }
  }
  if (config.maxTaskOutputBytes !== undefined && !(config.maxTaskOutputBytes > 0)) {
    throw new Error(
      `DaemonConfig.maxTaskOutputBytes must be a positive number (or omitted to use the ${DEFAULT_MAX_TASK_OUTPUT_BYTES}-byte default) — got ${config.maxTaskOutputBytes}. Pass Number.POSITIVE_INFINITY to explicitly disable the cap; 0 or a negative number is rejected rather than silently treated as "disabled".`,
    );
  }
  // Same up-front discipline as `maxTaskOutputBytes` above, with one
  // deliberate difference: there is no `Number.POSITIVE_INFINITY` opt-out.
  // An unbounded per-event payload is the exact failure this cap exists to
  // prevent, and a cap below `MIN_MAX_INLINE_EVENT_BYTES` cannot even hold
  // the descriptor that documents the omission — see
  // `DaemonConfig.maxInlineEventBytes`'s own doc comment.
  if (
    config.maxInlineEventBytes !== undefined
    && !(Number.isSafeInteger(config.maxInlineEventBytes) && config.maxInlineEventBytes >= MIN_MAX_INLINE_EVENT_BYTES)
  ) {
    throw new Error(
      `DaemonConfig.maxInlineEventBytes must be a safe integer of at least ${MIN_MAX_INLINE_EVENT_BYTES} (or omitted to use the ${DEFAULT_MAX_INLINE_EVENT_BYTES}-byte default) — got ${config.maxInlineEventBytes}. A smaller cap cannot hold the spill descriptor that documents the omission, and there is no "disabled" value: an unbounded tool_use.input/tool_result.output is what this cap exists to prevent.`,
    );
  }
  validateProgressBatcherOptions(config.progressBatch);
  if (config.agentEgress !== undefined && config.agentHome === undefined) {
    throw new Error('DaemonConfig.agentEgress requires DaemonConfig.agentHome for the per-Agent local spool');
  }
  // WP0: same up-front discipline as `maxTaskOutputBytes` above. A cap that
  // governs how many writers may share one Agent home is a correctness
  // control, so an unusable value is a construction error rather than
  // something the first offer discovers — and there is no
  // `Number.POSITIVE_INFINITY` opt-out here: "no cap" is exactly the
  // co-writing state this exists to prevent.
  if (
    config.maxConcurrentReaderAttemptsPerAgentHome !== undefined
    && !(Number.isSafeInteger(config.maxConcurrentReaderAttemptsPerAgentHome)
      && config.maxConcurrentReaderAttemptsPerAgentHome > 0)
  ) {
    throw new Error(
      `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome must be a positive safe integer (or omitted to use the default of ${DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME}) — got ${config.maxConcurrentReaderAttemptsPerAgentHome}. 0, a negative number, NaN, or a non-integer is rejected rather than silently treated as "uncapped".`,
    );
  }
  // #1121: like the reader cap above, there is no "uncapped" value.
  if (
    config.maxConcurrentTasks !== undefined
    && !(Number.isSafeInteger(config.maxConcurrentTasks) && config.maxConcurrentTasks > 0)
  ) {
    throw new Error(
      `DaemonConfig.maxConcurrentTasks must be a positive safe integer (or omitted to use the default of ${DEFAULT_MAX_CONCURRENT_TASKS}) — got ${config.maxConcurrentTasks}. 0, a negative number, NaN, or a non-integer is rejected rather than silently treated as "uncapped".`,
    );
  }
  if (
    config.defaultMaxDurationMs !== undefined
    && !(Number.isSafeInteger(config.defaultMaxDurationMs) && config.defaultMaxDurationMs > 0)
  ) {
    throw new Error(`DaemonConfig.defaultMaxDurationMs must be a positive safe integer (or omitted for no default limit) — got ${config.defaultMaxDurationMs}.`);
  }
  return {
    agentMemoryMcpEnabled, resolveAgentMemoryFilesystemHelperBin, agentMemoryMcpBin,
    agentMemoryDescribeBin, agentMemoryMcpAdmission, localAgentRelease, toolsetRegistry, piByokLauncher,
    memoryHelper, configWarnings, toolAuthorizationResolver,
  };
}

export type DaemonConfigScope = ReturnType<typeof resolveDaemonConfig>;
