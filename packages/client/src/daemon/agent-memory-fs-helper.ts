import type { AgentHomeLease } from '../agent-home.js';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem.js';
import {
  AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL as protocol,
  AGENT_MEMORY_FILESYSTEM_HELPER_VERSION as version,
  isAgentMemoryFilesystemHelperSupported as supported,
  agentMemoryHelperIdentity as identity,
  agentMemoryHelperIdentityMatches as identityMatches,
  openAgentMemoryFilesystemHelperWithBudget,
} from './agent-memory-fs-helper-internal.js';

export const AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL = protocol;
export const AGENT_MEMORY_FILESYSTEM_HELPER_VERSION = version;

export function isAgentMemoryFilesystemHelperSupported(): boolean {
  return supported();
}

/** Private helper protocol identity. Decimal strings keep all 64 bits. */
export type AgentMemoryHelperIdentity =
  | Readonly<{ kind: 'unix'; dev: string; ino: string }>
  | Readonly<{ kind: 'windows'; volumeSerial: string; fileIndex: string }>;


/** Serialization is not platform admission or a durability proof. */
export function agentMemoryHelperIdentity(home: AgentHomeLease['homeIdentity'], platform: NodeJS.Platform): AgentMemoryHelperIdentity {
  return identity(home, platform);
}

export function agentMemoryHelperIdentityMatches(value: unknown, expected: AgentMemoryHelperIdentity): boolean {
  return identityMatches(value, expected);
}

export async function openAgentMemoryFilesystemHelper(input: Readonly<{ helperBin: string; assetRoot?: string | undefined; canonicalHome: string; ancestorRoot: string; homeIdentity: AgentHomeLease['homeIdentity'] }>): Promise<AgentMemoryFilesystem> {
  return openAgentMemoryFilesystemHelperWithBudget(input);
}
