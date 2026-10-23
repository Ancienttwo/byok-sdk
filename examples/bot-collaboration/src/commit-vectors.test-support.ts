import { describe, expect, it } from 'vitest';
import { hash } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from './model';
import { outcomeSchema } from './schema';
import { CommitConflict, type CommitRequest, type CommitResult } from './rules/commit';
import type { Command } from './rules/commands';
import { TeamModeError, type TeamSnapshotBot } from './rules/team';

/**
 * #739 D1 commit contract vectors. Each store runs the same cases: the K8 L ledger now, and the H adapter in D2.
 * A subject may be async: the H adapter commits through Postgres. A sync throw and a rejection are the same failure.
 * A subject starts from `seedCollaboration` and decides at time 1000.
 */
export interface CommitSubject {
  readonly scope: string;
  commit(request: CommitRequest<Command>): CommitResult | Promise<CommitResult>;
  /** All stored bytes of the store, for the checks that a refused commit changed nothing. */
  stored(): string | Promise<string>;
  /** A copy of the stored collaboration state. */
  state(): CollaborationState | Promise<CollaborationState>;
}
export const VECTOR_NOW = 1000;
/**
 * One active Main Bot `main`, its processing Turn `t1` with a frozen schema, an open question `q1` and an expired card `c1`.
 * `external`: the team authority owns the Bots, and its team revision 1 holds `main`.
 */
export type SeedTeam = 'local' | 'external';
export function seedCollaboration(state: CollaborationState, team: SeedTeam = 'local'): void {
  state.team.bots.main = { id: 'main', name: 'Main', role: 'Team owner', persona: '', model: 'default', mainBot: true, archived: false,
    revision: '1', readyRevision: '1', execution: template('device', 'main') };
  state.turns.t1 = { id: 't1', root: 't1', botId: 'main', source: 'user', request: 'Work', hop: 0, status: 'processing', authority: 'owner' };
  state.budgets.t1 = { continuation: 0, delegation: 0 };
  state.schemas.t1 = outcomeSchema('main', state, state.turns.t1);
  state.questions.q1 = { id: 'q1', turnId: 't1', value: { question: 'Go?', answerKind: 'text' } };
  state.cards.c1 = { id: 'c1', turnId: 't1', action: { action: 'send_message', summary: 'Send', draft: { text: 'hi' } }, state: 'pending', expiresAt: 0 };
  if (team === 'external') state.team.external = { revision: 1 };
}
const input = (key: string, request = 'Hello'): Extract<Command, { kind: 'input' }> => ({ kind: 'input', botId: 'main', key, request, sender: 'owner' });

