import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RuntimeOperationStartInput } from '@byok-sdk/client';

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: fake.spawn }));
import { BotStubSession } from '../../basic/goal-btw.test-support';
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

it('settles the completion receipt after result injection and helper close', async () => {
  const { child, session, requests } = controlledHelper();
  const events = session.events[Symbol.asyncIterator]();
  let emitted = false;
  const first = events.next().then(event => { emitted = true; return event; });
  const completion = session.finish({ text: 'done' });
  let observerStarted = false;
  const observer = Promise.resolve(completion).then(() => { observerStarted = true; });
  try {
    await vi.waitFor(() => expect(requests.some(row => row.method === 'tools/call')).toBe(true));
    // The old void return incorrectly starts observation while submission is still held.
    expect(observerStarted).toBe(false);
    expect(emitted).toBe(false);
    const call = requests.find(row => row.method === 'tools/call')!;
    child.stdout.write(JSON.stringify({ id: call.id, result: {} }) + '\n');
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce());
    expect(observerStarted).toBe(false); expect(emitted).toBe(false);
    child.emit('exit', 0);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(observerStarted).toBe(false); expect(emitted).toBe(false);
    child.emit('close', 0);
    await observer;
    expect(await first).toMatchObject({ value: { type: 'progress', text: '{"text":"done"}' } });
    expect(await events.next()).toMatchObject({ value: { type: 'turn_end' } });
  } finally { child.emit('exit', 0); child.emit('close', 0); await session.close(); await first; await observer; }
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
    child.emit('close', 0);
    await observed;
  } finally {
    child.emit('exit', 0);
    child.emit('close', 0);
    await session.close();
    await observed.catch(() => {});
  }
});
