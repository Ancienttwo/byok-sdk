import { describe, expect, it } from 'vitest';
import { hash } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from './model';
import { outcomeSchema } from './schema';
import { CommitConflict, type CommitRequest, type CommitResult } from './rules/commit';
import type { Command } from './rules/commands';

/**
 * #739 D1 commit contract vectors. Each store runs the same cases: the K8 L ledger now, and the H adapter in D2.
 * A subject starts from `seedCollaboration` and decides at time 1000.
 */
export interface CommitSubject {
  readonly scope: string;
  commit(request: CommitRequest<Command>): CommitResult;
  /** All stored bytes of the store, for the checks that a refused commit changed nothing. */
  stored(): string;
}
export const VECTOR_NOW = 1000;
/** One active Main Bot `main`, its processing Turn `t1` with a frozen schema, an open question `q1` and an expired card `c1`. */
export function seedCollaboration(state: CollaborationState): void {
  state.team.bots.main = { id: 'main', name: 'Main', role: 'Team owner', persona: '', model: 'default', mainBot: true, archived: false,
    revision: '1', readyRevision: '1', execution: template('device', 'main') };
  state.turns.t1 = { id: 't1', root: 't1', botId: 'main', source: 'user', request: 'Work', hop: 0, status: 'processing', authority: 'owner' };
  state.budgets.t1 = { continuation: 0, delegation: 0 };
  state.schemas.t1 = outcomeSchema('main', state, state.turns.t1);
  state.questions.q1 = { id: 'q1', turnId: 't1', value: { question: 'Go?', answerKind: 'text' } };
  state.cards.c1 = { id: 'c1', turnId: 't1', action: { action: 'send_message', summary: 'Send', draft: { text: 'hi' } }, state: 'pending', expiresAt: 0 };
}
const input = (key: string, request = 'Hello'): Extract<Command, { kind: 'input' }> => ({ kind: 'input', botId: 'main', key, request, sender: 'owner' });

export function commitVectors(name: string, open: () => CommitSubject): void {
  describe(`commit contract: ${name}`, () => {
    const request = (subject: CommitSubject, commandId: string, command: Command, expectedRevision?: number): CommitRequest<Command> =>
      ({ scope: subject.scope, commandId, command, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
    const conflict = (subject: CommitSubject, req: CommitRequest<Command>, code: CommitConflict['code'], message?: string) => {
      const before = subject.stored();
      let error: unknown;
      try { subject.commit(req); } catch (cause) { error = cause; }
      expect(error).toBeInstanceOf(CommitConflict);
      expect((error as CommitConflict).code).toBe(code);
      if (message) expect((error as CommitConflict).message).toBe(message);
      expect(subject.stored()).toBe(before);
    };

    it('commits a new command once and returns the same result to a replay', () => {
      const subject = open(), first = subject.commit(request(subject, 'i1', input('k1')));
      expect(first).toEqual({ revision: 1, disposition: { outcome: 'accepted', value: hash(['user', 'main', 'k1']) }, outbox: [] });
      const stored = subject.stored();
      expect(subject.commit(request(subject, 'i1', input('k1')))).toEqual(first);
      expect(subject.stored()).toBe(stored);
    });

    it('replays with the original expected revision after the head moved', () => {
      const subject = open(), first = subject.commit(request(subject, 'i1', input('k1'), 0));
      expect(subject.commit(request(subject, 'i2', input('k2'))).revision).toBe(2);
      expect(subject.commit(request(subject, 'i1', input('k1'), 0))).toEqual(first);
    });

    it('refuses the same command id with other content, and keeps the existing error text', () => {
      const subject = open();
      subject.commit(request(subject, 'i1', input('k1')));
      conflict(subject, request(subject, 'i1', input('k1', 'Other')), 'identity_conflict', 'Input identity conflict');
      subject.commit(request(subject, 'a1', { kind: 'answer', questionId: 'q1', answer: 'Yes' }));
      conflict(subject, request(subject, 'a1', { kind: 'answer', questionId: 'q1', answer: 'No' }), 'identity_conflict', 'Answer identity conflict');
    });

    it('decides on the head without an expected revision, and refuses a stale explicit revision', () => {
      const subject = open();
      expect(subject.commit(request(subject, 'i1', input('k1'))).revision).toBe(1);
      conflict(subject, request(subject, 'i2', input('k2'), 0), 'stale_revision');
      expect(subject.commit(request(subject, 'i2', input('k2'), 1)).revision).toBe(2);
    });

    it('refuses a commit for another scope', () => {
      const subject = open();
      conflict(subject, { ...request(subject, 'i1', input('k1')), scope: `${subject.scope}:other` }, 'scope_mismatch');
    });

    it('keeps no revision, record or outbox row when the decision throws', () => {
      const subject = open(), before = subject.stored();
      expect(() => subject.commit(request(subject, 'i1', { ...input('k1'), botId: 'absent' }))).toThrow('Bot is archived or absent');
      expect(subject.stored()).toBe(before);
      expect(subject.commit(request(subject, 'i1', input('k1'))).revision).toBe(1);
    });

    it('commits a refused disposition and replays it', () => {
      const subject = open(), decide: Command = { kind: 'decide', cardId: 'c1', decision: 'confirmed' };
      const first = subject.commit(request(subject, 'd1', decide));
      expect(first).toEqual({ revision: 1, disposition: { outcome: 'refused', reasonCode: 'card_expired', reason: 'Card expired' }, outbox: [] });
      expect(subject.commit(request(subject, 'd1', decide))).toEqual(first);
      conflict(subject, request(subject, 'd1', { ...decide, decision: 'rejected' }), 'identity_conflict', 'Card expired');
    });

    it('keys each record by its own command id, also for `constructor` and `__proto__`', () => {
      const subject = open();
      for (const [index, id] of ['constructor', 'toString', '__proto__'].entries()) {
        const first = subject.commit(request(subject, id, input(`k${index}`)));
        expect(first.revision).toBe(index + 1);
        const stored = subject.stored();
        expect(subject.commit(request(subject, id, input(`k${index}`)))).toEqual(first);
        expect(subject.stored()).toBe(stored);
      }
    });

    it('returns the outbox rows that the commit wrote', () => {
      const subject = open(), card = hash(['task-1', 'confirmable_action', 0]);
      const result = subject.commit(request(subject, 'task-1', { kind: 'outcome', turnId: 't1', taskId: 'task-1',
        document: { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] } }));
      expect(result).toEqual({ revision: 1, disposition: { outcome: 'accepted' }, outbox: [{ kind: 'projection', id: `card:${card}` }] });
    });
  });
}
