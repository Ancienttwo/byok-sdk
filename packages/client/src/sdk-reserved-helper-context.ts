import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SdkReservedHelperKind } from './sdk-reserved-helper-host.js';

/**
 * What a task-scoped MCP server gets from its private context file, the one
 * argument the daemon appends to its argv. A reserved helper reads the file
 * itself; `requestTaskAssertion` reads it for a Host toolset server, whose
 * format stays internal. A runtime may store its MCP entries in plain text
 * beyond the session, so the entry carries only this file's path.
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

/** The daemon's context file, the one source of a task-scoped MCP server's identity. Throws when unusable. */
export async function readMcpContextFile(file: string): Promise<SdkReservedMcpContext & Readonly<Record<string, unknown>>> {
  if (!path.isAbsolute(file)) throw new Error('the MCP context file path must be absolute');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (cause) {
    throw new Error(`cannot read the MCP context file ${file}`, { cause });
  }
  const context = (parsed ?? {}) as Partial<SdkReservedMcpContext>;
  for (const field of ['storeDir', 'productId', 'contextToken'] as const) {
    if (typeof context[field] !== 'string' || context[field] === '') {
      throw new Error(`MCP context file ${file} has no ${field}`);
    }
  }
  return context as SdkReservedMcpContext & Readonly<Record<string, unknown>>;
}

/** Arguments after `kind`: a task helper takes its context file. Pi hosts parse their own argv, so `undefined`. */
export function sdkReservedHelperArgumentCount(kind: SdkReservedHelperKind): number | undefined {
  switch (kind) {
    case 'agent-message-mcp': case 'agent-result-mcp': case 'agent-memory-mcp': return 1;
    case 'agent-memory-describe': case 'agent-team-mcp': return 0;
    case 'pi-rpc': case 'pi-prepared': case 'pi-durable': return undefined;
  }
}
