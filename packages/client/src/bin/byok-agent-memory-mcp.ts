#!/usr/bin/env node
import { connectControlClient, type ControlClient } from './control-client';
import { serveAgentMemoryMcpOverStdio, type AgentMemoryMcpDeps } from './agent-memory-mcp-server';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`missing required environment variable ${name}`); return value; }
async function main(): Promise<void> {
  const storeDir = required('BYOK_STORE_DIR'); const productId = required('BYOK_PRODUCT_ID'); const contextToken = required('BYOK_AGENT_MEMORY_CONTEXT');
  let clientPromise: Promise<ControlClient> | undefined;
  const client = async (): Promise<ControlClient> => {
    if (!clientPromise) clientPromise = connectControlClient({ storeDir, productId }).then((result) => { if (!result.ok) throw new Error(result.reason); return result.client; });
    return clientPromise;
  };
  const deps: AgentMemoryMcpDeps = {
    recall: async (input) => (await client()).request('agent_memory.recall', { contextToken, ...input }),
    save: async (input) => (await client()).request('agent_memory.save', { contextToken, ...input }),
  };
  serveAgentMemoryMcpOverStdio({ deps });
}
main().catch((error: unknown) => { process.stderr.write(`byok-agent-memory-mcp: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
