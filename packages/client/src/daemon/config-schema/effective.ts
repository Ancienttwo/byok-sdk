import path from 'node:path';
import { AGENT_HOME_DIRECTORY } from '../../agent-home';
import {
  AGENT_MEMORY_MCP_SERVER_NAME,
  AGENT_MESSAGE_MCP_SERVER_NAME,
  AGENT_RESULT_MCP_SERVER_NAME,
} from '../../sdk-reserved-mcp';
import {
  parseToolAuthorizationPolicy, toolAuthorizationMode,
  type ToolAuthorizationMode, type ToolFileScope,
} from '../../tool-authorization';
import type { RuntimeAdapter, RuntimeVersionPolicy } from '../../types';
import { serviceLogDir } from '../host-layout';
import { scratchRootSocketBudget } from '../retention/scratch';
import type { DaemonConfig, DaemonStatus } from '../create-daemon';
import { DAEMON_CONFIG_SCHEMA_VERSION } from './schema.generated';
import type { DaemonConfigIssue } from './validate';

/**
 * How daemon construction resolved the SDK Agent memory filesystem helper
 * (#603, #614).
 *
 * - `not-needed`: no Agent home, or memory is off and no memory feature is configured.
 * - `native`: Linux; the descriptor backend needs no helper.
 * - `resolved`: macOS or Windows x64; the SDK release helper at `path` passed its digest check.
 * - `missing`: macOS or Windows x64, but the helper did not resolve; memory is
 *   silently unavailable (#603). `reason` says why.
 * - `unsupported-platform`: no secure memory backend on this platform.
 */
export type DaemonMemoryHelperResolution =
  | { readonly state: 'not-needed' | 'native' | 'unsupported-platform' }
  | { readonly state: 'resolved'; readonly path: string }
  | { readonly state: 'missing'; readonly reason: string };

/** One MCP server a task of this daemon may get. */
export interface DaemonEffectiveMcpServer {
  readonly name: string;
  /** `sdk-reserved`: an SDK helper. `host-toolset`: a server of `DaemonConfig.mcpToolsets`. */
  readonly kind: 'sdk-reserved' | 'host-toolset';
  /** `per-task`: mounted for each task that `when` describes. `off` / `unavailable`: never mounted. */
  readonly mount: 'per-task' | 'off' | 'unavailable';
  /** Which tasks get it (`per-task`), or why it is never mounted. */
  readonly detail: string;
}

/** One runtime adapter of this daemon. */
export interface DaemonEffectiveRuntime {
  readonly id: string;
  /** `sdk-built`: `createDaemon` built it from config. `injected`: passed to `createDaemonWithAdapters`. */
  readonly source: 'sdk-built' | 'injected';
  /** Whether an `auto` tool-authorization offer can run on it. */
  readonly toolAuthorizationAuto: boolean;
  /**
   * The isolation options `createDaemon` gives an SDK-built adapter. Absent
   * for an injected adapter, whose options the Host set when it built it.
   */
  readonly isolation?: Readonly<Record<string, string>>;
  /**
   * The effective version policy (#1103), resolved once at adapter
   * construction; only the policy, never the installed runtime token.
   */
  readonly versionPolicy?: RuntimeVersionPolicy;
}

/**
 * Effective values of one daemon's configuration (#1094): what it resolved
 * from `DaemonConfig`, beyond the literal fields. `byok-agent config check`
 * and `Daemon.status().config` both return this, from the same function.
 */
export interface DaemonEffectiveConfig {
  /** Version of the generated `daemon-config.schema.json` this daemon validates against. */
  readonly schemaVersion: number;
  /** Unknown-field warnings; a daemon starts with them (Q4'). */
  readonly warnings: readonly DaemonConfigIssue[];
  readonly directories: {
    readonly storeDir: { readonly path: string; readonly source: 'config' | 'default' };
    /** `agentHome.hostStorageRoot`, resolved. Absent without an Agent home. */
    readonly hostStorageRoot?: string;
    /** `<hostStorageRoot>/agents`, the SDK-owned parent of every Agent home. */
    readonly agentHomes?: string;
    /** `<storeDir>/service-logs`, where `byok-agent service install` sends the daemon's stdout and stderr. */
    readonly logDir: string;
    /**
     * Execution scratch root (#493). `config`: `storage.scratchRoot`. `store`:
     * `<storeDir>/tmp`. `short-root`: the store path is too long for runtime
     * Unix sockets, so scratch moved to a fixed short root.
     */
    readonly scratchRoot: {
      readonly path: string;
      readonly source: 'config' | 'store' | 'short-root';
      /** Byte length of `path`, and the longest root runtime sockets allow on this platform (absent: unbounded). */
      readonly socketPathBytes: number;
      readonly socketPathMaximumBytes?: number;
    };
  };
  readonly memory: {
    /** Same value as `DaemonStatus.agentMemoryMcp`. */
    readonly mcp: DaemonStatus['agentMemoryMcp'];
    readonly helper: DaemonMemoryHelperResolution;
  };
  readonly mcpServers: readonly DaemonEffectiveMcpServer[];
  readonly runtimes: readonly DaemonEffectiveRuntime[];
  readonly toolAuthorization: DaemonEffectiveToolAuthorization;
}

