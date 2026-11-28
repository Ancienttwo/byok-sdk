import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HostProcess } from '../main/host-process.ts';
import { createBeforeQuitHandler, createMaintenanceLock } from '../main/maintenance-lock.ts';
import { shellHandlers } from '../main/recovery.ts';
import { coalesceStateHints } from '../main/state-hint.ts';
import { offerInstall } from '../main/updater.ts';
import { RESTORE_COMMAND, SNAPSHOT_COMMAND, SNAPSHOT_STATUS_COMMAND, START_FRESH_COMMAND } from '../recovery/protocol.ts';
import { BridgeClient, type HostChild } from './client.ts';
import { rendererBridge } from '../renderer/bridge.ts';
import { BRIDGE_VERSION, BridgeError, buildBridgeContract, encodeMessage, type BridgeIpc, type SupervisedHostState } from './protocol.ts';
import { CustodyError } from '../custody/protocol.ts';
import { createRendererRouter, isAppRefusal, settleCall } from './route.ts';
import { serveBridge } from './server.ts';

vi.mock('electron', () => ({ app: {}, autoUpdater: {}, dialog: {} }));
vi.mock('electron-updater', () => ({ default: {} }));

/** A domain as a `src/bridge/domains/` module declares one; `test.reset` is not on the renderer allowlist. */
interface TestMethods {
  'test.echo': { params: { text: string }; result: { text: string } };
  'test.reset': { params: undefined; result: null };
  'test.boom': { params: undefined; result: null };
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

