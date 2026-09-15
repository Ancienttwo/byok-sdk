import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, PermissionPolicy, TaskOfferPayload } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { RuntimeAdapter, Session } from '../types';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { observationOf } from './fixtures/mcp-observation';

/**
 * Adapter-level contract for the projected-toolset MCP grant, against the
 * argv-validating fake CLIs. Both fixtures enforce the real binaries'
 * empirically-confirmed refusal (claude auto-denies an MCP tool missing from
 * `--allowedTools`; fake-codex rejects an `enabled_tools` entry with no
 * matching `approval_mode`), so a regression that stops emitting the grant
 * fails here rather than passing against a permissive double.
 *
 * `scripts/claude-toolset-permission-smoke.mjs` and
 * `scripts/codex-toolset-permission-smoke.mjs` are the same assertions
 * against the real installed CLIs.
 */
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

/**
 * The device's own read/mutation classification for the probe fixture. Every
 * `readonly` case here carries one, because without it the toolset is
 * INEXPRESSIBLE under a restricted policy on every runtime — which is the
 * property the last two cases in each block pin.
 */
const READ_ONLY = { readOnlyTools: { saleskoprobe: ['echo'] } } as const;

const sessions: Session[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
  await Promise.all(workspaces.splice(0).map((workspace) => fs.rm(workspace, { recursive: true, force: true })));
});

async function workspace(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  workspaces.push(dir);
  return dir;
}

function capturingSpawn(captured: string[][]) {
  return ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    captured.push([...args]);
    return spawn(command, args, options);
  }) as never;
}

async function drain(session: Session, count: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (events.length === count) break;
  }
  return events;
}

async function startWith(
  adapter: RuntimeAdapter,
  resources: PreparedOperationResources,
  instruction = 'call the toolset',
): Promise<Session> {
  const task: TaskOfferPayload = { instruction, policy: resources.policy };
  const session = await startPreparedOperation(adapter, task, resources);
  sessions.push(session);
  return session;
}

describe('projected MCP toolset grant — claude', () => {
  it('pre-grants exactly the SDK-reserved memory tools under readonly', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-claude-memory-grant-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: {
        byokagentmemory: { command: '/opt/byok-agent-memory-mcp' },
        byokagentmessage: { command: '/opt/byok-agent-message-mcp' },
      },
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(
      'mcp__byokagentmemory__memory_recall,mcp__byokagentmemory__memory_save',
    );
    expect(argv[argv.indexOf('--allowedTools') + 1]).not.toContain('send_agent_message');
  });

  it('readonly + allowTools:[] grants exactly the observed tools and keeps built-ins disabled', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-claude-toolset-grant-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { saleskoprobe: { command: process.execPath, args: ['/opt/probe.mjs'] } },
      mcpToolsetTools: observationOf({ saleskoprobe: ['echo'] }, READ_ONLY),
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__saleskoprobe__echo');
    expect(argv).toContain('--strict-mcp-config');
  });

  it('grants nothing when the task projects no toolset at all', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-claude-no-toolset-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv).not.toContain('--allowedTools');
    expect(argv).not.toContain('--mcp-config');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
  });

  it('grants only observed tools — an unobserved name on the same server is never allowed', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-claude-observed-only-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { saleskoprobe: { command: process.execPath, args: ['/opt/probe.mjs'] } },
      mcpToolsetTools: observationOf({ saleskoprobe: ['echo'] }, READ_ONLY),
    });
    await drain(session, 1);

    const granted = (captured[0] ?? [])[(captured[0] ?? []).indexOf('--allowedTools') + 1];
    expect(granted).toBe('mcp__saleskoprobe__echo');
    expect(granted).not.toMatch(/delete_everything/);
  });

  it('rejects pre-claim when a projected server carries no tools/list observation', async () => {
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
    await expect(adapter.prepare({
      offer: { instruction: 'x', policy: { mode: 'readonly', allowTools: [] } },
      policy: { mode: 'readonly', allowTools: [] },
      descriptor: adapter.descriptor,
      requiredToolsetIds: ['salesko'],
      mcpServers: { saleskoprobe: { command: process.execPath } },
    })).resolves.toMatchObject({
      kind: 'reject',
      retryable: false,
      reason: expect.stringContaining('no tools/list observation'),
    });
  });

  it('fails non-retryably when the tool observation drifts between prepare() and start()', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    await expect(startWith(adapter, {
      workspaceDir: await workspace('byok-claude-grant-drift-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { saleskoprobe: { command: process.execPath, args: ['/opt/probe.mjs'] } },
      mcpToolsetTools: observationOf({ saleskoprobe: ['echo'] }, READ_ONLY),
      // A tool that ALSO passes the policy filter: the re-check must compare
      // the authority, not merely notice that a mutation tool was dropped.
      startMcpToolsetTools: observationOf(
        { saleskoprobe: ['echo', 'peek'] },
        { readOnlyTools: { saleskoprobe: ['echo', 'peek'] } },
      ),
    })).rejects.toMatchObject({
      category: 'authority',
      retry: 'non-retryable',
      message: expect.stringContaining('different MCP toolset tool authority'),
    });
    // The widened grant never reached a process.
    expect(captured).toHaveLength(0);
  });

  it('rejects a projected server name that cannot form an mcp__<server>__<tool> identifier', async () => {
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
    await expect(adapter.prepare({
      offer: { instruction: 'x', policy: { mode: 'readonly', allowTools: [] } },
      policy: { mode: 'readonly', allowTools: [] },
      descriptor: adapter.descriptor,
      requiredToolsetIds: ['salesko'],
      mcpServers: { 'salesko.probe': { command: process.execPath } },
      mcpToolsetTools: observationOf({ 'salesko.probe': ['echo'] }, { readOnlyTools: { 'salesko.probe': ['echo'] } }),
    })).resolves.toMatchObject({
      kind: 'reject',
      retryable: false,
      reason: expect.stringContaining('cannot be expressed as a runtime tool grant'),
    });
  });
});

