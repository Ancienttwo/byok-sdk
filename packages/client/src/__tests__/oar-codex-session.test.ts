import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexSession } from '../../vendor/oar/7dc98e0/runtimes/codex/session';
import * as projection from '../../vendor/oar/7dc98e0/runtimes/codex/projection';
import type { LineProcess, SpawnLineProcess } from '../../vendor/oar/7dc98e0/runtimes/codex/app-server-client';

function fakeServer(openReply: Record<string, unknown> = {}) {
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
        ? { thread: { id: 'thread-root' }, model: 'model', reasoningEffort: null, ...openReply }
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

  it('passes launch arguments to the owned spawn without adding them to records', async () => {
    const fake = fakeServer();
    const launchArgs = ['-c', 'service_tier="fast"'];
    const session = await codexSession(fake.spawn, { kind: 'available', via: 'executable', command: 'fake' }, {
      cwd: '/workspace', env: { HOME: '/home' }, launchArgs,
    });
    expect(fake.spawn.mock.calls[0]![1]).toEqual([
      'app-server', '-c', 'sandbox_mode="danger-full-access"', ...launchArgs, '--listen', 'stdio://',
    ]);
    expect(fake.spawn.mock.calls[0]![2]).toEqual({ cwd: '/workspace', env: { HOME: '/home' } });
    expect(JSON.stringify(session.records())).not.toContain('service_tier="fast"');
    await session.dispose();
  });

  it.each([
    { resume: undefined, serviceTier: 'priority', nativeTier: 'priority' },
    { resume: 'thread-root', serviceTier: 'priority', nativeTier: 'priority' },
    { resume: undefined, serviceTier: 'default', nativeTier: null },
    { resume: 'thread-root', serviceTier: 'default', nativeTier: null },
  ])('verifies service tier $serviceTier on open with resume=$resume and folds native updates', async ({ resume, serviceTier, nativeTier }) => {
    const fake = fakeServer({ serviceTier: nativeTier });
    const session = await codexSession(fake.spawn, { kind: 'available', via: 'executable', command: 'fake' }, {
      cwd: '/workspace', env: { HOME: '/home' }, serviceTier, ...(resume === undefined ? {} : { resume }),
    });
    const method = resume === undefined ? 'thread/start' : 'thread/resume';
    expect(fake.writes.find(frame => frame.method === method)?.params).toMatchObject({ serviceTier });
    expect(session.records()).toContainEqual(expect.objectContaining({
      kind: 'frame', body: expect.objectContaining({ type: method, events: expect.arrayContaining([{ kind: 'service_tier', serviceTier }]) }),
    }));
    fake.frame({ method: 'thread/settings/updated', params: { threadId: 'thread-root', threadSettings: { serviceTier: null } } });
    expect(session.records().at(-1)).toMatchObject({ kind: 'frame', body: { events: [{ kind: 'service_tier', serviceTier: 'default' }] } });
    await session.dispose();
  });

  it.each([{ serviceTier: 'flex' }, {}])('kills the owned process if the requested tier is substituted or unreported: %j', async openReply => {
    const fake = fakeServer(openReply);
    await expect(codexSession(fake.spawn, { kind: 'available', via: 'executable', command: 'fake' }, {
      cwd: '/workspace', env: { HOME: '/home' }, serviceTier: 'priority',
    })).rejects.toThrow('although priority was requested');
    expect(fake.child.kill).toHaveBeenCalledTimes(1);
    await fake.child.exited;
  });

  it('names an unconfirmed tier when the native open RPC fails and releases the process', async () => {
    const fake = fakeServer();
    const write = vi.mocked(fake.child.write).getMockImplementation()!;
    vi.mocked(fake.child.write).mockImplementation(line => {
      const frame = JSON.parse(line);
      if (frame.method === 'thread/start') {
        fake.frame({ id: frame.id, error: { code: -32602, message: 'unsupported tier' } });
      } else {
        write(line);
      }
    });
    await expect(codexSession(fake.spawn, { kind: 'available', via: 'executable', command: 'fake' }, {
      cwd: '/workspace', env: { HOME: '/home' }, serviceTier: 'priority',
    })).rejects.toThrow('serviceTier priority could not be confirmed (actual unreported): unsupported tier');
    expect(fake.child.kill).toHaveBeenCalledTimes(1);
    await fake.child.exited;
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

  it('accepts an unanswered interrupt after 10 s and kills the app-server', async () => {
    vi.useFakeTimers();
    const fake = fakeServer(); const session = await fake.open();
    await session.prompt('long turn');
    vi.mocked(fake.child.write).mockImplementationOnce(() => {});
    const abort = session.abort();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fake.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await abort).response.body).toEqual({ kind: 'accepted' });
    expect(fake.child.kill).toHaveBeenCalledTimes(1);
    expect(session.records().some(record => record.kind === 'response' && record.body.kind === 'exited')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('withdraws the abort fallback when codex refuses the interrupt', async () => {
    vi.useFakeTimers();
    const fake = fakeServer(); const session = await fake.open();
    await session.prompt('long turn');
    vi.mocked(fake.child.write).mockImplementationOnce((line: string) => {
      fake.frame({ id: JSON.parse(line).id, error: { code: -32600, message: 'turn already ended' } });
    });
    expect((await session.abort()).response.body).toEqual({ kind: 'rejected', code: 'runtime_refused', reason: 'turn already ended' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await session.dispose();
  });

  it('records a control in flight at dispose as runtime_exited', async () => {
    const fake = fakeServer(); const session = await fake.open();
    vi.mocked(fake.child.write).mockImplementationOnce(() => {});
    const pending = session.prompt('in flight');
    await session.dispose();
    expect((await pending).response.body).toEqual({ kind: 'rejected', code: 'runtime_exited', reason: 'app-server killed' });
  });

  it('keeps a failed settlement inside the server-request deadline timer and rejects the pending control', async () => {
    vi.useFakeTimers();
    const fake = fakeServer();
    let armed = false;
    const session = await codexSession(fake.spawn, { kind: 'available', via: 'executable', command: 'fake' }, { cwd: '/workspace', env: { HOME: '/home' } }, 1_000, {
      onRecord: record => { if (armed && record.kind === 'response') throw new Error('consumer failed'); },
    });
    vi.mocked(fake.child.write).mockImplementationOnce(() => {});
    const pending = session.prompt('in flight').catch(error => error);
    fake.child.writeAcknowledged = () => new Promise(() => {});
    armed = true;
    fake.frame({ id: 'late', method: 'item/commandExecution/requestApproval', params: {} });
    await expect(vi.advanceTimersByTimeAsync(1_000)).resolves.not.toThrow();
    expect(fake.child.kill).toHaveBeenCalled();
    expect((await pending).message).toBe('consumer failed');
  });

  it('keeps raw failed-turn reason without classifying it', () => {
    const { commands } = projection.foldCodexNotification(projection.initialCodexProjection('root'), 'turn/completed', { threadId: 'root', turn: { status: 'quota exceeded' } });
    expect(commands[0]).toMatchObject({ kind: 'frame', body: { events: [{ kind: 'turn_ended', outcome: { kind: 'failed', reason: 'quota exceeded' } }] } });
    const frame = commands[0];
    if (frame?.kind !== 'frame') throw new Error('missing frame');
    const event = frame.body.events[0];
    expect(event?.kind === 'turn_ended' ? event.outcome : null).toHaveProperty('failure', 'unknown');
  });

  it('classifies a failed turn from its structured codexErrorInfo', () => {
    const outcome = (error: unknown) => {
      const { commands } = projection.foldCodexNotification(projection.initialCodexProjection('root'), 'turn/completed', { threadId: 'root', turn: { status: 'failed', error } });
      const frame = commands[0];
      const event = frame?.kind === 'frame' ? frame.body.events[0] : undefined;
      return event?.kind === 'turn_ended' ? event.outcome : null;
    };
    expect(outcome({ message: 'limit', codexErrorInfo: 'usageLimitExceeded' })).toEqual({ kind: 'failed', reason: 'failed', failure: 'quota' });
    expect(outcome({ message: 'busy', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } })).toEqual({ kind: 'failed', reason: 'failed', failure: 'rate_limited', status: 429 });
  });

  it('refuses empty prompt and steer input before any RPC is written', async () => {
    const fake = fakeServer(); const session = await fake.open();
    const before = fake.writes.length;
    expect((await session.prompt('')).response.body).toEqual({ kind: 'rejected', code: 'unsupported', reason: 'empty input: give text or images' });
    await session.prompt('hello');
    const steerAt = fake.writes.length;
    expect((await session.steer('')).response.body).toMatchObject({ kind: 'rejected', code: 'unsupported' });
    expect(fake.writes.length).toBe(steerAt);
    expect(fake.writes.slice(before).filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    await session.dispose();
  });

  it('reports an accepted steer as dropped when its turn is interrupted before codex echoes it', async () => {
    const fake = fakeServer(); const session = await fake.open();
    await session.prompt('long turn');
    fake.frame({ method: 'turn/started', params: { threadId: 'thread-root', turn: { id: 'turn-root' } } });
    expect((await session.steer('more', { inputId: 'echoed' })).response.body.kind).toBe('accepted');
    expect((await session.steer('lost', { inputId: 'dropped' })).response.body.kind).toBe('accepted');
    fake.frame({ method: 'item/started', params: { threadId: 'thread-root', turnId: 'turn-root', item: { type: 'userMessage', clientId: 'echoed' } } });
    fake.frame({ method: 'turn/completed', params: { threadId: 'thread-root', turn: { id: 'turn-root', status: 'interrupted' } } });
    const events = session.records().flatMap(record => record.kind === 'frame' ? record.body.events : []);
    expect(events.filter(event => event.kind === 'input_dropped')).toEqual([{ kind: 'input_dropped', inputId: 'dropped', reason: 'turn_interrupted' }]);
    await session.dispose();
  });
});
