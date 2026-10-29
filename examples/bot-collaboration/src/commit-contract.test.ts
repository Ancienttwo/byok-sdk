import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { canonical, hash, HostLedger, project, taskId, type Json, type LedgerState } from '@byok-sdk/server/execution-core';
import { stateOf, type CollaborationState } from './model';
import { admitUserInput, projectInputBatches, sealDueBatches } from './coalesce';
import { coalescePolicy, type CoalescePolicy } from './rules/coalesce';
import { CommitConflict, commitInLedger, retainInLedger, syncTurnInLedger, type CommitRequest } from './commit';
import { retainRoots, type RetentionStore } from './retention';
import { retentionVectors, type RetentionSubject } from './retention-vectors.test-support';
import type { CommandRecord } from './rules/commit';
import { DatabaseSync } from 'node:sqlite';
import { commitCommand, expireCards, refuseRetired, reportCardDecisions, RetiredIdentityError, type AdmittedIds, type Command,
  type CommandPorts } from './rules/commands';
import { cardVectors, coalesceVectors, commitVectors, replyVectors, roomVectors, seedCollaboration, settlementVectors, SYNC_OPTIONS, syncVectors,
  VECTOR_NOW, type CardSubject, type CoalesceSubject, type CommitSubject, type ReplySubject, type RoomSubject, type SeedTeam, type SettlementSubject,
  type SyncIntentRecord, type SyncSubject } from './commit-vectors.test-support';
import { advanceRoomsAndTurns } from './rooms';
import { intentRows, settleDelegations } from './delegation';
import { syncTurn } from './rules/sync';
import { checkReply, replyCheckDue, type Conclusion, type ReplyCheck } from './rules/delegation';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { writeSnapshotBot } from './team';

/** The intent fact fields that the memory store keeps. */
const pick = (row: { conclusion?: Conclusion; cancelReason?: 'cancelled' }) =>
  ({ ...(row.conclusion ? { conclusion: row.conclusion } : {}), ...(row.cancelReason ? { cancelReason: row.cancelReason } : {}) });
/** The memory outbox has the K4 projection identity rule, for commit and sync alike. */
const publishTo = (outbox: Record<string, Json>) => (id: string, value: Json) => {
  if (outbox[id] !== undefined && canonical(outbox[id]) !== canonical(value)) throw new Error('Projection identity conflict');
  outbox[id] = value;
};