describe('projected MCP toolset grant — codex', () => {
  it('pre-grants exactly the SDK-reserved memory tools while global approval stays never', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-codex-memory-grant-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { byokagentmemory: { command: '/opt/byok-agent-memory-mcp' } },
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv).toContain('approval_policy=never');
    expect(argv).toContain('mcp_servers.byokagentmemory.enabled_tools=["memory_recall","memory_save"]');
    expect(argv).toContain('mcp_servers.byokagentmemory.tools.memory_recall.approval_mode="approve"');
    expect(argv).toContain('mcp_servers.byokagentmemory.tools.memory_save.approval_mode="approve"');
    expect(argv.some((arg) => arg.includes('memory.recall') || arg.includes('memory.save'))).toBe(false);
  });

  it('emits enabled_tools plus per-tool approval while the global dials stay pinned', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-codex-toolset-grant-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { saleskoprobe: { command: process.execPath, args: ['/opt/probe.mjs'] } },
      mcpToolsetTools: observationOf({ saleskoprobe: ['echo'] }, READ_ONLY),
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv).toContain('sandbox_mode=read-only');
    expect(argv).toContain('approval_policy=never');
    expect(argv).toContain('mcp_servers.saleskoprobe.enabled_tools=["echo"]');
    expect(argv).toContain('mcp_servers.saleskoprobe.tools.echo.approval_mode="approve"');
    expect(argv.some((arg) => arg.includes('default_tools_approval_mode'))).toBe(false);
  });

  it('grants nothing when the task projects no toolset at all', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-codex-no-toolset-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv.some((arg) => arg.startsWith('mcp_servers.'))).toBe(false);
    expect(argv).not.toContain('--ignore-user-config');
  });

  it('grants only observed tools — an unobserved name on the same server is never allowed', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-codex-observed-only-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { saleskoprobe: { command: process.execPath, args: ['/opt/probe.mjs'] } },
      mcpToolsetTools: observationOf({ saleskoprobe: ['echo'] }, READ_ONLY),
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv).toContain('mcp_servers.saleskoprobe.enabled_tools=["echo"]');
    expect(argv.some((arg) => arg.includes('delete_everything'))).toBe(false);
    expect(argv.filter((arg) => arg.startsWith('mcp_servers.saleskoprobe.tools.'))).toEqual([
      'mcp_servers.saleskoprobe.tools.echo.approval_mode="approve"',
    ]);
  });

  it('rejects before spawn on a Codex without the per-tool approval contract', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const originalVersion = process.env.FAKE_CODEX_VERSION;
    process.env.FAKE_CODEX_VERSION = 'codex-cli 0.148.0';
    try {
      await expect(adapter.prepare({
        offer: { instruction: 'x', policy: { mode: 'readonly', allowTools: [] } },
        policy: { mode: 'readonly', allowTools: [] },
        descriptor: adapter.descriptor,
        requiredToolsetIds: ['salesko'],
        mcpServers: { saleskoprobe: { command: process.execPath } },
        mcpToolsetTools: observationOf({ saleskoprobe: ['echo'] }, READ_ONLY),
      })).resolves.toMatchObject({
        kind: 'reject',
        retryable: false,
        reason: expect.stringContaining('lacks the required per-MCP-tool approval contract'),
      });
      expect(captured).toHaveLength(0);
    } finally {
      if (originalVersion === undefined) delete process.env.FAKE_CODEX_VERSION;
      else process.env.FAKE_CODEX_VERSION = originalVersion;
    }
  });

  it('rejects pre-claim when a projected server carries no tools/list observation', async () => {
    const adapter = new CodexAdapter({ resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }) });
    await expect(adapter.prepare({
      offer: { instruction: 'x', policy: { mode: 'readonly', allowTools: [] } },
      policy: { mode: 'readonly', allowTools: [] },
      descriptor: adapter.descriptor,
      requiredToolsetIds: ['salesko'],
      mcpServers: { saleskoprobe: { command: process.execPath } },
    })).resolves.toMatchObject({
      kind: 'reject',
      retryable: false,
      reason: expect.stringContaining('no tools/list observation'),
    });
  });

  it('fails non-retryably when the tool observation drifts between prepare() and start()', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    await expect(startWith(adapter, {
      workspaceDir: await workspace('byok-codex-grant-drift-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { saleskoprobe: { command: process.execPath, args: ['/opt/probe.mjs'] } },
      mcpToolsetTools: observationOf({ saleskoprobe: ['echo'] }, READ_ONLY),
      // A tool that ALSO passes the policy filter: the re-check must compare
      // the authority, not merely notice that a mutation tool was dropped.
      startMcpToolsetTools: observationOf(
        { saleskoprobe: ['echo', 'peek'] },
        { readOnlyTools: { saleskoprobe: ['echo', 'peek'] } },
      ),
    })).rejects.toMatchObject({
      category: 'authority',
      retry: 'non-retryable',
      message: expect.stringContaining('different MCP toolset tool authority'),
    });
    expect(captured).toHaveLength(0);
  });

  it('rejects a projected server name that cannot form a flat mcp_servers.<name> config key', async () => {
    const adapter = new CodexAdapter({ resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }) });
    await expect(adapter.prepare({
      offer: { instruction: 'x', policy: { mode: 'readonly', allowTools: [] } },
      policy: { mode: 'readonly', allowTools: [] },
      descriptor: adapter.descriptor,
      requiredToolsetIds: ['salesko'],
      mcpServers: { 'salesko.probe': { command: process.execPath } },
      mcpToolsetTools: observationOf({ 'salesko.probe': ['echo'] }, { readOnlyTools: { 'salesko.probe': ['echo'] } }),
    })).resolves.toMatchObject({
      kind: 'reject',
      retryable: false,
      reason: expect.stringContaining('cannot be expressed as a runtime tool grant'),
    });
  });
});