/** Runs `work` so that a sync throw and a rejection both reject. */
const settle = async <T>(work: () => T | Promise<T>): Promise<T> => work();
export function commitVectors(name: string, open: (team?: SeedTeam) => CommitSubject | Promise<CommitSubject>): void {
  describe(`commit contract: ${name}`, () => {
    const request = (subject: CommitSubject, commandId: string, command: Command, expectedRevision?: number): CommitRequest<Command> =>
      ({ scope: subject.scope, commandId, command, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
    const conflict = async (subject: CommitSubject, req: CommitRequest<Command>, code: CommitConflict['code'], message?: string) => {
      const before = await subject.stored();
      let error: unknown;
      try { await subject.commit(req); } catch (cause) { error = cause; }
      expect(error).toBeInstanceOf(CommitConflict);
      expect((error as CommitConflict).code).toBe(code);
      if (message) expect((error as CommitConflict).message).toBe(message);
      expect(await subject.stored()).toBe(before);
    };

    it('commits a new command once and returns the same result to a replay', async () => {
      const subject = await open(), first = await subject.commit(request(subject, 'i1', input('k1')));
      expect(first).toEqual({ revision: 1, disposition: { outcome: 'accepted', value: hash(['user', 'main', 'k1']) }, outbox: [] });
      const stored = await subject.stored();
      expect(await subject.commit(request(subject, 'i1', input('k1')))).toEqual(first);
      expect(await subject.stored()).toBe(stored);
    });

    it('replays with the original expected revision after the head moved', async () => {
      const subject = await open(), first = await subject.commit(request(subject, 'i1', input('k1'), 0));
      expect((await subject.commit(request(subject, 'i2', input('k2')))).revision).toBe(2);
      expect(await subject.commit(request(subject, 'i1', input('k1'), 0))).toEqual(first);
    });

    it('refuses the same command id with other content, and keeps the existing error text', async () => {
      const subject = await open();
      await subject.commit(request(subject, 'i1', input('k1')));
      await conflict(subject, request(subject, 'i1', input('k1', 'Other')), 'identity_conflict', 'Input identity conflict');
      await subject.commit(request(subject, 'a1', { kind: 'answer', questionId: 'q1', answer: 'Yes' }));
      await conflict(subject, request(subject, 'a1', { kind: 'answer', questionId: 'q1', answer: 'No' }), 'identity_conflict', 'Answer identity conflict');
    });

    it('decides on the head without an expected revision, and refuses a stale explicit revision', async () => {
      const subject = await open();
      expect((await subject.commit(request(subject, 'i1', input('k1')))).revision).toBe(1);
      await conflict(subject, request(subject, 'i2', input('k2'), 0), 'stale_revision');
      expect((await subject.commit(request(subject, 'i2', input('k2'), 1))).revision).toBe(2);
    });

    it('refuses a commit for another scope', async () => {
      const subject = await open();
      await conflict(subject, { ...request(subject, 'i1', input('k1')), scope: `${subject.scope}:other` }, 'scope_mismatch');
    });

    it('keeps no revision, record or outbox row when the decision throws', async () => {
      const subject = await open(), before = await subject.stored();
      await expect(settle(() => subject.commit(request(subject, 'i1', { ...input('k1'), botId: 'absent' })))).rejects.toThrow('Bot is archived or absent');
      expect(await subject.stored()).toBe(before);
      expect((await subject.commit(request(subject, 'i1', input('k1')))).revision).toBe(1);
    });

    it('commits a refused disposition and replays it', async () => {
      const subject = await open(), decide: Command = { kind: 'decide', cardId: 'c1', decision: 'confirmed' };
      const first = await subject.commit(request(subject, 'd1', decide));
      expect(first).toEqual({ revision: 1, disposition: { outcome: 'refused', reasonCode: 'card_expired', reason: 'Card expired' }, outbox: [] });
      expect(await subject.commit(request(subject, 'd1', decide))).toEqual(first);
      await conflict(subject, request(subject, 'd1', { ...decide, decision: 'rejected' }), 'identity_conflict', 'Card expired');
    });

    it('applies a keyless command at each call, adds 1 each time and keeps no record (#739 6a)', async () => {
      const subject = await open(), command: Command = { kind: 'set_main_bot', botId: 'main', mainBot: true };
      await subject.commit(request(subject, 'i1', input('k1')));
      expect(await subject.commit(request(subject, 'm1', command))).toEqual({ revision: 2, disposition: { outcome: 'accepted' }, outbox: [] });
      expect((await subject.commit(request(subject, 'm1', command))).revision).toBe(3);
      expect(Object.keys((await subject.state()).commands ?? {})).toEqual(['i1']);
    });

    it('protects a keyless retry only with an explicit expected revision', async () => {
      const subject = await open(), command: Command = { kind: 'set_main_bot', botId: 'main', mainBot: false };
      expect((await subject.commit(request(subject, 'm1', command, 0))).revision).toBe(1);
      // No record: the retry is a new commit, and the first commit moved the head.
      await conflict(subject, request(subject, 'm1', command, 0), 'stale_revision');
      expect((await subject.commit(request(subject, 'm1', command, 1))).revision).toBe(2);
    });

    it('keys each record by its own command id, also for `constructor` and `__proto__`', async () => {
      const subject = await open();
      for (const [index, id] of ['constructor', 'toString', '__proto__'].entries()) {
        const first = await subject.commit(request(subject, id, input(`k${index}`)));
        expect(first.revision).toBe(index + 1);
        const stored = await subject.stored();
        expect(await subject.commit(request(subject, id, input(`k${index}`)))).toEqual(first);
        expect(await subject.stored()).toBe(stored);
      }
    });

    const main = { id: 'main', name: 'Main', role: 'Team owner', mainBot: true };
    const team = (revision: number, ...bots: Array<Partial<TeamSnapshotBot> & { id: string }>): [string, Command] => [hash(['team', revision]),
      { kind: 'team_snapshot', snapshot: { revision, bots: bots.map(bot => ({ name: bot.id, role: 'Helper', persona: '', model: 'default', mainBot: false, ...bot })) } }];
    const teamError = async (work: () => unknown) => {
      try { await work(); } catch (cause) { return cause instanceof TeamModeError ? cause.code : cause; }
      return 'no error';
    };

    it('applies a newer team snapshot: archives a missing Bot, adds a new one and queues a projection for a changed one (#739 Q4c)', async () => {
      const subject = await open('external');
      await subject.commit(request(subject, ...team(2, main, { id: 'b2' })));
      expect(await subject.commit(request(subject, ...team(3, { ...main, persona: 'New' })))).toEqual({ revision: 2, disposition: { outcome: 'accepted' }, outbox: [] });
      const state = (await subject.state());
      expect(state.team.external).toEqual({ revision: 3 });
      expect(state.team.bots.b2).toMatchObject({ archived: true, mainBot: false, revision: '1', readyRevision: null });
      expect(state.team.bots.main).toMatchObject({ archived: false, mainBot: true, persona: 'New', revision: '2', readyRevision: null });
      expect(state.team.homeOperations.map(op => [op.botId, op.request.payload.agentRef.profileRevision])).toEqual([['b2', '1'], ['main', '2']]);
    });

    it('replays a team revision with the same Bots in any order, and refuses other Bots for it', async () => {
      const subject = await open('external'), first = await subject.commit(request(subject, ...team(2, main, { id: 'b2' })));
      const stored = await subject.stored();
      expect(await subject.commit(request(subject, ...team(2, { id: 'b2' }, main)))).toEqual(first);
      expect(await subject.stored()).toBe(stored);
      await conflict(subject, request(subject, ...team(2, main)), 'identity_conflict', 'Team snapshot identity conflict');
    });

    it('refuses a team revision that is not newer with stale_team, after a replay check', async () => {
      const subject = await open('external'), applied = await subject.commit(request(subject, ...team(2, main)));
      await subject.commit(request(subject, ...team(4, main)));
      // A replay comes first: an exact retry of the applied revision 2 gets its first result.
      expect(await subject.commit(request(subject, ...team(2, main)))).toEqual(applied);
      expect(await subject.commit(request(subject, ...team(3, main)))).toEqual({ revision: 3,
        disposition: { outcome: 'refused', reasonCode: 'stale_team', reason: 'stale_team: team revision 3 is not newer than 4' }, outbox: [] });
      // The seed holds revision 1 with no command record.
      expect((await subject.commit(request(subject, ...team(1, main)))).disposition).toMatchObject({ reasonCode: 'stale_team' });
      expect((await subject.state()).team.external).toEqual({ revision: 4 });
    });

    it('changes nothing for an invalid team snapshot, a returning archived Bot or setMainBot in external mode', async () => {
      const subject = await open('external'), before = await subject.stored();
      await expect(settle(() => subject.commit(request(subject, ...team(2, main, main))))).rejects.toThrow('Duplicate team snapshot Bot');
      for (const id of ['__proto__', 'constructor', 'team/helper', 'CON', 'tab\there', 'x'.repeat(300)]) {
        await expect(settle(() => subject.commit(request(subject, ...team(2, main, { id }))))).rejects.toThrow('Invalid team snapshot Bot id');
      }
      await expect(settle(() => subject.commit(request(subject, ...team(2, main, { id: 'b2', persona: 'x'.repeat(70_000) })))))
        .rejects.toThrow('Team snapshot Bot projection is too large');
      await expect(settle(() => subject.commit(request(subject, ...team(2, { ...main, model: 'absent' }))))).rejects.toThrow('Unavailable model');
      expect(await teamError(() => subject.commit(request(subject, 'm1', { kind: 'set_main_bot', botId: 'main', mainBot: false })))).toBe('external_team');
      expect(await subject.stored()).toBe(before);
      await subject.commit(request(subject, ...team(2, main, { id: 'b2' })));
      await subject.commit(request(subject, ...team(3, main)));
      const archived = await subject.stored();
      await expect(settle(() => subject.commit(request(subject, ...team(4, main, { id: 'b2' }))))).rejects.toThrow('An archived Bot cannot return');
      expect(await subject.stored()).toBe(archived);
    });

    it('refuses a team snapshot for a local team', async () => {
      const subject = await open(), before = await subject.stored();
      await expect(settle(() => subject.commit(request(subject, ...team(1, main))))).rejects.toThrow('Team snapshots need the external team mode');
      expect(await subject.stored()).toBe(before);
    });

    it('returns the outbox rows that the commit wrote', async () => {
      const subject = await open(), card = hash(['task-1', 'confirmable_action', 0]);
      const result = await subject.commit(request(subject, 'task-1', { kind: 'outcome', turnId: 't1', taskId: 'task-1',
        document: { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] } }));
      expect(result).toEqual({ revision: 1, disposition: { outcome: 'accepted' }, outbox: [{ kind: 'projection', id: `card:${card}` }] });
    });
  });
}
