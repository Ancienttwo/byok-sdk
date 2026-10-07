import { EventEmitter, errorMonitor } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProcessClient, type SpawnFn } from '../adapters/claude/process-client';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
import { startPreparedOperation } from './fixtures/prepared-operation';

const tree = vi.hoisted(() => ({
  adopt: vi.fn(async () => {}),
  terminate: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
}));
vi.mock('../adapters/process-tree', () => ({
  adoptOwnedProcessTree: tree.adopt,
  requestOwnedProcessTreeTermination: tree.terminate,
  disposeOwnedProcessTree: tree.dispose,
  withOwnedProcessTree: (options: unknown) => options,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function observe<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; value?: T; error?: unknown } = { status: 'pending' };
  void promise.then(
    value => { state.status = 'fulfilled'; state.value = value; },
    error => { state.status = 'rejected'; state.error = error; },
  );
  return state;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const children: { child: EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough } }[] = [];
function fakeChild(failWrite = true, holdWrite = false) {
  let pendingWrite: ((error?: Error | null) => void) | undefined;
  const error = Object.assign(new Error('synthetic stdin EPIPE'), { code: 'EPIPE' });
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      if (holdWrite) pendingWrite = callback;
      else callback(failWrite ? error : undefined);
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout: new PassThrough(), stderr: new PassThrough(),
  });
  // errorMonitor observes the real Writable callback -> error sequence but
  // does NOT consume an unhandled error. Only the pre-fix client needs a test
  // safety listener; its missing owned listener remains an explicit failure.
  let ownedErrorListeners = -1;
  const errors: Error[] = [];
  const spawnFn = (() => {
    queueMicrotask(() => {
      ownedErrorListeners = stdin.listenerCount('error');
      stdin.on(errorMonitor, error => errors.push(error));
      if (ownedErrorListeners === 0) stdin.on('error', () => {});
    });
    return child;
  }) as unknown as SpawnFn;
  const fixture = {
    child, error, errors, spawnFn,
    failWrites: () => { failWrite = true; },
    finishWrite: () => { pendingWrite?.(failWrite ? error : undefined); },
    get ownedErrorListeners() { return ownedErrorListeners; },
  };
  children.push(fixture);
  return fixture;
}

