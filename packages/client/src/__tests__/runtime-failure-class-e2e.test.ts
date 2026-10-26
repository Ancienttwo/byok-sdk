import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { testAgentHomeConfig } from './fixtures/test-agent';
/**
 * #869: a Host reads a failed task's runtime failure class from
 * `tasks.get(taskId).result.failure` on the real embedded server, never from
 * `reason`. The path from the adapter's `RuntimeExecutionFailure` to the
 * Host read is the same for every adapter; the adapter tests cover each
 * runtime's classes.
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { RuntimeAdapter } from '../types';
import { testScratchRoot } from './fixtures/execution-scratch';
import { startRealServer, submitAgentTask, type RealServerHandle } from './fixtures/real-server';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const RESETS_AT_SECONDS = 1_792_832_400;

/** Spawns the fixture with extra environment the daemon's filtered runtime env would drop. */
const withEnv = (env: Record<string, string>) => ((command: string, args: readonly string[], options?: SpawnOptions) =>
  spawn(command, args, { ...options, env: { ...options?.env, ...env } })) as typeof spawn;

const ADAPTERS = {
  claude: () => new ClaudeAdapter({
    resolveBin: () => ({ command: fixture('fake-claude.mjs'), source: 'path' }),
    spawnFn: withEnv({ FAKE_CLAUDE_FAILURES: JSON.stringify([
      { rateLimit: { status: 'rejected', resetsAt: RESETS_AT_SECONDS, rateLimitType: 'five_hour' }, error: 'rate_limit', status: 429 },
    ]) }),
  }),
  codex: () => new CodexAdapter({
    resolveBin: () => ({ command: fixture('fake-codex.mjs'), source: 'path' }),
    spawnFn: withEnv({ FAKE_CODEX_TURN_FAILS: '1', FAKE_CODEX_FAIL_MESSAGE: 'Rate limit reached', FAKE_CODEX_ERROR_INFO: '"rateLimitExceeded"' }),
  }),
  pi: () => new PiAdapter({
    resolveBin: () => ({ command: fixture('fake-pi.mjs'), source: 'env' }),
    spawnFn: withEnv({ FAKE_PI_AUTO_RETRY_FAIL: '1', FAKE_PI_AUTO_RETRY_FINAL_ERROR: '429 You exceeded your current quota' }),
  }),
} satisfies Record<string, () => RuntimeAdapter>;

let real: RealServerHandle | undefined;
let daemon: Daemon | undefined;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await daemon?.stop();
  await real?.close();
  daemon = undefined;
  real = undefined;
});

async function failedTask(runtime: keyof typeof ADAPTERS, options: { oldServer?: boolean } = {}) {
  const productId = `failure-class-${runtime}`;
  real = await startRealServer({ productId, longPollHoldMs: 50 });
  const server = real;
  if (options.oldServer) {
    // A server that predates the flag: its advertisement lacks it.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${server.url}/byok/events`) && !url.startsWith(`${server.url}/byok/messages`)) return response;
      const body = await response.clone().json() as { capabilities?: string[] };
      if (body.capabilities === undefined) return response;
      body.capabilities = body.capabilities.filter((flag) => flag !== 'runtime-failure-class');
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }) as typeof fetch;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-failure-class-'));
  daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' },
    productName: 'Failure class test', productId, serverUrl: server.url,
    workspaceRoot: path.join(root, 'workspace'), storeDir: path.join(root, 'store'),
    agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
  }, [ADAPTERS[runtime]()], { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } });
  const record = await daemon.pair((await server.createPairingCode()).code);
  await daemon.start();
  await vi.waitFor(async () => {
    expect((await server.byok.machines.list()).find((machine) => machine.deviceId === record.deviceId)?.connected).toBe(true);
  });
  const taskId = await submitAgentTask(server, { taskId: `task-failure-class-${runtime}`, deviceId: record.deviceId, instruction: 'say hi', runtime });
  return vi.waitFor(async () => {
    const snapshot = await server.byok.tasks.get(taskId);
    expect(snapshot?.state).toBe('Failed');
    return snapshot!.result!;
  }, { timeout: 15_000 });
}

describe('the runtime failure class through the real embedded server (#869)', () => {
  it('reads a Claude quota failure with the time the runtime said it resets', async () => {
    const result = await failedTask('claude');
    expect(result.failure).toEqual({ class: 'quota', resetsAt: new Date(RESETS_AT_SECONDS * 1000).toISOString() });
    expect(result.reason).toBe('claude reported terminal task failure');
  }, 30_000);

  it('reads a Codex 429 as rate_limited', async () => {
    const result = await failedTask('codex');
    expect(result.failure).toEqual({ class: 'rate_limited' });
    expect(result.reason).toBe('Rate limit reached');
  }, 30_000);

  it('reads a Pi failure with no structured evidence as unknown', async () => {
    const result = await failedTask('pi');
    expect(result.failure).toEqual({ class: 'unknown' });
  }, 30_000);

  it('reads no class from a daemon talking to a server without the flag', async () => {
    const result = await failedTask('codex', { oldServer: true });
    expect(result.failure).toBeUndefined();
    expect(result.reason).toBe('Rate limit reached');
  }, 30_000);
});
