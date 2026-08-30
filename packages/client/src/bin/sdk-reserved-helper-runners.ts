import type { Readable } from 'node:stream';
import { connectControlClient, type ControlClient } from './control-client';
import { serveAgentMessageMcpOverStdio, type AgentMessageMcpDeps } from './agent-message-mcp-server';
import { serveAgentMemoryMcpOverStdio, type AgentMemoryMcpDeps } from './agent-memory-mcp-server';
import { serveTeamMcpOverStdio, type TeamMcpDeps } from './team-mcp-server';
import { serveApprovalMcpOverStdio, type ApprovalMcpDeps } from './approval-mcp-server';
import type { SdkReservedHelperKind } from '../sdk-reserved-helper-host';

const APPROVAL_REQUEST_TIMEOUT_SLOP_MS = 5_000;

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
  serveAgentMemoryMcpOverStdio({ deps });
  await waitForInputClose();
}

async function runApprovalMcp(): Promise<void> {
  const storeDir = required('BYOK_STORE_DIR');
  const productId = required('BYOK_PRODUCT_ID');
  const taskId = required('BYOK_TASK_ID');
  const timeoutMs = Number(process.env.BYOK_APPROVAL_TIMEOUT_MS ?? '600000');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('invalid BYOK_APPROVAL_TIMEOUT_MS environment variable');
  }
  let clientPromise: Promise<ControlClient> | undefined;
  const client = async (): Promise<ControlClient> => {
    if (!clientPromise) clientPromise = connectControlClient({
      storeDir,
      productId,
      requestTimeoutMs: timeoutMs + APPROVAL_REQUEST_TIMEOUT_SLOP_MS,
    }).then((result) => {
      if (!result.ok) throw new Error(result.reason);
      return result.client;
    });
    return clientPromise;
  };
  const deps: ApprovalMcpDeps = {
    requestApproval: async (requestedTaskId, summary) => {
      try {
        return await (await client()).request('approvals.request', { taskId: requestedTaskId, summary });
      } catch (error) {
        clientPromise = undefined;
        throw error;
      }
    },
  };
  serveApprovalMcpOverStdio({ taskId, deps });
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

export async function runSdkReservedHelper(kind: SdkReservedHelperKind): Promise<void> {
  switch (kind) {
    case 'agent-message-mcp':
      await runAgentMessageMcp();
      return;
    case 'agent-memory-mcp':
      await runAgentMemoryMcp();
      return;
    case 'approval-mcp':
      await runApprovalMcp();
      return;
    case 'agent-team-mcp':
      await runAgentTeamMcp();
      return;
  }
}
