import { describe, expect, it } from 'vitest';
import { hash, taskId, type ExecutionTemplate } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from './model';
import { outcomeSchema } from './schema';
import { CommitConflict, type CommitRequest, type CommitResult } from './rules/commit';
import type { Command } from './rules/commands';
import { TeamModeError, type TeamSnapshotBot } from './rules/team';
import { BOT_TURN_OUTCOME_CONTRACT } from '@byok-sdk/protocol';
import { OFFER_WAIT_MS, syncTurn, type SyncFacts, type SyncOptions, type SyncStep } from './rules/sync';
import type { Conclusion, DelegationTimers, ReplyReadback } from './rules/delegation';
import type { Json } from './rules/turn';
import type { CoalescePolicy } from './rules/coalesce';
import { ROOM_GRACE_MS, roomFields, roomInput, type Seat } from './rules/rooms';

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

/**
 * #793 D2b: the sync step as a store operation. The store runs `syncTurn` for each stored Turn, in insertion order, in one
 * transaction under the same scope lock as `commit`, with the options below. It writes each returned step: a `freeze` stores
 * its intent input as it is. The projections that the step publishes reach the store's outbox in the same transaction.
 * A projection with the same id and the same body adds nothing; another body for that id throws `Projection identity conflict`.
 * It writes no command record and keeps the revision. A sync is the Host's own work, so a client's expected revision must
 * not go stale because of it. The store reads the facts inside the sync transaction. A Host sync can run other steps in the
 * same transaction before and after the per-Turn steps, as L does; this contract defines only the per-Turn step.
 */
export interface SyncSubject extends CommitSubject {
  /** A test edit of the stored state, outside the contract. */
  change(edit: (state: CollaborationState) => void): void | Promise<void>;
  sync(): void | Promise<void>;
  /** The stored intent input of a Turn. */
  intent(turnId: string): SyncIntentRecord | undefined | Promise<SyncIntentRecord | undefined>;
  /** A test edit: the store settles the intent of a Turn with this conclusion, outside the contract. */
  concludeIntent(turnId: string, conclusion: Conclusion): void | Promise<void>;
  /** The values of the stored outbox rows with this projection id. */
  projection(id: string): Json[] | Promise<Json[]>;
}
export type SyncIntentRecord = Extract<SyncStep<unknown>, { kind: 'freeze' }>['input'];
/** The sync options of the vectors. A Bot with an undeclared connector toolset cannot freeze. */
export const SYNC_OPTIONS: SyncOptions<never> = { now: VECTOR_NOW, models: ['default'], readOnlyToolsets: [],
  limits: { turnLimit: 12, contextMaxBytes: 32_768, instructionMaxBytes: 65_536 }, historyMode: false, routines: [] };
/**
 * `t1` is concluded and reported. `q1` (a user Turn) and `q2` (a continuation) wait for an offer. Card `c1` stays pending,
 * so a store that runs the card steps in its sync (`cardVectors`) changes nothing these vectors read.
 */
function seedSync(state: CollaborationState): void {
  Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
  state.cards.c1!.expiresAt = Number.MAX_SAFE_INTEGER;
  state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'queued', authority: 'owner' };
  state.turns.q2 = { id: 'q2', root: 'q1', botId: 'main', source: 'continuation', request: 'Next', hop: 0, status: 'queued', authority: 'owner' };
}
const NO_FACTS: SyncFacts = { intent: () => undefined, executionStarted: () => false, retired: () => undefined };
export function syncVectors(name: string, open: () => SyncSubject | Promise<SyncSubject>): void {
  describe(`sync contract: ${name}`, () => {
    const seeded = async () => { const subject = await open(); await subject.change(seedSync); return subject; };

    it('stores the frozen intent input as the rule returns it, with no command record and no revision change', async () => {
      const subject = await seeded(), before = await subject.state();
      const expected = structuredClone(before), step = syncTurn(expected, expected.turns.q1!, NO_FACTS, SYNC_OPTIONS, () => {});
      await subject.sync();
      const after = await subject.state();
      expect(step).toMatchObject({ kind: 'freeze' });
      expect(await subject.intent('q1')).toEqual((step as Extract<typeof step, { kind: 'freeze' }>).input);
      expect(await subject.intent('q1')).toMatchObject({ key: 'q1', source: 'user', waitUntil: VECTOR_NOW + OFFER_WAIT_MS,
        execution: { payload: { terminalProjection: { mode: 'result-document', contract: BOT_TURN_OUTCOME_CONTRACT, schema: after.schemas.q1 } } } });
      expect(await subject.intent('q2')).toMatchObject({ key: 'q2', source: 'bot' });
      expect(await subject.intent('t1')).toBeUndefined();
      expect([after.turns.q1!.status, after.turns.q2!.status]).toEqual(['processing', 'processing']);
      expect([after.revision, after.commands]).toEqual([before.revision, before.commands]);
    });

    it('changes no stored byte at a second sync', async () => {
      const subject = await seeded();
      await subject.sync();
      const stored = await subject.stored();
      await subject.sync();
      expect(await subject.stored()).toBe(stored);
    });

    it('keeps the expected revision of a client valid across a sync', async () => {
      const subject = await seeded(), revision = (await subject.state()).revision ?? 0;
      await subject.sync();
      const result = await subject.commit({ scope: subject.scope, commandId: 'i1', command: input('k1'), expectedRevision: revision });
      expect(result.revision).toBe(revision + 1);
    });

    it('writes the report of a concluded intent to the outbox once, at the same revision', async () => {
      const subject = await seeded();
      await subject.sync();
      await subject.concludeIntent('q1', 'succeeded');
      const revision = (await subject.state()).revision;
      expect(await subject.projection('bot-turn:q1')).toEqual([]);
      await subject.sync();
      expect(await subject.projection('bot-turn:q1')).toEqual([expect.objectContaining({ owner: 'main', id: 'q1', status: 'succeeded',
        conclusion: 'succeeded' })]);
      const after = await subject.state();
      expect([after.turns.q1!.status, after.turns.q1!.reported, after.revision]).toEqual(['succeeded', true, revision]);
      const stored = await subject.stored();
      await subject.sync();
      expect(await subject.stored()).toBe(stored);
    });

    it('writes nothing when a later Turn of the same sync throws', async () => {
      const subject = await seeded();
      await subject.change(state => {
        const base = template('device', 'b2');
        state.team.bots.b2 = { ...state.team.bots.main!, id: 'b2', name: 'B2', mainBot: false,
          execution: { ...base, payload: { ...base.payload, requiredToolsets: ['github'] } } };
        state.turns.q3 = { id: 'q3', root: 'q3', botId: 'b2', source: 'user', request: 'Tools', hop: 0, status: 'queued', authority: 'owner' };
      });
      const before = await subject.stored();
      await expect(settle(() => subject.sync())).rejects.toThrow('not declared read-only by the Host: github');
      expect(await subject.stored()).toBe(before);
      expect(await subject.intent('q1')).toBeUndefined();
    });
  });
}

