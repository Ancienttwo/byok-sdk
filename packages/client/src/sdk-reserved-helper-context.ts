import type { SdkReservedHelperKind } from './sdk-reserved-helper-host';

/**
 * What a task-scoped reserved helper reads from its private context file, the
 * one argument the daemon appends to the helper's argv. A runtime may store its
 * MCP entries in plain text beyond the session, so the entry carries only this
 * file's path.
 */
export interface SdkReservedMcpContext {
  readonly storeDir: string;
  readonly productId: string;
  readonly contextToken: string;
}

/** `toolList: 'granted'` lists only the tools `mode` grants; the prepared lane needs `complete`. */
export interface AgentMemoryMcpContext extends SdkReservedMcpContext {
  readonly mode: 'read' | 'read-write';
  readonly toolList: 'granted' | 'complete';
}

/** Arguments after `kind`: a task helper takes its context file. Pi hosts parse their own argv, so `undefined`. */
export function sdkReservedHelperArgumentCount(kind: SdkReservedHelperKind): number | undefined {
  switch (kind) {
    case 'agent-message-mcp': case 'agent-result-mcp': case 'agent-memory-mcp': return 1;
    case 'agent-memory-describe': case 'agent-team-mcp': return 0;
    case 'pi-rpc': case 'pi-prepared': case 'pi-durable': return undefined;
  }
}
