import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { canonical, hash, HostLedger, MIN_TOMBSTONE_RETENTION_MS, project, type LedgerState } from '@byok-sdk/server/execution-core';
import { stateOf } from './model';
import { admitUserInput } from './coalesce';
import { callCardsInLedger, commitInLedger, retainInLedger, syncTurnInLedger } from './commit';
import { intentRows } from './delegation';
import { CONNECTOR_OUTCOME_UNKNOWN, expireCards, reportCardDecisions, type CommandPorts } from './rules/commands';
import { SwitchExportedError } from './switch';
import { cardCallVectors, seedCollaboration, SYNC_OPTIONS, VECTOR_NOW, type CardCallSubject, type SyncIntentRecord } from './commit-vectors.test-support';

// #793 S12: the shared card call vectors on the L ledger, with L's card call step (K8 host.ts `flushCards`).
const roots: string[] = [], ledgers: HostLedger[] = [];
afterAll(() => {
  for (const ledger of ledgers) ledger.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A real SQLite HostLedger with L's card sync order (K8 host.ts `sync`: `expireCards`, the Turn steps, then
 * `reportCardDecisions`) and L's card call step, `callCardsInLedger`, which K8 host.ts `flushCards` runs.
 */
function cardCallSubject(): CardCallSubject & { ledger: HostLedger } {
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
    callCards: connector => callCardsInLedger(ledger, card => connector(card.id, card.action.action, card.action.draft, new AbortController().signal)),
    ledger,
  };
}

cardCallVectors('L HostLedger', cardCallSubject);

/** #958: `t1` concluded and reported, and card `c1` confirmed and due for its call. */
async function confirmed() {
  const subject = cardCallSubject();
  subject.change(state => {
    Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    state.cards.c1!.expiresAt = VECTOR_NOW + 60_000;
  });
  await subject.commit({ scope: subject.scope, commandId: 'decide', command: { kind: 'decide', cardId: 'c1', decision: 'confirmed' } });
  await subject.sync(VECTOR_NOW);
  return subject;
}

it('#958: claims the card call in the ledger before the connector runs, and drops the claim at the settle', async () => {
  const subject = await confirmed();
  const seen: unknown[] = [];
  await subject.callCards(async () => { seen.push(stateOf(subject.ledger.snapshot().application).cardCalls); return { sent: true }; });
  expect(seen).toEqual([{ c1: true }]);
  expect(stateOf(subject.ledger.snapshot().application).cardCalls).toEqual({});
  expect((await subject.state()).cards.c1).toMatchObject({ result: { sent: true }, conclusion: 'succeeded' });
});

it('#958: ends a card whose claim never settled with the unknown outcome, and never calls the connector again', async () => {
  const subject = await confirmed();
  // A crash after the call: the claim is stored and the card has no result or error.
  subject.ledger.transaction(s => { stateOf(s.application).cardCalls = { c1: true }; });
  const calls: string[] = [];
  await subject.callCards(async id => { calls.push(id); return { sent: true }; });
  expect(calls).toEqual([]);
  expect((await subject.state()).cards.c1).toMatchObject({ error: CONNECTOR_OUTCOME_UNKNOWN, conclusion: 'failed' });
  expect((await subject.state()).cards.c1).not.toHaveProperty('result');
  expect(stateOf(subject.ledger.snapshot().application).cardCalls).toEqual({});
  await subject.callCards(async id => { calls.push(id); return { sent: true }; });
  expect(calls).toEqual([]);
  await subject.sync(VECTOR_NOW);
  expect((await subject.state()).turns[hash(['action_result', 'c1'])]).toMatchObject({ source: 'action_result',
    request: JSON.stringify({ cardId: 'c1', state: 'confirmed', conclusion: 'failed', error: CONNECTOR_OUTCOME_UNKNOWN }) });
});

it('#975: a ledger with an uncommitted switch import refuses the card call before the connector runs, a command, a sync step and retention', async () => {
  const subject = await confirmed();
  subject.change(state => { state.switchImport = { digest: 'd', devices: ['d1'] }; });
  const before = subject.stored(), refusal = 'This ledger holds the switch import d; commit it toward L or discard it first';
  let calls = 0;
  await expect(subject.callCards(async () => { calls++; return { sent: true }; })).rejects.toThrow(refusal);
  expect(calls).toBe(0);
  expect(() => subject.commit({ scope: subject.scope, commandId: 'cancel', command: { kind: 'cancel_turn', turnId: 't1' } })).toThrow(refusal);
  expect(() => subject.sync(VECTOR_NOW)).toThrow(refusal);
  expect(() => retainInLedger(subject.ledger, { acknowledgedRoots: [], now: VECTOR_NOW, retentionMs: MIN_TOMBSTONE_RETENTION_MS },
    { contextTurnLimit: 1 })).toThrow(refusal);
  expect(subject.stored()).toBe(before);
});

it('#975: an exported ledger refuses the card call before the connector runs, a command, a sync step and retention', async () => {
  const subject = await confirmed();
  subject.change(state => { state.switchExport = { digest: 'd', exportedAt: VECTOR_NOW, devices: [{ deviceId: 'd1', frozenRevision: 1 }] }; });
  const before = subject.stored();
  let calls = 0;
  await expect(subject.callCards(async () => { calls++; return { sent: true }; })).rejects.toBeInstanceOf(SwitchExportedError);
  expect(calls).toBe(0);
  expect(() => subject.commit({ scope: subject.scope, commandId: 'cancel', command: { kind: 'cancel_turn', turnId: 't1' } }))
    .toThrow(SwitchExportedError);
  expect(() => subject.sync(VECTOR_NOW)).toThrow(SwitchExportedError);
  expect(() => retainInLedger(subject.ledger, { acknowledgedRoots: [], now: VECTOR_NOW, retentionMs: MIN_TOMBSTONE_RETENTION_MS },
    { contextTurnLimit: 1 })).toThrow(SwitchExportedError);
  expect(subject.stored()).toBe(before);
});