/**
 * How this daemon decides each task's tool-authorization mode.
 *
 * - `all`: no `DaemonConfig.toolAuthorization`; every task runs `all`.
 * - `static`: a policy; `byRuntime` holds the mode of every runtime of this
 *   daemon (its `byRuntime` entry, else `default`).
 */
export type DaemonEffectiveToolAuthorization = (
  | { readonly mode: 'all' }
  | { readonly mode: 'static'; readonly byRuntime: Readonly<Record<string, ToolAuthorizationMode>> }
) & {
  /** Who may approve a `tool-authorization` approval: `host-only` (default) or `allow` (the control socket too). */
  readonly localToolApproval: 'host-only' | 'allow';
  /**
   * The configured explicit file scope (#1061), copied and normalized.
   * Absent means `inherit`: no file-scope policy is configured and behavior
   * is unchanged. `home` is the canonical Agent home read+write; `workspaces`
   * adds the listed roots (`write` implies `read`). Whether the selected
   * runtime/lane/platform can enforce it is per-offer admission.
   */
  readonly fileScope?: ToolFileScope;
};

export interface EffectiveDaemonConfigInput {
  readonly config: DaemonConfig;
  readonly warnings: readonly DaemonConfigIssue[];
  readonly memoryHelper: DaemonMemoryHelperResolution;
  readonly agentMemoryMcpAdmission: DaemonStatus['agentMemoryMcp'];
  /** Resolved `storeDir`. */
  readonly storeDir: string;
  /** Resolved scratch root. */
  readonly scratchRoot: string;
  readonly adapters: readonly RuntimeAdapter[];
  readonly runtimeSource: 'sdk-built' | 'injected';
  readonly platform?: NodeJS.Platform;
}

/**
 * The isolation options of the adapters `createDaemon` builds: the values of
 * `DaemonConfig.runtimes` and `codexSandbox`, and for an unset option the
 * adapter's default, under which a runtime keeps the user's own login,
 * settings and MCP servers.
 */
function sdkBuiltIsolation(id: string, config: DaemonConfig): Readonly<Record<string, string>> | undefined {
  const runtimes = config.runtimes;
  switch (id) {
    case 'pi': return { agentUserContext: runtimes?.pi?.agentUserContext ?? 'inherit' };
    case 'claude': return {
      agentUserContext: runtimes?.claude?.agentUserContext ?? 'inherit',
      agentSessionPersistence: runtimes?.claude?.agentSessionPersistence ?? 'enabled',
    };
    case 'codex': return {
      agentUserMcpServers: runtimes?.codex?.agentUserMcpServers ?? 'inherit',
      sandbox: config.codexSandbox ?? 'danger-full-access',
    };
    default: return undefined;
  }
}

function effectiveToolAuthorization(config: DaemonConfig, adapters: readonly RuntimeAdapter[]): DaemonEffectiveToolAuthorization {
  const localToolApproval = config.localToolApproval === 'allow' ? 'allow' : 'host-only';
  const policy = config.toolAuthorization;
  if (policy === undefined) return { mode: 'all', localToolApproval };
  const byRuntime = Object.fromEntries(adapters.map((adapter) => [adapter.descriptor.id, toolAuthorizationMode(policy, adapter.descriptor.id)]));
  // Re-parse so the report shows the normalized, frozen scope (duplicate
  // paths merged, lexically absolute), not the raw config object.
  const fileScope = parseToolAuthorizationPolicy(policy).fileScope;
  return { mode: 'static', byRuntime, localToolApproval, ...(fileScope === undefined ? {} : { fileScope }) };
}