/**
 * #793 D2f-5: the delegation settlement of the Host sync. `settle` is one Host sync: the per-Turn steps of the sync contract,
 * then K8 `settleDelegations` on the store's own intent facts, as L's sync runs it after the Turn steps. A store may run more
 * rounds in one sync, and it may deliver a cancel fact to K4 in it; these vectors sync until nothing changes, and they end a
 * cancelled target with `conclude`, as the K4 drain or the reconciliation would. The fact edits are outside the contract:
 * each one writes the K4 evidence in the store's own shape, and the store's adapter reads the facts from it.
 */
export interface SettlementSubject extends SyncSubject {
  settle(now: number, timers?: DelegationTimers): void | Promise<void>;
  /** A test edit: the first attempt of the Turn's intent was submitted, with no claim. */
  submit(turnId: string): void | Promise<void>;
  /** A test edit: a device claimed the first attempt (K4 `Execution.started`). */
  claim(turnId: string): void | Promise<void>;
  /** A test edit: the device terminal of the first attempt. */
  terminal(turnId: string, type: string, payload: Json): void | Promise<void>;
  /** A test edit: the intent concludes, with the K4 cancel reason when one is given. */
  conclude(turnId: string, conclusion: Conclusion, cancelReason?: 'cancelled' | 'expired'): void | Promise<void>;
}
/** The settlement vectors' steps on the subjects that `open` gives. */
function settlementSteps<Subject extends SettlementSubject>(open: () => Subject | Promise<Subject>) {
  /** Syncs until a sync writes nothing. */
  const settled = async (subject: SettlementSubject, now = VECTOR_NOW, timers?: DelegationTimers) => {
    for (let round = 0; round < 5; round++) {
      const before = await subject.stored();
      await subject.settle(now, timers);
      if (await subject.stored() === before) return;
    }
    throw new Error('The sync does not settle');
  };
  let commands = 0;
  const commit = async (subject: SettlementSubject, command: Command) => {
    const result = await subject.commit({ scope: subject.scope, commandId: `settle-${++commands}`, command });
    if (result.disposition.outcome !== 'accepted') throw new Error(`Refused ${command.kind}: ${JSON.stringify(result.disposition)}`);
    return (result.disposition as { value?: unknown }).value;
  };
  /** An owner Turn of the Main Bot that ends with `document` as its outcome. */
  const owner = async (subject: SettlementSubject, key: string, document: Json) => {
    const turnId = await commit(subject, { kind: 'input', botId: 'main', key, request: key, sender: 'owner' }) as string;
    await settled(subject);
    await commit(subject, { kind: 'outcome', turnId, taskId: taskId(turnId, 0), document });
    await subject.terminal(turnId, 'task.complete', { document });
    await subject.conclude(turnId, 'succeeded');
    await settled(subject);
    return turnId;
  };
  /** The Main Bot delegated to Bot `b`, and B's request Turn froze. Returns the delegation id, which is also that Turn's id. */
  const delegated = async () => {
    const subject = await open();
    await subject.change(state => {
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.team.bots.b = { ...state.team.bots.main!, id: 'b', name: 'B', role: 'Reviewer', mainBot: false, execution: template('device', 'b') };
    });
    const root = await owner(subject, 'r1', { delegate: [{ to: 'b', request: 'Check' }] });
    const id = hash([taskId(root, 0), 'delegate', 0]);
    expect(await subject.intent(id)).toMatchObject({ key: id });
    return { subject, root, id, delegation: async () => (await subject.state()).delegations[id]! };
  };
  return { settled, commit, owner, delegated };
}
export function settlementVectors(name: string, open: () => SettlementSubject | Promise<SettlementSubject>): void {
  describe(`settlement contract: ${name}`, () => {
    const TIMERS: DelegationTimers = { cancelGraceMs: 1_000, uncertainAfterMs: 5_000 };
    const { settled, commit, owner, delegated } = settlementSteps(open);
    const unit = (state: CollaborationState, id: string) => state.units[hash([id, 'B'])]!.state;

    const ends: Array<[string, (subject: SettlementSubject, id: string) => Promise<void>, { verdict: string; reason?: string }, 'spent' | 'released']> = [
      ['a failed terminal', async (subject, id) => { await subject.terminal(id, 'task.fail', {}); await subject.conclude(id, 'failed'); }, { verdict: 'failed' }, 'spent'],
      ['a busy decline', async (subject, id) => { await subject.terminal(id, 'task.decline', { code: 'agent_home_writer_busy' }); await subject.conclude(id, 'declined'); },
        { verdict: 'failed', reason: 'busy' }, 'released'],
      ['a decline with no code', async (subject, id) => { await subject.terminal(id, 'task.decline', {}); await subject.conclude(id, 'declined'); },
        { verdict: 'failed', reason: 'busy' }, 'released'],
      ['another decline', async (subject, id) => { await subject.terminal(id, 'task.decline', { code: 'model_unavailable' }); await subject.conclude(id, 'declined'); },
        { verdict: 'failed', reason: 'model_unavailable' }, 'released'],
      ['an expiry', async (subject, id) => { await subject.conclude(id, 'expired'); }, { verdict: 'expired' }, 'released'],
      ['a cancel that raced the wait deadline', async (subject, id) => { await subject.conclude(id, 'cancelled', 'expired'); },
        { verdict: 'expired', reason: 'claim_raced_deadline' }, 'released'],
      ['a cancel', async (subject, id) => { await subject.conclude(id, 'cancelled', 'cancelled'); }, { verdict: 'cancelled', reason: 'user_cancelled' }, 'released'],
    ];
    for (const [end, conclude, verdict, units] of ends) {
      it(`gives ${end} of the chain end its verdict, and spends or releases the unit`, async () => {
        const { subject, id, delegation } = await delegated();
        await conclude(subject, id);
        await settled(subject);
        const state = await subject.state(), d = await delegation();
        expect(d).toMatchObject({ ...verdict, status: 'resolved', replyTurnId: hash(['bot_reply', id]) });
        if (!verdict.reason) expect(d.reason).toBeUndefined();
        expect(unit(state, id)).toBe(units);
        expect(state.turns[d.replyTurnId!]).toMatchObject({ source: 'bot_reply', botId: 'main', replies: [expect.objectContaining(verdict)] });
      });
    }

    it('spends the unit at the first claim, and the delegation runs', async () => {
      const { subject, id, delegation } = await delegated();
      const root = (await delegation()).root, before = (await subject.state()).budgets[root]!;
      await subject.claim(id);
      await settled(subject);
      const state = await subject.state();
      expect(unit(state, id)).toBe('spent');
      expect(state.budgets[root]).toMatchObject({ reserved: before.reserved! - 1, delegation: before.delegation + 1 });
      expect(await delegation()).toMatchObject({ status: 'running', claimed: { turnId: id, at: VECTOR_NOW } });
      expect(await subject.projection(`delegation:${id}:2`)).toEqual([expect.objectContaining({ status: 'running' })]);
    });

    it('takes a decline terminal as no start, and any other terminal as a start', async () => {
      const declined = await delegated();
      await declined.subject.terminal(declined.id, 'task.decline', { code: 'model_unavailable' });
      await settled(declined.subject);
      expect(unit(await declined.subject.state(), declined.id)).toBe('reserved');
      expect((await declined.delegation()).status).not.toBe('running');
      const failed = await delegated();
      await failed.subject.terminal(failed.id, 'task.fail', {});
      await settled(failed.subject);
      expect(unit(await failed.subject.state(), failed.id)).toBe('spent');
      expect(await failed.delegation()).toMatchObject({ status: 'running' });
    });

    it('refuses a delegation whose target Bot was archived (target_archived), once its target concluded', async () => {
      const { subject, id, delegation } = await delegated();
      await subject.change(state => { state.team.bots.b!.archived = true; });
      await settled(subject);
      expect(await delegation()).toMatchObject({ cancel: { reason: 'target_archived', targetTurnId: id } });
      await subject.conclude(id, 'cancelled', 'cancelled');
      await settled(subject);
      expect(await delegation()).toMatchObject({ verdict: 'refused', reason: 'target_archived', status: 'resolved' });
    });

    it('shows a cancel with no conclusion as uncertain once the cancel grace passed', async () => {
      const { subject, id, delegation } = await delegated();
      await subject.submit(id);
      await subject.change(state => { state.team.bots.b!.archived = true; });
      await settled(subject, VECTOR_NOW, TIMERS);
      await settled(subject, VECTOR_NOW + TIMERS.cancelGraceMs - 1, TIMERS);
      expect((await delegation()).status).not.toBe('uncertain');
      await settled(subject, VECTOR_NOW + TIMERS.cancelGraceMs, TIMERS);
      expect(await delegation()).toMatchObject({ status: 'uncertain', uncertainSince: VECTOR_NOW + TIMERS.cancelGraceMs });
      expect(await delegation()).not.toHaveProperty('verdict');
    });

    /** A claimed chain end with no conclusion, `uncertain` once `uncertainAfterMs` passed. */
    const uncertainClaim = async () => {
      const h = await delegated();
      await h.subject.claim(h.id);
      await settled(h.subject, VECTOR_NOW, TIMERS);
      await settled(h.subject, VECTOR_NOW + TIMERS.uncertainAfterMs - 1, TIMERS);
      expect((await h.delegation()).status).toBe('running');
      await settled(h.subject, VECTOR_NOW + TIMERS.uncertainAfterMs, TIMERS);
      expect(await h.delegation()).toMatchObject({ status: 'uncertain', uncertainSince: VECTOR_NOW + TIMERS.uncertainAfterMs });
      return h;
    };
    it('shows a claimed chain end with no conclusion as uncertain once uncertainAfterMs passed', async () => { await uncertainClaim(); });

    it('writes a terminal that comes after the verdict to the audit list only, once', async () => {
      const { subject, id, delegation } = await uncertainClaim();
      await commit(subject, { kind: 'abandon_delegation', delegationId: id });
      expect(await delegation()).toMatchObject({ verdict: 'abandoned', lateTurnId: id });
      await subject.conclude(id, 'cancelled', 'cancelled');
      await settled(subject, VECTOR_NOW + TIMERS.uncertainAfterMs, TIMERS);
      const state = await subject.state();
      expect(state.audit.filter(line => line.includes(id))).toEqual([`Delegation terminal after verdict: ${id} ${taskId(id, 0)}`]);
      expect(state.delegations[id]).not.toHaveProperty('lateTurnId');
      expect(state.delegations[id]).toMatchObject({ verdict: 'abandoned' });
    });

    for (const tried of [false, true]) {
      it(`resolves a Main Bot cancel of ${tried ? 'a tried' : 'an untried'} target from a later owner Turn's outcome once the target concluded`, async () => {
        const { subject, id, delegation } = await delegated();
        if (tried) await subject.submit(id);
        await owner(subject, 'r2', { cancel_delegation: [{ delegationId: id }] });
        expect(await delegation()).toMatchObject({ cancel: { reason: 'main_bot_cancelled', targetTurnId: id } });
        if (tried) {
          const open = await delegation();
          expect(open).not.toHaveProperty('verdict');
          expect(open.status).not.toBe('uncertain');
        }
        await subject.conclude(id, 'cancelled', 'cancelled');
        await settled(subject);
        expect(await delegation()).toMatchObject({ verdict: 'cancelled', reason: 'main_bot_cancelled', status: 'resolved' });
      });
    }
  });
}