/**
 * Owner ruling (2026-09-15): `readonly` becomes expressible for an MCP toolset
 * through `McpToolsetConfig.readOnlyTools` — the device configuration owner
 * declares the read-only tools per `(server, tool)` — and stays refused when no
 * trusted declaration exists. The rule is the shared core's, so claude and
 * codex must reach the same grant from the same observation.
 */
const SALESKO_READ_TOOLS = [
  'get_account', 'get_contact', 'get_lead', 'list_accounts',
  'list_contacts', 'search_leads', 'summarize_pipeline',
] as const;
const SALESKO_TOOLS = [...SALESKO_READ_TOOLS, 'propose_graph_change_set'];
const SALESKO_CLASSIFIED = observationOf(
  { salesko: SALESKO_TOOLS },
  { toolsetId: 'salesko.read.v1', readOnlyTools: { salesko: [...SALESKO_READ_TOOLS] } },
);
const SALESKO_UNCLASSIFIED = observationOf({ salesko: SALESKO_TOOLS }, { toolsetId: 'salesko.read.v1' });

function readonlyPrepareInput(
  adapter: RuntimeAdapter,
  mcpToolsetTools: ReturnType<typeof observationOf>,
) {
  const policy: PermissionPolicy = { mode: 'readonly', allowTools: [] };
  return {
    offer: { instruction: 'read the pipeline', policy },
    policy,
    descriptor: adapter.descriptor,
    requiredToolsetIds: ['salesko.read.v1'],
    mcpServers: { salesko: { command: process.execPath, args: ['/opt/salesko-mcp.mjs'] } },
    mcpToolsetTools,
  };
}

