import { createHash } from 'node:crypto';
import { PreparedAgentMemoryModeSchema, type PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import {
  AGENT_MEMORY_MCP_SERVER_INFO,
  AGENT_MEMORY_TOOLS,
  PREPARED_AGENT_MEMORY_OPERATION_META_KEY,
  type AgentMemoryOperation,
} from '../bin/agent-memory-mcp-server';

export { PREPARED_AGENT_MEMORY_OPERATION_META_KEY } from '../bin/agent-memory-mcp-server';

export interface PreparedAgentMemoryObservationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly _meta: Readonly<Record<typeof PREPARED_AGENT_MEMORY_OPERATION_META_KEY, AgentMemoryOperation>>;
}

/** SDK-specific tools/list observation. Generic Host MCP metadata is never accepted here. */
export interface PreparedAgentMemoryObservation {
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly protocolVersion: string;
  readonly tools: readonly PreparedAgentMemoryObservationTool[];
}

/** Model-visible selection contains schemas only. Executor identities are intentionally computed separately. */
export interface PreparedAgentMemorySelectedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface PreparedAgentMemoryImplementationDigests {
  /** Attested descriptor-helper identity; never supplied by a Host request. */
  readonly descriptor: string;
  /** Attested execution-helper identity; never supplied by a Host request. */
  readonly execution: string;
}

export function parsePreparedAgentMemoryMode(value: unknown): PreparedAgentMemoryMode {
  if (!PreparedAgentMemoryModeSchema.safeParse(value).success) throw new Error('prepared Agent memory mode must be none, read, or read-write');
  return value as PreparedAgentMemoryMode;
}

export function preparedAgentMemoryModeAllowsOperation(mode: PreparedAgentMemoryMode, operation: AgentMemoryOperation): boolean {
  return mode === 'read-write' || (mode === 'read' && operation === 'read');
}

export function preparedAgentMemoryModeWithinCeiling(requested: PreparedAgentMemoryMode, ceiling: PreparedAgentMemoryMode): boolean {
  const rank: Record<PreparedAgentMemoryMode, number> = { none: 0, read: 1, 'read-write': 2 };
  return rank[requested] <= rank[ceiling];
}

export function preparedAgentMemoryToolNames(mode: PreparedAgentMemoryMode): readonly string[] {
  return Object.freeze(AGENT_MEMORY_TOOLS.filter((tool) => preparedAgentMemoryModeAllowsOperation(mode, tool.operation)).map((tool) => tool.name));
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

/** Strict parser for the task-free SDK descriptor. Missing/unknown operation metadata fails closed. */
export function validatePreparedAgentMemoryObservation(value: unknown): PreparedAgentMemoryObservation {
  const raw = record(value, 'prepared Agent memory observation');
  exactKeys(raw, ['serverInfo', 'protocolVersion', 'tools']);
  const serverInfo = record(raw.serverInfo, 'prepared Agent memory serverInfo');
  exactKeys(serverInfo, ['name', 'version']);
  if (serverInfo.name !== AGENT_MEMORY_MCP_SERVER_INFO.name || serverInfo.version !== AGENT_MEMORY_MCP_SERVER_INFO.version) throw new Error('prepared Agent memory serverInfo mismatch');
  if (typeof raw.protocolVersion !== 'string' || raw.protocolVersion.length === 0) throw new Error('prepared Agent memory protocolVersion is invalid');
  if (!Array.isArray(raw.tools) || raw.tools.length !== AGENT_MEMORY_TOOLS.length) throw new Error('prepared Agent memory descriptor must contain the complete tool set');
  const tools = raw.tools.map((entry, index) => {
    const tool = record(entry, 'prepared Agent memory tool');
    exactKeys(tool, ['name', 'description', 'inputSchema', '_meta']);
    const expected = AGENT_MEMORY_TOOLS[index]!;
    const meta = record(tool._meta, 'prepared Agent memory tool _meta');
    if (tool.name !== expected.name || tool.description !== expected.description || canonicalPreparedAgentMemoryJson(tool.inputSchema) !== canonicalPreparedAgentMemoryJson(expected.inputSchema)
      || meta[PREPARED_AGENT_MEMORY_OPERATION_META_KEY] !== expected.operation || Object.keys(meta).length !== 1)
      throw new Error('prepared Agent memory descriptor drift');
    return Object.freeze({ name: expected.name, description: expected.description ?? '', inputSchema: expected.inputSchema,
      _meta: Object.freeze({ [PREPARED_AGENT_MEMORY_OPERATION_META_KEY]: expected.operation }) });
  });
  return Object.freeze({ serverInfo: Object.freeze({ ...AGENT_MEMORY_MCP_SERVER_INFO }), protocolVersion: raw.protocolVersion, tools: Object.freeze(tools) });
}

export function preparedAgentMemoryTools(mode: PreparedAgentMemoryMode, observation: PreparedAgentMemoryObservation): readonly PreparedAgentMemorySelectedTool[] {
  parsePreparedAgentMemoryMode(mode);
  return Object.freeze(observation.tools
    .filter((tool) => preparedAgentMemoryModeAllowsOperation(mode, tool._meta[PREPARED_AGENT_MEMORY_OPERATION_META_KEY]))
    .map((tool) => Object.freeze({ name: tool.name, description: tool.description, parameters: tool.inputSchema })));
}

export function preparedAgentMemoryDescriptorDigest(observation: PreparedAgentMemoryObservation): string {
  return digest({ v: 1, serverInfo: observation.serverInfo, protocolVersion: observation.protocolVersion, tools: observation.tools });
}

/** Per-tool executor fingerprints bind the complete descriptor, selected mode, both attested helper identities, and runtime identity. */
export function preparedAgentMemoryExecutorFingerprints(
  observation: PreparedAgentMemoryObservation,
  mode: PreparedAgentMemoryMode,
  implementation: PreparedAgentMemoryImplementationDigests,
  runtimeIdentity: string,
): readonly string[] {
  parsePreparedAgentMemoryMode(mode);
  if (implementation.descriptor.length === 0 || implementation.execution.length === 0 || runtimeIdentity.length === 0) {
    throw new Error('prepared Agent memory executor identity is invalid');
  }
  const descriptorDigest = preparedAgentMemoryDescriptorDigest(observation);
  return Object.freeze(preparedAgentMemoryTools(mode, observation).map((tool) => digest({
    v: 1, mode, descriptorDigest, descriptorIdentity: implementation.descriptor,
    executionIdentity: implementation.execution, runtimeIdentity, tool,
  })));
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalPreparedAgentMemoryJson(value), 'utf8').digest('hex')}`;
}

/** The sole canonical serialization used by descriptor validation and both memory digests. */
export function canonicalPreparedAgentMemoryJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('prepared Agent memory canonical value is unsupported');
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPreparedAgentMemoryJson).join(',')}]`;
  const object = record(value, 'prepared Agent memory canonical value');
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalPreparedAgentMemoryJson(object[key])}`).join(',')}}`;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`prepared Agent memory descriptor keys invalid; expected ${keys.join(',')}`);
}
