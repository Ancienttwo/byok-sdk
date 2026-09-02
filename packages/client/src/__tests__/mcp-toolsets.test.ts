import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import {
  McpToolsProbeAuthorityError,
  MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS,
  probeMcpServerTools,
} from '../daemon/mcp-tools-probe';
import { McpToolsetRegistry, McpToolsetRevisionConflictError } from '../daemon/toolset-registry';
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

/**
 * Stand in for the real `tools/list` handshake against a projected server.
 * These cases pin projection/freezing semantics with fixture command paths
 * that never exist on disk, so the observation is injected rather than
 * spawned — `salesko-mcp-e2e.test.ts` covers the real handshake end to end.
 */
const stubToolsProbe: NonNullable<TaskRunnerDeps['mcpToolsetToolsProbe']> = async () => ['find_leads'];

/** A server that completes no handshake at all — used to time the admission deadline. */
const SILENT_PROBE_FIXTURE = fileURLToPath(new URL('./fixtures/probe-mcp-server.mjs', import.meta.url));
/** Enough servers that a serial loop would be unmistakably slower than a concurrent one. */
const SILENT_SERVER_COUNT = 6;
/** Stands in for the production admission budget so the case stays fast. */
const SHORTENED_PROBE_TIMEOUT_MS = 700;

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  mcpToolsets?: ReadonlyMap<string, McpToolsetConfig>,
  getMcpToolsets?: () => ReadonlyMap<string, McpToolsetConfig>,
  mcpToolsetToolsProbe: NonNullable<TaskRunnerDeps['mcpToolsetToolsProbe']> = stubToolsProbe,
): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = {
    mcpToolsetToolsProbe,
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-mcp-toolsets-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => sent.push(envelope),
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-mcp-toolsets-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    ...(getMcpToolsets ? { getMcpToolsets } : mcpToolsets ? { getMcpToolsets: () => mcpToolsets } : {}),
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
    // The observed tool names travel beside the server definition; they are
    // the only names an adapter may pre-grant to a runtime.
    expect(adapter.startCalls[0]?.ctx.mcpToolsetTools).toEqual({ salesko: ['find_leads'] });
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

  it('declines pre-claim, retryably, when a projected toolset server cannot be observed', async () => {
    for (const probe of [
      async () => { throw new Error('server exited before handshake'); },
      async () => [],
    ] satisfies Array<NonNullable<TaskRunnerDeps['mcpToolsetToolsProbe']>>) {
      const adapter = new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE);
      const sent: Envelope[] = [];
      const runner = await makeRunner(
        adapter,
        sent,
        new Map([['salesko', { mcpServers: { salesko: { command: '/opt/salesko/bin/mcp' } } }]]),
        undefined,
        probe,
      );
      await runner.handleEnvelope(
        createEnvelope(
          'task.offer_with_toolsets',
          { instruction: 'x', policy: { mode: 'auto' }, runtime: 'claude', requiredToolsets: ['salesko'] },
          { taskId: 'task-unobservable', seq: 1 },
        ),
      );
      const decline = sent.find((envelope) => envelope.type === 'task.decline');
      expect(decline?.payload).toMatchObject({ retryable: true });
      expect(JSON.stringify(decline)).toMatch(/could not be observed/);
      expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
      expect(adapter.startCalls).toHaveLength(0);
    }
  });

  it('freezes the resolved projection per offer while later offers read a reloaded snapshot', async () => {
    const registry = new McpToolsetRegistry({
      salesko: { mcpServers: { salesko: { command: '/opt/salesko/mcp-v1' } } },
    });
    const adapter = new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, undefined, () => registry.snapshot().toolsets);

    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        { instruction: 'first', policy: { mode: 'auto' }, runtime: 'claude', requiredToolsets: ['salesko'] },
        { taskId: 'task-before-reload', seq: 1 },
      ),
    );
    const previousRevision = registry.status().revision;
    registry.reload(
      { salesko: { mcpServers: { salesko: { command: '/opt/salesko/mcp-v2' } } } },
      previousRevision,
    );
    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        { instruction: 'second', policy: { mode: 'auto' }, runtime: 'claude', requiredToolsets: ['salesko'] },
        { taskId: 'task-after-reload', seq: 2 },
      ),
    );

    expect(adapter.startCalls[0]?.ctx.mcpServers).toEqual({ salesko: { command: '/opt/salesko/mcp-v1' } });
    expect(adapter.startCalls[1]?.ctx.mcpServers).toEqual({ salesko: { command: '/opt/salesko/mcp-v2' } });
    expect(adapter.startCalls[1]?.ctx.mcpToolsetTools).toEqual({ salesko: ['find_leads'] });

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-before-reload', seq: 3 }));
    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-after-reload', seq: 4 }));
  });
});

