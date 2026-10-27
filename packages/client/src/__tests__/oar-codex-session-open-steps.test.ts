import { describe, expect, it, vi } from 'vitest';
import { codexSession } from '../../vendor/oar/51b83c9/runtimes/codex/session';
import { codexThreadOpen } from '../../vendor/oar/51b83c9/runtimes/codex/open';
import type { LineProcess, SpawnLineProcess } from '../../vendor/oar/51b83c9/runtimes/codex/app-server-client';

/**
 * A scripted app-server: answers every request, `thread/start` and
 * `thread/resume` with the root thread. A kill exits on a later tick, as a
 * process does.
 */
function fakeServer(answers: Record<string, Record<string, unknown>> = {}) {
  let receive!: (line: string) => void;
  const exitHandlers: Array<(code: number | null) => void> = [];
  let resolveExit!: (code: number | null) => void;
  let ended = false;
  let exited = false;
  const writes: Record<string, any>[] = [];
  const child: LineProcess = {
    spawned: Promise.resolve(), exited: new Promise(resolve => { resolveExit = resolve; }),
    onLine: fn => { receive = fn; }, onExit: fn => { exitHandlers.push(fn); },
    write: vi.fn((line: string) => {
      const frame = JSON.parse(line); writes.push(frame);
      if (typeof frame.method !== 'string' || frame.id === undefined) return;
      const result = frame.method === 'thread/start' || frame.method === 'thread/resume'
        ? { thread: { id: 'thread-root' }, model: 'model', reasoningEffort: null }
        : answers[frame.method] ?? {};
      receive(JSON.stringify({ id: frame.id, result }));
    }),
    writeAcknowledged: text => { child.write(text); return Promise.resolve(); },
    kill: vi.fn(() => {
      if (ended) return; ended = true;
      setTimeout(() => { exited = true; exitHandlers.forEach(fn => fn(null)); resolveExit(null); }, 5);
    }),
  };
  const spawn = vi.fn<SpawnLineProcess>(() => child);
  return { child, spawn, writes, exited: () => exited, methods: () => writes.filter(frame => frame.id !== undefined).map(frame => frame.method) };
}
const installation = { kind: 'available', via: 'executable', command: 'fake' } as const;
const servers = [{ name: 'task_tool', command: '/bin/task-tool' }];

describe('vendored Codex caller-owned open steps (BYOK change)', () => {
  it.each([undefined, 'thread-root'])('sends the unmodified open request without steps (resume=%s)', async (resume) => {
    const options = { cwd: '/workspace', env: { HOME: '/home' }, mcpServers: servers, ...(resume === undefined ? {} : { resume }) };
    const fake = fakeServer();
    const session = await codexSession(fake.spawn, installation, options);
    const { method, params } = codexThreadOpen(options);
    expect(fake.methods()).toEqual(['initialize', method]);
    expect(fake.writes.find(frame => frame.method === method)?.params).toEqual(params);
    await session.dispose();
  });

  it('opens with the params beforeOpen returns and runs afterOpen on the same client before onReady', async () => {
    const fake = fakeServer({ 'config/read': { config: { model: 'm' } }, 'mcpServerStatus/list': { data: [], nextCursor: null } });
    const order: string[] = [];
    const session = await codexSession(fake.spawn, installation, { cwd: '/workspace', env: { HOME: '/home' }, mcpServers: servers }, 1000, {
      beforeOpen: async (request, params) => {
        order.push('beforeOpen');
        expect(await request('config/read', { cwd: '/workspace' })).toEqual({ config: { model: 'm' } });
        return { ...params, config: { ...(params.config as object), features: { plugins: false } } };
      },
      afterOpen: async (request, threadId) => {
        order.push(`afterOpen:${threadId}`);
        expect(await request('mcpServerStatus/list', { threadId })).toEqual({ data: [], nextCursor: null });
      },
      onReady: (threadId) => { order.push(`onReady:${threadId}`); },
    });
    expect(order).toEqual(['beforeOpen', 'afterOpen:thread-root', 'onReady:thread-root']);
    expect(fake.methods()).toEqual(['initialize', 'config/read', 'thread/start', 'mcpServerStatus/list']);
    expect(fake.writes.find(frame => frame.method === 'thread/start')?.params.config).toEqual({
      mcp_servers: { task_tool: { command: '/bin/task-tool', args: [], enabled: true } },
      features: { plugins: false },
    });
    await session.dispose();
  });

  it('kills the app-server and rethrows after it exits when beforeOpen throws, before any open request', async () => {
    const fake = fakeServer();
    const refusal = new Error('before refused');
    await expect(codexSession(fake.spawn, installation, { cwd: '/workspace', env: { HOME: '/home' } }, 1000, {
      beforeOpen: async () => { throw refusal; },
    })).rejects.toBe(refusal);
    expect(fake.child.kill).toHaveBeenCalledTimes(1);
    expect(fake.exited()).toBe(true);
    expect(fake.methods()).toEqual(['initialize']);
  });

  it('kills the app-server and rethrows after it exits when afterOpen throws, and never reports the thread ready', async () => {
    const fake = fakeServer();
    const refusal = new Error('after refused');
    const onReady = vi.fn();
    await expect(codexSession(fake.spawn, installation, { cwd: '/workspace', env: { HOME: '/home' } }, 1000, {
      afterOpen: async () => { throw refusal; }, onReady,
    })).rejects.toBe(refusal);
    expect(fake.child.kill).toHaveBeenCalledTimes(1);
    expect(fake.exited()).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
  });
});
