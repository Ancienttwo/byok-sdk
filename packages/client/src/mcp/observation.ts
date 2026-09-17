import { compareCodeUnits } from '../util/compare-code-units';
import {
  McpAuthorityError,
  McpStdioClient,
  MCP_OBSERVATION_MAX_STDOUT_BYTES,
  type McpStdioClientOptions,
  type McpStdioServerSpec,
} from './client';

/**
 * Tool names an adapter is allowed to pre-grant must be OBSERVED, never
 * configured: the daemon's own `mcpToolsets` config carries `command`/`args`
 * only (see `../daemon/toolset-registry.ts`), so the single authority for
 * "which tools does this server actually expose" is the server's own
 * `tools/list` answer.
 *
 * A name that survives this filter is about to be interpolated into runtime
 * CLI authority — `--allowedTools mcp__<server>__<tool>` for claude,
 * `mcp_servers.<server>.tools.<tool>.approval_mode` for codex, and the
 * registered Pi tool name for pi. A comma, a dot, a quote, or whitespace in a
 * tool name would forge additional grants or a different config key out of one
 * legitimate one.
 *
 * A server that reports ANY name outside this shape fails the whole
 * observation — it is rejected, and the task is declined permanently rather
 * than partially granted. Granting the well-formed subset and silently
 * dropping the rest would hand the model a toolset it can only half call, and
 * would let one bad name ride along with good ones. The shape is deliberately
 * narrower than MCP's own (unbounded) name rule.
 */
export const GRANTABLE_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/u;

/**
 * The same rule for the SERVER half of the identifier, enforced at grant
 * resolution (`../adapters/mcp-tool-grants.ts`). A projected server name is
 * interpolated into `mcp__<server>__<tool>` for claude and into the flat TOML
 * key `mcp_servers.<server>.tools.<tool>.approval_mode` for codex: a `.` would
 * split that key into a different table, and a quote, comma, or space would
 * forge a second grant out of one.
 */
export const GRANTABLE_MCP_SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/u;

/** One tool exactly as its server described it. The model-visible truth, unedited. */
export interface McpToolDescriptor {
  readonly name: string;
  /** Empty string when the server supplied none; never inferred. */
  readonly description: string;
  /** The server's own JSON Schema, passed through verbatim. */
  readonly inputSchema: unknown;
}

/** Everything one `initialize` + `tools/list` exchange established about a server. */
export interface McpServerObservation {
  readonly serverName: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly protocolVersion: string;
  /** Ordered by tool name, code unit. */
  readonly tools: readonly McpToolDescriptor[];
}

/**
 * One observed server together with the toolset it was projected from.
 *
 * The toolset id is the daemon's fact, not the server's, so it is attached
 * here rather than inside {@link McpServerObservation}: the core observes
 * servers and knows nothing about the registry. Carrying it ON the entry
 * instead of in a parallel `serverName -> toolsetId` map is deliberate — two
 * structures that must agree are two structures that can disagree, and the
 * projection's ordering is derived from this id.
 */
export interface McpToolsetServerObservation extends McpServerObservation {
  readonly toolsetId: string;
}

export interface ObserveMcpServerOptions extends Omit<McpStdioClientOptions, 'maxStdoutBytes'> {
  readonly signal?: AbortSignal;
}

/**
 * Structural JSON equality: same keys, same values, arrays positionally.
 *
 * Object key ORDER is not part of a JSON value, so a server that re-emits the
 * same schema with its keys in another order has not changed anything and must
 * not read as drift. This is deliberately a comparison rather than a canonical
 * serialization: introducing a second canonical form here would make this
 * module a rival authority to the native `canonicalPreparedValue` that every
 * digest in this package is computed with.
 */
export function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEquals(value, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left as object).sort(compareCodeUnits);
  const rightKeys = Object.keys(right as object).sort(compareCodeUnits);
  if (leftKeys.length !== rightKeys.length) return false;
  if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
  return leftKeys.every((key) => jsonEquals(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
  ));
}

function validateTool(label: string, entry: unknown): McpToolDescriptor {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new McpAuthorityError(`${label} tools/list returned a malformed tool entry`);
  }
  const tool = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof tool.name !== 'string' || !GRANTABLE_TOOL_NAME.test(tool.name)) {
    throw new McpAuthorityError(
      `${label} tools/list reported an ungrantable tool name ${JSON.stringify(tool.name)}`,
    );
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    throw new McpAuthorityError(
      `${label} tools/list reported a non-string description for tool ${JSON.stringify(tool.name)}`,
    );
  }
  // The schema is what the model is shown and what every digest binds. A tool
  // without one is not describable, so there is nothing to fall back to.
  if (tool.inputSchema === null || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
    throw new McpAuthorityError(
      `${label} tools/list reported no object inputSchema for tool ${JSON.stringify(tool.name)}`,
    );
  }
  return Object.freeze({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
  });
}