/** A reply readback through the SDK `tasks.agentMessage`, as the Host binds it. */
export type ReplyRead = (taskId: string, deviceId: string, agentRef: ExecutionTemplate['payload']['agentRef']) => Promise<ReplyReadback>;
/**
 * #793 S7 reply checks. `checkReplies(now, read, timers)` is the Host's reply check at `now`, as L's `flushReplies` runs it:
 * for each delegation that K8 `replyCheckDue` selects, the chain end's readback through `read`, outside any transaction,
 * then the K8 `checkReply` decision. It runs no sync. `timers` gives `uncertainAfterMs`.
 */
export interface ReplySubject extends SettlementSubject {
  checkReplies(now: number, read: ReplyRead, timers?: DelegationTimers): void | Promise<void>;
}
export function replyVectors(name: string, open: () => ReplySubject | Promise<ReplySubject>): void {
  describe(`reply check contract: ${name}`, () => {
    const TIMERS: DelegationTimers = { cancelGraceMs: 1_000, uncertainAfterMs: 5_000 };
    const { settled, commit, delegated } = settlementSteps(open);
    /** B's chain end succeeded with no Host reply record, so its delegation waits for a reply check at `VECTOR_NOW`. */
    const pending = async () => {
      const h = await delegated();
      await commit(h.subject, { kind: 'outcome', turnId: h.id, taskId: taskId(h.id, 0), document: {} });
      await h.subject.terminal(h.id, 'task.complete', { document: {} });
      await h.subject.conclude(h.id, 'succeeded');
      await settled(h.subject);
      expect(await h.delegation()).toMatchObject({ status: 'reply_pending', checks: 0, nextCheckAt: VECTOR_NOW, pendingSince: VECTOR_NOW });
      const reads: unknown[][] = [];
      /** A read that records its arguments, then throws `readback` when it is an error, or returns it. */
      const reader = (readback: ReplyReadback | Error): ReplyRead => async (...args) => {
        reads.push(args);
        if (readback instanceof Error) throw readback;
        return readback;
      };
      return { ...h, reads, reader };
    };
    const projected = async (h: Awaited<ReturnType<typeof pending>>) => h.subject.projection(`delegation:${h.id}:${(await h.delegation()).revision}`);

    for (const [read, readback] of [['a pending read', {}], ['a read that throws', new Error('down')]] as const) {
      it(`answers a delegation whose reply body the Host holds, after ${read}`, async () => {
        const h = await pending();
        await h.subject.change(state => {
          state.replies[taskId(h.id, 0)] = { turnId: h.id, messageId: 'm1', contentHash: 'sha256:m1', contentType: 'text/markdown', acceptedAt: VECTOR_NOW, body: 'Done' };
        });
        await h.subject.checkReplies(VECTOR_NOW, h.reader(readback));
        expect(h.reads).toEqual([[taskId(h.id, 0), 'device', template('device', 'b').payload.agentRef]]);
        const d = await h.delegation();
        expect(d).toMatchObject({ verdict: 'answered', status: 'resolved', reply: taskId(h.id, 0), replyTurnId: hash(['bot_reply', h.id]) });
        expect(d).not.toHaveProperty('nextCheckAt');
        expect(await projected(h)).toEqual([expect.objectContaining({ status: 'resolved', verdict: 'answered' })]);
      });
    }

    for (const [read, readback] of [['no message', undefined], ['a refused message', { disposition: { outcome: 'refused' } }]] as const) {
      it(`fails a delegation whose readback has ${read} (no_reply)`, async () => {
        const h = await pending();
        await h.subject.checkReplies(VECTOR_NOW, h.reader(readback));
        expect(await h.delegation()).toMatchObject({ verdict: 'failed', reason: 'no_reply', status: 'resolved', replyTurnId: hash(['bot_reply', h.id]) });
      });
    }

    it('holds a delegation whose message is held, with no verdict and no next check', async () => {
      const h = await pending();
      await h.subject.checkReplies(VECTOR_NOW, h.reader({ disposition: { outcome: 'held' } }));
      const d = await h.delegation();
      expect(d.status).toBe('reply_held');
      expect(d).not.toHaveProperty('verdict');
      expect(d).not.toHaveProperty('nextCheckAt');
      expect(await projected(h)).toEqual([expect.objectContaining({ status: 'reply_held' })]);
    });

    it('checks a pending readback again with backoff, not before its time, and shows it as uncertain once uncertainAfterMs passed', async () => {
      const h = await pending(), read = h.reader({});
      await h.subject.checkReplies(VECTOR_NOW, read, TIMERS);
      expect(await h.delegation()).toMatchObject({ status: 'reply_pending', checks: 1, nextCheckAt: VECTOR_NOW + 1000 });
      await h.subject.checkReplies(VECTOR_NOW + 999, read, TIMERS);
      expect(h.reads).toHaveLength(1);
      await h.subject.checkReplies(VECTOR_NOW + 1000, read, TIMERS);
      expect(await h.delegation()).toMatchObject({ status: 'reply_pending', checks: 2, nextCheckAt: VECTOR_NOW + 3000 });
      await h.subject.checkReplies(VECTOR_NOW + TIMERS.uncertainAfterMs, read, TIMERS);
      const d = await h.delegation();
      expect(d).toMatchObject({ status: 'uncertain', uncertainSince: VECTOR_NOW + TIMERS.uncertainAfterMs, checks: 3,
        nextCheckAt: VECTOR_NOW + TIMERS.uncertainAfterMs + 4000 });
      expect(d).not.toHaveProperty('verdict');
      expect(h.reads).toHaveLength(3);
    });

    for (const [read, readback] of [['a read that throws', new Error('down')], ['an accepted message with no Host record', { disposition: { outcome: 'accepted' } }]] as const) {
      it(`checks again after ${read}`, async () => {
        const h = await pending();
        await h.subject.checkReplies(VECTOR_NOW, h.reader(readback));
        const d = await h.delegation();
        expect(d).toMatchObject({ status: 'reply_pending', checks: 1, nextCheckAt: VECTOR_NOW + 1000 });
        expect(d).not.toHaveProperty('verdict');
      });
    }
  });
}

