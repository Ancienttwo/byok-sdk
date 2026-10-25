import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { canonical, hash, HostLedger, project, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { stateOf } from './model';
import { admitUserInput } from './coalesce';
import { commitInLedger, syncTurnInLedger } from './commit';
import { intentRows } from './delegation';
import { cardCallDue, expireCards, reportCardDecisions, settleCardCall, type CommandPorts } from './rules/commands';
import { cardCallVectors, seedCollaboration, SYNC_OPTIONS, VECTOR_NOW, type CardCallSubject, type SyncIntentRecord } from './commit-vectors.test-support';

// #793 S12: the shared card call vectors on the L ledger, with L's card call step (K8 host.ts `flushCards`).
const roots: string[] = [], ledgers: HostLedger[] = [];
afterAll(() => {
  for (const ledger of ledgers) ledger.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A real SQLite HostLedger with L's card sync order (K8 host.ts `sync`: `expireCards`, the Turn steps, then
 * `reportCardDecisions`) and L's `flushCards`, written out here: each due card's connector call outside the transaction, then
 * `settleCardCall` in one ledger transaction.
 */
function cardCallSubject(): CardCallSubject {
  const root = mkdtempSync(join(tmpdir(), 'k8-card-call-'));
  roots.push(root);
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'product:card-call');
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
    sync: now => {
      ledger.transaction((s, rows) => {
        const state = stateOf(s.application);
        expireCards(state, now);
        for (const turn of Object.values(state.turns)) syncTurnInLedger(ledger, s, rows, turn, { ...SYNC_OPTIONS, now });
        reportCardDecisions(state, (id, value) => project(s, id, value));
      });
    },
    intent: id => {
      const row = ledger.snapshot().intents[hash(id)];
      return row && { key: row.key, source: row.source as SyncIntentRecord['source'], waitUntil: row.waitUntil, execution: row.execution };
    },
    concludeIntent: (id, conclusion) => { ledger.transaction(s => { Object.assign(s.intents[hash(id)]!, { phase: 'settled', conclusion }); }); },
    projection: id => Object.values(ledger.snapshot().outbox).flatMap(row => row.kind === 'projection' && row.id === id ? [row.value] : []),
    callCards: async connector => {
      for (const card of Object.values(stateOf(ledger.snapshot().application).cards)) {
        if (!cardCallDue(card)) continue;
        let outcome: Parameters<typeof settleCardCall>[1];
        try { outcome = { result: await connector(card.id, card.action.action, card.action.draft, new AbortController().signal) }; }
        catch (error) { outcome = { error }; }
        ledger.transaction(s => settleCardCall(stateOf(s.application).cards[card.id]!, outcome));
      }
    },
  };
}

cardCallVectors('L HostLedger', cardCallSubject);
