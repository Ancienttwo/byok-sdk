import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpToolsProbeAuthorityError,
  MCP_TOOLS_PROBE_MAX_STDOUT_BYTES,
  probeMcpServerTools,
} from '../daemon/mcp-tools-probe';
import { buildRuntimeEnv } from '../daemon/environment';
import type { McpStdioServerConfig } from '../types';

/**
 * `probeMcpServerTools` is the SDK's only authority on which MCP tool names an
 * adapter may interpolate into runtime grant surfaces, and it starts a
 * host-configured command to get them. These cases pin both halves of that:
 * what it accepts from the server's own answer, and what the spawned child is
 * allowed to see of the daemon's environment.
 */
const PROBE_FIXTURE = fileURLToPath(new URL('./fixtures/probe-mcp-server.mjs', import.meta.url));
const ECHO_FIXTURE = fileURLToPath(new URL('./fixtures/toolset-echo-mcp.mjs', import.meta.url));

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function tmpRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-mcp-probe-'));
  roots.push(root);
  return root;
}

interface FixtureConfig {
  tools?: unknown;
  silent?: boolean;
  floodBytes?: number;
  dumpEnvTo?: string;
  dumpCwdTo?: string;
  dumpPidTo?: string;
}

function fixtureServer(config: FixtureConfig): McpStdioServerConfig {
  return { command: process.execPath, args: [PROBE_FIXTURE, JSON.stringify(config)] };
}

/** The allowlisted environment the real runtime child of a task would receive. */
function runtimeEnv(): Record<string, string> {
  return buildRuntimeEnv({ ambient: process.env, requirements: { credentialNames: [] } });
}

