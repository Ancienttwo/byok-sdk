import { expect, it } from 'vitest';
import { HostExecutionCore, HostLedger } from '@byok-sdk/server/execution-core';
import { openHost } from './test-support';

it('measures initial scan wake records for 1000 submitted intents with and without event hints', async () => {
  const host = await openHost();
  await host.offline(); // Real submission/wake stores, no model work or claims.
  const counts: Record<string, number> = {};
  try {
    for (const mode of ['scan', 'events'] as const) {
      const before = (await host.server.wakes.pending()).length;
      for (let i = 0; i < 1000; i++) {
        const ledger = new HostLedger(':memory:', `measure-${mode}-${i}`);
        const server = mode === 'events' ? host.server : {
          executions: host.server.executions, tasks: host.server.tasks, wakes: host.server.wakes,
        };
        const core = new HostExecutionCore(server, ledger, { reconcileMs: 60_000 });
        try { await core.enqueue(host.intent(`measure-${mode}-${i}`, { waitUntil: Date.now() + 120_000 })); }
        finally { await core.close(); ledger.close(); }
      }
      counts[mode] = (await host.server.wakes.pending()).length - before;
    }
    expect(counts).toEqual({ scan: 1000, events: 0 });
    console.info('1000-intent initial host-scan wake records', counts);
  } finally { await host.close(); }
}, 30_000);