describe('operator-classified readonly toolset', () => {
  it('claude grants exactly the classified read tools and never the propose tool', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-claude-readonly-classified-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { salesko: { command: process.execPath, args: ['/opt/salesko-mcp.mjs'] } },
      mcpToolsetTools: SALESKO_CLASSIFIED,
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(
      SALESKO_READ_TOOLS.map((tool) => `mcp__salesko__${tool}`).join(','),
    );
    expect(argv.join(' ')).not.toContain('propose_graph_change_set');
  });

  it('codex enables exactly the classified read tools and never the propose tool', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-codex-readonly-classified-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { salesko: { command: process.execPath, args: ['/opt/salesko-mcp.mjs'] } },
      mcpToolsetTools: SALESKO_CLASSIFIED,
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv).toContain(
      `mcp_servers.salesko.enabled_tools=${JSON.stringify([...SALESKO_READ_TOOLS])}`,
    );
    expect(argv.filter((arg) => arg.startsWith('mcp_servers.salesko.tools.'))).toEqual(
      SALESKO_READ_TOOLS.map((tool) => `mcp_servers.salesko.tools.${tool}.approval_mode="approve"`),
    );
    expect(argv.join(' ')).not.toContain('propose_graph_change_set');
  });

  it.each([
    ['claude', () => new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) })],
    ['codex', () => new CodexAdapter({ resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }) })],
  ])('%s refuses readonly when the device declared no classification at all', async (_runtime, make) => {
    const adapter = make();
    const rejection = await adapter.prepare(readonlyPrepareInput(adapter, SALESKO_UNCLASSIFIED));
    expect(rejection).toMatchObject({ kind: 'reject', retryable: false });
    const { reason } = rejection as { reason: string };
    expect(reason).toMatch(/McpToolsetConfig\.readOnlyTools/u);
    expect(reason).toMatch(/salesko\.read\.v1/u);
    // Never inferred from what the tools happen to be called.
    expect(reason).toMatch(/never inferred from tool names, descriptions, schemas/u);
  });

  it.each([
    ['claude', () => new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) })],
    ['codex', () => new CodexAdapter({ resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }) })],
  ])('%s treats a tool the classification omits as a mutation tool', async (_runtime, make) => {
    // Fail-closed default: an operator who adds a tool to the server and
    // forgets the declaration gets a narrower toolset, never a wider one.
    const adapter = make();
    const prepared = await adapter.prepare(readonlyPrepareInput(adapter, observationOf(
      { salesko: SALESKO_TOOLS },
      { toolsetId: 'salesko.read.v1', readOnlyTools: { salesko: ['get_account'] } },
    )));
    expect(prepared).toMatchObject({ kind: 'prepared' });
  });

  it('refuses a readonly task whose server has no read-only tool at all', async () => {
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
    const rejection = await adapter.prepare(readonlyPrepareInput(adapter, observationOf(
      { salesko: ['propose_graph_change_set'] },
      { toolsetId: 'salesko.propose.v1', readOnlyTools: { salesko: [] } },
    )));
    expect(rejection).toMatchObject({
      kind: 'reject',
      retryable: false,
      reason: expect.stringContaining('exposes no tool classified read-only'),
    });
  });

  it('auto still sees every tool the server exposes', async () => {
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
    const input = readonlyPrepareInput(adapter, SALESKO_CLASSIFIED);
    const policy: PermissionPolicy = { mode: 'auto' };
    await expect(adapter.prepare({ ...input, policy, offer: { ...input.offer, policy } }))
      .resolves.toMatchObject({ kind: 'prepared' });
  });
});