describe('TaskRunner toolset tools/list probe — who pays for it, and for how long', () => {
  it('never probes for an adapter that grants projected toolset tools itself', async () => {
    // The pi shape: `mcpToolsets: true`, but it projects servers through its
    // own extension and reads no observation, so an offer routed to it must
    // not wait on a `tools/list` handshake per projected server.
    const adapter = new StubRuntimeAdapter('pi', { present: true }, {
      steer: true, resume: true, approvalInteractive: false, mcpToolsets: true,
      permissionModes: ['auto', 'readonly'],
    }, false);
    const sent: Envelope[] = [];
    const probe = vi.fn<NonNullable<TaskRunnerDeps['mcpToolsetToolsProbe']>>(async () => ['find_leads']);
    const runner = await makeRunner(
      adapter,
      sent,
      new Map([['salesko', { mcpServers: { salesko: { command: '/opt/salesko/bin/mcp' } } }]]),
      undefined,
      probe,
    );
    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        { instruction: 'x', policy: { mode: 'auto' }, runtime: 'pi', requiredToolsets: ['salesko'] },
        { taskId: 'task-pi-no-probe', seq: 1 },
      ),
    );

    expect(probe).not.toHaveBeenCalled();
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(adapter.startCalls).toHaveLength(1);
    // The server is still projected; only the observation nothing consumes is absent.
    expect(adapter.startCalls[0]?.ctx.mcpServers).toEqual({ salesko: { command: '/opt/salesko/bin/mcp' } });
    expect(adapter.startCalls[0]?.ctx.mcpToolsetTools).toBeUndefined();

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-pi-no-probe', seq: 2 }));
  });

  it('declines permanently when a server reports an ungrantable tool name', async () => {
    // A retry would start the same configured command and get the same answer,
    // so a retryable decline here is an infinite re-offer loop.
    const adapter = new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(
      adapter,
      sent,
      new Map([['salesko', { mcpServers: { salesko: { command: '/opt/salesko/bin/mcp' } } }]]),
      undefined,
      async () => {
        throw new McpToolsProbeAuthorityError(
          'MCP toolset server "salesko" tools/list reported an ungrantable tool name "evil,tool"',
        );
      },
    );
    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        { instruction: 'x', policy: { mode: 'auto' }, runtime: 'claude', requiredToolsets: ['salesko'] },
        { taskId: 'task-ungrantable', seq: 1 },
      ),
    );

    const decline = sent.find((envelope) => envelope.type === 'task.decline');
    expect(decline?.payload).toMatchObject({ retryable: false });
    expect(JSON.stringify(decline)).toMatch(/salesko/);
    expect(JSON.stringify(decline)).toMatch(/evil,tool/);
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('bounds admission by ONE shared deadline no matter how many servers never answer', async () => {
    const servers: Record<string, { command: string; args: string[] }> = {};
    for (let index = 0; index < SILENT_SERVER_COUNT; index += 1) {
      servers[`srv${index}`] = {
        command: process.execPath,
        args: [SILENT_PROBE_FIXTURE, JSON.stringify({ silent: true })],
      };
    }
    const adapter = new StubRuntimeAdapter('claude', { present: true }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const budgets: Array<number | undefined> = [];
    const runner = await makeRunner(
      adapter,
      sent,
      new Map([['salesko', { mcpServers: servers }]]),
      undefined,
      // Forwards to the REAL handshake, recording the budget the runner chose
      // and shortening it so the case stays fast. Concurrency, not the value
      // of the constant, is what the elapsed assertion below proves.
      async (server, options) => {
        budgets.push(options.timeoutMs);
        return probeMcpServerTools(server, { ...options, timeoutMs: SHORTENED_PROBE_TIMEOUT_MS });
      },
    );

    const startedAt = Date.now();
    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        { instruction: 'x', policy: { mode: 'auto' }, runtime: 'claude', requiredToolsets: ['salesko'] },
        { taskId: 'task-probe-deadline', seq: 1 },
      ),
    );
    const elapsed = Date.now() - startedAt;

    // Every server got the one shared admission budget, not a per-server one.
    expect(budgets).toHaveLength(SILENT_SERVER_COUNT);
    expect(new Set(budgets)).toEqual(new Set([MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS]));
    // Serial probing would cost SILENT_SERVER_COUNT × the timeout; concurrent
    // probing costs one, plus process startup.
    expect(elapsed).toBeLessThan(SHORTENED_PROBE_TIMEOUT_MS * 3);
    const decline = sent.find((envelope) => envelope.type === 'task.decline');
    expect(decline?.payload).toMatchObject({ retryable: true });
    expect(JSON.stringify(decline)).toMatch(/could not be observed/);
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
  }, 30_000);
});