  it('answers a domain method through the Host bridge; a refused param or a failing handler answers only that call', async () => {
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
        'test.boom': () => { throw new Error('boom'); },
      },
    }, { input, output });

    input.write(encodeMessage({ id: 1, method: 'hello', params: { bridgeVersion: BRIDGE_VERSION } }));
    expect(await next()).toEqual({ id: 1, result: { bridgeVersion: BRIDGE_VERSION } });
    input.write(encodeMessage({ id: 2, method: 'test.echo', params: { text: 'hi' } }));
    expect(await next()).toEqual({ id: 2, result: { text: 'hi' } });
    input.write(encodeMessage({ id: 3, method: 'test.echo', params: {} }));
    expect(await next()).toEqual({ id: 3, error: { code: 'invalid_params', message: 'test.echo needs a text' } });
    input.write(encodeMessage({ id: 6, method: 'test.boom' }));
    expect(await next()).toEqual({ id: 6, error: { code: 'method_failed', message: 'boom' } });
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

  it('delivers a refused call to the renderer as an error with the refusing handler\'s code', async () => {
    const route = createRendererRouter<TestMethods, never>({ allowed: ['test.echo', 'test.boom'], main: {}, host: async (method, params) => {
      if (method === 'test.boom') throw params;
      if ((params as { text?: unknown }).text === undefined) throw new BridgeError('invalid_params', 'test.echo needs a text');
      return params;
    } });
    // Main's IPC handler and the preload, without Electron: every call crosses as a BridgeOutcome.
    const ipc: BridgeIpc = { invoke: (method, params) => settleCall(() => route(method, params), isAppRefusal), onStateChanged: () => () => {} };
    const bridge = rendererBridge(ipc) as unknown as { call(method: string, params: unknown): Promise<unknown> };
    expect(await bridge.call('test.echo', { text: 'hi' })).toEqual({ text: 'hi' });
    await expect(bridge.call('test.echo', {})).rejects.toMatchObject({ name: 'BridgeCallError', code: 'invalid_params', message: 'test.echo needs a text' });
    await expect(bridge.call('test.boom', new CustodyError('keys_store_refused', 'store refused'))).rejects.toMatchObject({ code: 'keys_store_refused' });
    // Only the app's own codes cross: a Node error's code, or a thrown non-error, is method_failed.
    await expect(bridge.call('test.boom', Object.assign(new Error('no such file'), { code: 'ENOENT' }))).rejects.toMatchObject({ code: 'method_failed', message: 'no such file' });
    await expect(bridge.call('test.boom', null)).rejects.toMatchObject({ code: 'method_failed', message: 'null' });
  });

  it('turns a burst of Host state changes into one renderer hint, after which status reads the new state', async () => {
    // A Host that pushes three states in one burst and answers status with the last one.
    const script = `let state = { state: 'starting', pid: process.pid };
      const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const { id, method } = JSON.parse(line);
        if (method === 'hello') {
          send({ id, result: { bridgeVersion: ${BRIDGE_VERSION} } });
          for (const activeWork of [undefined, 0, 2]) {
            state = activeWork === undefined ? state : { state: 'running', pid: process.pid, activeWork };
            send({ event: 'state', state });
          }
        }
        if (method === 'status') send({ id, result: state });
        if (method === 'shutdown') { send({ id, result: null }); process.exit(0); }
      })`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    let hints = 0;
    let hinted: () => void = () => {};
    const firstHint = new Promise<void>(resolve => { hinted = resolve; });
    const hint = coalesceStateHints(() => { hints += 1; hinted(); }, 20);
    const host = new HostProcess({ spawnHost: () => child, onState: hint });
    host.start();

    await firstHint;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(hints).toBe(1);
    expect(await host.call('status', undefined)).toEqual({ state: 'running', pid: child.pid, activeWork: 2 });
    await host.stop();
  });

  it('offers start fresh only on a refused store, and relaunches after a refused clear with the stores back', async () => {
    const calls: string[] = [];
    let state: SupervisedHostState = { state: 'running', pid: 1, activeWork: 0 };
    const receipt = (line: string, code = 1) => {
      const stdout = new PassThrough();
      const events = new PassThrough();
      const child = { stdin: new PassThrough(), stdout, once: (event: string, listener: (...args: unknown[]) => void) => { events.once(event, listener); return child; } };
      child.stdin.on('finish', () => { stdout.end(`${line}\n`); events.emit('exit', code); });
      return child as never;
    };
    const deps: Parameters<typeof shellHandlers>[0] = {
      version: '1.0.0', hostState: () => state, now: () => new Date(0),
      maintenanceLock: createMaintenanceLock(),
      stopHost: async () => { calls.push('stop'); },
      spawnHostCommand: args => {
        calls.push(args.join(' '));
        if (args[0] === SNAPSHOT_STATUS_COMMAND) return receipt(JSON.stringify({ ok: true, snapshot: null }), 0);
        return receipt(JSON.stringify({ ok: false, code: 'store_not_bound', message: 'not bound', movedBack: true }), 1);
      },
      relaunch: failure => { calls.push(`relaunch ${failure?.message ?? ''}`); },
    };
    const handlers = shellHandlers(deps);

    expect(await handlers['shell.state'](undefined)).toEqual({ host: state, restore: null, restoreError: null });
    await expect(handlers['shell.startFresh'](undefined)).rejects.toThrow('only while the Host is stopped on a refused store');
    state = { state: 'stopped', pid: 1, reason: 'halted', storeRefused: false };
    await expect(handlers['shell.startFresh'](undefined)).rejects.toThrow('only while the Host is stopped on a refused store');
    expect(calls).toEqual([`${SNAPSHOT_STATUS_COMMAND} 1.0.0`]);
    calls.length = 0;

    state = { state: 'stopped', pid: 1, reason: 'refused', storeRefused: true };
    await expect(handlers['shell.startFresh'](undefined)).rejects.toThrow(/store_not_bound.*back where they were.*byok-agent doctor/);
    expect(calls[0]).toBe('stop');
    expect(calls[1]).toBe(`${START_FRESH_COMMAND} 1970-01-01T00-00-00.000Z`);
    expect(calls[2]).toMatch(/^relaunch Start fresh refused \(store_not_bound\)/);

    // One recovery action at a time: a second one while the first still stops the Host is refused.
    calls.length = 0;
    let release: () => void = () => {};
    const slow = shellHandlers({ ...deps, maintenanceLock: createMaintenanceLock(), stopHost: () => new Promise<void>(resolve => { release = resolve; }) });
    const first = slow['shell.startFresh'](undefined);
    await expect(slow['shell.restore'](undefined)).rejects.toThrow('Another recovery action is running');
    await expect(slow['shell.startFresh'](undefined)).rejects.toThrow('Another recovery action is running');
    release();
    await expect(first).rejects.toThrow('store_not_bound');
  });

  it('shell.restore confirms Host stopped before spawning S1 restore and aborts cleanly if stopHost fails', async () => {
    const calls: string[] = [];
    let hostStopped = false;
    const okReceipt = (line: string) => {
      const stdout = new PassThrough();
      const events = new PassThrough();
      const child = { stdin: new PassThrough(), stdout, once: (event: string, listener: (...args: unknown[]) => void) => { events.once(event, listener); return child; } };
      child.stdin.on('finish', () => { stdout.end(`${line}\n`); events.emit('exit', 0); });
      return child as never;
    };
    const handlers = shellHandlers({
      version: '1.0.0',
      hostState: () => ({ state: 'stopped', pid: 1, reason: 'halted', storeRefused: false }),
      now: () => new Date(0),
      maintenanceLock: createMaintenanceLock(),
      stopHost: async () => {
        hostStopped = true;
        calls.push('stop');
      },
      spawnHostCommand: args => {
        calls.push(args.join(' '));
        if (args[0] === SNAPSHOT_STATUS_COMMAND) return okReceipt(JSON.stringify({ ok: true, snapshot: { version: '1.0.0', target: '/snap/1.0.0' } }));
        expect(hostStopped).toBe(true);
        return okReceipt(JSON.stringify({ ok: true, asidePath: '/home/host.aside-0' }));
      },
      relaunch: failure => { calls.push(`relaunch:${failure?.message ?? 'ok'}`); },
    });

    await expect(handlers['shell.restore'](undefined)).resolves.toEqual({ asidePath: '/home/host.aside-0' });
    expect(calls).toEqual([
      `${SNAPSHOT_STATUS_COMMAND} 1.0.0`,
      'stop',
      `${RESTORE_COMMAND} 1.0.0 1970-01-01T00-00-00.000Z`,
      'relaunch:ok',
    ]);

    calls.length = 0;
    const failHandlers = shellHandlers({
      version: '1.0.0',
      hostState: () => ({ state: 'stopped', pid: 1, reason: 'halted', storeRefused: false }),
      now: () => new Date(0),
      maintenanceLock: createMaintenanceLock(),
      stopHost: async () => { calls.push('stop-fail'); throw new Error('stop failed'); },
      spawnHostCommand: args => {
        calls.push(args.join(' '));
        if (args[0] === SNAPSHOT_STATUS_COMMAND) return okReceipt(JSON.stringify({ ok: true, snapshot: { version: '1.0.0', target: '/snap/1.0.0' } }));
        throw new Error('restore must not run when stopHost fails');
      },
      relaunch: failure => { calls.push(`relaunch:${failure?.message ?? 'ok'}`); },
    });

    await expect(failHandlers['shell.restore'](undefined)).rejects.toThrow('stop failed');
    expect(calls).toEqual([`${SNAPSHOT_STATUS_COMMAND} 1.0.0`, 'stop-fail']);
  });

  const delayedReceipt = () => {
    const stdout = new PassThrough();
    const events = new PassThrough();
    let stdinFinished = false;
    let pending: { line: string; code: number } | undefined;
    const flush = () => {
      if (!stdinFinished || !pending) return;
      stdout.end(`${pending.line}\n`);
      events.emit('exit', pending.code);
      pending = undefined;
    };
    const child = { stdin: new PassThrough(), stdout, once: (event: string, listener: (...args: unknown[]) => void) => { events.once(event, listener); return child; } };
    child.stdin.on('finish', () => { stdinFinished = true; flush(); });
    return {
      child: child as never,
      resolveReceipt: (line: string, code = 0) => { pending = { line, code }; flush(); },
    };
  };

  it('shares maintenanceLock across shell.restore and offerInstall: delayed restore blocks update and seals after relaunch', async () => {
    const calls: string[] = [];
    const maintenanceLock = createMaintenanceLock();
    const immediateReceipt = (line: string, code = 0) => {
      const delayed = delayedReceipt();
      delayed.resolveReceipt(line, code);
      return delayed.child;
    };

    let markRestoreStarted!: () => void;
    const restoreStarted = new Promise<void>(resolve => { markRestoreStarted = resolve; });
    const delayedRestore = delayedReceipt();

    const handlers = shellHandlers({
      version: '1.0.0',
      hostState: () => ({ state: 'stopped', pid: 1, reason: 'halted', storeRefused: false }),
      now: () => new Date(0),
      maintenanceLock,
      stopHost: async () => { calls.push('restore:stop'); },
      spawnHostCommand: args => {
        calls.push(`restore:${args[0]}`);
        if (args[0] === SNAPSHOT_STATUS_COMMAND) return immediateReceipt(JSON.stringify({ ok: true, snapshot: { version: '1.0.0', target: '/snap/1.0.0' } }));
        markRestoreStarted();
        return delayedRestore.child;
      },
      relaunch: failure => { calls.push(`restore:relaunch:${failure?.message ?? 'ok'}`); },
    });

    const beforeInstall = vi.fn(async () => {});
    const spawnUpdaterHost = vi.fn(() => immediateReceipt(JSON.stringify({ ok: true, target: '/snap/1.0.0' })));
    const showError = vi.fn();
    const relaunchAndQuit = vi.fn();
    const quitAndInstall = vi.fn(() => ({ status: 'confirmed' as const }));
    const updaterOptions = {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall,
      spawnHostCommand: spawnUpdaterHost,
      showError,
      relaunchAndQuit,
      quitAndInstall,
      maintenanceLock,
    };

    const pendingRestore = handlers['shell.restore'](undefined);
    await restoreStarted;

    // While S1 restore helper has not emitted its receipt, updater cannot acquire lock or run S1 snapshot.
    await expect(offerInstall('2.0.0', updaterOptions)).resolves.toBe(false);
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(spawnUpdaterHost).not.toHaveBeenCalled();
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(relaunchAndQuit).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('Update not installed', 'Another recovery action is running');
    expect(calls).toEqual([`restore:${SNAPSHOT_STATUS_COMMAND}`, 'restore:stop', `restore:${RESTORE_COMMAND}`]);

    delayedRestore.resolveReceipt(JSON.stringify({ ok: true, asidePath: '/home/host.aside-0' }), 0);
    await expect(pendingRestore).resolves.toEqual({ asidePath: '/home/host.aside-0' });
    expect(calls.at(-1)).toBe('restore:relaunch:ok');

    // Once relaunch handover began, lock stays sealed so no late update runs while exiting.
    showError.mockClear();
    await expect(offerInstall('2.0.0', updaterOptions)).resolves.toBe(false);
    expect(beforeInstall).not.toHaveBeenCalled();
    expect(spawnUpdaterHost).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('Update not installed', 'Another recovery action is running');
  });

  it('shares maintenanceLock across offerInstall and recovery callers: delayed snapshot blocks restore/startFresh/update and seals after quitAndInstall', async () => {
    const updaterEvents: string[] = [];
    const maintenanceLock = createMaintenanceLock();

    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>(resolve => { markSnapshotStarted = resolve; });
    const delayedSnapshot = delayedReceipt();

    const shellStop = vi.fn(async () => {});
    const shellSpawn = vi.fn(() => { throw new Error('shell helper must not spawn while update holds lock'); });
    const shellRelaunch = vi.fn();
    const handlers = shellHandlers({
      version: '1.0.0',
      hostState: () => ({ state: 'stopped', pid: 1, reason: 'refused', storeRefused: true }),
      now: () => new Date(0),
      maintenanceLock,
      stopHost: shellStop,
      spawnHostCommand: shellSpawn,
      relaunch: shellRelaunch,
    });

    const pendingInstall = offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: async () => { updaterEvents.push('beforeInstall'); },
      spawnHostCommand: args => {
        updaterEvents.push(args.join(' '));
        markSnapshotStarted();
        return delayedSnapshot.child;
      },
      showError: (title, msg) => { updaterEvents.push(`error:${title}:${msg}`); },
      relaunchAndQuit: () => { updaterEvents.push('relaunchAndQuit'); },
      quitAndInstall: () => { updaterEvents.push('quitAndInstall'); return { status: 'confirmed' as const }; },
      maintenanceLock,
    });

    await snapshotStarted;

    // While S1 snapshot helper has not emitted its receipt, recovery callers and concurrent updates are rejected.
    await expect(handlers['shell.restore'](undefined)).rejects.toThrow('Another recovery action is running');
    await expect(handlers['shell.startFresh'](undefined)).rejects.toThrow('Another recovery action is running');
    const secondBeforeInstall = vi.fn(async () => {});
    const secondSpawn = vi.fn(() => delayedSnapshot.child);
    const secondShowError = vi.fn();
    const secondQuit = vi.fn(() => ({ status: 'confirmed' as const }));
    await expect(offerInstall('2.0.1', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: secondBeforeInstall,
      spawnHostCommand: secondSpawn,
      showError: secondShowError,
      relaunchAndQuit: vi.fn(),
      quitAndInstall: secondQuit,
      maintenanceLock,
    })).resolves.toBe(false);

    expect(shellStop).not.toHaveBeenCalled();
    expect(shellSpawn).not.toHaveBeenCalled();
    expect(shellRelaunch).not.toHaveBeenCalled();
    expect(secondBeforeInstall).not.toHaveBeenCalled();
    expect(secondSpawn).not.toHaveBeenCalled();
    expect(secondQuit).not.toHaveBeenCalled();
    expect(secondShowError).toHaveBeenCalledWith('Update not installed', 'Another recovery action is running');
    expect(updaterEvents).toEqual(['beforeInstall', `${SNAPSHOT_COMMAND} 1.0.0`]);

    delayedSnapshot.resolveReceipt(JSON.stringify({ ok: true, target: '/snap/1.0.0' }), 0);
    await expect(pendingInstall).resolves.toBe(true);
    expect(updaterEvents).toEqual(['beforeInstall', `${SNAPSHOT_COMMAND} 1.0.0`, 'quitAndInstall']);

    // Once quitAndInstall handover began, lock stays sealed so no late restore runs while exiting.
    await expect(handlers['shell.restore'](undefined)).rejects.toThrow('Another recovery action is running');
    expect(shellStop).not.toHaveBeenCalled();
    expect(shellSpawn).not.toHaveBeenCalled();
    expect(shellRelaunch).not.toHaveBeenCalled();
  });

  it('before-quit waits for an in-flight S1 restore helper without exiting early and allows intentional post-handover quit', async () => {
    const maintenanceLock = createMaintenanceLock();
    const immediateReceipt = (line: string, code = 0) => {
      const delayed = delayedReceipt();
      delayed.resolveReceipt(line, code);
      return delayed.child;
    };

    let markRestoreStarted!: () => void;
    const restoreStarted = new Promise<void>(resolve => { markRestoreStarted = resolve; });
    const delayedRestore = delayedReceipt();
    const calls: string[] = [];

    const handlers = shellHandlers({
      version: '1.0.0',
      hostState: () => ({ state: 'stopped', pid: 1, reason: 'halted', storeRefused: false }),
      now: () => new Date(0),
      maintenanceLock,
      stopHost: async () => { calls.push('restore:stop'); },
      spawnHostCommand: args => {
        calls.push(`restore:${args[0]}`);
        if (args[0] === SNAPSHOT_STATUS_COMMAND) return immediateReceipt(JSON.stringify({ ok: true, snapshot: { version: '1.0.0', target: '/snap/1.0.0' } }));
        markRestoreStarted();
        return delayedRestore.child;
      },
      relaunch: () => { calls.push('restore:relaunch'); },
    });

    const quitStopHost = vi.fn(async () => {});
    const exit = vi.fn();
    const beforeQuit = createBeforeQuitHandler({
      maintenanceLock,
      stopHost: quitStopHost,
      exit,
      logError: vi.fn(),
    });

    const pendingRestore = handlers['shell.restore'](undefined);
    await restoreStarted;

    // Normal quit (and duplicate quit click) must prevent exit while S1 helper is still running.
    const quitEvent1 = { preventDefault: vi.fn() };
    const quitEvent2 = { preventDefault: vi.fn() };
    beforeQuit(quitEvent1);
    beforeQuit(quitEvent2);
    expect(quitEvent1.preventDefault).toHaveBeenCalledTimes(1);
    expect(quitEvent2.preventDefault).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(quitStopHost).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    // Release delayed S1 receipt -> handover completes relaunch; normal quit yields cleanly.
    delayedRestore.resolveReceipt(JSON.stringify({ ok: true, asidePath: '/home/host.aside-0' }), 0);
    await expect(pendingRestore).resolves.toEqual({ asidePath: '/home/host.aside-0' });
    await Promise.resolve();
    expect(calls).toEqual([`restore:${SNAPSHOT_STATUS_COMMAND}`, 'restore:stop', `restore:${RESTORE_COMMAND}`, 'restore:relaunch']);
    expect(quitStopHost).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    // Intentional quit triggered after handover (e.g. app.quit() in relaunchAndQuit/quitAndInstall) proceeds unblocked.
    const postHandoverEvent = { preventDefault: vi.fn() };
    beforeQuit(postHandoverEvent);
    expect(postHandoverEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('before-quit waits for non-handover maintenance failure, blocks new S1 work, then stops Host and exits 0', async () => {
    const maintenanceLock = createMaintenanceLock();
    let markStopStarted!: () => void;
    const stopStarted = new Promise<void>(resolve => { markStopStarted = resolve; });
    let rejectBeforeInstall!: (error: Error) => void;

    const quitStopHost = vi.fn(async () => {});
    const exit = vi.fn();
    const beforeQuit = createBeforeQuitHandler({
      maintenanceLock,
      stopHost: quitStopHost,
      exit,
      logError: vi.fn(),
    });

    const shellStop = vi.fn(async () => {});
    const handlers = shellHandlers({
      version: '1.0.0',
      hostState: () => ({ state: 'stopped', pid: 1, reason: 'halted', storeRefused: false }),
      now: () => new Date(0),
      maintenanceLock,
      stopHost: shellStop,
      spawnHostCommand: vi.fn(),
      relaunch: vi.fn(),
    });

    const pendingInstall = offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: () => {
        markStopStarted();
        return new Promise<void>((_resolve, reject) => { rejectBeforeInstall = reject; });
      },
      spawnHostCommand: vi.fn(),
      showError: vi.fn(),
      relaunchAndQuit: vi.fn(),
      quitAndInstall: vi.fn(() => ({ status: 'confirmed' as const })),
      maintenanceLock,
    });

    await stopStarted;

    const quitEvent = { preventDefault: vi.fn() };
    beforeQuit(quitEvent);
    expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(quitStopHost).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await expect(handlers['shell.restore'](undefined)).rejects.toThrow('Another recovery action is running');

    rejectBeforeInstall(new Error('Host did not shut down'));
    await expect(pendingInstall).resolves.toBe(false);

    await vi.waitFor(() => {
      expect(quitStopHost).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });
    await expect(handlers['shell.restore'](undefined)).rejects.toThrow('Another recovery action is running');
    expect(shellStop).not.toHaveBeenCalled();
  });

  it('keeps committed bridge-contract.json aligned with buildBridgeContract() (S2)', () => {
    const file = fileURLToPath(new URL('./bridge-contract.json', import.meta.url));
    const committed = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const contract = buildBridgeContract();
    expect(committed).toBe(`${JSON.stringify(contract, null, 2)}\n`);
    expect(contract.schemaVersion).toBe(2);
    expect(contract.bridgeVersion).toBe(5);
    expect(contract.rendererMethods).toContain('k8.memory');
    expect(contract.hostMethods).toContain('k8.memory');
    expect(contract.mainMethods).not.toContain('k8.memory');
    expect(contract.shellToHostMethods).toEqual(['keys.profilesChanged']);
    expect(contract.hostMethods).toContain('keys.profilesChanged');
    expect(contract.rendererMethods).not.toContain('keys.profilesChanged');
    expect(contract.mainMethods).not.toContain('keys.profilesChanged');
  });
});
