import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BYOK_PI_MCP_CONFIG_PATH } from '../adapters/pi/mcp-config';
import { observeMcpServer } from '../mcp/observation';
import { trustedCwd } from './fixtures/launch-cwd';

/**
 * The Pi call path's half of the launch-cwd boundary.
 *
 * `McpServerPool.open` used to pass no cwd at all, so every MCP toolset server
 * inherited the Pi child's cwd — the canonical Agent home, which the agent's
 * own tools write by design. A `bun --compile` server binary runs
 * `$cwd/bunfig.toml` `preload` before its own code, so that inheritance handed
 * the agent a code-injection seam into the server it was being served by.
 *
 * These tests run the REAL extension against the REAL fixture server, with
 * this process's own cwd set to the planted "Agent home", so "it did not
 * inherit" is a fact read back out of the child rather than an assumption.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const ENV = { PATH: process.env.PATH ?? '' } as const;
const BUNFIG = 'preload = ["./byok-preload.js"]\n';
const PRELOAD = 'globalThis.__BYOK_LAUNCH_CWD_PRELOADED__ = true;\n';

/**
 * bun, if this machine has one. Resolved once, synchronously, so the case
 * below is either RUN or visibly SKIPPED — never a body that returns early and
 * reports as a pass.
 */
const BUN_BIN = ((): string | undefined => {
  const candidates = [
    process.env.BYOK_TEST_BUN_BIN,
    path.join(os.homedir(), '.local/bin/bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  return undefined;
})();

const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
  delete process.env[BYOK_PI_MCP_CONFIG_PATH];
});

/** A directory shaped exactly like a canonical Agent home: this uid can write it. */
async function plantedAgentHome(): Promise<string> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-home-')));
  await fs.writeFile(path.join(home, 'bunfig.toml'), BUNFIG);
  await fs.writeFile(path.join(home, 'byok-preload.js'), PRELOAD);
  return home;
}

interface Started { cwd: string; preloaded: boolean }

async function callThroughExtension(
  command: string,
  launchCwd: string | undefined,
  recordTo: string,
): Promise<void> {
  const server = { command, args: [FIXTURE, JSON.stringify({ recordTo })] };
  const observed = await observeMcpServer('salesko', server, { env: ENV, timeoutMs: 15_000 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-config-'));
  const configPath = path.join(dir, 'mcp-config.json');
  await fs.writeFile(configPath, JSON.stringify({
    mcpServers: { salesko: server },
    observation: { salesko: { ...observed, toolsetId: 'salesko.read.v1' } },
    permissionMode: 'auto',
    ...(launchCwd === undefined ? {} : { launchCwd }),
  }));
  process.env[BYOK_PI_MCP_CONFIG_PATH] = configPath;

  const tools: Array<{ name: string; execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown> }> = [];
  let onShutdown: (() => void) | undefined;
  const extension = await import('../adapters/pi/mcp-extension');
  extension.default({
    registerTool: (tool: never) => tools.push(tool),
    on: (event: string, handler: () => void) => { if (event === 'session_shutdown') onShutdown = handler; },
  } as never);
  const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo');
  if (echo === undefined) throw new Error('the extension registered no echo tool');
  await echo.execute('call-1', { text: 'hello' }, undefined);
  onShutdown?.();
}

async function startRecord(recordTo: string): Promise<Started> {
  const raw = await fs.readFile(recordTo, 'utf8');
  const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  // The observation spawn is recorded first; the pool's own spawn is the one
  // under test, so read the LAST start entry.
  const starts = lines.filter((entry) => entry.event === 'start');
  const last = starts[starts.length - 1];
  if (last === undefined) throw new Error('the fixture server never recorded a start');
  return { cwd: String(last.cwd), preloaded: last.preloaded === true };
}

describe('Pi MCP server pool — launch cwd', () => {
  it('starts the server in the trusted directory, not in the Agent home it inherits', async () => {
    const home = await plantedAgentHome();
    const recordTo = path.join(home, 'records.jsonl');
    process.chdir(home);
    const trusted = await trustedCwd();
    expect(trusted).not.toBe(home);

    await callThroughExtension(process.execPath, trusted, recordTo);

    const started = await startRecord(recordTo);
    expect(await fs.realpath(started.cwd)).toBe(await fs.realpath(trusted));
    expect(started.cwd).not.toBe(home);
  });

  it('refuses to open a server at all when the config carries no launch directory', async () => {
    const home = await plantedAgentHome();
    const recordTo = path.join(home, 'records.jsonl');
    process.chdir(home);
    await expect(callThroughExtension(process.execPath, undefined, recordTo))
      .rejects.toThrow(/absolute launchCwd/u);
  });

  // The vector itself, with the real mechanism: a bun interpreter reads
  // `$cwd/bunfig.toml` and runs its `preload` before the server's own first
  // line (probe 1, `attestation-probes/results.md`). Under the old inherited
  // cwd this test's planted preload would run; under the trusted directory it
  // is unreachable. Skipped where bun is not installed — the cwd assertion
  // above still holds there.
  it.skipIf(BUN_BIN === undefined)(
    'leaves a bunfig.toml preload planted in the Agent home unexecuted',
    async () => {
      const bun = BUN_BIN!;
      const home = await plantedAgentHome();
      process.chdir(home);

      // Negative control FIRST: the same planted file, the same bun, with the
      // old inherited cwd. If this does not preload, the positive case below
      // proves nothing.
      const inherited = path.join(home, 'inherited.jsonl');
      await callThroughExtension(bun, home, inherited);
      expect((await startRecord(inherited)).preloaded).toBe(true);

      const trusted = await trustedCwd();
      const guarded = path.join(home, 'guarded.jsonl');
      await callThroughExtension(bun, trusted, guarded);
      const started = await startRecord(guarded);
      expect(started.preloaded).toBe(false);
      expect(await fs.realpath(started.cwd)).toBe(await fs.realpath(trusted));
    },
  );
});
