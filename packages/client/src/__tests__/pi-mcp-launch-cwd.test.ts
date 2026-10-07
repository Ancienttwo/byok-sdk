import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BYOK_PI_MCP_CONFIG_PATH } from '../adapters/pi/mcp-config';
import { observeMcpServer } from '../mcp/observation';

/**
 * The Pi MCP server pool starts every server in the `launchCwd` of the
 * task-scoped config: the session cwd, as in OAR. It never falls back to the
 * Pi process cwd.
 *
 * These tests run the REAL extension against the REAL fixture server, with
 * this process's own cwd set to a different directory, so the start cwd is a
 * fact read back out of the child rather than an assumption.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const ENV = { PATH: process.env.PATH ?? '' } as const;

const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
  delete process.env[BYOK_PI_MCP_CONFIG_PATH];
});

async function tempDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

interface Started { cwd: string }

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
    mcpEnv: ENV,
    mcpServers: { salesko: server },
    observation: { salesko: { ...observed, toolsetId: 'salesko.read.v1' } },
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
  return { cwd: String(last.cwd) };
}

describe('Pi MCP server pool — launch cwd', () => {
  it('starts the server in the session cwd of the config, not in the Pi process cwd', async () => {
    const session = await tempDir('byok-session-');
    const processCwd = await tempDir('byok-pi-process-');
    const recordTo = path.join(session, 'records.jsonl');
    process.chdir(processCwd);

    await callThroughExtension(process.execPath, session, recordTo);

    const started = await startRecord(recordTo);
    expect(await fs.realpath(started.cwd)).toBe(session);
    expect(started.cwd).not.toBe(processCwd);
  });

  it('refuses to open a server at all when the config carries no launch directory', async () => {
    const home = await tempDir('byok-agent-home-');
    const recordTo = path.join(home, 'records.jsonl');
    process.chdir(home);
    await expect(callThroughExtension(process.execPath, undefined, recordTo))
      .rejects.toThrow(/absolute launchCwd/u);
  });
});
