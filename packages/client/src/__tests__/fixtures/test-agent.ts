import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRef } from '@byok-sdk/protocol';
import { expect } from 'vitest';
import { AgentHomeManager } from '../../agent-home';
import { AgentSessionHandoffStore } from '../../daemon/agent-session-handoff-store';
import { isAgentMemorySecureFilesystemAvailable } from '../../daemon/agent-memory';
import { isAgentMemoryFilesystemHelperSupported } from '../../daemon/agent-memory-fs-helper';
import { prependAgentMemoryGuidance, prependAgentMemoryModeGuidance } from '../../daemon/memory-guidance';
import { resolveAgentMemoryFilesystemHelper } from '../../util/agent-memory-helper-release';

// Wire v4 has only Agent offers. Tests whose subject is not the Agent home
// itself run each offer as its own Agent, so concurrent tasks never share a
// home and meet its single-writer admission.
let agentSerial = 0;

/** A new AgentRef for each call. */
export function freshTestAgentRef(): AgentRef {
  agentSerial += 1;
  return { agentId: `test-agent-${agentSerial}`, profileRevision: 'rev-1' };
}

function hostStorageRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'byok-test-agent-home-'));
}

/** `TaskRunnerDeps` members an Agent offer needs. */
export function testAgentHomeDeps(): { agentHome: AgentHomeManager; agentSessionHandoffs: AgentSessionHandoffStore } {
  return { agentHome: new AgentHomeManager({ hostStorageRoot: hostStorageRoot() }), agentSessionHandoffs: new AgentSessionHandoffStore() };
}

/** `DaemonConfig.agentHome` for a test daemon. */
export function testAgentHomeConfig(): { hostStorageRoot: string } {
  return { hostStorageRoot: hostStorageRoot() };
}

/** Matches the `agentRef` a terminal echoes for an offer from {@link freshTestAgentRef}. */
export const echoedTestAgentRef = expect.objectContaining({ agentId: expect.stringMatching(/^test-agent-\d+$/), profileRevision: 'rev-1' });

/** What a fresh task of a new Agent runs on a daemon that admits the memory MCP: the guidance and its empty `MEMORY.md` before the instruction. */
export function freshMemoryInstruction(instruction: string, { reader = false, mode = reader ? 'read' : 'read-write' }: { reader?: boolean; mode?: 'read' | 'read-write' } = {}): string {
  return prependAgentMemoryModeGuidance(instruction, mode, reader, {
    content: '', revision: `sha256:${createHash('sha256').update('').digest('hex')}`, byteCount: 0,
  });
}

function daemonAdmitsMemoryMcp(): boolean {
  if (!isAgentMemoryFilesystemHelperSupported()) return isAgentMemorySecureFilesystemAvailable();
  try {
    resolveAgentMemoryFilesystemHelper();
    return true;
  } catch {
    return false;
  }
}

/** The same task on a `createDaemon` default, which admits the memory MCP when the platform or a built helper allows it. Otherwise the guidance reads the file. */
export function daemonMemoryInstruction(instruction: string): string {
  return daemonAdmitsMemoryMcp() ? freshMemoryInstruction(instruction) : prependAgentMemoryGuidance(instruction);
}