async function probe(
  server: McpStdioServerConfig,
  overrides: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<readonly string[]> {
  return probeMcpServerTools(server, {
    label: 'probed server',
    timeoutMs: overrides.timeoutMs ?? 5_000,
    env: overrides.env ?? runtimeEnv(),
    ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
  });
}

describe('probeMcpServerTools — observed tool names', () => {
  it('returns the sorted, de-duplicated names of a well-formed server', async () => {
    const tools = await probe(fixtureServer({
      tools: [{ name: 'find_leads' }, { name: 'echo' }, { name: 'find_leads' }],
    }));
    expect(tools).toEqual(['echo', 'find_leads']);
  });

  it('observes the shipped toolset-echo fixture the live smokes use', async () => {
    const root = await tmpRoot();
    const tools = await probe({
      command: process.execPath,
      args: [ECHO_FIXTURE, path.join(root, 'audit.jsonl')],
    });
    expect(tools).toEqual(['echo']);
  });

  // Each of these would forge a second grant, or a different config key, out
  // of one legitimate one if it were interpolated into `--allowedTools
  // mcp__<server>__<tool>` or `mcp_servers.<server>.tools.<tool>
  // .approval_mode`. One bad name rejects the WHOLE observation — a partial
  // grant is never produced.
  const ungrantable: Array<[string, unknown]> = [
    ['a comma', 'evil,tool'],
    ['a dot', 'a.b'],
    ['a name longer than 64 characters', 'a'.repeat(100)],
    ['a leading dash', '-rf'],
    ['a quote', 'ev"il'],
    ['whitespace', 'two words'],
  ];
  for (const [label, name] of ungrantable) {
    it(`rejects the whole observation for a tool name with ${label}`, async () => {
      await expect(probe(fixtureServer({ tools: [{ name: 'echo' }, { name }] })))
        .rejects.toThrow(McpToolsProbeAuthorityError);
      await expect(probe(fixtureServer({ tools: [{ name: 'echo' }, { name }] })))
        .rejects.toThrow(/ungrantable tool name/);
    });
  }

  it('rejects a non-string tool name', async () => {
    await expect(probe(fixtureServer({ tools: [{ name: 42 }] })))
      .rejects.toThrow(/ungrantable tool name 42/);
  });

  it('rejects a non-object tool entry', async () => {
    await expect(probe(fixtureServer({ tools: ['echo'] })))
      .rejects.toThrow(/malformed tool entry/);
  });

  it('classifies an ungrantable answer as a permanent authority failure, not a transient one', async () => {
    // The distinction the task runner declines on: a retry cannot change what
    // the same configured command reports about itself.
    await expect(probe(fixtureServer({ tools: [{ name: 'a.b' }] })))
      .rejects.toBeInstanceOf(McpToolsProbeAuthorityError);
    await expect(probe(fixtureServer({ silent: true }), { timeoutMs: 250 }))
      .rejects.not.toBeInstanceOf(McpToolsProbeAuthorityError);
  });

  it('rejects a server that floods stdout past the byte cap instead of buffering it', async () => {
    await expect(probe(
      fixtureServer({ floodBytes: MCP_TOOLS_PROBE_MAX_STDOUT_BYTES + 64_000 }),
      { timeoutMs: 15_000 },
    )).rejects.toThrow(/more than \d+ bytes of stdout/);
  }, 20_000);
});

describe('probeMcpServerTools — spawned child', () => {
  it('never hands the daemon\'s own ambient credentials to the probed server', async () => {
    const root = await tmpRoot();
    const dumpEnvTo = path.join(root, 'env.json');
    const restore = { ...process.env };
    process.env.BYOK_SECRET = 'control-plane-secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'daemon-deployment-secret';
    try {
      await probe(fixtureServer({ tools: [{ name: 'echo' }], dumpEnvTo }));
    } finally {
      delete process.env.BYOK_SECRET;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      Object.assign(process.env, restore);
    }
    const childEnv = JSON.parse(await fs.readFile(dumpEnvTo, 'utf8')) as Record<string, string>;
    expect(childEnv).not.toHaveProperty('BYOK_SECRET');
    expect(childEnv).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(JSON.stringify(childEnv)).not.toContain('control-plane-secret');
    expect(JSON.stringify(childEnv)).not.toContain('daemon-deployment-secret');
    // The platform baseline still arrives, or the server could not run at all.
    expect(childEnv.PATH).toBe(process.env.PATH);
  });

  it('layers an SDK-reserved server\'s own env over the allowlisted base', async () => {
    const root = await tmpRoot();
    const dumpEnvTo = path.join(root, 'env.json');
    const server = fixtureServer({ tools: [{ name: 'echo' }], dumpEnvTo });
    await probe({ ...server, env: { BYOK_AGENT_MESSAGE_CONTEXT: 'context-token' } });
    const childEnv = JSON.parse(await fs.readFile(dumpEnvTo, 'utf8')) as Record<string, string>;
    // The hard deny governs what leaks in from the AMBIENT environment; a
    // task-scoped value the SDK deliberately hands one of its own reserved
    // helpers is layered on top, exactly as the runtime path layers it.
    expect(childEnv.BYOK_AGENT_MESSAGE_CONTEXT).toBe('context-token');
  });

  it('runs the server in the supplied working directory', async () => {
    const root = await tmpRoot();
    const dumpCwdTo = path.join(root, 'cwd.txt');
    await probe(fixtureServer({ tools: [{ name: 'echo' }], dumpCwdTo }), { cwd: root });
    expect(await fs.realpath(await fs.readFile(dumpCwdTo, 'utf8'))).toBe(await fs.realpath(root));
  });

  it('times out and leaves no lingering child behind', async () => {
    const root = await tmpRoot();
    const dumpPidTo = path.join(root, 'pid.txt');
    await expect(probe(fixtureServer({ silent: true, dumpPidTo }), { timeoutMs: 400 }))
      .rejects.toThrow(/handshake timed out after 400ms/);
    const pid = Number(await fs.readFile(dumpPidTo, 'utf8'));
    expect(Number.isInteger(pid)).toBe(true);
    await expect.poll(() => {
      try {
        process.kill(pid, 0);
        return 'alive';
      } catch {
        return 'gone';
      }
    }, { timeout: 5_000 }).toBe('gone');
  });

  it('reports a command that cannot start at all', async () => {
    const root = await tmpRoot();
    await expect(probe({ command: path.join(root, 'does-not-exist') }))
      .rejects.toThrow(/failed to start|exited before handshake/);
  });
});