/**
 * Start the exact configured stdio server, complete `initialize` +
 * `tools/list`, and return everything it said about itself.
 *
 * No `tools/call` is ever sent, so an authenticated task binding stays unused
 * until the real runtime invokes it. The child is always gone before this
 * resolves — the observation proves the server can start and enumerate its
 * tools; whoever runs it spawns their own copy.
 */
export async function observeMcpServer(
  serverName: string,
  server: McpStdioServerSpec,
  options: ObserveMcpServerOptions,
): Promise<McpServerObservation> {
  const label = options.label ?? `MCP server "${serverName}"`;
  const client = new McpStdioClient(server, {
    ...options,
    label,
    maxStdoutBytes: MCP_OBSERVATION_MAX_STDOUT_BYTES,
  });
  try {
    await client.connect(options.signal);
    const tools = await client.listTools(options.signal);
    const descriptors = tools.map((tool) => validateTool(label, tool));
    const names = new Set<string>();
    for (const tool of descriptors) {
      if (names.has(tool.name)) {
        throw new McpAuthorityError(
          `${label} tools/list reported tool name ${JSON.stringify(tool.name)} more than once`,
        );
      }
      names.add(tool.name);
    }
    return Object.freeze({
      serverName,
      serverInfo: client.serverInfo(),
      protocolVersion: client.protocolVersion(),
      tools: Object.freeze([...descriptors].sort((left, right) => compareCodeUnits(left.name, right.name))),
    });
  } finally {
    await client.close();
  }
}

/** Why a re-observation is not the observation that was frozen. */
export type McpObservationDriftReason =
  | 'tool_added'
  | 'tool_removed'
  | 'tool_description_changed'
  | 'tool_schema_changed'
  | 'server_info_changed'
  | 'protocol_version_changed';

export interface McpObservationDrift {
  readonly reason: McpObservationDriftReason;
  /** Absent for the two server-level reasons. */
  readonly toolName?: string;
  readonly detail: string;
}

/**
 * Compare a fresh observation against a frozen one and report EVERY way they
 * differ.
 *
 * Set equality, not containment: a tool that appeared is as much a drift as
 * one that vanished. A server that grew a tool between preparation and launch
 * is offering the model authority nobody froze, priced or disclosed — so an
 * extra tool is rejected rather than skipped, exactly like a missing one.
 *
 * The reasons are distinct on purpose. "The schema changed" and "a tool
 * disappeared" are different operational events with different fixes, and
 * collapsing them into one "drift" would hide which one happened.
 */
export function diffMcpObservation(
  frozen: McpServerObservation,
  observed: McpServerObservation,
): readonly McpObservationDrift[] {
  const drifts: McpObservationDrift[] = [];
  if (
    frozen.serverInfo.name !== observed.serverInfo.name
    || frozen.serverInfo.version !== observed.serverInfo.version
  ) {
    drifts.push({
      reason: 'server_info_changed',
      detail: `serverInfo ${frozen.serverInfo.name}@${frozen.serverInfo.version}`
        + ` became ${observed.serverInfo.name}@${observed.serverInfo.version}`,
    });
  }
  if (frozen.protocolVersion !== observed.protocolVersion) {
    drifts.push({
      reason: 'protocol_version_changed',
      detail: `protocolVersion ${frozen.protocolVersion} became ${observed.protocolVersion}`,
    });
  }
  const frozenByName = new Map(frozen.tools.map((tool) => [tool.name, tool]));
  const observedByName = new Map(observed.tools.map((tool) => [tool.name, tool]));
  for (const name of [...new Set([...frozenByName.keys(), ...observedByName.keys()])].sort(compareCodeUnits)) {
    const before = frozenByName.get(name);
    const after = observedByName.get(name);
    if (before === undefined) {
      drifts.push({ reason: 'tool_added', toolName: name, detail: `tool ${JSON.stringify(name)} was not frozen` });
      continue;
    }
    if (after === undefined) {
      drifts.push({ reason: 'tool_removed', toolName: name, detail: `frozen tool ${JSON.stringify(name)} is gone` });
      continue;
    }
    if (before.description !== after.description) {
      drifts.push({
        reason: 'tool_description_changed',
        toolName: name,
        detail: `description of ${JSON.stringify(name)} changed`,
      });
    }
    if (!jsonEquals(before.inputSchema, after.inputSchema)) {
      drifts.push({
        reason: 'tool_schema_changed',
        toolName: name,
        detail: `inputSchema of ${JSON.stringify(name)} changed`,
      });
    }
  }
  return Object.freeze(drifts);
}
