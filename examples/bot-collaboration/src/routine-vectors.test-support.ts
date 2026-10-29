import { describe, expect, it } from 'vitest';
import { nextRoutineOccurrence, type RoutineSchedule } from '@byok-sdk/core';
import type { RoutineScheduleFields, UpdateRoutineAction } from '@byok-sdk/protocol';
import { hash, taskId, type Conclusion, type Intent, type Json, type Occurrence, type Routine } from '@byok-sdk/server/execution-core';
import { json, type CollaborationState } from './model';
import { ROUTINE_LATE_AFTER_MS, ROUTINE_WAIT_MS } from './routines';
import { archiveBot } from './rules/team';

/**
 * #793 D2f routine vectors. Each Host runs the same cases: the K8 L ledger now, and the H store in D2f-3.
 * A subject sees only Host verbs and the row views below, not its row layout. The views are the H projection of the K4
 * rows (scheduler note §2.0): K4 fields with no H reader are left out. A subject may be async.
 * Each verb that writes (`input`, `finish`, `fire`, `cancelTurn`, `update`, `lifecycle`, `end`) ends by running the Host as `sync` does,
 * so the cases read promotions, claims and switches right after it.
 */
export interface RoutineSubject {
  /** The Host clock. The subject picks the start, because the L SDK keeps real time. */
  now(): number;
  at(now: number): void;
  /** A test edit of the stored collaboration state, outside the contract. */
  change(edit: (state: CollaborationState) => void): void | Promise<void>;
  /**
   * A test write of one routine of Bot `owner`, outside the contract: the K4 create command with the K8 Bot definition, as an
   * outcome of that Bot's Turn writes it. Returns the routine id. The other cases create routines through Bot `main`'s outcomes.
   */
  addRoutine(owner: string, schedule: RoutineScheduleFields): Promise<string>;
  /** An owner input to Bot `main`. Returns its Turn id once the Host has run it. */
  input(key: string, request: string): Promise<string>;
  /** Waits until the device has claimed the Turn's intent. Then the intent is tried (K4 `attempts > 0`, H `tries > 0`). */
  start(turnId: string): Promise<void>;
  /** Completes a started Turn with this outcome document, and runs the Host. */
  finish(turnId: string, document: Json): Promise<void>;
  /** Fires the due slot of routine `id` at the clock: L delivers its reserved wake, H runs a scheduler pass. */
  fire(id: string): Promise<void>;
  /** Runs the Host: sync, promotion, claims and expiries. */
  sync(): Promise<void>;
  cancelTurn(turnId: string): Promise<void>;
  /** The owner routine API of the Main Bot. */
  update(action: UpdateRoutineAction): Promise<void>;
  lifecycle(id: string, value: Routine['lifecycle']): Promise<void>;
  /** The keyless `end_routine` command of Bot `main` (§55c). */
  end(id: string): Promise<void>;
  routine(id: string): RoutineRow | undefined | Promise<RoutineRow | undefined>;
  /** The slot times that the Host still holds to fire routine `id`: L's pending SDK wakes, H's `routine_due` scan rows. */
  reserved(id: string): Promise<number[]>;
  /** The occurrences of a routine, by planned time. */
  occurrences(id: string): OccurrenceRow[] | Promise<OccurrenceRow[]>;
  intent(key: string): RoutineIntentRow | undefined | Promise<RoutineIntentRow | undefined>;
  state(): CollaborationState | Promise<CollaborationState>;
}
export interface RoutineRow { id: string; version: number; pending: number | null; lifecycle: Routine['lifecycle']; status: Routine['status'];
  nextAt: number | null; calendarErrors: number }
export interface OccurrenceRow { key: string; routineId: string; version: number; trigger: Occurrence['trigger']; recordedAt: number; nextAt: number | null;
  executionSuperseded: boolean; promoted: boolean; conclusion: Conclusion | null }
export interface RoutineIntentRow { key: string; source: Intent['source']; waitUntil: number; retryUntil: number | null; conclusion: Conclusion | null;
  tried: boolean; instruction: string }

/** The H view of a K4 routine row. */
export function routineView(routine: Readonly<Routine>): RoutineRow {
  return { id: routine.definition.id, version: routine.definition.version, pending: routine.pending?.version ?? null, lifecycle: routine.lifecycle,
    status: routine.status, nextAt: routine.next?.availableAt ?? null, calendarErrors: routine.calendarErrors?.length ?? 0 };
}
/** The H view of a K4 occurrence. A promoted occurrence takes its conclusion from its intent (DDL D5). */
export function occurrenceView(occurrence: Readonly<Occurrence>, intent?: Readonly<Pick<Intent, 'conclusion'>>): OccurrenceRow {
  return { key: occurrence.key, routineId: occurrence.routineId, version: occurrence.definitionVersion, trigger: structuredClone(occurrence.trigger),
    recordedAt: occurrence.recordedAt, nextAt: occurrence.nextAt, executionSuperseded: !!occurrence.hook?.executionSuperseded,
    promoted: occurrence.intentId !== undefined, conclusion: (intent ? intent.conclusion : occurrence.conclusion) ?? null };
}

