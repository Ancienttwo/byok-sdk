import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AclProbeObserver, nativeAclProbeObserver, type ProbePhase } from '../fixtures/owned-acl-probe';
import type { CommandResult, CommandRunner } from '../command-runner';

// Defense in depth: this entire local suite uses fake handles. Even the one
// wiring check below cannot start an OS child if observation is broken.
const spawnGuard = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>(() => { throw new Error('native spawn forbidden in synthetic tests'); }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { nativeAclProbeObserver: observer } = await import('../fixtures/owned-acl-probe');
  return { ...actual, spawn: function (this: unknown, ...received: Parameters<typeof actual.spawn>) {
    return observer.spawn(spawnGuard as typeof actual.spawn, this, received);
  } };
});
vi.mock('../command-runner', async importOriginal => {
  const actual = await importOriginal<typeof import('../command-runner')>();
  const { nativeAclProbeObserver: observer } = await import('../fixtures/owned-acl-probe');
  return { ...actual, runCommand: function (this: unknown, ...received: Parameters<typeof actual.runCommand>) {
    return observer.command(actual.runCommand, this, received);
  } };
});
afterAll(() => { vi.doUnmock('../command-runner'); vi.doUnmock('node:child_process'); });
import { runCommand } from '../command-runner';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); spawnGuard.mockReset(); spawnGuard.mockImplementation(() => { throw new Error('native spawn forbidden in synthetic tests'); }); });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  readonly stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  readonly pid = 101;
  readonly kill = vi.fn(() => true);
  asChild(): ChildProcess { return this as unknown as ChildProcess; }
  close(code = 0) { this.emit('close', code, null); }
}
const args: Parameters<CommandRunner> = ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', 'synthetic-script'], '{"path":"C:\\fixture"}'];
const result: CommandResult = { exitCode: 0, stdout: '{"synthetic":true}', stderr: '' };
function setup(observer = new AclProbeObserver()) {
  const phases: ProbePhase[] = []; const child = new FakeChild(); const completion = deferred<CommandResult>();
  const probe = observer.create({ executable: args[0], stdin: args[2]! }, phase => phases.push(phase));
  const spawnOptions = { env: { SYNTHETIC: 'only' }, stdio: ['pipe', 'pipe', 'pipe'] };
  const spawnArgs = ['original-executable', ['original-arg'], spawnOptions] as Parameters<typeof spawn>;
  const spawnReceiver = {}; const runnerReceiver = {};
  const originalSpawn = vi.fn(function (this: unknown, ..._args: Parameters<typeof spawn>) { expect(this).toBe(spawnReceiver); return child.asChild(); });
  const originalRunner = vi.fn(function (this: unknown, ...received: Parameters<CommandRunner>) {
    expect(this).toBe(runnerReceiver); expect(received).toEqual(args);
    expect(observer.spawn(originalSpawn as unknown as typeof spawn, spawnReceiver, spawnArgs)).toBe(child.asChild());
    return completion.promise;
  });
  const command = () => observer.command(originalRunner, runnerReceiver, args);
  return { observer, phases, child, completion, probe, spawnOptions, spawnArgs, originalSpawn, originalRunner, command };
}

