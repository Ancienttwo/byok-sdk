import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { canonical, hash, HostLedger, project, type LedgerState } from '@byok-sdk/server/execution-core';
import { stateOf } from './model';
import { admitUserInput } from './coalesce';
import { commitInLedger, syncTurnInLedger } from './commit';
import { intentRows } from './delegation';
import { flushHomes } from './home-projections';
import { homeRequests } from './team';
import type { CommandPorts } from './rules/commands';
import { homeVectors, seedCollaboration, SYNC_OPTIONS, VECTOR_NOW, type HomeSubject, type SyncIntentRecord } from './commit-vectors.test-support';

// #793 S13: the shared Agent home flush vectors on the L ledger, with L's `flushHomes`.
const roots: string[] = [], ledgers: HostLedger[] = [];
afterAll(() => {
  for (const ledger of ledgers) ledger.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A real SQLite HostLedger with L's Turn steps as its sync and L's `flushHomes` as its home flush. The server's home calls
 * go to the vector's calls: a read finds its request among the stored operations by request id.
 */
function homeSubject(): HomeSubject {
  const root = mkdtempSync(join(tmpdir(), 'k8-home-'));
  roots.push(root);
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'product:home');
  ledgers.push(ledger);
  ledger.transaction(s => { seedCollaboration(stateOf(s.application)); });
  const ports = (s: LedgerState): CommandPorts => {
    const state = stateOf(s.application);
    return { now: () => VECTOR_NOW, publish: (id, value) => project(s, id, value), admitInput: fields => admitUserInput(state, fields, undefined, VECTOR_NOW),
      intents: intentRows(s),
      outcome: { committed: intentRows(s), manage: () => {}, createRoutine: () => {}, updateRoutine: () => {}, cancelRoutine: () => {} } };
  };
  return {
    scope: ledger.tenant,
    commit: request => commitInLedger(ledger, request, ports),
    stored: () => canonical(ledger.snapshot() as never),
    state: () => stateOf(ledger.snapshot().application),
    change: edit => { ledger.transaction(s => { edit(stateOf(s.application)); }); },
    sync: () => { ledger.transaction((s, rows) => { for (const turn of Object.values(stateOf(s.application).turns)) syncTurnInLedger(ledger, s, rows, turn, SYNC_OPTIONS); }); },
    intent: id => {
      const row = ledger.snapshot().intents[hash(id)];
      return row && { key: row.key, source: row.source as SyncIntentRecord['source'], waitUntil: row.waitUntil, execution: row.execution };
    },
    concludeIntent: (id, conclusion) => { ledger.transaction(s => { Object.assign(s.intents[hash(id)]!, { phase: 'settled', conclusion }); }); },
    projection: id => Object.values(ledger.snapshot().outbox).flatMap(row => row.kind === 'projection' && row.id === id ? [row.value] : []),
    flushHomes: (now, calls) => flushHomes({
      readAgentHomeProjection: async (_deviceId, _agentRef, requestId) => {
        const request = stateOf(ledger.snapshot().application).team.homeOperations.flatMap(homeRequests).find(row => row.payload.requestId === requestId)!;
        return await calls.read(request) as never;
      },
      enqueueAgentHomeProjection: async request => await calls.enqueue(request) as never,
    }, ledger, () => now),
  };
}

homeVectors('L HostLedger', homeSubject);
