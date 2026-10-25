import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { canonical, hash, HostLedger, project, taskId, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { stateOf } from './model';
import { admitUserInput } from './coalesce';
import { commitInLedger, syncTurnInLedger } from './commit';
import { intentRows, observeDevices, settleDelegations } from './delegation';
import type { CommandPorts } from './rules/commands';
import { deviceVectors, seedCollaboration, SYNC_OPTIONS, VECTOR_NOW, type DeviceSubject, type SyncIntentRecord } from './commit-vectors.test-support';

// #793 S11: the shared device observation vectors on the L ledger, with L's device step (K8 host.ts `refreshDevices`).
const roots: string[] = [], ledgers: HostLedger[] = [];
afterAll(() => {
  for (const ledger of ledgers) ledger.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A real SQLite HostLedger with L's sync order (K8 host.ts `sync`: the Turn steps, then `settleDelegations`) and L's device
 * step: K8 `observeDevices` on the K8 `intentFacts` adapter in one ledger transaction. Commands take the intent rows as L's
 * owner commands and outcomes do. The fact edits write the K4 execution that `intentFacts` reads.
 */
function deviceSubject(): DeviceSubject {
  const root = mkdtempSync(join(tmpdir(), 'k8-device-'));
  roots.push(root);
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'product:device');
  ledgers.push(ledger);
  ledger.transaction(s => { seedCollaboration(stateOf(s.application)); });
  const execution = (s: LedgerState, turnId: string) => s.executions[taskId(turnId, 0)]!;
  const ports = (s: LedgerState): CommandPorts => {
    const state = stateOf(s.application);
    return { now: () => VECTOR_NOW, publish: (id, value) => project(s, id, value), admitInput: fields => admitUserInput(state, fields, undefined, VECTOR_NOW),
      intents: intentRows(s),
      outcome: { committed: intentRows(s), manage: () => {}, createRoutine: () => {}, updateRoutine: () => {}, cancelRoutine: () => {} } };
  };
  const sync = (now: number, timers?: Parameters<typeof settleDelegations>[4]) => {
    ledger.transaction((s, rows) => {
      const state = stateOf(s.application);
      for (const turn of Object.values(state.turns)) syncTurnInLedger(ledger, s, rows, turn, { ...SYNC_OPTIONS, now });
      settleDelegations(s, state, now, (id, value) => project(s, id, value), timers);
    });
  };
  return {
    scope: ledger.tenant,
    commit: request => commitInLedger(ledger, request, ports),
    stored: () => canonical(ledger.snapshot() as never),
    state: () => stateOf(ledger.snapshot().application),
    change: edit => { ledger.transaction(s => { edit(stateOf(s.application)); }); },
    sync: () => sync(VECTOR_NOW),
    settle: sync,
    intent: id => {
      const row = ledger.snapshot().intents[hash(id)];
      return row && { key: row.key, source: row.source as SyncIntentRecord['source'], waitUntil: row.waitUntil, execution: row.execution };
    },
    concludeIntent: (id, conclusion) => { ledger.transaction(s => { Object.assign(s.intents[hash(id)]!, { phase: 'settled', conclusion }); }); },
    projection: id => Object.values(ledger.snapshot().outbox).flatMap(row => row.kind === 'projection' && row.id === id ? [row.value] : []),
    submit: turnId => { ledger.transaction(s => { s.intents[hash(turnId)]!.phase = 'inflight'; execution(s, turnId).submission = 'uncertain'; }); },
    deliver: (turnId, status) => {
      ledger.transaction(s => {
        s.intents[hash(turnId)]!.phase = 'inflight';
        const row = execution(s, turnId);
        row.submission = 'delivered';
        if (status) row.attempt = { taskId: taskId(turnId, 0), deviceId: 'device', status, updatedAt: new Date(0).toISOString() } as typeof row.attempt;
        else delete row.attempt;
      });
    },
    claim: turnId => { ledger.transaction(s => { Object.assign(execution(s, turnId), { submission: 'delivered', started: true }); }); },
    terminal: (turnId, type, payload) => {
      ledger.transaction(s => { execution(s, turnId).terminal = { envelope: { task_id: taskId(turnId, 0), type, payload } } as never; });
    },
    conclude: (turnId, conclusion, cancelReason) => {
      ledger.transaction(s => { Object.assign(s.intents[hash(turnId)]!, { phase: 'settled', conclusion, ...(cancelReason ? { cancelReason } : {}) }); });
    },
    observeDevices: devices => {
      ledger.transaction(s => observeDevices(s, stateOf(s.application), devices, (id, value) => project(s, id, value)));
    },
  };
}

deviceVectors('L HostLedger', deviceSubject);
