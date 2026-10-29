// Test process only. In crash mode the occurrence hook kills this process inside the occurrence commit.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createByokServer } from '../../../index';
import { HostExecutionCore } from '../../../execution-core/core';
import { HostLedger } from '../../../execution-core/ledger';

const root = process.argv[2]!;
const crash = process.argv[3] === 'crash';
const productId = 'k4-hook-crash-test';
const ledger = new HostLedger(path.join(root, 'host.sqlite'), `product:${productId}`);
let core!: HostExecutionCore;
const server = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
  wake: { consume: async (wake, signal) => {
    await core.consume(wake, signal);
    process.send?.({ kind: 'consumed', dedupKey: wake.dedupKey, delivery: wake.delivery });
  } },
});
core = new HostExecutionCore(server, ledger, { occurrenceHooks: { turn: (run, tx) => {
  tx.application[run.occurrenceKey] = { plannedAt: run.trigger.plannedAt };
  // An external effect is at least once: this line survives the crash that rolls the commit back.
  appendFileSync(path.join(root, 'hook-calls.log'), `${run.occurrenceKey}\n`);
  if (!crash) return;
  process.kill(process.pid, 'SIGKILL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000); // Hold the commit open until the signal lands.
  throw new Error('SIGKILL did not stop the Host');
} } });
process.on('message', (message: { kind: string }) => {
  if (message.kind !== 'routine') return;
  void core.addRoutine({ id: 'hook-routine', version: 1, timeZone: 'UTC', rule: { anchorMs: Date.now() + 20, everyMs: 86_400_000 },
    // A late redelivery stays `scheduled`, so both deliveries derive the same occurrence key.
    hostOccurrence: { type: 'turn', input: null }, waitMs: 60_000, lateAfterMs: 60_000,
  }).catch(error => { process.send?.({ kind: 'error', message: String(error) }); });
});
await core.recover();
process.send?.({ kind: 'ready' });