const roots: string[] = [], ledgers: HostLedger[] = [];
// Windows cannot delete an open SQLite file, so each ledger closes first.
afterAll(() => {
  for (const ledger of ledgers) ledger.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function ports(state: CollaborationState, publish: CommandPorts['publish']): CommandPorts {
  return { now: () => VECTOR_NOW, publish, admitInput: fields => admitUserInput(state, fields, undefined, VECTOR_NOW),
    teamBot: row => writeSnapshotBot(state, row, { default: template('device', 'main') }),
    outcome: { committed: { intent: () => undefined }, manage: () => {}, createRoutine: () => {}, updateRoutine: () => {}, cancelRoutine: () => {} } };
}
/** Rows that retention moved, and permanent tombstones, kept in memory like the K4 row port. */
interface MemoryArchive { rows: Record<string, { value: Json; expiresAt?: number }>; retired: string[] }
function memoryStore(archive: MemoryArchive): RetentionStore & { get(namespace: string, id: string): Json | undefined } {
  const key = (namespace: string, id: string) => JSON.stringify([namespace, id]);
  return {
    get: (namespace, id) => structuredClone(archive.rows[key(namespace, id)]?.value),
    put: (namespace, id, value, expiresAt) => { archive.rows[key(namespace, id)] = { value: structuredClone(value), ...(expiresAt === undefined ? {} : { expiresAt }) }; },
    expire: (namespace, now) => {
      const expired = Object.keys(archive.rows).filter(id => JSON.parse(id)[0] === namespace && (archive.rows[id]!.expiresAt ?? Infinity) <= now);
      for (const id of expired) delete archive.rows[id];
      return expired.length;
    },
    retire: (namespace, id) => { if (!archive.retired.includes(key(namespace, id))) archive.retired.push(key(namespace, id)); },
    isRetired: (namespace, id) => archive.retired.includes(key(namespace, id)),
  };
}
/** The pure rules on a plain object. A commit or a sync works on a copy and keeps it only when it returns. */
function memorySubject(team?: SeedTeam): RetentionSubject & SyncSubject {
  let stored = { state: stateOf({}), outbox: {} as Record<string, Json>, archive: { rows: {}, retired: [] } as MemoryArchive,
    intents: {} as Record<string, SyncIntentRecord & { cancelReason?: 'cancelled'; conclusion?: Conclusion }> };
  seedCollaboration(stored.state, team);
  const facts = { hasIntent: () => false, occurrenceOpen: () => false };
  return {
    scope: 'memory',
    commit(request) {
      const next = structuredClone(stored), rows = memoryStore(next.archive);
      let admitted: AdmittedIds | undefined;
      const result = commitCommand(next.state, request, { scope: 'memory', recordCallbacks: true,
        archived: id => rows.get('commands', id) as CommandRecord | undefined, admitted: ids => { admitted = ids; } }, ports(next.state, publishTo(next.outbox)));
      refuseRetired(admitted, rows.isRetired);
      stored = next;
      return result;
    },
    retain(input, limits) {
      const next = structuredClone(stored), result = retainRoots(next.state, input, limits, facts, memoryStore(next.archive));
      stored = next;
      return result;
    },
    change(edit) { const next = structuredClone(stored); edit(next.state); stored = next; },
    sync() {
      const next = structuredClone(stored), rows = memoryStore(next.archive);
      for (const turn of Object.values(next.state.turns)) {
        const step = syncTurn(next.state, turn, { intent: id => next.intents[id] && { taskId: id, ...pick(next.intents[id]!) }, executionStarted: () => false,
          retired: id => rows.isRetired('turn', id) ? 'turn_retired' : undefined }, SYNC_OPTIONS, publishTo(next.outbox));
        if (step?.kind === 'freeze') next.intents[turn.id] = step.input;
        else if (step?.kind === 'cancel') next.intents[turn.id]!.cancelReason = 'cancelled';
        else if (step?.kind === 'routine') throw new Error('The memory subject has no routines');
      }
      stored = next;
    },
    intent: id => { const row = stored.intents[id]; return row && { key: row.key, source: row.source, waitUntil: row.waitUntil, execution: structuredClone(row.execution) }; },
    concludeIntent(id, conclusion) { const next = structuredClone(stored); next.intents[id]!.conclusion = conclusion; stored = next; },
    projection: id => stored.outbox[id] === undefined ? [] : [structuredClone(stored.outbox[id]!)],
    stored: () => JSON.stringify(stored),
    state: () => structuredClone(stored.state),
  };
}
/** Every row of every table for the tenant, through a separate read handle. */
function tables(file: string, tenant: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const dump: Record<string, unknown> = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>) {
      dump[name] = db.prepare(`SELECT * FROM ${name} WHERE tenant=?`).all(tenant).map(row => JSON.stringify(row)).sort();
    }
    return JSON.stringify(dump);
  } finally { db.close(); }
}
/** The K8 L store: a real SQLite HostLedger. */
function ledgerSubject(team?: SeedTeam): RetentionSubject & SyncSubject & { ledger: HostLedger } {
  const root = mkdtempSync(join(tmpdir(), 'k8-commit-'));
  roots.push(root);
  const file = join(root, 'host.sqlite'), ledger = new HostLedger(file, 'product:commit');
  ledgers.push(ledger);
  ledger.transaction(s => { seedCollaboration(stateOf(s.application), team); });
  return {
    scope: ledger.tenant, ledger,
    commit: request => commitInLedger(ledger, request, (s: LedgerState) => ports(stateOf(s.application), (id, value) => project(s, id, value))),
    retain: (input, limits) => retainInLedger(ledger, input, limits),
    change: edit => { ledger.transaction(s => { edit(stateOf(s.application)); }); },
    // The Host sync loop runs the same function for each Turn.
    sync: () => { ledger.transaction((s, rows) => { for (const turn of Object.values(stateOf(s.application).turns)) syncTurnInLedger(ledger, s, rows, turn, SYNC_OPTIONS); }); },
    concludeIntent: (id, conclusion) => { ledger.transaction(s => { Object.assign(s.intents[hash(id)]!, { phase: 'settled', conclusion }); }); },
    projection: id => Object.values(ledger.snapshot().outbox).flatMap(row => row.kind === 'projection' && row.id === id ? [row.value] : []),
    intent: id => {
      const row = ledger.snapshot().intents[hash(id)];
      return row && { key: row.key, source: row.source as SyncIntentRecord['source'], waitUntil: row.waitUntil, execution: row.execution };
    },
    stored: () => tables(file, ledger.tenant),
    state: () => stateOf(ledger.snapshot().application),
  };
}
/** The L card subject: the ledger subject, whose sync runs the card steps around the Turn steps in L's sync order. */
function cardSubject(): CardSubject {
  const base = ledgerSubject(), ledger = base.ledger;
  return { ...base, sync: now => {
    ledger.transaction((s, rows) => {
      const state = stateOf(s.application);
      expireCards(state, now);
      for (const turn of Object.values(state.turns)) syncTurnInLedger(ledger, s, rows, turn, { ...SYNC_OPTIONS, now });
      reportCardDecisions(state, (id, value) => project(s, id, value));
    });
  } };
}
commitVectors('pure rules in memory', memorySubject);
commitVectors('L HostLedger', ledgerSubject);
retentionVectors('pure rules in memory', memorySubject);
retentionVectors('L HostLedger', ledgerSubject);
syncVectors('pure rules in memory', () => memorySubject());
syncVectors('L HostLedger', () => ledgerSubject());

