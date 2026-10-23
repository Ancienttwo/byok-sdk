import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { canonical, hash, HostLedger, project, type Json, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { stateOf, type CollaborationState } from './model';
import { admitUserInput } from './coalesce';
import { CommitConflict, commitInLedger, type CommitRequest } from './commit';
import { commitCommand, type Command, type CommandPorts } from './rules/commands';
import { commitVectors, seedCollaboration, VECTOR_NOW, type CommitSubject } from './commit-vectors.test-support';

const roots: string[] = [], ledgers: HostLedger[] = [];
// Windows cannot delete an open SQLite file, so each ledger closes first.
afterAll(() => {
  for (const ledger of ledgers) ledger.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function ports(state: CollaborationState, publish: CommandPorts['publish']): CommandPorts {
  return { now: () => VECTOR_NOW, publish, admitInput: fields => admitUserInput(state, fields, undefined, VECTOR_NOW),
    outcome: { committed: { intent: () => undefined }, manage: () => {}, createRoutine: () => {}, updateRoutine: () => {}, cancelRoutine: () => {} } };
}
/** The pure rules on a plain object. A commit works on a copy and keeps it only when it returns. */
function memorySubject(): CommitSubject {
  let stored = { state: stateOf({}), outbox: {} as Record<string, Json> };
  seedCollaboration(stored.state);
  return {
    scope: 'memory',
    commit(request) {
      const next = structuredClone(stored);
      const result = commitCommand(next.state, request, { scope: 'memory', recordCallbacks: true }, ports(next.state, (id, value) => {
        if (next.outbox[id] !== undefined && canonical(next.outbox[id]) !== canonical(value)) throw new Error('Projection identity conflict');
        next.outbox[id] = value;
      }));
      stored = next;
      return result;
    },
    stored: () => JSON.stringify(stored),
    state: () => structuredClone(stored.state),
  };
}
/** The K8 L store: a real SQLite HostLedger. */
function ledgerSubject(): CommitSubject & { ledger: HostLedger } {
  const root = mkdtempSync(join(tmpdir(), 'k8-commit-'));
  roots.push(root);
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'product:commit');
  ledgers.push(ledger);
  ledger.transaction(s => { seedCollaboration(stateOf(s.application)); });
  return {
    scope: ledger.tenant, ledger,
    commit: request => commitInLedger(ledger, request, (s: LedgerState) => ports(stateOf(s.application), (id, value) => project(s, id, value))),
    stored: () => JSON.stringify(ledger.snapshot()),
    state: () => stateOf(ledger.snapshot().application),
  };
}
commitVectors('pure rules in memory', memorySubject);
commitVectors('L HostLedger', ledgerSubject);

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
