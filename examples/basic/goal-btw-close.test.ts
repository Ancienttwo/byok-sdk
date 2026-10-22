import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeOperationStartInput } from '@byok-sdk/client';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@byok-sdk/client', () => ({
  freezeRuntimeAdapterDescriptor: (value: unknown) => value,
  RuntimeDisposalFailure: class extends Error { stage: string; constructor(input: { stage: string; reason: string }) { super(input.reason); this.name = 'RuntimeDisposalFailure'; this.stage = input.stage; } },
}));
import { BotStubSession } from './goal-btw.test-support';

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
function heldChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); }); return true; }),
  });
  let release!: () => void;
  let arrived!: () => void;
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  child.stdin.on('data', bytes => {
    const request = JSON.parse(String(bytes));
    if (request.method === 'initialize') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
    if (request.method === 'tools/call') {
      release = () => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
      arrived();
    }
  });
  mocks.spawn.mockReturnValue(child);
  const input = { mcpServers: { byokagentresult: { command: 'controlled-helper', args: [], env: {} } } } as unknown as RuntimeOperationStartInput;
  return { child, session: new BotStubSession(input), requested, release: () => release() };
}

it('close cancels its held result RPC and settles finish before returning', async () => {
  const f = heldChild();
  let settled = false;
  const finishing = f.session.finish({ text: 'controlled' }).then(() => { settled = true; });
  await f.requested;
  try {
    await f.session.close();
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
  } finally { f.release(); f.child.kill(); await finishing; }
});

it('does not inject result events after close even when the held RPC later completes', async () => {
  const f = heldChild();
  const emit = vi.spyOn(f.session, 'emit');
  const finishing = f.session.finish({ text: 'controlled' });
  await f.requested;
  try {
    await f.session.close();
    f.release();
    await finishing;
    expect(emit).not.toHaveBeenCalled();
  } finally { f.child.kill(); await finishing; }
});

it('waits for child close after exit, and shares concurrent disposal', async () => {
  const f = heldChild();
  f.child.kill.mockImplementation(() => { queueMicrotask(() => f.child.emit('exit', 0)); return true; });
  const finishing = f.session.finish({});
  await f.requested;
  let closed = false;
  const first = f.session.close();
  expect(f.session.close()).toBe(first);
  void first.then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  try {
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
  } finally { f.child.emit('close', 0); await first; await finishing; }
  await f.session.close();
  await f.session.finish({});
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(f.child.kill).toHaveBeenCalledTimes(1);
});

it('rejects bounded disposal while retaining the pending child for a later close receipt', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = heldChild();
  f.child.kill.mockImplementation(() => true);
  const finishing = f.session.finish({});
  await f.requested;
  const closing = f.session.close();
  const rejected = expect(closing).rejects.toMatchObject({ name: 'RuntimeDisposalFailure', stage: 'quiescence' });
  try {
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    f.child.emit('close', 0);
    await finishing;
    await f.session.close();
  } finally { f.child.emit('close', 0); await finishing; }
});

it('keeps independent finish injections concurrent and disposes every owned helper', async () => {
  const first = heldChild();
  const one = first.session.finish({ text: 'one' });
  await first.requested;
  const second = heldChild();
  const two = first.session.finish({ text: 'two' });
  await second.requested;
  await first.session.close();
  await Promise.all([one, two]);
  expect(first.child.kill).toHaveBeenCalledTimes(1);
  expect(second.child.kill).toHaveBeenCalledTimes(1);
});

it('injects a normal result only after the owned helper closes', async () => {
  const f = heldChild();
  const emit = vi.spyOn(f.session, 'emit');
  const finishing = f.session.finish({ text: 'ok' });
  await f.requested;
  f.release();
  await finishing;
  expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['progress', 'turn_end']);
  await f.session.close();
  expect(f.child.kill).toHaveBeenCalledTimes(1);
});

it('settles a failed spawn through close without requiring an exit event', async () => {
  const f = heldChild();
  const finishing = f.session.finish({});
  const failure = new Error('controlled spawn failure');
  f.child.emit('error', failure);
  f.child.emit('close', -1);
  await finishing;
  await expect(f.session.events[Symbol.asyncIterator]().next()).rejects.toBe(failure);
  await f.session.close();
});
