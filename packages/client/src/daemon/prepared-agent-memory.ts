import type { PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import { McpStdioClient, MCP_OBSERVATION_MAX_STDOUT_BYTES } from '../mcp/client';
import { validatePreparedAgentMemoryObservation, preparedAgentMemoryTools, preparedAgentMemoryExecutorFingerprints, type PreparedAgentMemoryObservation } from '../agent-memory/prepared-capability';

/** The SDK-owned Agent-memory helper launch (`resolveSdkReservedHelperBin`). */
export interface PreparedAgentMemoryHelper {
  readonly command: string;
  readonly args: readonly string[];
}

/** The task-free descriptor observation a preparation is counted over. */
export interface PreparedAgentMemoryState {
  readonly observation: PreparedAgentMemoryObservation;
}

/** Spawn the task-free descriptor helper and read its tools/list answer. */
export async function observePreparedMemory(
  describe: PreparedAgentMemoryHelper,
  env: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<PreparedAgentMemoryState> {
  const client = new McpStdioClient({ command: describe.command, args: [...describe.args] }, {
    env, maxStdoutBytes: MCP_OBSERVATION_MAX_STDOUT_BYTES, timeoutMs: 10_000,
  });
  try {
    await client.connect(signal);
    const observation = validatePreparedAgentMemoryObservation({
      serverInfo: client.serverInfo(), protocolVersion: client.protocolVersion(), tools: await client.listTools(signal),
    });
    return Object.freeze({ observation });
  } finally { await client.close(); }
}

export function preparedMemoryProjection(mode: PreparedAgentMemoryMode, memory: PreparedAgentMemoryState | null, runtimeIdentity: string) {
  if (mode === 'none') {
    if (memory !== null) throw new Error('agent_memory_unselected');
    return { tools: [], toolExecutors: {} };
  }
  if (memory === null) throw new Error('agent_memory_observation_missing');
  const tools = preparedAgentMemoryTools(mode, memory.observation);
  const fingerprints = preparedAgentMemoryExecutorFingerprints(memory.observation, mode, runtimeIdentity);
  return { tools, toolExecutors: Object.fromEntries(tools.map((t, i) => [t.name, fingerprints[i]!])) };
}

export function parsePreparedMemoryState(raw: unknown): PreparedAgentMemoryState | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('agent_memory_state_invalid');
  const data = raw as Record<string, unknown>;
  if (Object.keys(data).join(',') !== 'observation') throw new Error('agent_memory_state_invalid');
  return Object.freeze({ observation: validatePreparedAgentMemoryObservation(data.observation) });
}
