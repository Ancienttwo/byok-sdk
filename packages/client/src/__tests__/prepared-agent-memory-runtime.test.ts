import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import type { SpawnFn } from '../adapters/pi/rpc-client';
import { validatePreparedAgentMemoryObservation } from '../agent-memory/prepared-capability';
import { AGENT_MEMORY_MCP_SERVER_INFO, AGENT_MEMORY_TOOLS } from '../bin/agent-memory-mcp-server';
import { INPUT_PREPARATION_ARTIFACT_FORMAT, INPUT_PREPARATION_VERSION } from '../input-preparation';
import { AGENT_MEMORY_MCP_SERVER_NAME } from '../sdk-reserved-mcp';
import { sealRuntimeOperationManifest, type RuntimePreparedLaunchV1 } from '../types';
import { openPreparedMemoryCall } from '../bin/pi-prepared-host';
import { McpStdioClient } from '../mcp/client';

const TIMING_HOST = fileURLToPath(new URL('./fixtures/prepared-response-timing-host.mjs', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const MODEL = {
  id: 'memory-runtime-model',
  name: 'Memory runtime model',
  api: 'openai-completions' as const,
  provider: 'memory-runtime-provider',
  baseUrl: 'http://127.0.0.1:1/v1',
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const MEMORY = {
  observation: validatePreparedAgentMemoryObservation({
    serverInfo: AGENT_MEMORY_MCP_SERVER_INFO,
    protocolVersion: '2025-03-26',
    tools: AGENT_MEMORY_TOOLS.map(({ name, description, inputSchema, _meta }) => ({
      name, description, inputSchema, _meta,
    })),
  }),
} as const;

function runtimeMemoryConfig() {
  return {
    agentMemory: 'read',
    cwd: '/',
    memory: MEMORY,
    memoryCall: {
      command: '/execution',
      args: ['__byok_sdk_helper', 'agent-memory-mcp'],
      env: {
        BYOK_STORE_DIR: '/private/store',
        BYOK_PRODUCT_ID: 'product',
        BYOK_AGENT_MEMORY_CONTEXT: 'context',
        BYOK_PREPARED_AGENT_MEMORY_MODE: 'read',
      },
    },
    mcp: { mcpEnv: {} },
  } as never;
}

function wireTools() {
  return AGENT_MEMORY_TOOLS.map(({ name, description, inputSchema, _meta }) => ({
    name, description, inputSchema, _meta,
  }));
}

function mockHealthyMemoryHelper() {
  vi.spyOn(McpStdioClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(McpStdioClient.prototype, 'serverInfo').mockReturnValue(AGENT_MEMORY_MCP_SERVER_INFO);
  vi.spyOn(McpStdioClient.prototype, 'protocolVersion').mockReturnValue('2025-03-26');
  vi.spyOn(McpStdioClient.prototype, 'listTools').mockResolvedValue(wireTools() as never);
  return vi.spyOn(McpStdioClient.prototype, 'close').mockResolvedValue(undefined);
}

describe('prepared Agent memory runtime configuration', () => {
  it('registers only the selected read tool through its separate memory call', async () => {
    const close = mockHealthyMemoryHelper();
    const callTool = vi.spyOn(McpStdioClient.prototype, 'callTool').mockResolvedValue({
      content: [{ type: 'text', text: 'memory result' }],
    } as never);

    // This is a transport-boundary mock: this test pins the runtime's
    // descriptor parity and call routing without pretending a test fixture is
    // an installed SDK helper.
    const memoryCall = await openPreparedMemoryCall(runtimeMemoryConfig());
    if (memoryCall === undefined) throw new Error('selected memory produced no runtime call');
    await expect(memoryCall.call('memory_recall', { path: 'MEMORY.md' })).resolves.toEqual({
      content: [{ type: 'text', text: 'memory result' }],
    });
    expect(callTool).toHaveBeenCalledExactlyOnceWith('memory_recall', { path: 'MEMORY.md' }, undefined);
    await memoryCall.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ['protocol version', () => vi.spyOn(McpStdioClient.prototype, 'protocolVersion').mockReturnValue('2025-06-18')],
    ['operation metadata', () => vi.spyOn(McpStdioClient.prototype, 'listTools').mockResolvedValue(
      wireTools().map((tool, index) => index === 0
        ? { ...tool, _meta: { 'byok.agent-memory.operation': 'write' } }
        : tool) as never,
    )],
    ['extra schema field', () => vi.spyOn(McpStdioClient.prototype, 'listTools').mockResolvedValue(
      wireTools().map((tool, index) => index === 0
        ? { ...tool, inputSchema: { ...tool.inputSchema, unexpected: true } }
        : tool) as never,
    )],
  ])('rejects execution tools/list %s drift and closes the helper', async (_name, drift) => {
    const close = mockHealthyMemoryHelper();
    drift();
    await expect(openPreparedMemoryCall(runtimeMemoryConfig())).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the helper when its pre-model initialize handshake fails', async () => {
    const close = vi.spyOn(McpStdioClient.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(McpStdioClient.prototype, 'connect').mockRejectedValue(new Error('initialize failed'));
    await expect(openPreparedMemoryCall(runtimeMemoryConfig())).rejects.toThrow('initialize failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the memory helper in private execution config, outside the empty Host MCP map', async () => {
    const workspace = await tempDir('byok-prepared-memory-runtime-workspace-');
    const recordDir = await tempDir('byok-prepared-memory-runtime-record-');
    const artifactPath = path.join(recordDir, 'artifact.json');
    const recordId = 'prepared-memory-runtime-record';
    const envelopeDigest = 'a'.repeat(64);
    const toolManifestDigest = 'b'.repeat(64);
    await fs.writeFile(artifactPath, JSON.stringify({
      format: INPUT_PREPARATION_ARTIFACT_FORMAT,
      version: INPUT_PREPARATION_VERSION,
      recordId,
      envelopeDigest,
      toolManifestDigest,
      envelope: {},
    }), { mode: 0o600 });

    let configBytes: string | undefined;
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: process.execPath, source: 'env' }),
      spawnFn: ((command: string, args: readonly string[], options: SpawnOptions) => {
        const configIndex = args.indexOf('--config');
        const configPath = args[configIndex + 1];
        if (configIndex < 0 || typeof configPath !== 'string') throw new Error('prepared runtime was not given its config');
        configBytes = readFileSync(configPath, 'utf8');
        if (!args[0]?.endsWith('byok-pi-prepared.js')) throw new Error('adapter did not select the prepared host entry');
        return spawn(command, [TIMING_HOST, ...args.slice(1)], options);
      }) as unknown as SpawnFn,
    });
    const prepared = await adapter.prepare({
      offer: { instruction: 'recall the current memory' },
      descriptor: adapter.descriptor,
      requiredToolsetIds: [],
    });
    if (prepared.kind === 'reject') throw new Error(prepared.reason);
    const preparation: RuntimePreparedLaunchV1 = {
      agentMemory: 'read',
      memory: MEMORY as never,
      reference: { scopeId: 'scope', agentRef: 'agent', requestId: 'request', recordId },
      artifactPath,
      expected: {
        envelopeDigest,
        toolManifestDigest,
        model: MODEL,
        binding: {
          inputIdentity: 'input', runtimeIdentity: 'runtime',
          policyIdentity: 'policy', profileRevision: 'profile',
        },
      },
      toolBindingDigest: 'memory-tool-binding',
      observationDigest: 'memory-observation',
      toolsetDefinitionRevisions: {},
    };
    const manifest = sealRuntimeOperationManifest({
      agentMemory: 'read',
      taskId: 'prepared-memory-runtime-task',
      runtimeId: 'pi',
      descriptor: adapter.descriptor,
      requiredToolsetIds: [],
      workspace: { workspaceDir: workspace },
      forwardedEnvironmentNames: [],
    });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
    };
    const runtimeLaunch = await prepared.operation.resolveRuntimeLaunch!({
      kind: 'prepared',
      cwd: workspace,
      env,
      projectionRoot: path.join(recordDir, 'projections'),
    });
    const memoryServer = {
      command: '/agent-memory-helper',
      args: ['__byok_sdk_helper', 'agent-memory-mcp'],
      env: {
        BYOK_STORE_DIR: '/private/store',
        BYOK_PRODUCT_ID: 'product',
        BYOK_AGENT_MEMORY_CONTEXT: 'context',
        BYOK_PREPARED_AGENT_MEMORY_MODE: 'read',
      },
    };
    const session = await prepared.operation.start({
      runtimeLaunch,
      kind: 'prepared',
      preparation,
      manifest,
      env,
      mcpEnv: projectPiMcpEnvironment(env),
      mcpServers: { [AGENT_MEMORY_MCP_SERVER_NAME]: memoryServer },
    });
    try {
      const config = JSON.parse(configBytes ?? '') as Record<string, unknown>;
      expect(config.agentMemory).toBe('read');
      expect(config.memory).toEqual(MEMORY);
      expect(config.memoryCall).toEqual(memoryServer);
      expect(config.mcp).toMatchObject({ mcpServers: {}, observation: {} });
      expect(JSON.stringify(config.mcp)).not.toContain(AGENT_MEMORY_MCP_SERVER_NAME);
    } finally {
      await session.close();
      await runtimeLaunch.release();
    }
  }, 30_000);
});