it('L: a projection identity conflict in a decision leaves the ledger unchanged', () => {
  const subject = ledgerSubject(), card = hash(['task-1', 'confirmable_action', 0]);
  subject.ledger.transaction(s => { project(s, `card:${card}`, { other: true }); });
  const before = subject.stored();
  expect(() => subject.commit({ scope: subject.scope, commandId: 'task-1', command: { kind: 'outcome', turnId: 't1', taskId: 'task-1',
    document: { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] } } })).toThrow('Projection identity conflict');
  expect(subject.stored()).toBe(before);
  expect(stateOf(subject.ledger.snapshot().application).revision).toBeUndefined();
});

it('L: records owner commands only; K4 deduplicates the callbacks', () => {
  const subject = ledgerSubject();
  subject.commit({ scope: subject.scope, commandId: 'i1', command: { kind: 'input', botId: 'main', key: 'k1', request: 'Hello', sender: 'owner' } });
  subject.commit({ scope: subject.scope, commandId: 'task-1', command: { kind: 'outcome', turnId: 't1', taskId: 'task-1', document: {} } });
  const state = stateOf(subject.ledger.snapshot().application);
  expect(state.revision).toBe(2);
  expect(Object.keys(state.commands ?? {})).toEqual(['i1']);
});

it('L: keeps a record for a refused message only; K4 deduplicates an accepted one by its receipt', () => {
  const subject = ledgerSubject();
  const message = (turnId: string, taskId: string, body: string): CommitRequest<Command> => ({ scope: subject.scope, commandId: `${taskId}:m1`,
    command: { kind: 'message', turnId, message: { taskId, payload: { body, messageId: 'm1', contentHash: `sha256:${body}`, contentType: 'text/markdown' } } } });
  const refused = subject.commit(message('absent', 'task-9', 'a'));
  expect(refused).toEqual({ revision: 1, disposition: { outcome: 'refused', reasonCode: 'binding_mismatch' }, outbox: [] });
  // A transport retry replays the refusal and does not move the revision.
  expect(subject.commit(message('absent', 'task-9', 'a'))).toEqual(refused);
  expect(() => subject.commit(message('absent', 'task-9', 'b'))).toThrow(new CommitConflict('identity_conflict', 'message_conflict'));
  expect(subject.commit(message('t1', 'task-1', 'a'))).toEqual({ revision: 2, disposition: { outcome: 'accepted' }, outbox: [] });
  const state = stateOf(subject.ledger.snapshot().application);
  expect(state.revision).toBe(2);
  expect(Object.keys(state.commands ?? {})).toEqual(['task-9:m1']);
});