/**
 * #793 H batch seal: input coalescing in the Host sync. `open(policy)` opens a store whose input admission uses `policy`, or
 * no coalescing without one. `sync(now)` is one Host sync at `now`: K8 `sealDueBatches` first, then the Turn steps, then
 * `projectInputBatches` last, as L's sync runs them. A store may run more rounds in one sync.
 */
export interface CoalesceSubject extends Omit<SyncSubject, 'sync'> {
  sync(now: number): void | Promise<void>;
}
/** The policy of the vectors: a 1 s window and two inputs a batch. */
const COALESCE_POLICY: CoalescePolicy = { windowMs: 1000, maxItems: 2, maxBytes: 8192 };
export function coalesceVectors(name: string, open: (policy?: CoalescePolicy) => CoalesceSubject | Promise<CoalesceSubject>): void {
  describe(`coalesce contract: ${name}`, () => {
    const user = (key: string) => hash(['user', 'main', key]);
    /** `t1` is concluded and `q1` holds the Bot: it freezes at the first sync and stays open. */
    const busy = async (policy: CoalescePolicy | undefined) => {
      const subject = await open(policy);
      await subject.change(state => {
        Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
        state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'queued', authority: 'owner' };
      });
      await subject.sync(VECTOR_NOW);
      return subject;
    };
    const send = async (subject: CoalesceSubject, key: string) => {
      const result = await subject.commit({ scope: subject.scope, commandId: key, command: input(key, `Say ${key}`) });
      expect(result.disposition.outcome).toBe('accepted');
      return (result.disposition as { value: string }).value;
    };
    const projected = (subject: CoalesceSubject, batch: string, revision: 1 | 2) => subject.projection(`input-batch:${batch}:${revision}`);

    it('answers inputs to a busy Bot with one open batch, and projects its revision 1 at the next sync', async () => {
      const subject = await busy(COALESCE_POLICY), batch = user('k1');
      expect([await send(subject, 'k1'), await send(subject, 'k2')]).toEqual([batch, batch]);
      const state = await subject.state();
      expect(state.turns[batch]).toBeUndefined();
      expect(state.inputBatches?.[batch]).toMatchObject({ state: 'open', inputIds: [batch, user('k2')], openedAt: VECTOR_NOW,
        sealAt: VECTOR_NOW + COALESCE_POLICY.windowMs });
      expect(await projected(subject, batch, 1)).toEqual([]);
      await subject.sync(VECTOR_NOW);
      expect(await projected(subject, batch, 1)).toEqual([expect.objectContaining({ owner: 'main', id: batch, revision: 1, state: 'open',
        inputIds: [batch, user('k2')], sealAt: VECTOR_NOW + COALESCE_POLICY.windowMs })]);
      expect(await projected(subject, batch, 2)).toEqual([]);
    });

    it('seals the batch at the first sync at or after its window ends, and freezes its Turn in that sync', async () => {
      const subject = await busy(COALESCE_POLICY), batch = user('k1');
      await send(subject, 'k1');
      await send(subject, 'k2');
      const request = (await subject.state()).inputBatches![batch]!.request;
      await subject.sync(VECTOR_NOW + COALESCE_POLICY.windowMs - 1);
      expect((await subject.state()).inputBatches![batch]!.state).toBe('open');
      await subject.sync(VECTOR_NOW + COALESCE_POLICY.windowMs);
      const state = await subject.state();
      expect(state.inputBatches![batch]).toMatchObject({ state: 'sealed', sealReason: 'window' });
      expect(state.turns[batch]).toMatchObject({ source: 'user', request, authority: 'owner', inputIds: [batch, user('k2')] });
      expect(await subject.intent(batch)).toMatchObject({ key: batch, source: 'user' });
      expect(await projected(subject, batch, 2)).toEqual([expect.objectContaining({ id: batch, revision: 2, state: 'sealed', sealReason: 'window' })]);
      const stored = await subject.stored();
      await subject.sync(VECTOR_NOW + COALESCE_POLICY.windowMs);
      expect(await subject.stored()).toBe(stored);
    });

    it('seals a full batch at the next input, so a batch sealed before any sync projects only revision 2', async () => {
      const subject = await busy(COALESCE_POLICY), batch = user('k1');
      await send(subject, 'k1');
      await send(subject, 'k2');
      // The third input opens the next batch and seals the full one at its admission.
      expect(await send(subject, 'k3')).toBe(user('k3'));
      expect((await subject.state()).inputBatches![batch]).toMatchObject({ state: 'sealed', sealReason: 'items' });
      await subject.sync(VECTOR_NOW);
      expect(await projected(subject, batch, 1)).toEqual([]);
      expect(await projected(subject, batch, 2)).toEqual([expect.objectContaining({ id: batch, revision: 2, sealReason: 'items' })]);
      expect(await projected(subject, user('k3'), 1)).toEqual([expect.objectContaining({ id: user('k3'), revision: 1, state: 'open' })]);
    });

    it('seals an open batch as idle once its Bot has no open Turn', async () => {
      const subject = await busy(COALESCE_POLICY), batch = user('k1');
      await send(subject, 'k1');
      await subject.concludeIntent('q1', 'succeeded');
      // L's sync seals before the Turn steps, so the seal comes at the sync after the one that concludes q1.
      await subject.sync(VECTOR_NOW);
      await subject.sync(VECTOR_NOW);
      const state = await subject.state();
      expect(state.turns.q1).toMatchObject({ conclusion: 'succeeded' });
      expect(state.inputBatches![batch]).toMatchObject({ state: 'sealed', sealReason: 'idle' });
      expect(await subject.intent(batch)).toMatchObject({ key: batch, source: 'user' });
    });

    it('keeps one Turn for each input without a policy', async () => {
      const subject = await busy(undefined);
      expect(await send(subject, 'k1')).toBe(user('k1'));
      const state = await subject.state();
      expect(state.turns[user('k1')]).toMatchObject({ source: 'user', request: 'Say k1' });
      expect(state.inputBatches).toBeUndefined();
    });
  });
}