describe('owned ACL probe (synthetic handles only)', () => {
  it('forwards exact spawn/runner inputs, promise, child and result identities', async () => {
    const f = setup();
    const operation = f.probe.run(() => { const promise = f.command(); expect(promise).toBe(f.completion.promise); return promise; });
    expect(f.originalSpawn.mock.calls[0]).toEqual(f.spawnArgs);
    expect(f.originalSpawn.mock.calls[0]?.[2]).toBe(f.spawnOptions);
    expect(f.observer.state().captureGeneration).toBeUndefined();
    f.completion.resolve(result); f.child.close(); expect(await operation).toBe(result);
    const cleanup = vi.fn(async () => {}); await f.probe.dispose(100, cleanup);
    expect(cleanup).toHaveBeenCalledOnce(); f.observer.assertIdle();
    expect(f.child.eventNames()).toEqual([]); expect(f.child.stdin.listenerCount('error')).toBe(0);
  });

  it('wires the unchanged production runner through a fake spawn only', async () => {
    const observer = new AclProbeObserver(); const child = new FakeChild();
    const probe = observer.create({ executable: args[0], stdin: args[2]! });
    const native = vi.fn(() => child.asChild());
    spawnGuard.mockImplementation((...received: unknown[]) => observer.spawn(native as unknown as typeof spawn, undefined, received as Parameters<typeof spawn>));
    const operation = probe.run(() => observer.command(runCommand, undefined, args));
    expect(native.mock.calls[0]).toEqual([args[0], args[1], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }]);
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith(args[2]);
    child.stdout.emit('data', 'actual stdout'); child.stderr.emit('data', 'actual stderr'); child.close(7);
    expect(await operation).toEqual({ exitCode: 7, stdout: 'actual stdout', stderr: 'actual stderr' });
    await probe.dispose(100, async () => {}); observer.assertIdle();
  });

  it('the importOriginal module bridge reaches the real runner and returns its fake native handle unchanged', async () => {
    const child = new FakeChild(); spawnGuard.mockReturnValue(child.asChild());
    const phases: ProbePhase[] = [];
    const probe = nativeAclProbeObserver.create({ executable: args[0], stdin: args[2]! }, phase => phases.push(phase));
    // No direct observer.command call here: exercise the same transparent
    // vi.mock(importOriginal) bridge installed by the Windows test file.
    const operation = probe.run(() => runCommand(...args));
    expect(spawnGuard).toHaveBeenCalledExactlyOnceWith(args[0], args[1], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith(args[2]);
    child.stdout.emit('data', 'native bytes'); child.close();
    expect(await operation).toEqual({ exitCode: 0, stdout: 'native bytes', stderr: '' });
    await probe.dispose(100, async () => {}); nativeAclProbeObserver.assertIdle();
    expect(phases.map(p => p.phase)).toContain('child-owned');
    const remainingCloseListeners = child.listenerCount('close');
    expect(remainingCloseListeners).toBe(1); // original runCommand listener only
    // Outside the disposed context the wrapper is transparent and unowned.
    const next = new FakeChild(); spawnGuard.mockReturnValue(next.asChild());
    const outside = runCommand(...args); next.close(); await outside;
    probe.cancel(new Error('old timer')); await Promise.resolve();
    expect(next.kill).not.toHaveBeenCalled(); nativeAclProbeObserver.assertIdle();
  });

  it('observes phase times without changing native output', async () => {
    const f = setup(); const operation = f.probe.run(f.command);
    f.child.emit('spawn'); f.child.stdout.emit('data', 'one'); f.child.stdout.emit('data', 'two'); f.child.stderr.emit('data', 'error');
    f.child.emit('exit', 0, null); f.child.close(); f.completion.resolve(result); await operation;
    await f.probe.dispose(100, async () => {});
    expect(f.phases.filter(p => p.phase === 'first-stdout')).toHaveLength(1);
    expect(f.phases.map(p => p.phase)).toEqual(expect.arrayContaining(['spawn-call', 'spawn-event', 'first-stdout', 'first-stderr', 'exit', 'close', 'assertion-resolved', 'disposed']));
  });

  it('waits for close even if exit and assertion resolution arrived first', async () => {
    const f = setup(); const operation = f.probe.run(f.command); f.completion.resolve(result); await operation;
    f.child.emit('exit', 0, null);
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup);
    await Promise.resolve(); expect(cleanup).not.toHaveBeenCalled();
    f.child.close(); await disposal; expect(cleanup).toHaveBeenCalledOnce();
  });

  it('waits for the original assertion after close arrived first', async () => {
    const f = setup(); const operation = f.probe.run(f.command); f.child.close();
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup);
    await Promise.resolve(); expect(cleanup).not.toHaveBeenCalled();
    f.completion.resolve(result); await operation; await disposal; expect(cleanup).toHaveBeenCalledOnce();
  });

  it('expiry kills once, keeps late success failed, and cleans only after close and settlement', async () => {
    const f = setup(); const deadline = new Error('evidence deadline');
    const operation = f.probe.run(f.command).catch(error => error);
    f.probe.cancel(deadline); f.probe.cancel(deadline); await Promise.resolve();
    expect(f.child.kill).toHaveBeenCalledOnce();
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup);
    f.completion.resolve(result); expect(await operation).toBe(deadline); expect(cleanup).not.toHaveBeenCalled();
    f.child.close(); await disposal; expect(cleanup).toHaveBeenCalledOnce();
  });

  it('expiry before a delayed command suppresses native spawn but waits for original invocation', async () => {
    const f = setup(); const filesystem = deferred<void>(); const deadline = new Error('deadline before spawn');
    const operation = f.probe.run(async () => { await filesystem.promise; return f.command(); }).catch(error => error);
    f.probe.cancel(deadline);
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup);
    await Promise.resolve(); expect(cleanup).not.toHaveBeenCalled(); expect(f.originalRunner).not.toHaveBeenCalled();
    filesystem.resolve(); expect(await operation).toBe(deadline); await disposal;
    expect(f.originalRunner).not.toHaveBeenCalled(); expect(f.originalSpawn).not.toHaveBeenCalled();
    expect(f.child.kill).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce(); f.observer.assertIdle();
  });

  it('unresolved pre-spawn teardown retains its fixture, fences later work, and suppresses a still-late command', async () => {
    vi.useFakeTimers(); const f = setup(); const filesystem = deferred<void>();
    const operation = f.probe.run(async () => { await filesystem.promise; return f.command(); }).catch(error => error);
    f.probe.cancel(new Error('deadline'));
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); expect((await disposal).message).toContain('teardown unresolved');
    expect(() => f.observer.create({ executable: args[0], stdin: args[2]! })).toThrow('ownership is unresolved');
    filesystem.resolve(); await operation;
    await expect(f.probe.dispose(100, cleanup)).rejects.toThrow('fixture retained');
    expect(f.originalSpawn).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
  });

  it('unresolved child close remains failure after a late close and retains fixture', async () => {
    vi.useFakeTimers(); const f = setup(); const operation = f.probe.run(f.command).catch(error => error);
    f.probe.cancel(new Error('deadline')); f.completion.resolve(result); await operation;
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); expect((await disposal).message).toContain('teardown unresolved');
    expect(cleanup).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalledOnce();
    f.child.close(); await expect(f.probe.dispose(100, cleanup)).rejects.toThrow('fixture retained');
    expect(() => f.observer.assertIdle()).toThrow('ownership is unresolved');
  });

  it('old cancellation callbacks cannot cancel or capture a later generation', async () => {
    const observer = new AclProbeObserver(); const old = setup(observer); const op = old.probe.run(old.command);
    old.completion.resolve(result); old.child.close(); await op; await old.probe.dispose(100, async () => {});
    const fresh = setup(observer); const freshOp = fresh.probe.run(fresh.command);
    expect(fresh.probe.generation).not.toBe(old.probe.generation);
    old.probe.cancel(new Error('old timer')); await Promise.resolve();
    expect(old.child.kill).not.toHaveBeenCalled(); expect(fresh.child.kill).not.toHaveBeenCalled();
    fresh.completion.resolve(result); fresh.child.close(); await freshOp; await fresh.probe.dispose(100, async () => {});
    observer.assertIdle();
  });

  it('a stale asynchronous ALS invocation cannot attach to a new generation with the same target', async () => {
    const observer = new AclProbeObserver(); const old = setup(observer); const later = deferred<void>();
    let stale!: Promise<unknown>;
    const oldOperation = old.probe.run(() => {
      // This callback retains old's ALS object even though it runs after disposal.
      stale = later.promise.then(() => old.command()).catch(error => error);
      return old.command();
    });
    old.completion.resolve(result); old.child.close(); await oldOperation;
    await old.probe.dispose(100, async () => {});
    const fresh = setup(observer); const freshOperation = fresh.probe.run(fresh.command);
    later.resolve(); expect(await stale).toMatchObject({ message: 'ACL probe generation already disposed' });
    expect(old.originalRunner).toHaveBeenCalledOnce(); expect(fresh.originalRunner).toHaveBeenCalledOnce();
    expect(old.child.kill).not.toHaveBeenCalled(); expect(fresh.child.kill).not.toHaveBeenCalled();
    expect(observer.state()).toEqual({ activeGeneration: fresh.probe.generation, captureGeneration: undefined });
    expect(Object.getOwnPropertyDescriptor(old.probe, 'generation')?.writable).toBe(false);
    fresh.completion.resolve(result); fresh.child.close(); await freshOperation;
    await fresh.probe.dispose(100, async () => {}); observer.assertIdle();
  });

  it('unrelated and outside-context calls keep original results and cannot be cancelled', async () => {
    const f = setup(); const otherChild = new FakeChild();
    const otherSpawn = vi.fn(() => otherChild.asChild()); const otherRunner = vi.fn(() => Promise.resolve(result));
    const outside = f.observer.command(otherRunner, undefined, args); expect(await outside).toBe(result);
    const operation = f.probe.run(async () => {
      expect(await f.observer.command(otherRunner, undefined, ['other', [], 'other'])).toBe(result);
      expect(f.observer.spawn(otherSpawn as unknown as typeof spawn, undefined, ['other', [], {}] as Parameters<typeof spawn>)).toBe(otherChild.asChild());
      return f.command();
    }).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    f.probe.cancel(new Error('deadline')); await Promise.resolve();
    expect(otherChild.kill).not.toHaveBeenCalled();
    f.completion.resolve(result); f.child.close(); await operation; await f.probe.dispose(100, async () => {});
    expect(await f.observer.command(otherRunner, undefined, args)).toBe(result); f.observer.assertIdle();
  });

  it('original command throw restores capture and cannot be mistaken for a child close receipt', async () => {
    vi.useFakeTimers(); const f = setup(); const failure = new Error('original command throw');
    await expect(f.probe.run(() => f.observer.command(() => { throw failure; }, undefined, args))).rejects.toBe(failure);
    expect(f.observer.state().captureGeneration).toBeUndefined();
    const other = new FakeChild();
    expect(f.observer.spawn((() => other.asChild()) as typeof spawn, undefined, ['other', [], {}] as Parameters<typeof spawn>)).toBe(other.asChild());
    f.probe.cancel(new Error('deadline')); await Promise.resolve(); expect(other.kill).not.toHaveBeenCalled();
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); expect((await disposal).message).toContain('teardown unresolved'); expect(cleanup).not.toHaveBeenCalled();
  });

  it('original spawn throw restores capture, preserves error, and retains the unproven fixture', async () => {
    vi.useFakeTimers(); const f = setup(); const failure = new Error('original spawn throw');
    const runner: CommandRunner = () => {
      f.observer.spawn((() => { throw failure; }) as typeof spawn, undefined, ['synthetic', [], {}] as Parameters<typeof spawn>);
      return Promise.resolve(result);
    };
    await expect(f.probe.run(() => f.observer.command(runner, undefined, args))).rejects.toBe(failure);
    expect(f.observer.state().captureGeneration).toBeUndefined();
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); expect((await disposal).message).toContain('teardown unresolved'); expect(cleanup).not.toHaveBeenCalled();
  });

  it('query rejection remains the original rejection and still waits for close', async () => {
    const f = setup(); const failure = new Error('native query rejected'); const op = f.probe.run(f.command).catch(error => error);
    f.completion.reject(failure); expect(await op).toBe(failure);
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup);
    await Promise.resolve(); expect(cleanup).not.toHaveBeenCalled(); f.child.close(1); await disposal;
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it('cleanup rejection is permanent, fenced, and restores observer listeners after quiescence', async () => {
    const f = setup(); const operation = f.probe.run(f.command);
    f.completion.resolve(result); f.child.close(); await operation;
    const failure = new Error('fixture cleanup refused'); const cleanup = vi.fn(async () => { throw failure; });
    await expect(f.probe.dispose(100, cleanup)).rejects.toBe(failure);
    await expect(f.probe.dispose(100, cleanup)).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledOnce(); expect(f.child.eventNames()).toEqual([]);
    expect(f.child.stdout.listenerCount('data')).toBe(0); expect(f.child.stdin.listenerCount('error')).toBe(0);
    expect(f.observer.state().captureGeneration).toBeUndefined();
    expect(() => f.observer.create({ executable: args[0], stdin: args[2]! })).toThrow('ownership is unresolved');
  });

  it('cancellation racing capture owns and cancels the returned child once', async () => {
    const f = setup(); const deadline = new Error('deadline during native spawn');
    const original: typeof spawn = (() => { f.probe.cancel(deadline); return f.child.asChild(); }) as typeof spawn;
    const runner: CommandRunner = () => {
      expect(f.observer.spawn(original, undefined, ['synthetic', [], {}] as Parameters<typeof spawn>)).toBe(f.child.asChild());
      return f.completion.promise;
    };
    const operation = f.probe.run(() => f.observer.command(runner, undefined, args)).catch(error => error);
    await Promise.resolve(); expect(f.child.kill).toHaveBeenCalledOnce();
    f.child.stdin.emit('error', new Error('cancelled pipe'));
    f.completion.resolve(result); f.child.close(); expect(await operation).toBe(deadline);
    await f.probe.dispose(100, async () => {}); f.observer.assertIdle();
  });

  it('a failed kill request is not a close receipt or permission to retry another handle', async () => {
    vi.useFakeTimers(); const f = setup(); const op = f.probe.run(f.command).catch(error => error);
    f.child.kill.mockImplementation(() => { throw new Error('kill failed'); });
    f.probe.cancel(new Error('deadline')); await Promise.resolve();
    f.probe.cancel(new Error('repeat')); await Promise.resolve(); expect(f.child.kill).toHaveBeenCalledOnce();
    f.completion.resolve(result); await op;
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); expect((await disposal).message).toContain('teardown unresolved');
    expect(cleanup).not.toHaveBeenCalled(); expect(() => f.observer.assertIdle()).toThrow('ownership is unresolved');
  });

  it('a missing capture cannot turn an apparently successful command into successful evidence', async () => {
    vi.useFakeTimers(); const f = setup(); const runner: CommandRunner = () => Promise.resolve(result);
    await expect(f.probe.run(() => f.observer.command(runner, undefined, args))).rejects.toThrow('no proven child');
    const cleanup = vi.fn(async () => {}); const disposal = f.probe.dispose(100, cleanup).catch(error => error);
    await vi.advanceTimersByTimeAsync(100); expect((await disposal).message).toContain('teardown unresolved'); expect(cleanup).not.toHaveBeenCalled();
  });
});
