import type { PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import { resolveSdkHelperImplementation, sdkHelperLaunch, parseToolImplementationIdentity, type ToolImplementationAuthority, type ToolImplementationAttestedV1, type ToolImplementationFsProbe, type SdkHelperSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import { McpStdioClient, MCP_OBSERVATION_MAX_STDOUT_BYTES } from '../mcp/client';
import { inputPreparationDigest } from '../input-preparation';
import { validatePreparedAgentMemoryObservation, preparedAgentMemoryTools, preparedAgentMemoryExecutorFingerprints, type PreparedAgentMemoryObservation } from '../agent-memory/prepared-capability';
import type { McpLaunchAttestation } from './trusted-launch-cwd';

export interface PreparedAgentMemoryImplementation {
  readonly descriptor: ToolImplementationAttestedV1;
  readonly execution: ToolImplementationAttestedV1;
}
export interface PreparedAgentMemoryState {
  readonly implementation: PreparedAgentMemoryImplementation;
  readonly observation: PreparedAgentMemoryObservation;
}
export async function resolvePreparedMemoryImplementation(authority: ToolImplementationAuthority | undefined, env: Readonly<Record<string,string>>, launch: McpLaunchAttestation, probe?: ToolImplementationFsProbe): Promise<PreparedAgentMemoryImplementation> {
  const descriptor = await resolveSdkHelperImplementation(authority, { subject: {kind:'sdk-helper',helperId:'agent-memory'}, entry:'agent-memory-describe' }, env, probe);
  const execution = await resolveSdkHelperImplementation(authority, { subject: {kind:'sdk-helper',helperId:'agent-memory'}, entry:'agent-memory-mcp' }, env, probe);
  if (descriptor.kind !== 'attested' || execution.kind !== 'attested') throw new Error('agent_memory_implementation_unproven');
  if (descriptor.launchCwd !== launch.launchCwd || execution.launchCwd !== launch.launchCwd) throw new Error('agent_memory_launch_mismatch');
  return Object.freeze({descriptor, execution});
}
export function memorySpawnBinding(identity: ToolImplementationAttestedV1, entry: 'agent-memory-describe'|'agent-memory-mcp', mode: PreparedAgentMemoryMode): SdkHelperSpawnBindingV1 {
  const launch = sdkHelperLaunch(identity, entry);
  if (!launch || (entry === 'agent-memory-mcp' && mode === 'none')) throw new Error('agent_memory_launch_invalid');
  return Object.freeze({format:'byok.sdk-helper-spawn',version:1,subject:{kind:'sdk-helper' as const,helperId:'agent-memory' as const},helperEntry:entry,identity,...launch,...(entry === 'agent-memory-mcp' ? {agentMemoryMode:mode as 'read'|'read-write'} : {})});
}
export function memoryServer(binding: SdkHelperSpawnBindingV1) {
  return {command:binding.command,args:[...(binding.entry === undefined ? [] : [binding.entry]),...binding.fixedArgv]};
}
export async function observePreparedMemory(implementation: PreparedAgentMemoryImplementation, env: Readonly<Record<string,string>>, signal?: AbortSignal, probe?: ToolImplementationFsProbe): Promise<PreparedAgentMemoryState> {
  const binding = memorySpawnBinding(implementation.descriptor,'agent-memory-describe','none');
  const client = new McpStdioClient(memoryServer(binding), {env,cwd:binding.cwd,sdkHelperBinding:binding,implementationFsProbe:probe,maxStdoutBytes:MCP_OBSERVATION_MAX_STDOUT_BYTES,timeoutMs:10_000});
  try {
    await client.connect(signal);
    const observation = validatePreparedAgentMemoryObservation({serverInfo:client.serverInfo(),protocolVersion:client.protocolVersion(),tools:await client.listTools(signal)});
    return Object.freeze({implementation,observation});
  } finally { await client.close(); }
}
export function preparedMemoryProjection(mode: PreparedAgentMemoryMode, memory: PreparedAgentMemoryState|null, runtimeIdentity: string) {
  if (mode === 'none') {
    if (memory !== null) throw new Error('agent_memory_unselected');
    return {tools:[],toolExecutors:{},toolImplementationKinds:{}};
  }
  if (memory === null) throw new Error('agent_memory_observation_missing');
  const tools = preparedAgentMemoryTools(mode,memory.observation);
  const identities = preparedAgentMemoryExecutorFingerprints(memory.observation,mode,{descriptor:inputPreparationDigest(memory.implementation.descriptor),execution:inputPreparationDigest(memory.implementation.execution)},runtimeIdentity);
  return {tools,toolExecutors:Object.fromEntries(tools.map((t,i)=>[t.name,identities[i]!])),toolImplementationKinds:Object.fromEntries(tools.map(t=>[t.name,'attested']))};
}
export function parsePreparedMemoryState(raw: unknown): PreparedAgentMemoryState|null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('agent_memory_state_invalid');
  const data = raw as Record<string,unknown>;
  if (Object.keys(data).sort().join(',') !== 'implementation,observation' || !data.implementation || typeof data.implementation !== 'object') throw new Error('agent_memory_state_invalid');
  const pair = data.implementation as Record<string,unknown>;
  if(Object.keys(pair).sort().join(',') !== 'descriptor,execution') throw new Error('agent_memory_identity_invalid');
  const descriptor = parseToolImplementationIdentity(pair.descriptor);
  const execution = parseToolImplementationIdentity(pair.execution);
  if (descriptor?.kind !== 'attested' || execution?.kind !== 'attested') throw new Error('agent_memory_identity_unproven');
  memorySpawnBinding(descriptor,'agent-memory-describe','none'); memorySpawnBinding(execution,'agent-memory-mcp','read');
  return Object.freeze({implementation:{descriptor,execution},observation:validatePreparedAgentMemoryObservation(data.observation)});
}