function makeClient(fixture: ReturnType<typeof fakeChild>) {
  let sendControl!: (frame: Record<string, unknown>) => Promise<void>;
  const control = { bind: (send: typeof sendControl) => { sendControl = send; }, receive: vi.fn(), closed: vi.fn() };
  const client = new ClaudeProcessClient({ command: 'inert-fixture', args: [], cwd: process.cwd(), env: {}, spawnFn: fixture.spawnFn, control });
  return { client, control, sendControl: (frame: Record<string, unknown>) => sendControl(frame) };
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => {
  for (const { child } of children.splice(0)) {
    child.emit('close', 1, null);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
});

describe('Claude stdin transport failure ownership', () => {
  it.each(['user', 'control'] as const)('owns the real Writable EPIPE event for a %s write without fabricating process close', async kind => {
    const fixture = fakeChild();
    const { client, control, sendControl } = makeClient(fixture);
    const init = observe(client.waitForInit());
    const events = observe(client.events[Symbol.asyncIterator]().next());
    const closed = observe(client.waitClosed());
    await flush();
    const write = observe(Promise.resolve(kind === 'user' ? client.writeUserMessage('hello') : sendControl({ type: 'control_request' })));
    await flush();
    expect(fixture.errors).toEqual([fixture.error]);
    expect(fixture.ownedErrorListeners).toBeGreaterThan(0);
    expect(write).toMatchObject({ status: 'rejected', error: fixture.error });
    expect(init).toMatchObject({ status: 'rejected', error: fixture.error });
    expect(events).toMatchObject({ status: 'fulfilled', value: { done: true } });
    expect(client.terminalError).toBe(fixture.error);
    expect(tree.terminate).toHaveBeenCalledTimes(1);
    expect(control.closed).toHaveBeenCalledTimes(1);
    expect(closed.status).toBe('pending');
    expect(tree.dispose).not.toHaveBeenCalled();
    fixture.child.emit('close', 1, null);
    await flush();
    expect(closed.status).toBe('fulfilled');
    expect(client.terminalError).toBe(fixture.error);
    expect(control.closed).toHaveBeenCalledTimes(1);
  });

  it('consumes a late Writable error even when child close precedes the write callback', async () => {
    const fixture = fakeChild(true, true);
    const { client } = makeClient(fixture);
    const write = observe(Promise.resolve(client.writeUserMessage('hello')));
    await flush();
    fixture.child.emit('close', 1, null);
    await flush();
    expect(write.status).toBe('rejected');
    fixture.finishWrite();
    await flush();
    expect(fixture.errors).toEqual([fixture.error]);
    expect(fixture.ownedErrorListeners).toBeGreaterThan(0);
    await client.waitClosed();
  });

  it('rejects later writes and ignores late init after an independent stdin error', async () => {
    const fixture = fakeChild(false);
    const { client, sendControl } = makeClient(fixture);
    await flush();
    fixture.child.stdin.destroy(fixture.error);
    await flush();
    fixture.child.stdout.write('{"type":"system","subtype":"init","session_id":"late"}\n');
    await expect(client.waitForInit()).rejects.toBe(fixture.error);
    await expect(client.writeUserMessage('later')).rejects.toBe(fixture.error);
    await expect(sendControl({ type: 'control_request' })).rejects.toBe(fixture.error);
    expect(tree.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['write', 'init'] as const)('keeps a failed %s startup pending until owned disposal settles', async phase => {
    const fixture = fakeChild(phase === 'write');
    const disposal = deferred();
    tree.dispose.mockReturnValue(disposal.promise);
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'inert-fixture', source: 'path' }), spawnFn: fixture.spawnFn });
    const start = observe(startPreparedOperation(adapter, { instruction: 'hello' }, {
      workspaceDir: process.cwd(), env: {},
    }));
    await flush();
    if (phase === 'init') fixture.child.stdin.destroy(fixture.error);
    await flush();
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    expect(start.status).toBe('pending');
    fixture.child.emit('close', 1, null);
    await flush();
    expect(start.status).toBe('pending');
    disposal.resolve();
    await flush();
    expect(start.error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(start.error).toMatchObject({ phase: 'start', cause: fixture.error });
  });

  it('does not publish a session when init arrives before the initial write fails', async () => {
    const fixture = fakeChild(true, true);
    const disposal = deferred();
    tree.dispose.mockReturnValue(disposal.promise);
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'inert-fixture', source: 'path' }), spawnFn: fixture.spawnFn });
    const start = observe(startPreparedOperation(adapter, { instruction: 'hello' }, {
      workspaceDir: process.cwd(), env: {},
    }));
    await flush();
    fixture.child.stdout.write('{"type":"system","subtype":"init","session_id":"early"}\n');
    await flush();
    expect(start.status).toBe('pending');
    fixture.finishWrite();
    await flush();
    expect(start.status).toBe('pending');
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    disposal.resolve();
    await flush();
    expect(start.error).toMatchObject({ phase: 'start', cause: fixture.error });
  });

  it('surfaces a follow-up EPIPE to both the writer and session events while close retains the disposal barrier', async () => {
    const fixture = fakeChild(false);
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'inert-fixture', source: 'path' }), spawnFn: fixture.spawnFn });
    const start = startPreparedOperation(adapter, { instruction: 'hello' }, {
      workspaceDir: process.cwd(), env: {},
    });
    await flush();
    fixture.child.stdout.write('{"type":"system","subtype":"init","session_id":"ready"}\n');
    const session = await start;
    const events = observe(session.events[Symbol.asyncIterator]().next());
    fixture.failWrites();
    await expect(session.followUp({ instruction: 'next' })).rejects.toMatchObject({
      phase: 'run', cause: fixture.error,
    });
    await flush();
    expect(events.error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(events.error).toMatchObject({ phase: 'run', cause: fixture.error });
    const disposal = deferred();
    tree.dispose.mockReturnValue(disposal.promise);
    const close = observe(session.close());
    await flush();
    expect(close.status).toBe('pending');
    disposal.resolve();
    await flush();
    expect(close.status).toBe('fulfilled');
  });

  it('rejects an outstanding control write on a stream error even before its write callback runs', async () => {
    const fixture = fakeChild(false, true);
    const { client, sendControl } = makeClient(fixture);
    const write = observe(sendControl({ type: 'control_request' }));
    await flush();
    fixture.child.stdin.emit('error', fixture.error);
    await flush();
    expect(write).toMatchObject({ status: 'rejected', error: fixture.error });
    expect(client.terminalError).toBe(fixture.error);
    fixture.finishWrite();
    await flush();
    expect(write.status).toBe('rejected');
  });

  it('retains an owned startup-disposal retry after EPIPE cleanup fails', async () => {
    const fixture = fakeChild();
    const failure = new Error('disposal not yet quiescent');
    tree.dispose.mockRejectedValueOnce(failure);
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'inert-fixture', source: 'path' }), spawnFn: fixture.spawnFn });
    const start = observe(startPreparedOperation(adapter, { instruction: 'hello' }, {
      workspaceDir: process.cwd(), env: {},
    }));
    await flush(); await flush();
    expect(start.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    const receipt = start.error as RuntimeStartupDisposalFailure;
    expect(receipt.cause).toBeInstanceOf(AggregateError);
    expect((receipt.cause as AggregateError).errors).toEqual([
      expect.objectContaining({ phase: 'start', cause: fixture.error }), failure,
    ]);
    await receipt.retryDisposal();
    expect(tree.dispose).toHaveBeenCalledTimes(2);
  });
});
