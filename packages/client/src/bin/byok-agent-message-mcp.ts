#!/usr/bin/env node
import { connectControlClient, type ControlClient } from './control-client';
import { serveAgentMessageMcpOverStdio, type AgentMessageMcpDeps } from './agent-message-mcp-server';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const storeDir = required('BYOK_STORE_DIR');
  const productId = required('BYOK_PRODUCT_ID');
  const contextToken = required('BYOK_AGENT_MESSAGE_CONTEXT');
  let clientPromise: Promise<ControlClient> | undefined;
  const client = async (): Promise<ControlClient> => {
    if (!clientPromise) clientPromise = connectControlClient({ storeDir, productId }).then((result) => {
      if (!result.ok) throw new Error(result.reason);
      return result.client;
    });
    return clientPromise;
  };
  const deps: AgentMessageMcpDeps = {
    publish: async (input) => (await client()).request('agent_messages.publish', { contextToken, ...input }),
  };
  serveAgentMessageMcpOverStdio({ deps });
}

main().catch((error: unknown) => {
  process.stderr.write(`byok-agent-message-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