export function describeEffectiveDaemonConfig(input: EffectiveDaemonConfigInput): DaemonEffectiveConfig {
  const { config, storeDir, scratchRoot, platform = process.platform } = input;
  const scratchSource: DaemonEffectiveConfig['directories']['scratchRoot']['source'] = config.storage?.scratchRoot !== undefined
    ? 'config'
    : path.dirname(scratchRoot) === path.resolve(storeDir) && path.basename(scratchRoot) === 'tmp' ? 'store' : 'short-root';
  const budget = scratchRootSocketBudget(scratchRoot, platform);
  const hostStorageRoot = config.agentHome === undefined ? undefined : path.resolve(config.agentHome.hostStorageRoot);

  const helper = input.memoryHelper;
  const memoryDetail = input.agentMemoryMcpAdmission === 'admitted'
    ? 'every Agent task (writer: memory_recall and memory_save; memory-reader: memory_recall)'
    : input.agentMemoryMcpAdmission === 'off'
      ? 'DaemonConfig.agentMemoryMcp is off'
      : config.agentHome === undefined
        ? 'no agentHome'
        : helper.state === 'missing'
          ? `SDK Agent memory helper did not resolve: ${helper.reason}`
          : 'no secure memory filesystem on this platform';
  const mcpServers: DaemonEffectiveMcpServer[] = [
    {
      name: AGENT_MEMORY_MCP_SERVER_NAME, kind: 'sdk-reserved',
      mount: input.agentMemoryMcpAdmission === 'admitted' ? 'per-task' : input.agentMemoryMcpAdmission === 'off' ? 'off' : 'unavailable',
      detail: memoryDetail,
    },
    config.agentHome === undefined
      ? { name: AGENT_RESULT_MCP_SERVER_NAME, kind: 'sdk-reserved', mount: 'unavailable', detail: 'no agentHome' }
      : { name: AGENT_RESULT_MCP_SERVER_NAME, kind: 'sdk-reserved', mount: 'per-task', detail: 'result-document offers' },
    config.agentHome !== undefined && config.agentEgress !== undefined
      ? { name: AGENT_MESSAGE_MCP_SERVER_NAME, kind: 'sdk-reserved', mount: 'per-task', detail: 'offers that require Agent messages' }
      : { name: AGENT_MESSAGE_MCP_SERVER_NAME, kind: 'sdk-reserved', mount: 'unavailable', detail: config.agentHome === undefined ? 'no agentHome' : 'no agentEgress' },
  ];
  for (const [toolsetId, toolset] of Object.entries(config.mcpToolsets ?? {})) {
    for (const serverName of Object.keys(toolset.mcpServers)) {
      mcpServers.push({ name: serverName, kind: 'host-toolset', mount: 'per-task', detail: `offers that require toolset ${toolsetId}` });
    }
  }

  return {
    schemaVersion: DAEMON_CONFIG_SCHEMA_VERSION,
    warnings: input.warnings,
    directories: {
      storeDir: { path: storeDir, source: config.storeDir === undefined ? 'default' : 'config' },
      ...(hostStorageRoot === undefined ? {} : { hostStorageRoot, agentHomes: path.join(hostStorageRoot, AGENT_HOME_DIRECTORY) }),
      logDir: serviceLogDir(storeDir),
      scratchRoot: {
        path: scratchRoot,
        source: scratchSource,
        socketPathBytes: budget.bytes,
        ...(budget.maximumBytes === undefined ? {} : { socketPathMaximumBytes: budget.maximumBytes }),
      },
    },
    memory: { mcp: input.agentMemoryMcpAdmission, helper },
    mcpServers,
    runtimes: input.adapters.map((adapter) => {
      const id = adapter.descriptor.id;
      const isolation = input.runtimeSource === 'sdk-built' ? sdkBuiltIsolation(id, config) : undefined;
      const versionPolicy = adapter.descriptor.versionPolicy;
      return {
        id,
        source: input.runtimeSource,
        toolAuthorizationAuto: adapter.descriptor.capabilities.toolAuthorizationAuto === true,
        ...(isolation === undefined ? {} : { isolation }),
        ...(versionPolicy === undefined ? {} : { versionPolicy }),
      };
    }),
    toolAuthorization: effectiveToolAuthorization(config, input.adapters),
  };
}