/**
 * #793 S5: the card steps of the Host sync. `sync(now)` is one Host sync at `now`, in L's order: K8 `expireCards`, the Turn
 * steps of the sync contract, then K8 `reportCardDecisions`. A store may run more rounds in one sync.
 */
export interface CardSubject extends Omit<SyncSubject, 'sync'> {
  sync(now: number): void | Promise<void>;
}
export function cardVectors(name: string, open: () => CardSubject | Promise<CardSubject>): void {
  describe(`card contract: ${name}`, () => {
    const result = hash(['action_result', 'c1']);
    /** `t1` is concluded and reported, so Bot `main` is idle. Card `c1` of `t1` expires at `expiresAt`. */
    const opened = async (expiresAt: number) => {
      const subject = await open();
      await subject.change(state => {
        Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
        state.cards.c1!.expiresAt = expiresAt;
      });
      return subject;
    };
    const decide = async (subject: CardSubject, decision: 'confirmed' | 'rejected') => {
      const done = await subject.commit({ scope: subject.scope, commandId: `decide-${decision}`, command: { kind: 'decide', cardId: 'c1', decision } });
      expect(done.disposition).toEqual({ outcome: 'accepted' });
    };

    it('expires a pending card before the Turn steps, projects it once, and starts no Turn for it', async () => {
      const subject = await opened(VECTOR_NOW + 10);
      await subject.sync(VECTOR_NOW + 9);
      expect((await subject.state()).cards.c1).toMatchObject({ state: 'pending' });
      expect(await subject.projection('card:c1:expired')).toEqual([]);
      await subject.change(state => {
        state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'queued', authority: 'owner' };
      });
      await subject.sync(VECTOR_NOW + 10);
      const state = await subject.state();
      expect(state.cards.c1).toMatchObject({ state: 'expired', decisionReported: true });
      expect(await subject.projection('card:c1:expired')).toEqual([expect.objectContaining({ id: 'c1', state: 'expired' })]);
      expect(state.turns[result]).toBeUndefined();
      // The Turn that froze in the same sync sees the expiry in its ContextPack.
      const instruction = String(((await subject.intent('q1'))!.execution as { payload: { instruction: unknown } }).payload.instruction);
      expect(instruction).toContain(`"id":"c1","turnId":"t1",`);
      expect(instruction).toContain(`"state":"expired","expiresAt":${VECTOR_NOW + 10}`);
      const before = await subject.stored();
      await subject.sync(VECTOR_NOW + 10);
      expect(await subject.stored()).toBe(before);
    });

    it('reports a rejected card once, and runs its action_result Turn under the root of the card\'s Turn', async () => {
      const subject = await opened(VECTOR_NOW + 60_000);
      await decide(subject, 'rejected');
      await subject.sync(VECTOR_NOW);
      await subject.sync(VECTOR_NOW);
      const state = await subject.state();
      expect(await subject.projection('card:c1:rejected')).toEqual([expect.objectContaining({ id: 'c1', state: 'rejected' })]);
      expect(state.turns[result]).toMatchObject({ id: result, root: 't1', source: 'action_result', botId: 'main', hop: 0, authority: 'owner',
        request: JSON.stringify({ cardId: 'c1', state: 'rejected' }) });
      expect(await subject.intent(result)).toMatchObject({ key: result });
      const before = await subject.stored();
      await subject.sync(VECTOR_NOW);
      expect(await subject.stored()).toBe(before);
    });

    it('holds a confirmed card until its action has a result, then reports it with the result', async () => {
      const subject = await opened(VECTOR_NOW + 60_000);
      await decide(subject, 'confirmed');
      await subject.sync(VECTOR_NOW);
      expect(await subject.projection('card:c1:confirmed')).toEqual([]);
      expect((await subject.state()).turns[result]).toBeUndefined();
      await subject.change(state => { Object.assign(state.cards.c1!, { result: { sent: true }, conclusion: 'succeeded' }); });
      await subject.sync(VECTOR_NOW);
      expect(await subject.projection('card:c1:confirmed')).toEqual([expect.objectContaining({ id: 'c1', state: 'confirmed', result: { sent: true } })]);
      expect((await subject.state()).turns[result]).toMatchObject({ source: 'action_result',
        request: JSON.stringify({ cardId: 'c1', state: 'confirmed', conclusion: 'succeeded', result: { sent: true } }) });
    });
  });
}

