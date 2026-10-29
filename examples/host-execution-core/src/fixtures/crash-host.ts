// Test process only. The parent kills this process while a real wake is delivering.
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { createByokServer } from '@byok-sdk/server';
import { HostExecutionCore, HostLedger, hash, type ExecutionTemplate } from '@byok-sdk/server/execution-core';

const root = process.argv[2]!;
const port = Number(process.argv[3] ?? 0);
const holdSubmit = process.argv[4] === 'hold';
const productId = 'k4-crash-test';
const ledger = new HostLedger(path.join(root, 'host.sqlite'), `product:${productId}`);
let core!: HostExecutionCore;
const server = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
  wake: { consume: async (wake, signal) => {
    const before = ledger.snapshot();
    const occurrenceKey = before.slots[hash(wake.dedupKey)];
    await core.consume(wake, signal);
    if (occurrenceKey) {
      const after = ledger.snapshot();
      const occurrence = after.occurrences[occurrenceKey]!;
      const taskId = after.intents[occurrence.intentId!]!.taskId;
      process.send?.({ kind: 'replayed', taskId, dedupKey: wake.dedupKey, delivery: wake.delivery,
        beforeReplayCount: before.occurrences[occurrenceKey]!.slotReplayCount ?? 0,
        slotReplayCount: occurrence.slotReplayCount,
        sdkWake: (await server.wakes.pending()).find(row => row.dedupKey === wake.dedupKey),
        attempt: await server.tasks.attempt(taskId),
      });
    }
  } },
});
core = new HostExecutionCore({ ...server, executions: { submit: async input => {
  const result = await server.executions.submit(input);
  if (holdSubmit) {
    // A started fake session does not prove that its asynchronous claim reached
    // SQLite. Freeze the crash checkpoint only after the SDK receipt is durable.
    const deadline = Date.now() + 5000;
    while ((await server.tasks.attempt(input.taskId))?.status !== 'running') {
      if (Date.now() >= deadline) {
        process.send?.({ kind: 'error', message: 'SDK running receipt did not reach the crash checkpoint' });
        throw new Error('SDK running receipt missing');
      }
      await delay(10);
    }
    const state = ledger.snapshot();
    const intent = Object.values(state.intents).find(row => row.taskId === input.taskId)!;
    const dedupKey = state.occurrences[intent.occurrence!]!.wakeKey;
    const pending = await server.wakes.pending();
    const current = pending.find(wake => wake.dedupKey === dedupKey);
    process.send?.({ kind: 'submitted', taskId: input.taskId, dedupKey,
      delivering: current?.state === 'delivering', delivery: current?.deliveries });
    await new Promise<void>(() => {});
  }
  return result;
} } }, ledger);
const http = serve({ fetch: server.hono.fetch, port, hostname: '127.0.0.1' });
if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
const address = http.address();
if (!address || typeof address === 'string') throw new Error('No TCP address');
process.on('message', (message: { kind: string; execution?: ExecutionTemplate }) => {
  if (message.kind === 'routine' && message.execution) {
    void core.addRoutine({ id: 'crash-routine', version: 1, timeZone: 'UTC',
      rule: { anchorMs: Date.now() + 20, everyMs: 86_400_000 }, execution: message.execution,
      waitMs: 60_000, lateAfterMs: 1000,
    }).catch(error => { process.send?.({ kind: 'error', message: String(error) }); });
  }
});
await core.recover();
const pairing = await server.pairing.createPairingCode({ productId });
process.send?.({ kind: 'ready', port: address.port, code: pairing.code });
