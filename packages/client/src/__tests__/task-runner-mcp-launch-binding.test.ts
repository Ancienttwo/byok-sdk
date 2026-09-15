import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import type { RuntimeCapabilities } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { trustedCwd } from './fixtures/launch-cwd';
import { resolveMcpLaunchCwdLauncher } from '../daemon/trusted-launch-cwd';

/**
 * The daemon half of the MCP launch working-directory boundary, for the MCP
 * servers a task generates WITHOUT the device projecting a host toolset.
 *
 * `TaskRunner` used to resolve the launch binding only when the task probed a
 * server or projected one from the toolset registry. A task whose only MCP
 * server is generated later — the reserved approval server a `confirm`-mode
 * adapter adds itself, or the reserved agent-memory helper the daemon adds
 * after admission — reached `start()` with no binding at all, and claude
 * wrote those servers unwrapped: they inherited the CLI's manifest cwd, which
 * for an Agent task is the Agent-writable home a compiled server binary reads
 * `bunfig.toml` `preload` from.
 *
 * The predicate is now "this task will generate >= 1 MCP server of ANY
 * origin", and these cases pin both directions of it.
 */

const CONFIRM_CAPABLE: RuntimeCapabilities = {
  steer: false,
  resume: true,
  approvalInteractive: true,
  mcpToolsets: true,
  permissionModes: ['auto', 'confirm'],
};

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used'); },
  uploadArtifact: async () => { throw new Error('not used'); },
};

const roots: string[] = [];
async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  // Best effort: a cancelled task may still be flushing its own workspace.
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
  vi.restoreAllMocks();
});

/** A claude-shaped adapter: an external CLI spawns its servers, and it generates its own approval server under `confirm`. */
function claudeShaped(id = 'claude'): StubRuntimeAdapter {
  return new StubRuntimeAdapter(id, { kind: 'available' }, CONFIRM_CAPABLE, true, {
    mcpServerLaunch: 'launcher-wrapped',
    generatesApprovalMcpServer: true,
  });
}

async function makeRunner(
  adapters: StubRuntimeAdapter[],
  sent: Envelope[],
  extra: Partial<TaskRunnerDeps> = {},
): Promise<TaskRunner> {
  const storeDir = await tmpDir('byok-launch-binding-store-');
  return new TaskRunner({
    adapters,
    workspaceRoot: await tmpDir('byok-launch-binding-workspace-'),
    deviceId: 'device-launch-binding',
    send: (envelope) => sent.push(envelope),
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(storeDir),
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'launch-binding',
    ...extra,
  });
}

