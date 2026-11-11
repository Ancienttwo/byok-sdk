import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HostProcess, type SupervisedHostState } from '../main/host-process.ts';
import { BridgeClient, type HostChild } from './client.ts';
import { BRIDGE_VERSION, BridgeError, encodeMessage } from './protocol.ts';
import { createRendererRouter } from './route.ts';
import { serveBridge } from './server.ts';

/** A domain as a `src/bridge/domains/` module declares one; `test.reset` is not on the renderer allowlist. */
interface TestMethods {
  'test.echo': { params: { text: string }; result: { text: string } };
  'test.reset': { params: undefined; result: null };
}

// Dev mode: the Host child runs under plain Node, as main spawns it.
const stubHost = (): HostChild =>
  spawn(process.execPath, [fileURLToPath(new URL('./stub-host.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'] });

describe('desktop bridge', () => {
  it('connects to the dev Host under Node, reads status and shuts it down cleanly', async () => {
    const child = stubHost();
    const host = await BridgeClient.connect(child);
    expect(await host.call('status', undefined)).toEqual({ state: 'running', pid: child.pid, activeWork: 0 });
    expect(await host.call('shutdown', undefined)).toBeNull();
    expect(await host.exited).toBe(0);
  });

  it('fails closed on a bridge version mismatch from either side', async () => {
    const host = stubHost();
    host.stdin.write(encodeMessage({ id: 1, method: 'hello', params: { bridgeVersion: BRIDGE_VERSION + 1 } }));
    const [line] = await once(createInterface({ input: host.stdout }), 'line') as [string];
    expect(JSON.parse(line)).toMatchObject({ id: 1, error: { code: 'bridge_version_mismatch' } });
    expect((await once(host, 'exit'))[0]).toBe(1);

    const script = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => process.stdout.write(
      JSON.stringify({ id: JSON.parse(line).id, result: { bridgeVersion: ${BRIDGE_VERSION + 1} } }) + '\\n'))`;
    const shell = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = once(shell, 'exit');
    await expect(BridgeClient.connect(shell)).rejects.toMatchObject({ code: 'bridge_version_mismatch' });
    expect((await exited)[1]).toBe('SIGTERM');
  });

  it('restarts a crashed Host with doubling backoff, then quits on an acknowledged shutdown', async () => {
    const children: HostChild[] = [];
    const crash = (): HostChild => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const states: SupervisedHostState[] = [];
    const host = new HostProcess({
      spawnHost: () => { const child = children.length < 2 ? crash() : stubHost(); children.push(child); return child; },
      onState: state => states.push(state),
      initialBackoffMs: 20,
    });
    host.start();
    await vi.waitFor(() => host.call('status', undefined), { timeout: 5_000 });
    expect(states.map(state => state.state === 'restarting' && state.inMs)).toEqual([20, 40]);

    const exited = once(children[2]!, 'exit');
    await host.stop();
    expect((await exited)[0]).toBe(0);
  });

  it('kills a Host that does not acknowledge shutdown within the grace period, and the quit fails', async () => {
    const script = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method } = JSON.parse(line);
      if (method !== 'hello') return;
      process.stdout.write(JSON.stringify({ id, result: { bridgeVersion: ${BRIDGE_VERSION} } }) + '\\n');
      process.stdout.write(JSON.stringify({ event: 'state', state: { state: 'running', pid: process.pid, activeWork: 1 } }) + '\\n');
    })`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    let running: (state: SupervisedHostState) => void = () => {};
    const pushed = new Promise<SupervisedHostState>(resolve => { running = resolve; });
    const host = new HostProcess({ spawnHost: () => child, onState: running, shutdownGraceMs: 100 });
    host.start();
    expect(await pushed).toEqual({ state: 'running', pid: child.pid, activeWork: 1 });

    const exited = once(child, 'exit');
    await expect(host.stop()).rejects.toThrow('Host did not shut down within 100 ms');
    expect((await exited)[1]).toBe('SIGTERM');
  });

  it('kills a Host that never answers hello when the app quits, and the quit fails', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const host = new HostProcess({ spawnHost: () => child, onState: () => {}, shutdownGraceMs: 100 });
    host.start();

    const exited = once(child, 'exit');
    await expect(host.stop()).rejects.toThrow('Host did not shut down within 100 ms');
    expect((await exited)[1]).toBe('SIGTERM');
  });

  it('answers a domain method through the Host bridge, and a refused param answers only that call', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = createInterface({ input: output })[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await replies.next()).value as string) as unknown;
    const served = serveBridge<TestMethods>({
      greeted: () => {},
      shutdown: async () => {},
      methods: {
        'test.echo': params => {
          const text = (params as { text?: unknown } | undefined)?.text;
          if (typeof text !== 'string') throw new BridgeError('invalid_params', 'test.echo needs a text');
          return { text };
        },
        'test.reset': () => null,
      },
    }, { input, output });

    input.write(encodeMessage({ id: 1, method: 'hello', params: { bridgeVersion: BRIDGE_VERSION } }));
    expect(await next()).toEqual({ id: 1, result: { bridgeVersion: BRIDGE_VERSION } });
    input.write(encodeMessage({ id: 2, method: 'test.echo', params: { text: 'hi' } }));
    expect(await next()).toEqual({ id: 2, result: { text: 'hi' } });
    input.write(encodeMessage({ id: 3, method: 'test.echo', params: {} }));
    expect(await next()).toEqual({ id: 3, error: { code: 'invalid_params', message: 'test.echo needs a text' } });
    input.write(encodeMessage({ id: 4, method: 'test.other' }));
    expect(await next()).toMatchObject({ id: 4, error: { code: 'unknown_method' } });
    input.write(encodeMessage({ id: 5, method: 'shutdown' }));
    expect(await next()).toEqual({ id: 5, result: null });
    await served;
  });

  it('refuses a renderer call to a domain method outside the allowlist before it reaches the Host', async () => {
    const host = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    const route = createRendererRouter<TestMethods, never>({ allowed: ['test.echo'], main: {}, host });

    expect(() => route('test.reset', undefined)).toThrow('bridge_method_refused');
    expect(host).not.toHaveBeenCalled();
    expect(await route('test.echo', { text: 'hi' })).toEqual({ method: 'test.echo', params: { text: 'hi' } });
  });
});
