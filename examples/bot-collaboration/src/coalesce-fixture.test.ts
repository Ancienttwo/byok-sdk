import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RuntimeOperationStartInput } from '@byok-sdk/client';

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: fake.spawn }));
import { BotStubSession, finishWithin } from '../../basic/goal-btw.test-support';
afterEach(() => { fake.spawn.mockReset(); });

function controlledHelper() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  const requests: Array<{ id: number; method: string }> = [];
  child.stdin.on('data', bytes => {
    const request = JSON.parse(String(bytes));
    if (request.id === undefined) return;
    requests.push(request);
    if (request.method === 'initialize') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
  });
  fake.spawn.mockReturnValue(child);
  const session = new BotStubSession({ mcpServers: { byokagentresult: { command: 'controlled-fixture' } } } as unknown as RuntimeOperationStartInput);
  return { child, session, requests };
}

it('keeps the injection receipt pending until RPC and helper exit complete', async () => {
  const { child, session, requests } = controlledHelper();
  const events = session.events[Symbol.asyncIterator]();
  let emitted = false;
  const first = events.next().then(event => { emitted = true; return event; });
  const completion = session.finish({ text: 'done' });
  let observerStarted = false;
  const observer = Promise.resolve(completion).then(() => { observerStarted = true; });
  try {
    await vi.waitFor(() => expect(requests.some(row => row.method === 'tools/call')).toBe(true));
    // The receipt remains pending; semantic observers may run concurrently.
    expect(observerStarted).toBe(false);
    expect(emitted).toBe(false);
    const call = requests.find(row => row.method === 'tools/call')!;
    child.stdout.write(JSON.stringify({ id: call.id, result: {} }) + '\n');
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce());
    expect(observerStarted).toBe(false); expect(emitted).toBe(false);
    child.emit('exit', 0);
    await observer;
    expect(await first).toMatchObject({ value: { type: 'progress', text: '{"text":"done"}' } });
    expect(await events.next()).toMatchObject({ value: { type: 'turn_end' } });
  } finally { child.emit('exit', 0); await session.close(); await first; await observer; }
});

it('keeps ignored completion promises handled while delivering helper failures through events', async () => {
  const { child, session, requests } = controlledHelper();
  const events = session.events[Symbol.asyncIterator]();
  const observed = expect(events.next()).rejects.toThrow('controlled failure');
  try {
    session.finish({ text: 'done' }); // Legacy callers intentionally ignore the completion promise.
    await vi.waitFor(() => expect(requests.some(row => row.method === 'tools/call')).toBe(true));
    const call = requests.find(row => row.method === 'tools/call')!;
    child.stdout.write(JSON.stringify({ id: call.id, error: { message: 'controlled failure' } }) + '\n');
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce());
    child.emit('exit', 0);
    await observed;
  } finally {
    child.emit('exit', 0);
    await session.close();
    await observed.catch(() => {});
  }
});


it('bounds held result injection and observation with the same deadline', async () => {
  const { child, session } = controlledHelper();
  const finish = vi.spyOn(session, 'finish');
  const observe = vi.fn(() => {});
  try {
    await expect(finishWithin(session, {}, observe, 100)).rejects.toThrow('result injection is still pending');
    expect(finish).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalled();
  } finally { child.emit('exit', 0); await session.close(); }
});

it('does not give observation a fresh window after RPC and child exit', async () => {
  const { child, session, requests } = controlledHelper();
  const finish = vi.spyOn(session, 'finish');
  let ready = false;
  const observationFailure = new Error('terminal still pending');
  const observe = vi.fn(() => { if (!ready) throw observationFailure; });
  const result = finishWithin(session, {}, observe, 1000);
  const rejected = expect(result).rejects.toBe(observationFailure);
  const response = setTimeout(() => {
    const call = requests.find(row => row.method === 'tools/call')!;
    child.stdout.write(JSON.stringify({ id: call.id, result: {} }) + '\n');
  }, 400);
  const exit = setTimeout(() => child.emit('exit', 0), 700);
  const terminal = setTimeout(() => { ready = true; }, 1200);
  try {
    await rejected;
    expect(ready).toBe(false);
    expect(finish).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
  } finally {
    clearTimeout(response); clearTimeout(exit); clearTimeout(terminal);
    child.emit('exit', 0); await session.close();
  }
});

it('preserves a rejected injection receipt instead of treating settlement as success', async () => {
  const failure = new Error('injection rejected');
  const finish = vi.fn(async () => { throw failure; });
  await expect(finishWithin({ finish }, {}, () => {}, 100)).rejects.toBe(failure);
  expect(finish).toHaveBeenCalledOnce();
});

it('observes concurrently and completes only after both receipts are ready', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const finish = vi.fn(() => pending);
  const observe = vi.fn(() => {});
  let complete = false;
  const result = finishWithin({ finish }, {}, observe).then(() => { complete = true; });
  try {
    await vi.waitFor(() => expect(observe).toHaveBeenCalled());
    expect(complete).toBe(false);
    release(); await result;
    expect(complete).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
  } finally { release(); await result; }
});


it('rejects observation that crosses the monotonic deadline before timer delivery', async () => {
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const finish = vi.fn(async () => {});
  const observe = vi.fn(() => { clock = 101; });
  try {
    await expect(finishWithin({ finish }, {}, observe, 100)).rejects.toThrow('result observation deadline exceeded');
    expect(finish).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
  } finally { now.mockRestore(); }
});
