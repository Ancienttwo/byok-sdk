import { createHash } from 'node:crypto';
import {
  CONFIGURED_TOOLSETS_MAX_ITEMS,
  ToolsetIdSchema,
  type ToolsetId,
} from '@byok-sdk/protocol';
import type {
  McpStdioServerConfig,
  McpToolsetConfig,
  McpToolsetLifecycleState,
  McpToolsetObservation,
  McpToolsetRegistryStatus,
  McpToolsetReloadReceipt,
  McpToolsetStatus,
} from '../types';
import { isReservedMcpServerName } from '../sdk-reserved-mcp';
import { GRANTABLE_MCP_SERVER_NAME, GRANTABLE_TOOL_NAME } from '../mcp/observation';
import { compareCodeUnits } from '../util/compare-code-units';

const MAX_LOCAL_MCP_SERVERS_PER_TOOLSET = 16;
const MAX_READ_ONLY_TOOLS_PER_SERVER = 128;
const MAX_LOCAL_MCP_ARGS = 64;
const MAX_LOCAL_MCP_TOKEN_CHARS = 4096;
const MAX_TOOLSET_VERSION_CHARS = 128;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

const LIFECYCLE_STATES = new Set<McpToolsetLifecycleState>([
  'installed',
  'unauthorized',
  'starting',
  'ready',
  'degraded',
  'crashed',
  'incompatible',
]);

export type McpToolsetConfigInput = Record<string, McpToolsetConfig> | undefined;

export interface McpToolsetRegistrySnapshot {
  revision: string;
  toolsets: ReadonlyMap<string, McpToolsetConfig>;
  configuredToolsets: readonly ToolsetId[];
}

interface RegistryState extends McpToolsetRegistrySnapshot {
  definitionRevisions: ReadonlyMap<string, string>;
}

interface StoredObservation {
  definitionRevision: string;
  observation: Readonly<McpToolsetObservation>;
}

