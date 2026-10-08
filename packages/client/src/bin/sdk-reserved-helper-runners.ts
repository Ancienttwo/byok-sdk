import type { Readable } from 'node:stream';
import { connectControlClient, type ControlClient } from './control-client';
import { serveAgentMessageMcpOverStdio, type AgentMessageMcpDeps } from './agent-message-mcp-server';
import { serveAgentMemoryDescriptorOverStdio, serveAgentMemoryMcpOverStdio, type AgentMemoryMcpDeps } from './agent-memory-mcp-server';
import { parsePreparedAgentMemoryMode } from '../agent-memory/prepared-capability';
import { serveTeamMcpOverStdio, type TeamMcpDeps } from './team-mcp-server';
import type { SdkReservedHelperKind } from '../sdk-reserved-helper-host';


function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function waitForInputClose(input: Readable = process.stdin): Promise<void> {
  if (input.readableEnded || input.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      input.off('end', done);
      input.off('close', done);
      resolve();
    };
    input.once('end', done);
    input.once('close', done);
  });
}

async function runAgentMessageMcp(): Promise<void> {
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
  await waitForInputClose();
}

async function runAgentMemoryMcp(): Promise<void> {
  const storeDir = required('BYOK_STORE_DIR');
  const productId = required('BYOK_PRODUCT_ID');
  const contextToken = required('BYOK_AGENT_MEMORY_CONTEXT');
  const mode = parsePreparedAgentMemoryMode(required('BYOK_PREPARED_AGENT_MEMORY_MODE'));
  if (mode === 'none') throw new Error('BYOK_PREPARED_AGENT_MEMORY_MODE must grant read or read-write');
  let clientPromise: Promise<ControlClient> | undefined;
  const client = async (): Promise<ControlClient> => {
    if (!clientPromise) clientPromise = connectControlClient({ storeDir, productId }).then((result) => {
      if (!result.ok) throw new Error(result.reason);
      return result.client;
    });
    return clientPromise;
  };
  const deps: AgentMemoryMcpDeps = {
    recall: async (input) => (await client()).request('agent_memory.recall', { contextToken, ...input }),
    save: async (input) => (await client()).request('agent_memory.save', { contextToken, ...input }),
  };
  serveAgentMemoryMcpOverStdio({ deps, mode });
  await waitForInputClose();
}

async function runAgentMemoryDescribe(): Promise<void> {
  for (const name of ['BYOK_STORE_DIR', 'BYOK_PRODUCT_ID', 'BYOK_AGENT_MEMORY_CONTEXT', 'BYOK_PREPARED_AGENT_MEMORY_MODE']) {
    if (process.env[name] !== undefined) throw new Error(`agent-memory-describe rejects ${name}`);
  }
  serveAgentMemoryDescriptorOverStdio({});
  await waitForInputClose();
}

async function runAgentTeamMcp(): Promise<void> {
  const storeDir = required('BYOK_STORE_DIR');
  const productId = required('BYOK_PRODUCT_ID');
  const lease = required('BYOK_TEAM_MEMBER_CONTEXT');
  let clientPromise: Promise<ControlClient> | undefined;
  const client = async (): Promise<ControlClient> => {
    if (!clientPromise) clientPromise = connectControlClient({ storeDir, productId }).then((result) => {
      if (!result.ok) throw new Error(result.reason);
      return result.client;
    });
    return clientPromise;
  };
  const deps: TeamMcpDeps = {
    post: async (input) => (await client()).request('team_messages.post', { context: lease, ...input }),
    read: async (input) => (await client()).request('team_messages.read', { context: lease, ...input }),
    ack: async (input) => (await client()).request('team_messages.ack', { context: lease, ...input }),
  };
  serveTeamMcpOverStdio({ deps });
  await waitForInputClose();
}

export async function runSdkReservedHelper(kind: SdkReservedHelperKind, argv: readonly string[] = []): Promise<void> {
  if (kind !== 'pi-rpc' && kind !== 'pi-prepared' && kind !== 'pi-durable' && argv.length !== 0) {
    throw new Error('SDK-reserved MCP helpers do not accept arguments');
  }
  switch (kind) {
    // The reserved helper is the single-file re-entry, which bundles Pi.
    case 'pi-rpc':
      await (await import('#byok-pi-runtime-host')).runPiRpcHost(argv, 'bundled');
      return;
    case 'pi-durable':
      await (await import('#byok-pi-runtime-host')).runPiDurableHost(argv);
      return;
    case 'pi-prepared':
      await (await import('#byok-pi-runtime-host')).runPiPreparedHost(argv);
      return;
    case 'agent-message-mcp':
      await runAgentMessageMcp();
      return;
    case 'agent-memory-mcp':
      await runAgentMemoryMcp();
      return;
    case 'agent-memory-describe':
      await runAgentMemoryDescribe();
      return;
    case 'agent-team-mcp':
      await runAgentTeamMcp();
      return;
  }
}