describe('TaskRunner MCP launch binding — every generated server, not only host toolsets', () => {
  it('binds a confirm-mode task with no toolsets at all: the approval server the adapter generates gets the trusted directory and a launcher', async () => {
    const adapter = claudeShaped();
    const sent: Envelope[] = [];
    const runner = await makeRunner([adapter], sent);

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'x', policy: { mode: 'confirm' }, runtime: 'claude' },
      { taskId: 'task-confirm-binding', seq: 1 },
    ));

    expect(sent.some((envelope) => envelope.type === 'task.decline')).toBe(false);
    expect(adapter.startCalls).toHaveLength(1);
    // No projected server, so nothing in `mcpServers` — and still a binding,
    // because the adapter itself will generate one.
    expect(adapter.startCalls[0]?.ctx.mcpServers).toBeUndefined();
    const launcher = resolveMcpLaunchCwdLauncher();
    if (launcher.kind !== 'resolved') throw new Error('no launcher on this machine');
    expect(adapter.startCalls[0]?.ctx.mcpLaunch).toEqual({
      cwd: await trustedCwd(),
      launcher: { interpreter: launcher.interpreter, script: launcher.script },
    });

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-confirm-binding', seq: 2 }));
  });

  it('declines a confirm-mode task non-retryably, before any spawn, when this daemon build cannot host the launcher (compiled-Bun shape, no configured interpreter)', async () => {
    // A compiled Salesko daemon is the bun binary: `process.execPath` would
    // read `$cwd/bunfig.toml` `preload` itself, so the launcher has no host
    // and the operator must configure `mcpLaunchCwd.launcherInterpreter`.
    // Declining is the only fail-closed answer — the alternative is starting
    // the approval server in the Agent's own writable home.
    Object.defineProperty(process.versions, 'bun', { value: '1.2.0', configurable: true });
    try {
      const adapter = claudeShaped();
      const sent: Envelope[] = [];
      const runner = await makeRunner([adapter], sent);

      await runner.handleEnvelope(createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'confirm' }, runtime: 'claude' },
        { taskId: 'task-confirm-no-launcher', seq: 1 },
      ));

      const decline = sent.find((envelope) => envelope.type === 'task.decline');
      expect(decline?.payload).toMatchObject({ retryable: false });
      expect(JSON.stringify(decline)).toContain('launch_cwd_launcher_interpreter_unconfigured');
      expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
      expect(adapter.startCalls).toHaveLength(0);
    } finally {
      delete (process.versions as Record<string, unknown>).bun;
    }
  });

  it('admits a task that generates no MCP server at all, on every adapter shape, with no binding resolved', async () => {
    const shapes = [
      { runtime: 'claude' as const, adapter: claudeShaped() },
      {
        runtime: 'pi' as const,
        adapter: new StubRuntimeAdapter('pi', { kind: 'available' }, CONFIRM_CAPABLE, false, { mcpServerLaunch: 'direct-cwd' }),
      },
      {
        runtime: 'codex' as const,
        adapter: new StubRuntimeAdapter('codex', { kind: 'available' }, CONFIRM_CAPABLE, true, { mcpServerLaunch: 'launcher-wrapped' }),
      },
    ];
    for (const { runtime, adapter } of shapes) {
      const sent: Envelope[] = [];
      const runner = await makeRunner([adapter], sent);
      const taskId = `task-no-mcp-${runtime}`;

      await runner.handleEnvelope(createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' }, runtime },
        { taskId, seq: 1 },
      ));

      expect(sent.some((envelope) => envelope.type === 'task.decline')).toBe(false);
      expect(adapter.startCalls).toHaveLength(1);
      expect(adapter.startCalls[0]?.ctx.mcpLaunch).toBeUndefined();

      await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId, seq: 2 }));
    }
  });

  it('binds an Agent task whose only MCP server is the reserved memory helper', async () => {
    if (!isAgentMemorySecureFilesystemAvailable(process.platform === 'darwin')) {
      // The memory helper is only injected where the secure-filesystem
      // precondition holds; nothing to bind otherwise.
      return;
    }
    const adapter = claudeShaped();
    const sent: Envelope[] = [];
    const runner = await makeRunner([adapter], sent, {
      agentHome: new AgentHomeManager({ hostStorageRoot: await tmpDir('byok-launch-binding-home-') }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      tenantId: 'tenant-launch-binding',
      agentMemoryMcpBin: { command: 'node', args: ['memory-mcp.js'] },
      ...(process.platform === 'darwin' ? { agentMemoryFilesystemHelperBin: '/opt/byok-agent-memory-fs' } : {}),
    });

    await runner.handleEnvelope(createEnvelope(
      'task.offer_for_agent',
      {
        instruction: 'x',
        policy: { mode: 'auto' },
        runtime: 'claude',
        agentRef: { agentId: 'agent-launch-binding', profileRevision: 'profile-1' },
      },
      { taskId: 'task-memory-binding', seq: 1 },
    ));

    expect(sent.some((envelope) => envelope.type === 'task.decline')).toBe(false);
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]?.ctx.mcpServers?.byokagentmemory).toMatchObject({ command: 'node' });
    const launcher = resolveMcpLaunchCwdLauncher();
    if (launcher.kind !== 'resolved') throw new Error('no launcher on this machine');
    expect(adapter.startCalls[0]?.ctx.mcpLaunch).toEqual({
      cwd: await trustedCwd(),
      launcher: { interpreter: launcher.interpreter, script: launcher.script },
    });

    adapter.sessions[0]?.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
  });
});
