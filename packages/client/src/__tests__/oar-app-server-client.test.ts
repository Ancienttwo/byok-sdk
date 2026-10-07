import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  startAppServerClient, RpcTimeoutError,
  type LineProcess, type SpawnLineProcess, type AppServerLimits,
} from '../../vendor/oar/e1f9177/runtimes/codex/app-server-client.js';
import { rpcControl } from '../../vendor/oar/e1f9177/runtimes/codex/rpc-control.js';
import { createSessionKernel } from '../../vendor/oar/e1f9177/shared/session-kernel.js';

function fakeProcess() {
  const lines: Array<(line: string) => void> = [];
  const exits: Array<(code: number | null) => void> = [];
  let resolveExit!: (code: number | null) => void;
  const child: LineProcess = {
    spawned: Promise.resolve(),
    exited: new Promise(resolve => { resolveExit = resolve; }),
    onLine: handler => { lines.push(handler); },
    onExit: handler => { exits.push(handler); },
    write: vi.fn(),
    writeAcknowledged: text => { child.write(text); return Promise.resolve(); },
    // Deliberately does not emit exit: client cleanup must not depend on prompt process death.
    kill: vi.fn(),
  };
  const spawn = vi.fn<SpawnLineProcess>(() => child);
  return {
    child, spawn,
    line: (frame: unknown) => { for (const handler of lines) handler(JSON.stringify(frame)); },
    exit: (code: number | null) => { for (const handler of exits) handler(code); resolveExit(code); },
  };
}
function setup(limits: AppServerLimits = {}) {
  const fake = fakeProcess();
  const client = startAppServerClient(fake.spawn, 'fake-codex', {}, {}, undefined, limits);
  return { ...fake, client };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('OAR injected app-server client', () => {
  it('passes exactly the filtered environment, command, overrides and cwd', async () => {
    vi.stubEnv('BYOK_S1_UNRELATED_SECRET', 'must-not-leak');
    const fake = fakeProcess();
    const env = Object.freeze({ HOME: '/fake/home', PATH: '/fake/bin' });
    const client = startAppServerClient(fake.spawn, 'fake-codex', env, { sandbox_mode: 'danger-full-access' }, '/workspace');
    await client.spawned;
    expect(fake.spawn).toHaveBeenCalledWith('fake-codex', ['app-server', '-c', 'sandbox_mode=danger-full-access', '--listen', 'stdio://'], { cwd: '/workspace', env });
    expect(fake.spawn.mock.calls[0]![2].env).toBe(env);
    expect(fake.spawn.mock.calls[0]![2].env).not.toHaveProperty('BYOK_S1_UNRELATED_SECRET');
    expect(fake.spawn.mock.calls[0]![2].env).not.toHaveProperty('USER');
    client.kill();
  });

  it('preserves numeric and string server request ids in callbacks and result/error frames', () => {
    const { client, child, line } = setup();
    const onServerRequest = vi.fn();
    line({ id: 7, method: 'approval', params: { kind: 'number' } });
    line({ id: '7', method: 'approval', params: { kind: 'string' } });
    client.handle({ onNotification: vi.fn(), onServerRequest });
    expect(onServerRequest.mock.calls.map(call => call[0])).toEqual([7, '7']);
    client.respond(7, { ok: true }); client.respond('7', { ok: true });
    client.rejectRequest(7, -32601, 'unsupported'); client.rejectRequest('7', -32601, 'unsupported');
    const frames = vi.mocked(child.write).mock.calls.map(([text]) => JSON.parse(text));
    expect(frames).toEqual([
      { id: 7, result: { ok: true } }, { id: '7', result: { ok: true } },
      { id: 7, error: { code: -32601, message: 'unsupported' } },
      { id: '7', error: { code: -32601, message: 'unsupported' } },
    ]);
    client.kill();
  });

  it('times out requests independently, reclaims pending capacity and ignores late replies', async () => {
    vi.useFakeTimers();
    const { client, line, child } = setup({ maxPending: 2 });
    const settled = vi.fn();
    const short = client.request('short/method', {}, settled, 10).catch(error => error);
    const long = client.request('long/method', {}, undefined, 100);
    await vi.advanceTimersByTimeAsync(10);
    expect(await short).toBeInstanceOf(RpcTimeoutError);
    expect((await short).message).toContain('short/method');
    expect(settled).toHaveBeenCalledTimes(1);
    line({ id: 1, result: { late: true } });
    expect(settled).toHaveBeenCalledTimes(1);
    const replacement = client.request('replacement', {}, undefined, 50);
    line({ id: 3, result: { replacement: true } }); line({ id: 2, result: { long: true } });
    expect(await replacement).toEqual({ replacement: true });
    expect(await long).toEqual({ long: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a finite default deadline', async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const result = client.request('default/deadline', {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).message).toContain('default/deadline timed out after 30000ms');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves notification, request and mark order before registration and synchronous reply settlement', async () => {
    const { client, line } = setup();
    const order: string[] = [];
    line({ method: 'before' });
    line({ id: 'server', method: 'approval' });
    const reply = client.request('ordered', {}, () => client.mark(() => { order.push('reply'); }));
    line({ id: 1, result: {} }); line({ method: 'after' });
    client.handle({ onNotification: method => { order.push(method); }, onServerRequest: () => { order.push('request'); } });
    expect(order).toEqual(['before', 'request', 'reply', 'after']);
    await reply;
    client.kill();
  });

  it('terminates on held overflow, rejects pending immediately and prevents replay or further writes', async () => {
    vi.useFakeTimers();
    const { client, line, child } = setup({ maxHeld: 2 });
    const pending = client.request('waiting', {}).catch(error => error);
    line({ method: 'one' }); client.mark(() => {});
    expect(() => line({ id: 'overflow', method: 'approval' })).toThrow('held limit exceeded (2)');
    expect((await pending).message).toContain('held limit exceeded');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => client.handle({ onNotification: vi.fn(), onServerRequest: vi.fn() })).toThrow('held limit');
    expect(() => client.notify('later', {})).toThrow('held limit');
    await expect(client.request('later', {})).rejects.toThrow('held limit');
  });

  it('terminates on pending overflow without writing the overflowing request', async () => {
    vi.useFakeTimers();
    const { client, child } = setup({ maxPending: 1 });
    const firstSettled = vi.fn(); const secondSettled = vi.fn();
    const first = client.request('first', {}, firstSettled).catch(error => error);
    const second = client.request('second', {}, secondSettled).catch(error => error);
    expect((await first).message).toContain('pending limit exceeded (1)');
    expect((await second).message).toContain('pending limit exceeded (1)');
    expect(firstSettled).toHaveBeenCalledTimes(1); expect(secondSettled).toHaveBeenCalledTimes(1);
    expect(child.write).toHaveBeenCalledTimes(1); expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans pending deadlines on process exit', async () => {
    vi.useFakeTimers();
    const { client, exit } = setup();
    const pending = client.request('waiting', {}).catch(error => error);
    exit(9);
    expect((await pending).message).toBe('app-server exited');
    expect(await client.exited).toBe(9);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reclaims pending capacity after a failed write and preserves error response settlement', async () => {
    vi.useFakeTimers();
    const { client, child, line } = setup({ maxPending: 1 });
    vi.mocked(child.write).mockImplementationOnce(() => { throw new Error('write failed'); });
    await expect(client.request('write', {})).rejects.toThrow('write failed');
    expect(vi.getTimerCount()).toBe(0);
    const settled = vi.fn(); const next = client.request('next', {}, settled).catch(error => error);
    line({ id: 2, error: { message: 'runtime refusal' } });
    expect((await next).message).toBe('runtime refusal'); expect(settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid count budgets before spawn', () => {
    const fake = fakeProcess();
    for (const value of [0, -1, 1.5, Infinity]) {
      expect(() => startAppServerClient(fake.spawn, 'fake', {}, {}, undefined, { maxHeld: value })).toThrow('limits');
      expect(() => startAppServerClient(fake.spawn, 'fake', {}, {}, undefined, { maxPending: value })).toThrow('limits');
    }
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it('releases all pending state even when a terminal settlement callback throws', async () => {
    vi.useFakeTimers();
    const { client, child } = setup({ maxPending: 2 });
    const first = client.request('first', {}, () => { throw new Error('callback failure'); }).catch(error => error);
    const second = client.request('second', {}).catch(error => error);
    const third = client.request('overflow', {}).catch(error => error);
    expect((await first).message).toContain('pending limit exceeded');
    expect((await second).message).toContain('pending limit exceeded');
    expect((await third).message).toBe('callback failure');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records a control timeout as one rejected response even if the error mapper would accept', async () => {
    vi.useFakeTimers();
    const { client, line } = setup();
    const kernel = createSessionKernel('test-session'); const onError = vi.fn(() => ({ kind: 'accepted' as const }));
    const control = rpcControl(kernel, client, {
      body: { kind: 'abort' }, gate: () => null, method: 'turn/interrupt', params: () => ({}), timeoutMs: 20,
      onReply: () => ({ kind: 'accepted' }), onError,
    });
    await vi.advanceTimersByTimeAsync(20);
    const result = await control;
    expect(result.response.body).toEqual({ kind: 'rejected', code: 'error', reason: 'app-server turn/interrupt timed out after 20ms' });
    expect(result.response.requestId).toBe(result.request.id);
    line({ id: 1, result: {} });
    expect(kernel.records().map(record => record.kind)).toEqual(['request', 'response']);
    expect(onError).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

it('accounts for every vendored file and the seven maintained source deltas', () => {
  const root = path.resolve(import.meta.dirname, '../../vendor/oar/e1f9177');
  const manifest = JSON.parse(readFileSync(path.join(root, 'source-manifest.json'), 'utf8')) as {
    files: Array<{ path: string; sourcePath: string; upstreamSha256: string; vendoredSha256: string; delta?: string }>;
  };
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
  expect(files).toEqual([...manifest.files.map(row => row.path), 'source-manifest.json', 'PROVENANCE.md'].sort());
  for (const row of manifest.files) {
    expect(createHash('sha256').update(readFileSync(path.join(root, row.path))).digest('hex'), row.path).toBe(row.vendoredSha256);
    if (!row.delta) expect(row.vendoredSha256).toBe(row.upstreamSha256);
    if (row.path.endsWith('.ts')) expect(row.sourcePath).toBe(`packages/oar/src/${row.path}`);
  }
  expect(manifest.files.filter(row => row.delta).map(row => row.path).sort()).toEqual(['runtimes/codex/app-server-client.ts', 'runtimes/codex/open.ts', 'runtimes/codex/projection.ts', 'runtimes/codex/rpc-control.ts', 'runtimes/codex/session.ts', 'shared/mcp-servers.ts', 'shared/session-kernel.ts']);
  expect(readFileSync(path.join(root, 'LICENSE'), 'utf8')).toContain('Apache License');
});
