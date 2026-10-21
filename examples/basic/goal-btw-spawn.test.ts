import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { RuntimeOperationStartInput } from '@byok-sdk/client';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ child: undefined as ReturnType<typeof makeChild> | undefined }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: () => state.child }));
import { BotStubSession } from './goal-btw.test-support';
function makeChild() { return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) }); }
function setup() {
  const child = makeChild();
  state.child = child;
  const session = new BotStubSession({ mcpServers: { byokagentresult: { command: 'controlled-only' } } } as unknown as RuntimeOperationStartInput);
  const events = session.events[Symbol.asyncIterator]();
  const requests: { id: number; method: string; params?: { name: string } }[] = [];
  child.stdin.on('data', data => requests.push(JSON.parse(String(data))));
  return { child, session, events, requests };
}
async function checkpoint() { await setImmediate(); }
describe('submitResult child settlement', () => {
  it('delivers spawn failure after close without exit', async () => {
    const { child, session, events, requests } = setup();
    const error = Object.assign(new Error('controlled spawn EAGAIN'), { code: 'EAGAIN' });
    let delivered: unknown;
    const next = events.next().catch(value => { delivered = value; });
    session.finish({ text: 'x' });
    expect(requests[0]!.method).toBe('initialize');
    child.emit('error', error);
    await checkpoint();
    expect(delivered).toBeUndefined(); // error alone is not proof of process closure
    child.emit('close', -1, null);
    await checkpoint();
    try { expect(delivered).toBe(error); }
    finally { child.emit('exit', -1, null); await next; await session.close(); }
  });
  it('retains the normal exit completion boundary after successful MCP response', async () => {
    const { child, session, events, requests } = setup();
    let delivered: unknown;
    const next = events.next().then(value => { delivered = value; });
    session.finish({ text: 'ok' });
    child.stdout.write(JSON.stringify({ id: requests[0]!.id, result: {} })+'\n');
    await checkpoint();
    const call = requests.find(row => row.method === 'tools/call');
    expect(call?.params?.name).toBe('submit_result');
    child.stdout.write(JSON.stringify({ id: call!.id, result: { content: [] } })+'\n');
    await checkpoint();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(delivered).toBeUndefined();
    child.emit('exit', 0, null);
    await next;
    expect(delivered).toEqual({ done: false, value: { type: 'progress', text: '{"text":"ok"}' } });
    child.emit('close', 0, null);
    await session.close();
  });
});