it('treats a Turn id and an input id as one identity space at admission, and keeps rounds apart', () => {
  const retired = (namespace: string) => (ns: string, id: string) => ns === namespace && id === 'x';
  expect(() => refuseRetired({ turn: [], input: ['x'], round: [] }, retired('turn'))).toThrow(RetiredIdentityError);
  expect(() => refuseRetired({ turn: ['x'], input: [], round: [] }, retired('input'))).toThrow(RetiredIdentityError);
  expect(() => refuseRetired({ turn: [], input: [], round: ['x'] }, retired('turn'))).not.toThrow();
  expect(() => refuseRetired({ turn: ['x'], input: ['x'], round: [] }, retired('round'))).not.toThrow();
});

it('records the root of the input itself when the input also seals an earlier due batch', () => {
  const state = stateOf({});
  seedCollaboration(state);
  const policy = coalescePolicy({ windowMs: 1000 }, 64_000);
  let now = 0;
  const run = (commandId: string, key: string) => commitCommand(state, { scope: 's', commandId,
    command: { kind: 'input', botId: 'main', key, request: key, sender: 'owner' } }, { scope: 's', recordCallbacks: true },
  { ...ports(state, () => {}), now: () => now, admitInput: fields => admitUserInput(state, fields, policy, now) });
  const first = run('c1', 'k1');
  now = 5000;
  // c2 seals k1's due batch, which adds k1's Turn, and opens its own batch.
  const second = run('c2', 'k2');
  const own = (result: typeof first) => (result.disposition as { value: string }).value;
  expect(own(first)).not.toBe(own(second));
  expect(state.turns[own(first)]).toBeDefined();
  expect(state.commands?.c1?.root).toBe(own(first));
  expect(state.commands?.c2?.root).toBe(own(second));
});

/**
 * The L ledger with L's sync order (K8 host.ts `sync`): the Turn steps, then `settleDelegations` on the K8 `intentFacts` adapter.
 * Commands take the intent rows as the L Host's owner commands and outcomes do (host.ts `commitOwner`, `committed`).
 */
function settlementSubject(): SettlementSubject & { ledger: HostLedger } {
  const base = ledgerSubject(), ledger = base.ledger;
  const execution = (s: LedgerState, turnId: string) => s.executions[taskId(turnId, 0)]!;
  return {
    ...base,
    commit: request => commitInLedger(ledger, request, (s: LedgerState) => {
      const own = ports(stateOf(s.application), (id, value) => project(s, id, value));
      return { ...own, intents: intentRows(s), outcome: { ...own.outcome!, committed: intentRows(s) } };
    }),
    settle: (now, timers) => {
      ledger.transaction((s, rows) => {
        const state = stateOf(s.application);
        for (const turn of Object.values(state.turns)) syncTurnInLedger(ledger, s, rows, turn, { ...SYNC_OPTIONS, now });
        settleDelegations(s, state, now, (id, value) => project(s, id, value), timers);
      });
    },
    submit: turnId => { ledger.transaction(s => { execution(s, turnId).submission = 'uncertain'; }); },
    claim: turnId => { ledger.transaction(s => { Object.assign(execution(s, turnId), { submission: 'delivered', started: true }); }); },
    terminal: (turnId, type, payload) => {
      ledger.transaction(s => { execution(s, turnId).terminal = { envelope: { task_id: taskId(turnId, 0), type, payload } } as never; });
    },
    conclude: (turnId, conclusion, cancelReason) => {
      ledger.transaction(s => { Object.assign(s.intents[hash(turnId)]!, { phase: 'settled', conclusion, ...(cancelReason ? { cancelReason } : {}) }); });
    },
  };
}
settlementVectors('L HostLedger', settlementSubject);

