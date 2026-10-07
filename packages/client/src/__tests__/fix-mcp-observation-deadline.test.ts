/** S18-2: one observation deadline across initialization, listing and pagination. */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { observeMcpServer } from '../mcp/observation';
import { McpStdioClient, McpTransportError } from '../mcp/client';
import { probeMcpServer } from '../daemon/mcp-tools-probe';
import { createPreparedToolSurfaceAssembler } from '../daemon/prepared-tool-surface';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import * as identity from '../daemon/tool-implementation-identity';

const FIXTURE = fileURLToPath(new URL('./fixtures/fix-mcp-observation-deadline.mjs', import.meta.url));
const ENV = { PATH: process.env.PATH ?? '' };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(config: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'byok-observation-deadline-'));
  roots.push(root);
  const recordTo = path.join(root, 'events.jsonl');
  return {
    server: { command: process.execPath, args: [FIXTURE, JSON.stringify({ ...config, recordTo })] },
    async events(): Promise<Array<{ event: string; pid?: number; method?: string; cursor?: string }>> {
      const text = await fs.readFile(recordTo, 'utf8').catch(() => '');
      return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
    },
  };
}
async function expectExited(f: Awaited<ReturnType<typeof fixture>>) {
  const events = await f.events();
  const pid = events.find((event) => event.event === 'start')?.pid;
  expect(pid).toBeTypeOf('number');
  expect(() => process.kill(pid!, 0)).toThrow();
  return events;
}

