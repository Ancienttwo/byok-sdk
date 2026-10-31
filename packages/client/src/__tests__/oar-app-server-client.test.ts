import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  startAppServerClient,
  type LineProcess, type SpawnLineProcess,
} from '../../vendor/oar/044633e/runtimes/codex/app-server-client.js';
import { rpcControl } from '../../vendor/oar/044633e/runtimes/codex/rpc-control.js';
import { createSessionKernel } from '../../vendor/oar/044633e/shared/session-kernel.js';
import { sessionCredentialRedactor } from '../../vendor/oar/044633e/shared/credential-redactor.js';

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
function setup() {
  const fake = fakeProcess();
  const client = startAppServerClient(fake.spawn, 'fake-codex', {}, {}, undefined);
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

  it('rejects pending requests on process exit', async () => {
    const { client, exit } = setup();
    const pending = client.request('waiting', {}).catch(error => error);
    exit(9);
    expect((await pending).message).toBe('app-server exited');
    expect(await client.exited).toBe(9);
  });

  it('rejects a request whose write failed and still settles later error replies', async () => {
    const { client, child, line } = setup();
    vi.mocked(child.write).mockImplementationOnce(() => { throw new Error('write failed'); });
    await expect(client.request('write', {})).rejects.toThrow('write failed');
    const settled = vi.fn(); const next = client.request('next', {}, settled).catch(error => error);
    line({ id: 2, error: { message: 'runtime refusal' } });
    expect((await next).message).toBe('runtime refusal'); expect(settled).toHaveBeenCalledTimes(1);
    client.kill();
  });

  it('settles pending and later requests as exited after an exit or a kill, and ignores lines after a kill', async () => {
    const exited = setup();
    const onExit = vi.fn();
    const beforeExit = exited.client.request('waiting', {}, onExit).catch(error => error);
    exited.exit(9);
    expect(onExit).toHaveBeenCalledWith({ kind: 'exited', error: await beforeExit });
    const afterExit = vi.fn();
    await expect(exited.client.request('later', {}, afterExit)).rejects.toThrow('app-server exited');
    expect(afterExit.mock.calls[0]![0]).toMatchObject({ kind: 'exited' });

    const killed = setup();
    const onKill = vi.fn();
    const beforeKill = killed.client.request('waiting', {}, onKill).catch(error => error);
    killed.client.kill();
    expect((await beforeKill).message).toBe('app-server killed');
    expect(onKill.mock.calls[0]![0]).toMatchObject({ kind: 'exited' });
    expect(killed.child.kill).toHaveBeenCalledTimes(1);
    killed.line({ id: 1, result: { late: true } });
    expect(onKill).toHaveBeenCalledTimes(1);
    expect(() => killed.client.notify('later', {})).toThrow('app-server killed');
    expect(() => killed.client.handle({ onNotification: vi.fn(), onServerRequest: vi.fn() })).toThrow('app-server killed');
  });

  it('passes the redacted native error object with an error reply', async () => {
    const fake = fakeProcess();
    const client = startAppServerClient(fake.spawn, 'fake-codex', {}, {}, undefined, { redact: text => text.replaceAll('TOKEN', '[redacted]') });
    const settled = vi.fn();
    const reply = client.request('refused', {}, settled).catch(error => error);
    fake.line({ id: 1, error: { code: -32000, message: 'bad TOKEN', data: { header: 'Bearer TOKEN', attempts: 2 } } });
    expect((await reply).message).toBe('bad [redacted]');
    expect(settled.mock.calls[0]![0]).toMatchObject({
      kind: 'error', native: { code: -32000, message: 'bad [redacted]', data: { header: 'Bearer [redacted]', attempts: 2 } },
    });
    client.kill();
  });

  it('records an exited outcome as runtime_exited without the plan error mapper', async () => {
    const { client, exit } = setup();
    const kernel = createSessionKernel('test-session'); const onError = vi.fn(() => ({ kind: 'accepted' as const }));
    const control = rpcControl(kernel, client, {
      body: { kind: 'steer', input: 'x' }, gate: () => null, method: 'turn/steer', params: () => ({}),
      onReply: () => ({ kind: 'accepted' }), onError,
    });
    exit(1);
    expect((await control).response.body).toEqual({ kind: 'rejected', code: 'runtime_exited', reason: 'app-server exited' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('lets a pending fallback accept a control and records the late native reply as a frame', async () => {
    const { client, line } = setup();
    const kernel = createSessionKernel('test-session');
    let takeover: (() => void) | undefined;
    const control = rpcControl(kernel, client, {
      body: { kind: 'abort' }, gate: () => null, method: 'turn/interrupt', params: () => ({}),
      onPending: accept => { takeover = accept; },
      onReply: () => ({ kind: 'rejected', code: 'runtime_refused', reason: 'second answer' }), onError: () => ({ kind: 'rejected', code: 'runtime_refused', reason: 'second answer' }),
    });
    takeover!();
    line({ id: 1, result: { late: true } });
    expect((await control).response.body).toEqual({ kind: 'accepted' });
    const records = kernel.records();
    expect(records.map(record => record.kind)).toEqual(['request', 'response', 'frame']);
    expect(records[2]).toMatchObject({ kind: 'frame', body: { type: 'turn/interrupt', native: { late: true }, events: [] } });
    client.kill();
  });

});

describe('OAR session kernel record redaction', () => {
  it('retains and delivers the redacted record, and swallows observer errors', () => {
    const secret = `sk-${'x'.repeat(4096)}`;
    const { redactValue } = sessionCredentialRedactor({ env: { OPENAI_API_KEY: secret } });
    const native = { type: 'item/agentMessage/delta', native: { delta: secret }, events: [] };
    const kernel = createSessionKernel('root', redactValue);
    const observer = vi.fn(() => { throw new Error('consumer failed'); });
    kernel.rawEvents(observer);
    const frame = kernel.frame(native);
    expect(frame.body.native).toEqual({ delta: '[redacted]' });
    expect(native.native.delta).toBe(secret);
    expect(kernel.records()).toEqual([frame]);
    expect(observer).toHaveBeenCalledWith(frame);
  });
});

it('accounts for every vendored file and the sixteen maintained source deltas', () => {
  const root = path.resolve(import.meta.dirname, '../../vendor/oar/044633e');
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
  expect(manifest.files.filter(row => row.delta).map(row => row.path).sort()).toEqual(['contracts/failure.ts', 'observe/events.ts', 'runtimes/codex/app-server-client.ts', 'runtimes/codex/failure.ts', 'runtimes/codex/open.ts', 'runtimes/codex/session.ts', 'runtimes/grok/session.ts', 'shared/acp/client-app.ts', 'shared/acp/errors.ts', 'shared/acp/failure.ts', 'shared/acp/process.ts', 'shared/acp/session.ts', 'shared/acp/terminal.ts', 'shared/acp/turns.ts', 'shared/executable/process-tree.ts', 'shared/failure-class.ts']);
  expect(readFileSync(path.join(root, 'LICENSE'), 'utf8')).toContain('Apache License');
});
