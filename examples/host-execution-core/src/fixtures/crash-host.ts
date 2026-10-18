// Test process only. The parent kills this process while a real wake is delivering.
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createByokServer } from '@byok-sdk/server';
import { HostExecutionCore } from '../core';
import { HostLedger } from '../ledger';
import type { ExecutionTemplate } from '../model';

const root = process.argv[2]!;
const port = Number(process.argv[3] ?? 0);
const holdSubmit = process.argv[4] === 'hold';
const productId = 'k4-crash-test';
const ledger = new HostLedger(path.join(root, 'host.sqlite'), `product:${productId}`);
let core!: HostExecutionCore;
const server = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
  wake: { consume: (wake, signal) => core.consume(wake, signal) },
});
core = new HostExecutionCore({ ...server, executions: { submit: async input => {
  const result = await server.executions.submit(input);
  if (holdSubmit) {
    const pending = await server.wakes.pending();
    process.send?.({ kind: 'submitted', taskId: input.taskId, delivering: pending.some(wake => wake.state === 'delivering') });
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
