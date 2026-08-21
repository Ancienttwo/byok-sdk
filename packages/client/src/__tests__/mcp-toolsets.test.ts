import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import type { McpToolsetConfig, RuntimeCapabilities } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const MCP_CAPABLE: RuntimeCapabilities = {
  steer: false,
  resume: true,
  approvalInteractive: true,
  mcpToolsets: true,
  permissionModes: ['auto', 'confirm'],
};

const MCP_UNSUPPORTED: RuntimeCapabilities = {
  steer: false,
  resume: true,
  approvalInteractive: false,
  permissionModes: ['auto'],
};

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used');
  },
  uploadArtifact: async () => {
    throw new Error('not used');
  },
};

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  mcpToolsets?: ReadonlyMap<string, McpToolsetConfig>,
): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-mcp-toolsets-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => sent.push(envelope),
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-mcp-toolsets-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    ...(mcpToolsets ? { mcpToolsets } : {}),
  };
  return new TaskRunner(deps);
}

describe('TaskRunner logical MCP toolset resolution', () => {
  it('resolves local server definitions into TaskContext and strips logical ids before adapter.start', async () => {
    const adapter = new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(
      adapter,
      sent,
      new Map([
        [
          'salesko',
          {
            mcpServers: {
              salesko: { command: '/opt/salesko/bin/mcp', args: ['--stdio'] },
            },
          },
        ],
      ]),
    );

    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        {
          instruction: 'find qualified leads',
          policy: { mode: 'auto' },
          runtime: 'claude',
          requiredToolsets: ['salesko'],
        },
        { taskId: 'task-mcp-1', seq: 1 },
      ),
    );

    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]?.ctx.mcpServers).toEqual({
      salesko: { command: '/opt/salesko/bin/mcp', args: ['--stdio'] },
    });
    expect('requiredToolsets' in (adapter.startCalls[0]?.task ?? {})).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('/opt/salesko/bin/mcp');

    await runner.handleEnvelope(
      createEnvelope('task.cancel', { reason: 'test cleanup' }, { taskId: 'task-mcp-1', seq: 2 }),
    );
  });

  it('declines pre-claim when the registry or a requested id is missing', async () => {
    for (const registry of [undefined, new Map<string, McpToolsetConfig>()]) {
      const adapter = new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE);
      const sent: Envelope[] = [];
      const runner = await makeRunner(adapter, sent, registry);
      await runner.handleEnvelope(
        createEnvelope(
          'task.offer_with_toolsets',
          {
            instruction: 'x',
            policy: { mode: 'auto' },
            runtime: 'claude',
            requiredToolsets: ['salesko'],
          },
          { taskId: `task-missing-${registry ? 'id' : 'registry'}`, seq: 1 },
        ),
      );
      expect(sent.some((envelope) => envelope.type === 'task.decline')).toBe(true);
      expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
      expect(adapter.startCalls).toHaveLength(0);
    }
  });

  it('declines a named runtime that cannot project MCP toolsets', async () => {
    const adapter = new StubRuntimeAdapter('pi', { present: true }, MCP_UNSUPPORTED);
    const sent: Envelope[] = [];
    const runner = await makeRunner(
      adapter,
      sent,
      new Map([['salesko', { mcpServers: { salesko: { command: '/opt/salesko/mcp' } } }]]),
    );
    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        { instruction: 'x', policy: { mode: 'auto' }, runtime: 'pi', requiredToolsets: ['salesko'] },
        { taskId: 'task-unsupported', seq: 1 },
      ),
    );
    const decline = sent.find((envelope) => envelope.type === 'task.decline');
    expect(decline?.payload).toMatchObject({ retryable: false });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('declines colliding MCP server names instead of choosing one by order', async () => {
    const adapter = new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(
      adapter,
      sent,
      new Map([
        ['mail', { mcpServers: { salesko: { command: '/opt/mail-mcp' } } }],
        ['social', { mcpServers: { salesko: { command: '/opt/social-mcp' } } }],
      ]),
    );
    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        {
          instruction: 'x',
          policy: { mode: 'auto' },
          runtime: 'claude',
          requiredToolsets: ['mail', 'social'],
        },
        { taskId: 'task-collision', seq: 1 },
      ),
    );
    const decline = sent.find((envelope) => envelope.type === 'task.decline');
    expect(decline?.payload).toMatchObject({ retryable: true });
    expect(JSON.stringify(decline)).toMatch(/collide/i);
    expect(adapter.startCalls).toHaveLength(0);
  });
});

describe('DaemonConfig.mcpToolsets local authority validation', () => {
  const baseConfig: DaemonConfig = {
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
    productId: 'test-product',
    serverUrl: 'http://localhost:3000',
    workspaceRoot: '/tmp/byok-test-workspace',
  };

  it('accepts a bounded stdio definition', () => {
    expect(() =>
      createDaemonWithAdapters(
        {
          ...baseConfig,
          mcpToolsets: {
            salesko: { mcpServers: { salesko: { command: '/opt/salesko/mcp', args: ['--stdio'] } } },
          },
        },
        [new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE)],
      ),
    ).not.toThrow();
  });

  it('rejects malformed ids, reserved names, and env/header fields synchronously', () => {
    const adapter = new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE);
    expect(() =>
      createDaemonWithAdapters(
        { ...baseConfig, mcpToolsets: { Salesko: { mcpServers: { salesko: { command: '/bin/true' } } } } },
        [adapter],
      ),
    ).toThrow(/invalid toolset id/);
    expect(() =>
      createDaemonWithAdapters(
        {
          ...baseConfig,
          mcpToolsets: {
            salesko: { mcpServers: { byokapproval: { command: '/bin/true' } } },
          },
        },
        [adapter],
      ),
    ).toThrow(/reserved/);
    expect(() =>
      createDaemonWithAdapters(
        {
          ...baseConfig,
          mcpToolsets: {
            salesko: {
              mcpServers: {
                salesko: { command: '/bin/true', env: { TOKEN: 'must-not-be-forwarded' } },
              },
            },
          } as never,
        },
        [adapter],
      ),
    ).toThrow(/accepts only command and args/);
  });
});
