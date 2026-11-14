import { expect, it } from 'vitest';
import { HostExecutionCore, HostLedger } from '@byok-sdk/server/execution-core';
import { openHost } from './test-support';

it('counts initial scan wakes for submitted intents with and without event hints', async () => {
  // Each sample has an independent ledger/core: this checks initial scheduling,
  // not throughput. Bound repeated SQLite submissions so CI has time to assert.
  const intentCount = 200;
  const host = await openHost();
  await host.offline(); // Real submission/wake stores, no model work or claims.
  const counts: Record<string, number> = {};
  try {
    for (const mode of ['scan', 'events'] as const) {
      const before = (await host.server.wakes.pending()).length;
      for (let i = 0; i < intentCount; i++) {
        const ledger = new HostLedger(':memory:', `measure-${mode}-${i}`);
        const server = mode === 'events' ? host.server : {
          executions: host.server.executions, tasks: host.server.tasks, wakes: host.server.wakes,
        };
        const core = new HostExecutionCore(server, ledger, { reconcileMs: 60_000 });
        try {
          const intent = await core.enqueue(host.intent(`measure-${mode}-${i}`, { waitUntil: Date.now() + 120_000 }));
          expect(intent.phase).toBe('inflight');
        } finally { await core.close(); ledger.close(); }
      }
      counts[mode] = (await host.server.wakes.pending()).length - before;
    }
    expect(counts).toEqual({ scan: intentCount, events: 0 });
  } finally { await host.close(); }
}, 30_000);