export class McpToolsetRevisionConflictError extends Error {
  constructor(readonly expectedRevision: string, readonly actualRevision: string) {
    super(`toolset registry revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    this.name = 'McpToolsetRevisionConflictError';
  }
}

export class McpToolsetDefinitionRevisionConflictError extends Error {
  constructor(
    readonly toolsetId: string,
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(
      `toolset definition revision conflict for ${JSON.stringify(toolsetId)}: expected ${expectedRevision}, current ${actualRevision}`,
    );
    this.name = 'McpToolsetDefinitionRevisionConflictError';
  }
}

function isNonEmptySingleLine(value: unknown, maxChars = MAX_LOCAL_MCP_TOKEN_CHARS): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars && !/[\u0000\r\n]/u.test(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function canonicalServers(toolset: McpToolsetConfig): readonly unknown[] {
  return Object.entries(toolset.mcpServers)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, server]) => [name, server.command, [...(server.args ?? [])]] as const);
}

/**
 * The full content identity of one toolset definition: what it runs AND how
 * its tools are classified.
 *
 * The classification is part of the definition, not metadata about it. A
 * toolset whose `readOnlyTools` changed grants a different tool set under a
 * restricted policy, so it must get a different `definitionRevision` —
 * otherwise a stored lifecycle observation, and every executor fingerprint
 * derived from the revision, would survive a permission change silently.
 * `null` rather than `{}` for an undeclared classification keeps "nobody
 * classified this" distinct from any declaration an operator could write.
 */
function canonicalToolset(toolset: McpToolsetConfig): unknown {
  return {
    servers: canonicalServers(toolset),
    readOnlyTools: toolset.readOnlyTools === undefined
      ? null
      : Object.entries(toolset.readOnlyTools)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([name, tools]) => [name, [...tools]] as const),
  };
}

function buildState(configured: McpToolsetConfigInput): RegistryState {
  if (configured !== undefined && (configured === null || typeof configured !== 'object' || Array.isArray(configured))) {
    throw new Error('DaemonConfig.mcpToolsets must be an object keyed by logical toolset id');
  }
  const toolsetEntries = Object.entries(configured ?? {});
  if (toolsetEntries.length > CONFIGURED_TOOLSETS_MAX_ITEMS) {
    throw new Error(`DaemonConfig.mcpToolsets may contain at most ${CONFIGURED_TOOLSETS_MAX_ITEMS} toolsets`);
  }

  const resolved = new Map<string, McpToolsetConfig>();
  const definitionRevisions = new Map<string, string>();
  for (const [toolsetId, rawToolset] of toolsetEntries.sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (!ToolsetIdSchema.safeParse(toolsetId).success) {
      throw new Error(`DaemonConfig.mcpToolsets contains invalid toolset id ${JSON.stringify(toolsetId)}`);
    }
    if (rawToolset === null || typeof rawToolset !== 'object' || Array.isArray(rawToolset)) {
      throw new Error(`DaemonConfig.mcpToolsets.${toolsetId} must be an object`);
    }
    const toolsetKeys = Object.keys(rawToolset);
    if (toolsetKeys.some((key) => key !== 'mcpServers' && key !== 'readOnlyTools')) {
      throw new Error(`DaemonConfig.mcpToolsets.${toolsetId} accepts only the mcpServers and readOnlyTools fields`);
    }
    const rawServers = (rawToolset as { mcpServers?: unknown }).mcpServers;
    if (rawServers === null || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
      throw new Error(`DaemonConfig.mcpToolsets.${toolsetId}.mcpServers must be an object`);
    }
    const serverEntries = Object.entries(rawServers);
    if (serverEntries.length === 0 || serverEntries.length > MAX_LOCAL_MCP_SERVERS_PER_TOOLSET) {
      throw new Error(
        `DaemonConfig.mcpToolsets.${toolsetId}.mcpServers must contain 1-${MAX_LOCAL_MCP_SERVERS_PER_TOOLSET} servers`,
      );
    }

    const servers: Record<string, McpStdioServerConfig> = {};
    for (const [serverName, rawServer] of serverEntries.sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!ToolsetIdSchema.safeParse(serverName).success) {
        throw new Error(
          `DaemonConfig.mcpToolsets.${toolsetId}.mcpServers contains invalid server name ${JSON.stringify(serverName)}`,
        );
      }
      if (isReservedMcpServerName(serverName)) {
        throw new Error(
          `DaemonConfig.mcpToolsets.${toolsetId}.mcpServers.${serverName} uses a server name reserved by the daemon`,
        );
      }
      if (rawServer === null || typeof rawServer !== 'object' || Array.isArray(rawServer)) {
        throw new Error(`DaemonConfig.mcpToolsets.${toolsetId}.mcpServers.${serverName} must be an object`);
      }
      const serverKeys = Object.keys(rawServer);
      if (serverKeys.some((key) => key !== 'command' && key !== 'args')) {
        throw new Error(
          `DaemonConfig.mcpToolsets.${toolsetId}.mcpServers.${serverName} accepts only command and args; env, headers, and remote task data are not supported`,
        );
      }
      const server = rawServer as { command?: unknown; args?: unknown };
      if (!isNonEmptySingleLine(server.command)) {
        throw new Error(
          `DaemonConfig.mcpToolsets.${toolsetId}.mcpServers.${serverName}.command must be a non-empty single-line string no longer than ${MAX_LOCAL_MCP_TOKEN_CHARS} characters`,
        );
      }
      if (server.args !== undefined && !Array.isArray(server.args)) {
        throw new Error(`DaemonConfig.mcpToolsets.${toolsetId}.mcpServers.${serverName}.args must be an array`);
      }
      const args = server.args ?? [];
      if (args.length > MAX_LOCAL_MCP_ARGS || args.some((arg) => !isNonEmptySingleLine(arg))) {
        throw new Error(
          `DaemonConfig.mcpToolsets.${toolsetId}.mcpServers.${serverName}.args must contain at most ${MAX_LOCAL_MCP_ARGS} non-empty single-line strings`,
        );
      }
      servers[serverName] = Object.freeze({
        command: server.command,
        ...(args.length > 0 ? { args: Object.freeze([...args]) as readonly string[] } : {}),
      });
    }
    const readOnlyTools = validateReadOnlyTools(
      toolsetId,
      (rawToolset as { readOnlyTools?: unknown }).readOnlyTools,
      servers,
    );
    const toolset = Object.freeze({
      mcpServers: Object.freeze(servers),
      ...(readOnlyTools === undefined ? {} : { readOnlyTools }),
    });
    resolved.set(toolsetId, toolset);
    definitionRevisions.set(toolsetId, digest(canonicalToolset(toolset)));
  }

  const configuredToolsets = Object.freeze([...resolved.keys()]) as readonly ToolsetId[];
  const canonical = configuredToolsets.map((toolsetId) => [toolsetId, canonicalToolset(resolved.get(toolsetId)!)] as const);
  return Object.freeze({
    revision: digest(canonical),
    toolsets: resolved,
    configuredToolsets,
    definitionRevisions,
  });
}

/**
 * Validate the operator's read/mutation classification against the toolset it
 * belongs to, strictly and synchronously.
 *
 * This is device configuration that decides what a restricted policy may call,
 * so every part of it is checked here rather than anywhere later: a server it
 * names must be one this toolset defines (a typo would otherwise classify
 * nothing at all while looking like it classified something), a tool name must
 * be shaped like a name a runtime grant can carry, and a repeated name is
 * refused rather than de-duplicated. An empty declaration is refused too —
 * omitting the field is how a device says "this toolset is unclassified", and
 * a second spelling of that would only be ambiguous.
 *
 * What CANNOT be checked here is whether the named tools exist: the servers
 * have not been started. That cross-check is the daemon's, against each
 * server's own `tools/list` answer, in `classifyMcpToolsetServerObservation`.
 */
function validateReadOnlyTools(
  toolsetId: string,
  raw: unknown,
  servers: Readonly<Record<string, McpStdioServerConfig>>,
): Readonly<Record<string, readonly string[]>> | undefined {
  if (raw === undefined) return undefined;
  const label = `DaemonConfig.mcpToolsets.${toolsetId}.readOnlyTools`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be an object keyed by configured server name`);
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    throw new Error(`${label} must name at least one server; omit the field entirely for an unclassified toolset`);
  }
  const classification: Record<string, readonly string[]> = {};
  for (const [serverName, rawTools] of entries.sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
      throw new Error(`${label}.${serverName} names a server this toolset does not define`);
    }
    if (!GRANTABLE_MCP_SERVER_NAME.test(serverName)) {
      throw new Error(`${label}.${serverName} cannot be expressed as a runtime tool grant`);
    }
    if (!Array.isArray(rawTools) || rawTools.length === 0 || rawTools.length > MAX_READ_ONLY_TOOLS_PER_SERVER) {
      throw new Error(`${label}.${serverName} must list 1-${MAX_READ_ONLY_TOOLS_PER_SERVER} tool names`);
    }
    const seen = new Set<string>();
    for (const tool of rawTools) {
      if (typeof tool !== 'string' || !GRANTABLE_TOOL_NAME.test(tool)) {
        throw new Error(`${label}.${serverName} contains invalid tool name ${JSON.stringify(tool)}`);
      }
      if (seen.has(tool)) {
        throw new Error(`${label}.${serverName} lists tool name ${JSON.stringify(tool)} more than once`);
      }
      seen.add(tool);
    }
    classification[serverName] = Object.freeze([...(rawTools as string[])].sort(compareCodeUnits));
  }
  return Object.freeze(classification);
}

