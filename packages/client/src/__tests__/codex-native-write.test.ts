import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnedLineProcessSpawn } from '../runtime/owned-line-process';
import { CodexNativeInteractions } from '../adapters/codex/native-interactions';
import type { NativeInteractionRequest } from '../native-interactions';
const children: ReturnType<ReturnType<typeof createOwnedLineProcessSpawn>>[] = [];
afterEach(async () => { for (const child of children.splice(0)) { child.kill(); await child.exited.catch(() => {}); } vi.useRealTimers(); });
function transport() {
  let callback!: (error?: Error | null) => void;
  const owned = createOwnedLineProcessSpawn({ spawnFn: (command: string, args: readonly string[], options: SpawnOptions) => {
    const process = spawn(command, args, options) as ChildProcessWithoutNullStreams;
    process.stdin.write = ((_text: unknown, cb: (error?: Error | null) => void) => { callback = cb; return false; }) as typeof process.stdin.write;
    return process;
  } })(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {} });
  children.push(owned);
  return { owned, complete: (error?: Error) => callback(error) };
}
describe('acknowledged native reply transport', () => {
  it('does not complete when stdin only buffered the reply', async () => {
    const t = transport(); await t.owned.spawned; let settled = false;
    const written = t.owned.writeAcknowledged('reply').then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    t.complete(); await written; expect(settled).toBe(true);
  });
  it('rejects the pending receipt on a late stdin callback error', async () => {
    const t = transport(); await t.owned.spawned; const written = t.owned.writeAcknowledged('reply');
    const failed = expect(written).rejects.toThrow('fixture pipe'); t.complete(new Error('fixture pipe')); await failed;
    await expect(t.owned.exited).rejects.toThrow('fixture pipe');
  });
  it('process close rejects a stalled write rather than abandoning its receipt', async () => {
    const t = transport(); await t.owned.spawned; const written = t.owned.writeAcknowledged('reply');
    const failed = expect(written).rejects.toThrow('closed during write'); t.owned.kill(); await failed;
  });
  it.each(['serverRequest/resolved', 'turn/completed'] as const)('retains uncertain-write disposal after %s', async notification => {
    vi.useFakeTimers(); const onFatal = vi.fn(); const receipts: unknown[] = []; let request!: NativeInteractionRequest;
    const bridge = new CodexNativeInteractions(() => 'thread', { onRequest: r => { request = r; }, onResolved: r => { receipts.push(r); }, writeTimeoutMs: 20 }, onFatal);
    bridge.beginTurn(); bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
    const reply = { respond: vi.fn(() => new Promise<void>(() => {})), reject: vi.fn(async () => {}), cancelled: vi.fn() };
    bridge.receive(7, 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'item' }, reply);
    const result = bridge.channel.respond({ requestId: request.requestId, kind: 'approval', decision: 'allow-once' }); await Promise.resolve();
    expect(reply.respond).toHaveBeenCalledOnce();
    bridge.notification(notification, notification === 'serverRequest/resolved' ? { threadId: 'thread', requestId: 7 } : { threadId: 'thread', turn: { id: 'turn' } });
    expect(await result).toMatchObject({ status: 'cancelled' }); expect(reply.cancelled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20); expect(onFatal).toHaveBeenCalledOnce(); expect(receipts).toHaveLength(1); bridge.close();
  });
});