const PROMPT = 'Daily report';
const settle = async <T>(work: () => T | Promise<T>): Promise<T> => work();
/** A daily slot about twelve hours after `now`, so the L SDK never delivers it on its own. */
function daily(now: number): RoutineScheduleFields { return { minute: 0, hour: (new Date(now).getUTCHours() + 12) % 24, tz: 'UTC' }; }
const slotAfter = (schedule: RoutineScheduleFields, after: number): number => nextRoutineOccurrence(schedule as unknown as RoutineSchedule, after)!;
const occurrenceKey = (id: string, version: number, kind: Occurrence['trigger']['kind'], plannedAt: number) => hash([id, version, { kind, plannedAt }]);
const routineTurn = (key: string) => `occurrence:${key}`;

export function routineVectors(name: string, open: () => RoutineSubject | Promise<RoutineSubject>): void {
  describe(`routine contract: ${name}`, () => {
    /** Turn `key` of the owner creates one routine through its outcome. Returns the routine id and its schedule. */
    async function created(subject: RoutineSubject, key = 'plan', prompt = PROMPT) {
      const schedule = daily(subject.now()), turn = await subject.input(key, 'Plan a routine');
      await subject.start(turn);
      await subject.finish(turn, json({ create_routine: [{ localId: 'new_routine_1', schedule, prompt }] }));
      return { id: hash([taskId(turn, 0), 'create_routine', 0]), schedule, turn };
    }
    /** Moves the clock to the reserved slot of `id`, plus `late`, and fires it. Returns the slot. */
    async function due(subject: RoutineSubject, id: string, late = 0): Promise<number> {
      const slot = (await settle(() => subject.routine(id)))!.nextAt!;
      subject.at(slot + late);
      await subject.fire(id);
      return slot;
    }
    /** The routine Turn of the newest occurrence of `id`. */
    const newest = async (subject: RoutineSubject, id: string) => routineTurn((await settle(() => subject.occurrences(id))).at(-1)!.key);
    /** An owner Turn that runs, so later intents of Bot `main` wait behind it in the K4 FIFO, untried. */
    async function blocker(subject: RoutineSubject, key = 'hold'): Promise<string> {
      const turn = await subject.input(key, 'Hold the queue');
      await subject.start(turn);
      return turn;
    }
    /** Bot `main` takes no new offer: its ready revision differs, so the sync leaves its Turns unpromoted. */
    const hold = (subject: RoutineSubject, held: boolean) => subject.change(state => { state.team.bots.main!.readyRevision = held ? 'held' : state.team.bots.main!.revision; });

    it('creates a routine through an outcome action, and the next Turn\'s frozen instruction lists it', async () => {
      const subject = await open(), at = subject.now();
      const { id, schedule } = await created(subject);
      expect(await subject.routine(id)).toEqual({ id, version: 1, pending: null, lifecycle: 'active', status: 'ok',
        nextAt: slotAfter(schedule, at - 1), calendarErrors: 0 });
      const next = await subject.input('next', 'What is planned?');
      const instruction = (await subject.intent(next))!.instruction;
      expect(instruction).toContain(id);
      expect(instruction).toContain(PROMPT);
    }, 60_000);

    it('fires on time as scheduled and late as catch_up, with the K4 occurrence keys and the routine Turn', async () => {
      const subject = await open(), { id, schedule } = await created(subject);
      const first = await due(subject, id, ROUTINE_LATE_AFTER_MS), firstAt = subject.now();
      await subject.start(await newest(subject, id));
      const second = await due(subject, id, ROUTINE_LATE_AFTER_MS + 1), secondAt = subject.now();
      const [one, two] = [occurrenceKey(id, 1, 'scheduled', first), occurrenceKey(id, 1, 'catch_up', second)];
      expect(await subject.occurrences(id)).toEqual([
        { key: one, routineId: id, version: 1, trigger: { kind: 'scheduled', plannedAt: first }, recordedAt: firstAt, nextAt: second,
          executionSuperseded: false, promoted: true, conclusion: null },
        { key: two, routineId: id, version: 1, trigger: { kind: 'catch_up', plannedAt: second }, recordedAt: secondAt, nextAt: slotAfter(schedule, secondAt),
          executionSuperseded: false, promoted: true, conclusion: null },
      ]);
      expect((await subject.state()).turns[routineTurn(two)]).toMatchObject({ id: routineTurn(two), root: routineTurn(two), botId: 'main', source: 'routine',
        request: PROMPT, hop: 0, authority: 'owner', status: 'processing' });
      expect(await subject.intent(routineTurn(two))).toMatchObject({ key: routineTurn(two), source: 'routine', waitUntil: secondAt + ROUTINE_WAIT_MS,
        retryUntil: slotAfter(schedule, secondAt), conclusion: null });
      expect((await subject.intent(routineTurn(two)))!.instruction).toContain(PROMPT);
      expect(await subject.routine(id)).toMatchObject({ nextAt: slotAfter(schedule, secondAt), status: 'ok' });
    }, 60_000);

    it('supersedes an untried promoted intent at a new slot, and keeps a running one with retry_until at the first later slot', async () => {
      const subject = await open(), { id, schedule } = await created(subject);
      await due(subject, id);
      const running = await newest(subject, id);
      await subject.start(running);
      await due(subject, id);
      const untried = await newest(subject, id), second = subject.now();
      // The first later slot ends the running occurrence's retries at its own time. A third slot keeps that bound.
      expect(await subject.intent(running)).toMatchObject({ tried: true, retryUntil: second, conclusion: null });
      expect(await subject.intent(untried)).toMatchObject({ tried: false, conclusion: null });
      await due(subject, id);
      const now = subject.now(), latest = await newest(subject, id);
      expect(await subject.intent(running)).toMatchObject({ tried: true, retryUntil: second, conclusion: null });
      expect(await subject.intent(untried)).toMatchObject({ tried: false, conclusion: 'superseded' });
      expect(await subject.intent(latest)).toMatchObject({ tried: false, retryUntil: slotAfter(schedule, now), conclusion: null });
      expect((await subject.occurrences(id)).map(row => row.conclusion)).toEqual([null, 'superseded', null]);
      const turns = (await subject.state()).turns;
      expect([running, untried, latest].map(turn => [turns[turn]!.status, turns[turn]!.conclusion])).toEqual([
        ['processing', undefined], ['failed', 'superseded'], ['processing', undefined]]);
    }, 60_000);

    it('marks an unpromoted occurrence executionSuperseded at a new slot, and its later promotion settles superseded', async () => {
      const subject = await open(), { id, schedule } = await created(subject);
      await hold(subject, true);
      await due(subject, id);
      const stale = await newest(subject, id);
      await due(subject, id);
      const fresh = await newest(subject, id), now = subject.now();
      expect((await subject.occurrences(id)).map(row => [row.promoted, row.executionSuperseded, row.conclusion]))
        .toEqual([[false, true, null], [false, false, null]]);
      expect(await subject.intent(stale)).toBeUndefined();
      await hold(subject, false);
      await subject.sync();
      expect(await subject.intent(stale)).toMatchObject({ source: 'routine', conclusion: 'superseded', tried: false });
      expect(await subject.intent(fresh)).toMatchObject({ conclusion: null, retryUntil: slotAfter(schedule, now) });
      expect((await subject.occurrences(id)).map(row => [row.promoted, row.conclusion])).toEqual([[true, 'superseded'], [true, null]]);
      expect((await subject.state()).turns[stale]).toMatchObject({ status: 'failed', conclusion: 'superseded' });
    }, 60_000);

    describe('stages a version while an occurrence is open, and switches when it concludes', () => {
      /** Fires one slot, stages version 2, checks that it waits, concludes the occurrence, then checks the switch. */
      async function switched(subject: RoutineSubject, id: string, schedule: RoutineScheduleFields, conclude: (turn: string) => Promise<void>,
        conclusion: Conclusion) {
        const turn = await newest(subject, id);
        await subject.update({ routineId: id, prompt: 'Version 2' });
        expect(await subject.routine(id)).toMatchObject({ version: 1, pending: 2 });
        await conclude(turn);
        expect((await subject.occurrences(id)).at(-1)!.conclusion).toBe(conclusion);
        expect(await subject.routine(id)).toMatchObject({ version: 2, pending: null, lifecycle: 'active', nextAt: slotAfter(schedule, subject.now()) });
      }
      it('after the routine Turn succeeds', async () => {
        const subject = await open(), { id, schedule } = await created(subject);
        await due(subject, id);
        await subject.start(await newest(subject, id));
        await switched(subject, id, schedule, turn => subject.finish(turn, {}), 'succeeded');
      }, 60_000);
      it('after the owner cancels the queued routine Turn', async () => {
        const subject = await open(), { id, schedule } = await created(subject);
        await blocker(subject);
        await due(subject, id);
        expect(await subject.intent(await newest(subject, id))).toMatchObject({ tried: false, conclusion: null });
        await switched(subject, id, schedule, turn => subject.cancelTurn(turn), 'cancelled');
      }, 60_000);
      it('after the owner cancels the routine Turn before its promotion', async () => {
        const subject = await open(), { id, schedule } = await created(subject);
        await hold(subject, true);
        await due(subject, id);
        await switched(subject, id, schedule, turn => subject.cancelTurn(turn), 'cancelled');
        expect((await subject.occurrences(id)).at(-1)!.promoted).toBe(false);
      }, 60_000);
    });

    it('pauses: removes the successor retry_until and the slot, then resumes on the current version', async () => {
      const subject = await open(), { id, schedule } = await created(subject);
      const slot = await due(subject, id);
      const turn = await newest(subject, id);
      await subject.start(turn);
      expect(await subject.intent(turn)).toMatchObject({ retryUntil: slotAfter(schedule, slot) });
      await subject.lifecycle(id, 'paused');
      expect(await subject.routine(id)).toMatchObject({ lifecycle: 'paused', nextAt: null });
      expect(await subject.intent(turn)).toMatchObject({ retryUntil: null, conclusion: null });
      await subject.lifecycle(id, 'active');
      expect(await subject.routine(id)).toMatchObject({ lifecycle: 'active', version: 1, nextAt: slotAfter(schedule, subject.now()) });
      expect(await subject.intent(turn)).toMatchObject({ retryUntil: null });
      // A later slot that fires while the intent still runs bounds it at the fire time, as K4 `min(retryUntil ?? now, now)`.
      await due(subject, id, 1);
      expect(await subject.intent(turn)).toMatchObject({ retryUntil: subject.now(), conclusion: null });
    }, 60_000);

    it('completes a routine through cancel_routine, and keeps at most eight open routines per owner', async () => {
      const subject = await open(), ids: string[] = [];
      for (let n = 0; n < 8; n++) ids.push((await created(subject, `plan-${n}`)).id);
      const ninth = await created(subject, 'plan-8');
      expect(await subject.routine(ninth.id)).toBeUndefined();
      expect((await subject.state()).rejected.at(-1)).toMatchObject({ action: 'create_routine', reason: 'Routine limit is 8', taskId: taskId(ninth.turn, 0) });
      const cancel = await subject.input('cancel', 'Stop the first routine');
      await subject.start(cancel);
      await subject.finish(cancel, { cancel_routine: [{ routineId: ids[0]! }] });
      expect(await subject.routine(ids[0]!)).toMatchObject({ lifecycle: 'completed', nextAt: null, pending: null });
      // A completed routine does not count.
      const tenth = await created(subject, 'plan-9');
      expect(await subject.routine(tenth.id)).toMatchObject({ lifecycle: 'active', version: 1 });
    }, 120_000);

    it('ends a routine of an archived owner only with Main Bot authority, and the ended routine has no later slot', async () => {
      const subject = await open(), at = subject.now();
      await subject.change(state => {
        state.team.bots.helper = { ...structuredClone(state.team.bots.main!), id: 'helper', name: 'Helper', mainBot: false };
      });
      const id = await subject.addRoutine('helper', daily(at)), slot = (await subject.routine(id))!.nextAt!;
      expect(await subject.reserved(id)).toEqual([slot]);
      await subject.change(state => { archiveBot(state.team, 'helper'); });
      // The owner API completes only the Main Bot's own routines.
      await expect(subject.lifecycle(id, 'completed')).rejects.toThrow('Routine is unavailable to this Bot');
      await subject.change(state => { state.team.bots.main!.mainBot = false; });
      await expect(subject.end(id)).rejects.toThrow('Main Bot role required');
      expect(await subject.routine(id)).toMatchObject({ lifecycle: 'active', nextAt: slot });
      await subject.change(state => { state.team.bots.main!.mainBot = true; });
      await subject.end(id);
      expect(await subject.routine(id)).toEqual({ id, version: 1, pending: null, lifecycle: 'completed', status: 'ok', nextAt: null, calendarErrors: 0 });
      // No later occurrence: the Host holds no slot to fire.
      expect(await subject.reserved(id)).toEqual([]);
      await expect(subject.end(id)).rejects.toThrow('No open Bot routine has this id');
    }, 60_000);

    it('concludes the occurrence cancelled when its routine Turn is cancelled before promotion', async () => {
      const subject = await open(), { id } = await created(subject);
      await hold(subject, true);
      await due(subject, id);
      const turn = await newest(subject, id);
      await subject.cancelTurn(turn);
      expect((await subject.occurrences(id)).map(row => [row.promoted, row.conclusion])).toEqual([[false, 'cancelled']]);
      expect(await subject.intent(turn)).toBeUndefined();
      expect((await subject.state()).turns[turn]).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
    }, 60_000);
  });
}