function validateObservation(input: McpToolsetObservation): Readonly<McpToolsetObservation> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('toolset observation must be an object');
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== 'state' && key !== 'observedAt' && key !== 'version' && key !== 'reasonCode')) {
    throw new Error('toolset observation accepts only state, observedAt, version, and reasonCode');
  }
  if (!LIFECYCLE_STATES.has(input.state)) {
    throw new Error(`invalid toolset lifecycle state ${JSON.stringify(input.state)}`);
  }
  if (typeof input.observedAt !== 'string' || Number.isNaN(Date.parse(input.observedAt))) {
    throw new Error('toolset observation observedAt must be an ISO timestamp');
  }
  const observedAt = new Date(input.observedAt).toISOString();
  if (observedAt !== input.observedAt) throw new Error('toolset observation observedAt must be a canonical ISO timestamp');
  if (input.version !== undefined && !isNonEmptySingleLine(input.version, MAX_TOOLSET_VERSION_CHARS)) {
    throw new Error(`toolset observation version must be a non-empty single-line string no longer than ${MAX_TOOLSET_VERSION_CHARS} characters`);
  }
  if (input.reasonCode !== undefined && !REASON_CODE_PATTERN.test(input.reasonCode)) {
    throw new Error('toolset observation reasonCode must match [a-z0-9][a-z0-9._-]{0,63}');
  }
  return Object.freeze({
    state: input.state,
    observedAt,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  });
}