/**
 * The L settlement ledger with L's reply check (K8 host.ts `flushReplies`), written out here: each due delegation's chain end
 * intent, the read outside the transaction, then `checkReply` in one ledger transaction.
 */
function replySubject(): ReplySubject {
  const base = settlementSubject(), ledger = base.ledger;
  return {
    ...base,
    checkReplies: async (now, read, timers) => {
      for (const d of Object.values(stateOf(ledger.snapshot().application).delegations)) {
        if (!replyCheckDue(d, now)) continue;
        const intent = ledger.snapshot().intents[hash(d.chainTurnIds.at(-1)!)];
        let check: ReplyCheck = { failed: true };
        if (intent) try {
          check = { taskId: intent.taskId, failed: false, readback: await read(intent.taskId, intent.execution.deviceId, intent.execution.payload.agentRef) };
        } catch { check = { taskId: intent.taskId, failed: true }; }
        ledger.transaction(s => {
          const state = stateOf(s.application);
          checkReply(state, state.delegations[d.id]!, check, now, (id, value) => project(s, id, value), timers?.uncertainAfterMs);
        });
      }
    },
  };
}
replyVectors('L HostLedger', replySubject);

/**
 * The L ledger with L's coalescing (K8 host.ts `commitOwner` and `sync`): the owner commands admit inputs with the policy, and
 * a sync seals the due batches first, runs the Turn steps, and projects the batches last.
 */
function coalesceSubject(policy?: CoalescePolicy): CoalesceSubject {
  const base = ledgerSubject(), ledger = base.ledger;
  return {
    ...base,
    commit: request => commitInLedger(ledger, request, (s: LedgerState) => {
      const state = stateOf(s.application);
      return { ...ports(state, (id, value) => project(s, id, value)), admitInput: fields => admitUserInput(state, fields, policy, VECTOR_NOW) };
    }),
    sync: now => {
      ledger.transaction((s, rows) => {
        const state = stateOf(s.application);
        sealDueBatches(state, policy, now);
        for (const turn of Object.values(state.turns)) syncTurnInLedger(ledger, s, rows, turn, { ...SYNC_OPTIONS, now });
        projectInputBatches(state, (id, value) => project(s, id, value));
      });
    },
  };
}
coalesceVectors('L HostLedger', coalesceSubject);
cardVectors('L HostLedger', cardSubject);

/** The L ledger with L's room step and Turn steps, through the function that K8 host.ts `sync` runs. */
function roomSubject(): RoomSubject {
  const base = ledgerSubject(), ledger = base.ledger;
  return {
    ...base,
    sync: now => {
      ledger.transaction((s, rows) => {
        advanceRoomsAndTurns(s, stateOf(s.application), now, turn => syncTurnInLedger(ledger, s, rows, turn, { ...SYNC_OPTIONS, now }));
      });
    },
    claim: turnId => { ledger.transaction(s => { s.executions[taskId(turnId, 0)]!.started = true; }); },
    cancelReason: turnId => ledger.snapshot().intents[hash(turnId)]?.cancelReason,
  };
}
roomVectors('L HostLedger', roomSubject);