/**
 * #793 S6: the room step of the Host sync. `sync(now)` is one Host sync at `now`, in L's order: the room step (K8
 * `advanceRoomSeats` on the seat facts of the K4 intents), then the Turn steps of the sync contract. When a Turn step releases
 * a seat, the sync runs the room step and the Turn steps again. A store may run more rounds in one sync. `claim` is a test edit: a device claimed the first attempt of the Turn's intent (K4 `Execution.started`).
 * `cancelReason` reads the K4 cancel reason of the Turn's intent.
 */
export interface RoomSubject extends Omit<SyncSubject, 'sync'> {
  sync(now: number): void | Promise<void>;
  claim(turnId: string): void | Promise<void>;
  cancelReason(turnId: string): string | undefined | Promise<string | undefined>;
}
export { ROOM_GRACE_MS };
/**
 * The room vectors' seed edit: `t1` concluded, the card `c1` kept pending, Bot `b` beside `main` on the same device, and room
 * `r` with both. An owner message mentions `b`, then `main`, so its round has `b`'s seat first.
 */
export function seedRoom(state: CollaborationState): void {
  Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
  state.cards.c1!.expiresAt = Number.MAX_SAFE_INTEGER;
  state.team.bots.b = { ...state.team.bots.main!, id: 'b', name: 'B', role: 'Reviewer', mainBot: false, execution: template('device', 'b') };
  state.team.rooms.r = { id: 'r', ...roomFields(state.team, { name: 'Room', members: ['main', 'b'] }), messages: [] };
  roomInput(state.team, 'm1', 'r', 'Hello', ['b', 'main']);
}
export function roomVectors(name: string, open: () => RoomSubject | Promise<RoomSubject>): void {
  describe(`room contract: ${name}`, () => {
    const opened = async () => {
      const subject = await open();
      await subject.change(seedRoom);
      const round = Object.values((await subject.state()).team.rounds)[0]!;
      const seats = async (): Promise<Seat[]> => { const team = (await subject.state()).team; return round.seats.map(id => team.seats[id]!); };
      return { subject, round, first: round.seats[0]!, second: round.seats[1]!, seats };
    };

    it('queues the first seat as a room_slot Turn with Bot authority, and freezes it in the same sync', async () => {
      const { subject, round, first, second, seats } = await opened();
      await subject.sync(VECTOR_NOW);
      expect(await seats()).toMatchObject([{ botId: 'b', status: 'queued', released: false, deadline: VECTOR_NOW + ROOM_GRACE_MS },
        { botId: 'main', status: 'waiting', released: false }]);
      const state = await subject.state();
      expect(state.turns[first]).toMatchObject({ id: first, root: first, source: 'room_slot', botId: 'b', hop: 0, authority: 'bot',
        request: JSON.stringify({ roomId: 'r', roundId: round.id, request: 'Hello', requestFrom: 'user' }) });
      expect(await subject.intent(first)).toMatchObject({ key: first, source: 'bot' });
      expect(state.turns[second]).toBeUndefined();
      const before = await subject.stored();
      await subject.sync(VECTOR_NOW);
      expect(await subject.stored()).toBe(before);
    });

    it('cancels an unclaimed seat at its deadline as busy, and queues the next seat', async () => {
      const { subject, first, second, seats } = await opened(), deadline = VECTOR_NOW + ROOM_GRACE_MS;
      await subject.sync(VECTOR_NOW);
      await subject.sync(deadline - 1);
      expect((await seats())[0]).toMatchObject({ status: 'queued', released: false });
      expect(await subject.cancelReason(first)).toBeUndefined();
      await subject.sync(deadline);
      expect(await seats()).toMatchObject([{ status: 'busy', released: true }, { status: 'queued', released: false, deadline: deadline + ROOM_GRACE_MS }]);
      expect(await subject.cancelReason(first)).toBe('cancelled');
      expect((await subject.state()).turns[second]).toMatchObject({ source: 'room_slot', botId: 'main', authority: 'bot' });
      expect(await subject.intent(second)).toMatchObject({ key: second, source: 'bot' });
    });

    it('releases a claimed seat as late at its running deadline, with no cancel, and queues the next seat', async () => {
      const { subject, first, seats } = await opened(), started = VECTOR_NOW + 5;
      await subject.sync(VECTOR_NOW);
      await subject.claim(first);
      await subject.sync(started);
      expect((await seats())[0]).toMatchObject({ status: 'running', released: false, startedAt: started, deadline: started + ROOM_GRACE_MS });
      await subject.sync(started + ROOM_GRACE_MS);
      expect(await seats()).toMatchObject([{ status: 'late', late: true, released: true }, { status: 'queued', released: false }]);
      expect(await subject.cancelReason(first)).toBeUndefined();
    });

    it('releases a seat whose Turn concluded with no speech as failed, and queues the next seat', async () => {
      const { subject, first, seats } = await opened();
      await subject.sync(VECTOR_NOW);
      await subject.concludeIntent(first, 'failed');
      await subject.sync(VECTOR_NOW + 1);
      expect(await seats()).toMatchObject([{ status: 'failed', released: true, reason: 'failed' }, { status: 'queued', released: false }]);
    });

    it('removes the admitted seat of a Bot that left the room, cancels its work, and queues the next seat', async () => {
      const { subject, first, second, seats } = await opened();
      await subject.sync(VECTOR_NOW);
      await subject.change(state => { state.team.rooms.r!.members = ['main']; });
      await subject.sync(VECTOR_NOW + 1);
      expect(await seats()).toMatchObject([{ status: 'removed', released: true }, { status: 'queued', released: false }]);
      expect(await subject.cancelReason(first)).toBe('cancelled');
      expect((await subject.state()).turns[second]).toMatchObject({ source: 'room_slot', botId: 'main' });
    });

    it('runs the room step again when a Turn step releases a seat, so the next seat gets its Turn in the same sync', async () => {
      const { subject, round, seats } = await opened();
      // A room request over the current-request limit blocks each seat Turn in its Turn step, which releases the seat.
      await subject.change(state => { state.team.rooms.r!.messages[0]!.text = 'x'.repeat(70_000); });
      await subject.sync(VECTOR_NOW);
      expect(await seats()).toMatchObject([{ status: 'blocked', released: true }, { status: 'blocked', released: true }]);
      expect((await subject.state()).team.rounds[round.id]).toMatchObject({ closed: true });
    });

    it('fails the unadmitted seat Turn of a Bot that left the room with cancelled', async () => {
      const { subject, second, seats } = await opened();
      // The second seat Turn exists without an intent: the room step has not queued it, so nothing froze it.
      await subject.change(state => {
        state.turns[second] = { id: second, root: second, source: 'room_slot', request: '{}', botId: 'main', hop: 0, authority: 'bot', status: 'queued' };
        state.team.rooms.r!.members = ['b'];
      });
      await subject.sync(VECTOR_NOW);
      expect((await seats())[1]).toMatchObject({ status: 'removed', released: true });
      expect((await subject.state()).turns[second]).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
      expect(await subject.intent(second)).toBeUndefined();
    });
  });
}