describe('S18-2: observation-wide deadline', () => {
  it.each(['ordinary', 'prepared'])('rejects slow successful initialize plus slow listing at the original %s admission deadline', async (route) => {
    const f = await fixture({ initializeMs: 700, listMs: 700 });
    const timeoutMs = 1_200;
    const started = performance.now();
    if (route === 'ordinary') {
      await expect(probeMcpServer('fixture', f.server, { env: ENV, timeoutMs })).rejects.toThrow(/timed out|deadline/iu);
    } else {
      const assembler = createPreparedToolSurfaceAssembler({
        runtimeEnv: () => ENV,
        toolsetRegistry: new McpToolsetRegistry({ test: { mcpServers: { fixture: f.server } } }),
        probeTimeoutMs: timeoutMs,
      });
      const result = await assembler.assemble({
        agentMemory: 'none', requiredToolsets: ['test'], runtimeIdentity: 'inert-runtime',
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toMatch(/timed out|deadline/iu);
    }
    expect(performance.now() - started).toBeLessThan(timeoutMs + 650);
    const events = await expectExited(f);
    expect(events.some((event) => event.method === 'tools/list')).toBe(true);
    expect(events.some((event) => event.event === 'reply' && event.method === 'tools/list')).toBe(false);
  });

  it('shares the same deadline across every tools/list page', async () => {
    const f = await fixture({ initializeMs: 150, listMs: 400, pages: 3 });
    const started = performance.now();
    await expect(observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 1_100 })).rejects.toBeInstanceOf(McpTransportError);
    expect(performance.now() - started).toBeLessThan(1_750);
    const events = await expectExited(f);
    expect(events.filter((event) => event.event === 'request' && event.method === 'tools/list').length).toBeGreaterThan(1);
  });

  it('observes six slow servers concurrently within one admission budget', async () => {
    const fixtures = await Promise.all(Array.from({ length: 6 }, () => fixture({ initializeMs: 700, listMs: 700 })));
    const started = performance.now();
    const results = await Promise.allSettled(fixtures.map((f, index) =>
      probeMcpServer(`fixture_${index}`, f.server, { env: ENV, timeoutMs: 1_200 })));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_850);
    await Promise.all(fixtures.map(expectExited));
  });

  it.each([NaN, Infinity, -1, 2_147_483_648])('rejects unsupported observation timer budget %s without spawning', async (timeoutMs) => {
    const f = await fixture();
    await expect(observeMcpServer('fixture', f.server, { env: ENV, timeoutMs })).rejects.toBeInstanceOf(RangeError);
    expect(await f.events()).toEqual([]);
  });

  it('treats a zero observation budget as already expired', async () => {
    const f = await fixture();
    await expect(observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 0 })).rejects.toBeInstanceOf(McpTransportError);
    expect(await f.events()).toEqual([]);
  });

  it('accepts successful multi-page observation within the total budget', async () => {
    const f = await fixture({ initializeMs: 40, listMs: 40, pages: 3 });
    const observed = await observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 1_500 });
    expect(observed.tools.map((tool) => tool.name)).toEqual(['echo_0', 'echo_1', 'echo_2']);
    await expectExited(f);
  });

  it('keeps long-lived clients on independent per-request deadlines', async () => {
    const f = await fixture({ initializeMs: 450, listMs: 450, callMs: 450 });
    const client = new McpStdioClient(f.server, { env: ENV, timeoutMs: 800 });
    try {
      await client.connect();
      expect(await client.listTools()).toHaveLength(1);
      expect((await client.callTool('echo_0', {})).content).toHaveLength(1);
    } finally { await client.close(); }
    await expectExited(f);
  });

  it('preserves caller cancellation during listing and awaits child exit', async () => {
    const f = await fixture({ listMs: 10_000 });
    const controller = new AbortController();
    const pending = observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 5_000, signal: controller.signal });
    const result = pending.catch((error: unknown) => error);
    await expect.poll(async () => (await f.events()).some((event) => event.method === 'tools/list')).toBe(true);
    controller.abort(new Error('caller stopped observation'));
    expect(await result).toMatchObject({ message: expect.stringContaining('caller stopped observation') });
    await expectExited(f);
  });

  it('does not spawn for an already-aborted caller', async () => {
    const f = await fixture();
    const verification = vi.spyOn(identity, 'assertToolImplementationBeforeSpawn');
    const signal = AbortSignal.abort(new Error('already cancelled'));
    await expect(observeMcpServer('fixture', f.server, { env: ENV, signal })).rejects.toThrow(/already cancelled/);
    expect(await f.events()).toEqual([]);
    expect(verification).not.toHaveBeenCalled();
  });

  it('refuses a spawn after verification passes the deadline before the timer callback runs', async () => {
    const f = await fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(identity, 'assertToolImplementationBeforeSpawn').mockImplementation(async () => { clock.mockReturnValue(2_000); });
    await expect(observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 1_000 })).rejects.toThrow(/timed out|deadline/iu);
    expect(await f.events()).toEqual([]);
  });

  it('does not issue another page after expiry even before timer delivery', async () => {
    const f = await fixture({ pages: 3 });
    const request = Client.prototype.request;
    vi.spyOn(Client.prototype, 'request').mockImplementation(async function (this: Client, ...args) {
      const result = await request.apply(this, args);
      if (args[0].method === 'tools/list' && (result as { nextCursor?: string }).nextCursor) {
        vi.spyOn(performance, 'now').mockReturnValue(1e12);
      }
      return result;
    });
    await expect(observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 10_000 })).rejects.toThrow(/timed out|deadline/iu);
    const events = await expectExited(f);
    expect(events.filter((event) => event.event === 'request' && event.method === 'tools/list')).toHaveLength(1);
  });

  it('refuses a late successful last page before returning an observation', async () => {
    const f = await fixture();
    const listTools = McpStdioClient.prototype.listTools;
    vi.spyOn(McpStdioClient.prototype, 'listTools').mockImplementation(async function (this: McpStdioClient, signal) {
      const result = await listTools.call(this, signal);
      vi.spyOn(performance, 'now').mockReturnValue(1e12);
      return result;
    });
    await expect(observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 10_000 })).rejects.toThrow(/timed out|deadline/iu);
    await expectExited(f);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite absolute deadline (%s) before verification or spawn', async (deadline) => {
    const f = await fixture();
    const verification = vi.spyOn(identity, 'assertToolImplementationBeforeSpawn');
    const client = new McpStdioClient(f.server, { env: ENV });
    try { await expect(client.connect(undefined, deadline)).rejects.toBeInstanceOf(RangeError); }
    finally { await client.close(); }
    expect(verification).not.toHaveBeenCalled();
    expect(await f.events()).toEqual([]);
  });

  it('rejects an already-expired absolute deadline without spawning', async () => {
    const f = await fixture();
    const verification = vi.spyOn(identity, 'assertToolImplementationBeforeSpawn');
    const client = new McpStdioClient(f.server, { env: ENV });
    try { await expect(client.connect(undefined, performance.now() - 1)).rejects.toBeInstanceOf(McpTransportError); }
    finally { await client.close(); }
    expect(verification).not.toHaveBeenCalled();
    expect(await f.events()).toEqual([]);
  });

  it('preserves an earlier caller abort over an expired deadline', async () => {
    const f = await fixture();
    const reason = new Error('earlier caller reason');
    const client = new McpStdioClient(f.server, { env: ENV });
    try { await expect(client.connect(AbortSignal.abort(reason), -1)).rejects.toBe(reason); }
    finally { await client.close(); }
    expect(await f.events()).toEqual([]);
  });

  it('does not begin listing after a late initialize even before timer delivery', async () => {
    const f = await fixture();
    const connect = McpStdioClient.prototype.connect;
    vi.spyOn(McpStdioClient.prototype, 'connect').mockImplementation(async function (this: McpStdioClient, ...args) {
      await connect.apply(this, args);
      vi.spyOn(performance, 'now').mockReturnValue(1e12);
    });
    await expect(observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 10_000 })).rejects.toThrow(/timed out|deadline/iu);
    const events = await expectExited(f);
    expect(events.some((event) => event.method === 'tools/list')).toBe(false);
  });

  it('uses the default total 10-second budget and waits for cleanup after expiry', async () => {
    vi.useFakeTimers();
    let finishClose!: () => void;
    let settled = false;
    vi.spyOn(McpStdioClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(McpStdioClient.prototype, 'listTools').mockImplementation((signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const close = vi.spyOn(McpStdioClient.prototype, 'close').mockImplementation(() => new Promise((resolve) => { finishClose = resolve; }));
    const result = observeMcpServer('fixture', { command: 'must-not-spawn' }, { env: {} })
      .catch((error: unknown) => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    finishClose();
    expect(await result).toBeInstanceOf(McpTransportError);
  });

  it.skipIf(process.platform === 'win32')('awaits the existing SIGTERM grace and confirmed child exit on forced cleanup', async () => {
    const f = await fixture({ initializeMs: 50, listMs: 10_000, ignoreTermination: true });
    const started = performance.now();
    await expect(observeMcpServer('fixture', f.server, { env: ENV, timeoutMs: 700 })).rejects.toBeInstanceOf(McpTransportError);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2_600);
    expect(elapsed).toBeLessThan(3_600);
    const events = await expectExited(f);
    expect(events.some((event) => event.event === 'sigterm')).toBe(true);
  });

  it('clears its observation timer after success', async () => {
    vi.useFakeTimers();
    let sharedSignal: AbortSignal | undefined;
    vi.spyOn(McpStdioClient.prototype, 'connect').mockImplementation(async (signal) => { sharedSignal = signal; });
    vi.spyOn(McpStdioClient.prototype, 'listTools').mockResolvedValue([]);
    vi.spyOn(McpStdioClient.prototype, 'serverInfo').mockReturnValue({ name: 'inert', version: '1' });
    vi.spyOn(McpStdioClient.prototype, 'protocolVersion').mockReturnValue('2025-06-18');
    vi.spyOn(McpStdioClient.prototype, 'close').mockResolvedValue();
    await observeMcpServer('fixture', { command: 'must-not-spawn' }, { env: {}, timeoutMs: 1_000 });
    expect(sharedSignal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sharedSignal?.aborted).toBe(false);
  });
});
