import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { RuntimeAdapter, Session } from '../types';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';

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
      mcpToolsetTools: { saleskoprobe: ['echo'] },
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
      mcpToolsetTools: { saleskoprobe: ['echo'] },
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
      mcpToolsetTools: { saleskoprobe: ['echo'] },
      startMcpToolsetTools: { saleskoprobe: ['echo', 'delete_everything'] },
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
      mcpToolsetTools: { 'salesko.probe': ['echo'] },
    })).resolves.toMatchObject({
      kind: 'reject',
      retryable: false,
      reason: expect.stringContaining('cannot be expressed as a runtime tool grant'),
    });
  });
});

describe('projected MCP toolset grant — codex', () => {
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
      mcpToolsetTools: { saleskoprobe: ['echo'] },
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
      mcpToolsetTools: { saleskoprobe: ['echo'] },
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
        mcpToolsetTools: { saleskoprobe: ['echo'] },
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
      mcpToolsetTools: { saleskoprobe: ['echo'] },
      startMcpToolsetTools: { saleskoprobe: ['echo', 'delete_everything'] },
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
      mcpToolsetTools: { 'salesko.probe': ['echo'] },
    })).resolves.toMatchObject({
      kind: 'reject',
      retryable: false,
      reason: expect.stringContaining('cannot be expressed as a runtime tool grant'),
    });
  });
});
