import type { AgentHomeLease } from '../agent-home';
import { AgentMemoryError } from './agent-memory';

/** Private protocol 2 identity. Decimal strings keep all 64 bits. */
export type AgentMemoryHelperIdentity =
  | Readonly<{ kind: 'unix'; dev: string; ino: string }>
  | Readonly<{ kind: 'windows'; volumeSerial: string; fileIndex: string }>;

function unsigned(value: bigint, bits: 32 | 64): string {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << BigInt(bits))) {
    throw new AgentMemoryError('Agent memory filesystem helper root identity is invalid');
  }
  return value.toString(10);
}

/** Serialization is not platform admission or a durability proof. */
export function agentMemoryHelperIdentity(home: AgentHomeLease['homeIdentity'], platform: NodeJS.Platform): AgentMemoryHelperIdentity {
  if (platform === 'win32') {
    return Object.freeze({ kind: 'windows', volumeSerial: unsigned(home.dev, 32), fileIndex: unsigned(home.ino, 64) });
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new AgentMemoryError('Agent memory filesystem helper identity is not supported on this platform');
  }
  return Object.freeze({ kind: 'unix', dev: unsigned(home.dev, 64), ino: unsigned(home.ino, 64) });
}

export function agentMemoryHelperIdentityMatches(value: unknown, expected: AgentMemoryHelperIdentity): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const entries = Object.entries(expected);
  return Object.keys(actual).length === entries.length && entries.every(([key, entry]) => actual[key] === entry);
}
