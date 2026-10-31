import type { Readable } from 'node:stream';
import { connectControlClient, type ControlClient } from '../daemon/control-client';
import { serveAgentMessageMcpOverStdio, type AgentMessageMcpDeps } from './agent-message-mcp-server';
import { serveAgentResultMcpOverStdio, type AgentResultMcpDeps } from './agent-result-mcp-server';
import { serveAgentMemoryDescriptorOverStdio, serveAgentMemoryMcpOverStdio, serveGrantedAgentMemoryMcpOverStdio, type AgentMemoryMcpDeps } from './agent-memory-mcp-server';
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

/** The context token arrives by env, as for the message helper; the frozen schema only over the control socket. */
async function runAgentResultMcp(): Promise<void> {
  const storeDir = required('BYOK_STORE_DIR');
  const productId = required('BYOK_PRODUCT_ID');
  const contextToken = required('BYOK_AGENT_RESULT_CONTEXT');
  let clientPromise: Promise<ControlClient> | undefined;
  const client = async (): Promise<ControlClient> => {
    if (!clientPromise) clientPromise = connectControlClient({ storeDir, productId }).then((result) => {
      if (!result.ok) throw new Error(result.reason);
      return result.client;
    });
    return clientPromise;
  };
  const deps: AgentResultMcpDeps = {
    describe: async () => (await client()).request('agent_results.describe', { contextToken }),
    submit: async (outcome) => (await client()).request('agent_results.submit', { contextToken, outcome }),
  };
  await serveAgentResultMcpOverStdio({ deps });
  await waitForInputClose();
  // describe opened the control connection at startup; an open socket would
  // keep the helper alive after its MCP client closed stdin.
  (await clientPromise?.catch(() => undefined))?.close();
}

async function runAgentMemoryMcp(): Promise<void> {
  const storeDir = required('BYOK_STORE_DIR');
  const productId = required('BYOK_PRODUCT_ID');
  const contextToken = required('BYOK_AGENT_MEMORY_CONTEXT');
  const mode = parsePreparedAgentMemoryMode(required('BYOK_PREPARED_AGENT_MEMORY_MODE'));
  if (mode === 'none') throw new Error('BYOK_PREPARED_AGENT_MEMORY_MODE must grant read or read-write');
  const toolList = process.env.BYOK_AGENT_MEMORY_TOOL_LIST;
  if (toolList !== undefined && toolList !== 'granted') throw new Error('BYOK_AGENT_MEMORY_TOOL_LIST must be granted when present');
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
  if (toolList === 'granted') serveGrantedAgentMemoryMcpOverStdio({ deps, mode });
  else serveAgentMemoryMcpOverStdio({ deps, mode });
  await waitForInputClose();
}

async function runAgentMemoryDescribe(): Promise<void> {
  for (const name of ['BYOK_STORE_DIR', 'BYOK_PRODUCT_ID', 'BYOK_AGENT_MEMORY_CONTEXT', 'BYOK_PREPARED_AGENT_MEMORY_MODE', 'BYOK_AGENT_MEMORY_TOOL_LIST']) {
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

/**
 * The Pi kinds import the Pi runtime host here. The caller must load Node's
 * undici first (#700); `runSdkReservedHelperCommand` does.
 */
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
    case 'agent-result-mcp':
      await runAgentResultMcp();
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
