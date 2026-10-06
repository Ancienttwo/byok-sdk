import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexSession } from '../../vendor/oar/a800aa0/runtimes/codex/session';
import * as projection from '../../vendor/oar/a800aa0/runtimes/codex/projection';
import type { LineProcess, SpawnLineProcess } from '../../vendor/oar/a800aa0/runtimes/codex/app-server-client';

function fakeServer() {
  let receive!: (line: string) => void;
  const exitHandlers: Array<(code: number | null) => void> = [];
  let resolveExit!: (code: number | null) => void;
  let ended = false;
  const writes: Record<string, unknown>[] = [];
  const child: LineProcess = {
    spawned: Promise.resolve(), exited: new Promise(resolve => { resolveExit = resolve; }),
    onLine: fn => { receive = fn; }, onExit: fn => { exitHandlers.push(fn); },
    write: vi.fn((line: string) => {
      const frame = JSON.parse(line); writes.push(frame);
      if (typeof frame.method !== 'string' || frame.id === undefined) return;
      const result = frame.method === 'thread/start' || frame.method === 'thread/resume'
        ? { thread: { id: 'thread-root' }, model: 'model', reasoningEffort: null }
        : frame.method === 'turn/start' ? { turn: { id: 'turn-root' } } : {};
      receive(JSON.stringify({ id: frame.id, result }));
    }),
    writeAcknowledged: text => { child.write(text); return Promise.resolve(); },
    kill: vi.fn(() => {
      if (ended) return; ended = true;
      exitHandlers.forEach(fn => fn(null)); resolveExit(null);
    }),
  };
  const spawn = vi.fn<SpawnLineProcess>(() => child);
  const open = () => codexSession(spawn, { kind: 'available', via: 'executable', command: 'fake' }, { cwd: '/workspace', env: { HOME: '/home' } });
  return { child, spawn, writes, open, frame: (value: unknown) => receive(JSON.stringify(value)) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('unconnected OAR Codex adapter', () => {
  it('opens with injected filtered env and fixed YOLO config and returns only the raw adapter', async () => {
    vi.stubEnv('OAR_CODEX_SANDBOX', 'read-only');
    const fake = fakeServer(); const session = await fake.open();
    expect(fake.spawn.mock.calls[0]![2]).toEqual({ cwd: '/workspace', env: { HOME: '/home' } });
    expect(fake.spawn.mock.calls[0]![1]).toContain('sandbox_mode="danger-full-access"');
    expect(Object.keys(session).sort()).toEqual(['abort','capabilities','dispose','graph','id','prompt','queue','rawEvents','records','steer'].sort());
    await session.dispose(); expect(fake.child.kill).toHaveBeenCalledTimes(1);
  });

  it('preserves native facts before derived readings and keeps child completion separate from root controls', async () => {
    const fake = fakeServer(); const session = await fake.open();
    await session.prompt('hello');
    fake.frame({ method: 'item/agentMessage/delta', params: { threadId: 'thread-root', delta: 'hello' } });
    const last = session.records().slice(-2);
    expect(last.map(record => record.kind === 'frame' ? record.body.events : null)).toEqual([[], [{ kind: 'text_delta', text: 'hello' }]]);
    fake.frame({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } });
    expect((await session.prompt('still busy')).response.body).toMatchObject({ kind: 'rejected', code: 'busy' });
    fake.frame({ method: 'turn/completed', params: { threadId: 'thread-root', turn: { status: 'completed' } } });
    expect((await session.prompt('next')).response.body.kind).toBe('accepted');
    await session.dispose();
  });

  it('retains the native notification and visibly terminates when the required fold throws', async () => {
    const fake = fakeServer(); const session = await fake.open();
    vi.spyOn(projection, 'foldCodexNotification').mockImplementationOnce(() => { throw new Error('projection failed'); });
    const params = { threadId: 'thread-root', delta: 'retain me' };
    expect(() => fake.frame({ method: 'item/agentMessage/delta', params })).toThrow('projection failed');
    expect(session.records().some(record => record.kind === 'frame' && record.body.type === 'item/agentMessage/delta' && JSON.stringify(record.body.native) === JSON.stringify(params))).toBe(true);
    expect(fake.child.kill).toHaveBeenCalledTimes(1);
    expect((await session.prompt('after failure')).response.body).toMatchObject({ kind: 'rejected', code: 'runtime_exited' });
  });

  it('answers every server request with its schema-specific refusal and preserves original wire ids', async () => {
    vi.useFakeTimers();
    const fake = fakeServer(); const session = await fake.open();
    const methods = ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request','item/tool/call','account/chatgptAuthTokens/refresh','attestation/generate','applyPatchApproval','execCommandApproval','unknown/method'];
    for (const [index, method] of methods.entries()) fake.frame({ id: index % 2 ? `${index}` : index, method, params: {} });
    const replies = fake.writes.filter(frame => frame.id !== undefined && frame.method === undefined);
    expect(replies).toHaveLength(methods.length);
    expect(replies.slice(0,3)).toEqual([{ id: 0, result: { decision: 'decline' } },{ id: '1', result: { decision: 'decline' } },{ id: 2, result: { permissions: {} } }]);
    for (const [index, reply] of replies.slice(3).entries()) {
      expect(reply.id).toBe((index + 3) % 2 ? `${index + 3}` : index + 3);
      expect(reply.error).toMatchObject({ code: -32601 });
    }
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(session.records().filter(record => record.kind === 'request' && record.direction === 'toApp')).toHaveLength(methods.length);
    await session.dispose();
  });

  it('terminates and records a failure if the server response cannot be written', async () => {
    vi.useFakeTimers();
    const fake = fakeServer(); const session = await fake.open();
    vi.mocked(fake.child.write).mockImplementationOnce(() => { throw new Error('broken transport'); });
    fake.frame({ id: 'request', method: 'item/permissions/requestApproval', params: {} });
    expect(fake.child.kill).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    expect(session.records().some(record => record.kind === 'response' && record.body.kind === 'rejected' && record.body.reason === 'broken transport')).toBe(true);
  });

  it('releases the active prompt slot after a bounded RPC timeout', async () => {
    vi.useFakeTimers();
    const fake = fakeServer(); const session = await fake.open();
    vi.mocked(fake.child.write).mockImplementationOnce(() => {});
    const pending = session.prompt('timeout');
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).response.body).toMatchObject({ kind: 'rejected', code: 'error' });
    expect((await session.prompt('retry')).response.body.kind).toBe('accepted');
    await session.dispose();
  });

  it('keeps raw failed-turn reason without classifying it', () => {
    const { commands } = projection.foldCodexNotification(projection.initialCodexProjection('root'), 'turn/completed', { threadId: 'root', turn: { status: 'quota exceeded' } });
    expect(commands[0]).toMatchObject({ kind: 'frame', body: { events: [{ kind: 'turn_ended', outcome: { kind: 'failed', reason: 'quota exceeded' } }] } });
    const frame = commands[0];
    if (frame?.kind !== 'frame') throw new Error('missing frame');
    const event = frame.body.events[0];
    expect(event?.kind === 'turn_ended' ? event.outcome : null).toHaveProperty('failure', 'unknown');
  });
});
