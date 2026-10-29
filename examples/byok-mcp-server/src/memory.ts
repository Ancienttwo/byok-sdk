import type { HostMemoryPage } from '@byok-sdk/server/execution-core';
import type { AgentRef } from '@byok-sdk/protocol';
import type { ScopedTool } from './http';
import type { BetaLedger } from './ledger';
import { BetaError } from './model';
import { input, json } from './tools';

export interface MemoryToolOptions {
  readonly ledger: BetaLedger;
  /**
   * The Host's own K4 memory page, which receives the device's redacted `agent.memory.projection`.
   * Its `contextPack` is the only read; the tools keep no copy of memory text.
   */
  readonly memory: Pick<HostMemoryPage, 'contextPack'>;
  /** The device that holds this Agent's home now, from the same trusted Host state as the page's `isCurrent`. */
  placement(agentRef: Readonly<AgentRef>): string | undefined;
}

/** The B5 memory catalogue: read-only (beta plan §9 Q9). Writes wait for PRD P5. */
export function createMemoryTools(options: MemoryToolOptions): ScopedTool[] {
  const { ledger } = options;
  return [
    {
      scope: 'memory.read',
      definition: { name: 'byok_memory_read',
        description: 'Read the byok Agent-home memory (MEMORY.md) of the byok Agent bound to this key. This is not your own conversation memory. '
          + 'The text is the redacted projection the Host holds, with its revision and time. text is null when the Host holds no current '
          + 'projection: none yet, none approved for projection, or a newer write waits for the next one. Read-only.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {
          path: { type: 'string', enum: ['MEMORY.md'], description: 'Only MEMORY.md (the default). The Host projects no notes/ files.' },
        } } },
      async call(caller, args) {
        const value = input(args, ['path']);
        if (value.path !== undefined && value.path !== 'MEMORY.md') throw new BetaError('invalid_input', 'path must be MEMORY.md; the Host projects no notes/ files');
        const key = ledger.authorize(caller, 'memory.read');
        // A memory grant always has an AgentRef (B2 key contract).
        const agentRef = key.agentRef!;
        const deviceId = options.placement(agentRef);
        if (deviceId === undefined) throw new BetaError('unavailable', 'The byok Agent has no current device', 60);
        if (!key.deviceIds.includes(deviceId)) throw new BetaError('forbidden', 'Device or runtime not granted');
        let resident;
        try { resident = options.memory.contextPack({ deviceId, agentRef: structuredClone(agentRef) }).residentMemory; }
        catch {
          // The page refuses a changed placement or profile, a revoked projection grant and an oversized MEMORY.md.
          throw new BetaError('unavailable', 'The byok Agent memory is not readable now. The Host owner must check its placement, projection grant and size.');
        }
        return json({ path: 'MEMORY.md', text: resident?.text ?? null,
          ...(resident ? { revision: resident.mutationId, projectedAt: resident.projectedAt } : {}) });
      },
    },
  ];
}