/** Single mutable owner of immutable-at-a-time device-local toolset snapshots. */
export class McpToolsetRegistry {
  private state: RegistryState;
  private observations = new Map<string, StoredObservation>();

  constructor(configured?: McpToolsetConfigInput) {
    this.state = buildState(configured);
  }

  snapshot(): McpToolsetRegistrySnapshot {
    return this.state;
  }

  status(): McpToolsetRegistryStatus {
    return Object.freeze({
      revision: this.state.revision,
      toolsets: Object.freeze(this.statusRows()),
    });
  }

  reload(configured: McpToolsetConfigInput, expectedRevision: string): McpToolsetReloadReceipt {
    if (!REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('expectedRevision must be a sha256 content revision');
    }
    if (expectedRevision !== this.state.revision) {
      throw new McpToolsetRevisionConflictError(expectedRevision, this.state.revision);
    }
    const previousRevision = this.state.revision;
    const candidate = buildState(configured);
    if (candidate.revision === previousRevision) {
      return Object.freeze({
        previousRevision,
        revision: previousRevision,
        changed: false,
        toolsets: Object.freeze(this.statusRows()),
      });
    }

    const retained = new Map<string, StoredObservation>();
    for (const [toolsetId, stored] of this.observations) {
      if (candidate.definitionRevisions.get(toolsetId) === stored.definitionRevision) retained.set(toolsetId, stored);
    }
    this.state = candidate;
    this.observations = retained;
    return Object.freeze({
      previousRevision,
      revision: candidate.revision,
      changed: true,
      toolsets: Object.freeze(this.statusRows()),
    });
  }

  report(toolsetId: string, expectedDefinitionRevision: string, observation: McpToolsetObservation): void {
    const definitionRevision = this.state.definitionRevisions.get(toolsetId);
    if (definitionRevision === undefined) {
      throw new Error(`cannot report lifecycle for unconfigured toolset ${JSON.stringify(toolsetId)}`);
    }
    if (expectedDefinitionRevision !== definitionRevision) {
      throw new McpToolsetDefinitionRevisionConflictError(
        toolsetId,
        expectedDefinitionRevision,
        definitionRevision,
      );
    }
    this.observations.set(toolsetId, {
      definitionRevision,
      observation: validateObservation(observation),
    });
  }

  private statusRows(): McpToolsetStatus[] {
    return this.state.configuredToolsets.map((id) => {
      const observation = this.observations.get(id)?.observation;
      return Object.freeze({
        id,
        serverCount: Object.keys(this.state.toolsets.get(id)!.mcpServers).length,
        definitionRevision: this.state.definitionRevisions.get(id)!,
        ...(observation === undefined ? {} : { observation }),
      });
    });
  }
}