describe('McpToolsetRegistry atomic reload and explicit observation authority', () => {
  const original = {
    mail: { mcpServers: { gmail: { command: '/opt/gmail-mcp', args: ['--stdio'] } } },
    crm: { mcpServers: { salesko: { command: '/opt/salesko-mcp' } } },
  };

  it('uses a restart-stable content revision and keeps same-content reload idempotent', () => {
    const first = new McpToolsetRegistry(original);
    const reordered = new McpToolsetRegistry({ crm: original.crm, mail: original.mail });
    expect(reordered.status().revision).toBe(first.status().revision);

    const mailRevision = first.status().toolsets.find((row) => row.id === 'mail')!.definitionRevision;
    first.report('mail', mailRevision, {
      state: 'ready',
      observedAt: '2026-08-21T15:00:00.000Z',
      version: '1.2.3',
    });
    const receipt = first.reload({ crm: original.crm, mail: original.mail }, first.status().revision);
    expect(receipt.changed).toBe(false);
    expect(receipt.toolsets.find((row) => row.id === 'mail')?.observation?.state).toBe('ready');
  });

  it('fails stale or invalid reload closed and clears only observations bound to changed definitions', () => {
    const registry = new McpToolsetRegistry(original);
    const mailRevision = registry.status().toolsets.find((row) => row.id === 'mail')!.definitionRevision;
    const crmRevision = registry.status().toolsets.find((row) => row.id === 'crm')!.definitionRevision;
    registry.report('mail', mailRevision, {
      state: 'degraded',
      observedAt: '2026-08-21T15:00:00.000Z',
      reasonCode: 'provider.timeout',
    });
    registry.report('crm', crmRevision, { state: 'ready', observedAt: '2026-08-21T15:00:01.000Z' });
    const before = registry.status();

    expect(() => registry.reload({}, `sha256:${'f'.repeat(64)}`)).toThrow(McpToolsetRevisionConflictError);
    expect(registry.status()).toEqual(before);
    expect(() =>
      registry.reload(
        { mail: { mcpServers: { gmail: { command: '/opt/gmail-mcp', env: { TOKEN: 'secret' } } } } } as never,
        before.revision,
      ),
    ).toThrow(/accepts only command and args/);
    expect(registry.status()).toEqual(before);

    const receipt = registry.reload(
      {
        mail: { mcpServers: { gmail: { command: '/opt/gmail-mcp-v2', args: ['--stdio'] } } },
        crm: original.crm,
      },
      before.revision,
    );
    expect(receipt.changed).toBe(true);
    expect(receipt.toolsets.find((row) => row.id === 'mail')?.observation).toBeUndefined();
    expect(receipt.toolsets.find((row) => row.id === 'crm')?.observation?.state).toBe('ready');
    expect(() =>
      registry.report('mail', mailRevision, {
        state: 'ready',
        observedAt: '2026-08-21T15:00:02.000Z',
      }),
    ).toThrow(/definition revision conflict/);
    expect(JSON.stringify(receipt)).not.toMatch(/gmail-mcp|salesko-mcp|--stdio|TOKEN|secret/);
  });

  it('rejects fabricated observations for unknown ids and bounds observation metadata', () => {
    const registry = new McpToolsetRegistry(original);
    expect(() => registry.report('unknown', `sha256:${'0'.repeat(64)}`, { state: 'ready', observedAt: '2026-08-21T15:00:00.000Z' })).toThrow(
      /unconfigured toolset/,
    );
    expect(() =>
      registry.report('mail', registry.status().toolsets.find((row) => row.id === 'mail')!.definitionRevision, {
        state: 'ready',
        observedAt: 'not-a-time',
      }),
    ).toThrow(/ISO timestamp/);
    expect(() =>
      registry.report('mail', registry.status().toolsets.find((row) => row.id === 'mail')!.definitionRevision, {
        state: 'crashed',
        observedAt: '2026-08-21T15:00:00.000Z',
        reasonCode: 'raw message with spaces',
      }),
    ).toThrow(/reasonCode/);
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
