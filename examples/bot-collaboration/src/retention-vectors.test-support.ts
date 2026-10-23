import { describe, expect, it } from 'vitest';
import { hash, MIN_TOMBSTONE_RETENTION_MS } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from './model';
import type { CommitRequest } from './rules/commit';
import { RetiredIdentityError, type Command } from './rules/commands';
import { RetentionRefused, type RetentionInput, type RetentionLimits, type RetentionResult } from './retention';
import type { CommitSubject } from './commit-vectors.test-support';

/**
 * #798 retention vectors. Each store runs the same cases: the memory rules and the K8 L ledger now, the H adapter in D2.
 * A subject starts from `seedCollaboration`. The cases see only `commit`, `retain`, `state` and `stored`, not the row layout.
 */
export interface RetentionSubject extends CommitSubject {
  retain(input: RetentionInput, limits: RetentionLimits): RetentionResult | Promise<RetentionResult>;
  /** Writes the stored collaboration state directly, as the Host's passes do. */
  change(edit: (state: CollaborationState) => void): void | Promise<void>;
}
export const RETENTION_NOW = 10_000;
const LIMITS: RetentionLimits = { contextTurnLimit: 1 };
const input = (key: string): Extract<Command, { kind: 'input' }> => ({ kind: 'input', botId: 'main', key, request: 'Hello', sender: 'owner' });
/** A settled Turn `id` of Bot `main` that is its own root, with an answered question and a reported card. */
function settledRoot(state: CollaborationState, id: string): void {
  state.turns[id] = { id, root: id, botId: 'main', source: 'user', request: id, hop: 0, status: 'succeeded', conclusion: 'succeeded', reported: true, authority: 'owner' };
  state.budgets[id] = { continuation: 0, delegation: 0 };
  state.questions[`${id}:q`] = { id: `${id}:q`, turnId: id, value: { question: 'Go?', answerKind: 'text' }, answer: 'yes' };
  state.cards[`${id}:c`] = { id: `${id}:c`, turnId: id, action: { action: 'send_message', summary: 'Send', draft: { text: 'hi' } },
    state: 'expired', expiresAt: 0, decisionReported: true };
  state.rejected.push({ botId: 'main', taskId: `${id}:task`, action: 'delegate', reason: 'hop_limit', consumedBy: id });
}
/** Removes the seed's open rows, so only the cases' roots decide. */
function clearSeed(state: CollaborationState): void {
  delete state.turns.t1; delete state.budgets.t1; delete state.schemas.t1; delete state.questions.q1; delete state.cards.c1;
}
const settle = async <T>(work: () => T | Promise<T>): Promise<T> => work();

export function retentionVectors(name: string, open: () => RetentionSubject | Promise<RetentionSubject>): void {
  describe(`retention contract: ${name}`, () => {
    const request = (subject: CommitSubject, commandId: string, command: Command): CommitRequest<Command> => ({ scope: subject.scope, commandId, command });
    const retain = (subject: RetentionSubject, roots: string[], fields: Partial<RetentionInput> = {}, limits = LIMITS) =>
      settle(() => subject.retain({ acknowledgedRoots: roots, now: RETENTION_NOW, retentionMs: MIN_TOMBSTONE_RETENTION_MS, ...fields }, limits));
    /** A refused call changes no stored byte. */
    const refused = async (subject: RetentionSubject, run: () => Promise<unknown>, check: (error: unknown) => void) => {
      const before = await subject.stored();
      let error: unknown;
      try { await run(); } catch (cause) { error = cause; }
      check(error);
      expect(await subject.stored()).toBe(before);
    };
    const opened = async () => {
      const subject = await open();
      await subject.change(state => { clearSeed(state); settledRoot(state, 'r1'); settledRoot(state, 'r2'); });
      return subject;
    };

    it('moves a settled root out of the state and counts a repeated root harmlessly', async () => {
      const subject = await opened();
      const result = await retain(subject, ['r1']);
      expect(result).toMatchObject({ archivedRoots: 1, alreadyArchivedRoots: 0 });
      expect(result.archivedRows).toBeGreaterThanOrEqual(5);
      expect(result.afterBytes).toBeLessThan(result.beforeBytes);
      const state = await subject.state();
      expect(state.turns.r1).toBeUndefined(); expect(state.budgets.r1).toBeUndefined();
      expect(state.questions['r1:q']).toBeUndefined(); expect(state.cards['r1:c']).toBeUndefined();
      expect(state.rejected.map(row => row.consumedBy)).toEqual(['r2']);
      expect(state.turns.r2).toBeDefined();
      expect(await retain(subject, ['r1'])).toMatchObject({ archivedRoots: 0, alreadyArchivedRoots: 1 });
    });

    it('refuses a short retention, an unknown root and a room seat, and changes nothing', async () => {
      const subject = await opened();
      await refused(subject, () => retain(subject, ['r1'], { retentionMs: MIN_TOMBSTONE_RETENTION_MS - 1 }),
        error => expect((error as Error).message).toBe('Retention must be at least seven days'));
      await refused(subject, () => retain(subject, ['r1', 'missing']), error => expect((error as Error).message).toBe('Acknowledged root not found'));
      await subject.change(state => {
        state.team.rooms.room = { id: 'room', name: 'Room', members: ['main'], visibleFrom: { main: 0 }, mode: 'mention', announcement: '', messages: [] };
        state.team.rounds.round = { id: 'round', root: 'round', roomId: 'room', input: '{}', seats: ['seat'], limit: 5, counts: { main: 1 }, closed: true };
        state.team.seats.seat = { id: 'seat', roundId: 'round', botId: 'main', status: 'post', released: true, late: false };
      });
      await refused(subject, () => retain(subject, ['seat']), error => {
        expect(error).toBeInstanceOf(RetentionRefused);
        expect(error).toMatchObject({ code: 'protected_root', root: 'seat', message: 'Retention refused: The Turn is a room seat of root round' });
      });
    });

    it('refuses each root that is still in use, and changes nothing', async () => {
      const cases: Array<[string, (state: CollaborationState) => void, string, RetentionLimits?]> = [
        ['an open Turn', state => { state.turns.r1!.status = 'processing'; delete state.turns.r1!.conclusion; }, 'A Turn of the root is not concluded'],
        ['an open question', state => { delete state.questions['r1:q']!.answer; }, 'A question of the root is unanswered'],
        ['a pending card', state => { state.cards['r1:c']!.state = 'pending'; }, 'A card of the root is not settled'],
        ['an unreported card', state => { delete state.cards['r1:c']!.decisionReported; }, 'A card of the root is not settled'],
        ['a delegation without a verdict', state => {
          state.delegations.d = { id: 'd', root: 'r1', fromBotId: 'main', fromTurnId: 'r1', fromTaskId: 'r1:task', index: 0, toBotId: 'main', request: '',
            hop: 1, chainTurnIds: [], batch: 'b', status: 'running', revision: 0 };
        }, 'A delegation of the root is unresolved'],
        ['a reserved unit', state => { state.units.u = { id: 'u', root: 'r1', state: 'reserved' }; }, 'A budget unit of the root is reserved'],
        ['the ContextPack window', () => {}, 'The root is in the ContextPack window of its Bot', { contextTurnLimit: 2 }],
      ];
      for (const [label, edit, reason, limits] of cases) {
        const subject = await opened();
        await subject.change(edit);
        await refused(subject, () => retain(subject, ['r1'], {}, limits ?? LIMITS), error => {
          expect(error, label).toBeInstanceOf(RetentionRefused);
          expect((error as RetentionRefused).message, label).toBe(`Retention refused: ${reason}`);
        });
      }
      // The newest root is in the window too.
      const subject = await opened();
      await refused(subject, () => retain(subject, ['r2']), error => expect((error as Error).message).toBe('Retention refused: The root is in the ContextPack window of its Bot'));
    });

    it('replays a moved command record, and refuses a retired Turn id at admission until the end', async () => {
      const subject = await opened();
      const first = await subject.commit(request(subject, 'i1', input('k1')));
      const turnId = hash(['user', 'main', 'k1']);
      await subject.change(state => {
        Object.assign(state.turns[turnId]!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
        settledRoot(state, 'r3');
      });
      expect(await retain(subject, [turnId])).toMatchObject({ archivedRoots: 1, archivedCommands: 1 });
      expect((await subject.state()).commands?.i1).toBeUndefined();
      expect(await subject.commit(request(subject, 'i1', input('k1')))).toEqual(first);
      for (let attempt = 0; attempt < 2; attempt++) {
        await refused(subject, () => settle(() => subject.commit(request(subject, 'i2', input('k1')))), error => {
          expect(error).toBeInstanceOf(RetiredIdentityError);
          expect(error).toMatchObject({ code: 'retired_identity', namespace: 'turn', id: turnId });
        });
      }
      // After its window the record expires. The retry decides again and meets the Turn tombstone.
      expect(await retain(subject, [], { now: RETENTION_NOW + MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ expiredCommands: 1 });
      await refused(subject, () => settle(() => subject.commit(request(subject, 'i1', input('k1')))), error => expect(error).toBeInstanceOf(RetiredIdentityError));
    });

    it('keeps the record of a command whose root is still in the state', async () => {
      const subject = await opened();
      await subject.commit(request(subject, 'i1', input('k1')));
      await retain(subject, ['r1']);
      expect(Object.keys((await subject.state()).commands ?? {})).toEqual(['i1']);
    });
  });
}
