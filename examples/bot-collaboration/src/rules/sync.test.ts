import { describe, expect, it, vi } from 'vitest';
import * as protocol from '@byok-sdk/protocol';
import { DEVICE_NOT_BOUND, DEVICE_SWITCHING, syncTurn, type DeviceRefusal, type FreezeExecution, type SealedRoutineTemplate, type SyncFacts, type SyncOptions,
  type SyncRefusal, type SyncState } from './sync';
import type { Json, Rejection, Turn } from './turn';
import type { IntentFact } from './delegation';
import { outcomeOffer, SYSTEM_PROMPT, systemPrompt, type CheckedOffer } from './schema';

const OPTIONS: SyncOptions<never> = { now: 1000, models: ['default'], readOnlyToolsets: [],
  limits: { turnLimit: 12, contextMaxBytes: 32_768, instructionMaxBytes: 65_536 }, historyMode: false, routines: [] };
const execution: FreezeExecution = { payload: {} };

const consumed = (): Rejection => ({ botId: 'main', taskId: 'a', action: 'delegate', reason: 'hop_limit', consumedBy: 't1' });
function state(archived = false, rejected: Rejection[] = []): SyncState<FreezeExecution> {
  return {
    team: { bots: { main: { id: 'main', name: 'Main', role: 'Owner', mainBot: true, archived, revision: '1', readyRevision: '1', execution } },
      rooms: {}, rounds: {}, seats: {}, notes: [], homeOperations: [] },
    delegations: {}, replies: {}, turns: {}, cards: {}, questions: {}, rejected, schemas: {}, audit: [],
  };
}
function turn(s: SyncState<FreezeExecution>, fields: Partial<Turn> = {}): Turn {
  const row: Turn = { id: 't1', root: 't1', botId: 'main', source: 'user', request: 'Work', hop: 0, status: 'processing', authority: 'owner', ...fields };
  (s.turns as Record<string, Turn>)[row.id] = row;
  return row;
}
function facts(intent?: IntentFact, started = false, retired?: 'result_retired' | 'turn_retired'): SyncFacts {
  return { intent: () => intent, executionStarted: () => started, retired: () => retired };
}
function published() {
  const rows: Array<[string, Json]> = [];
  return { rows, publish: (id: string, value: Json) => { rows.push([id, value]); } };
}

describe('syncTurn', () => {
  it('cancels an intent of an archived Bot only while its execution has not started', () => {
    const s = state(true), row = turn(s);
    expect(syncTurn(s, row, facts({ taskId: 'task' }), OPTIONS, () => {})).toEqual({ kind: 'cancel' });
    expect(syncTurn(s, row, facts({ taskId: 'task' }, true), OPTIONS, () => {})).toBeUndefined();
    expect(syncTurn(state(), turn(state()), facts({ taskId: 'task' }), OPTIONS, () => {})).toBeUndefined();
  });

  it('settles the Turn of a concluded intent, reports it once, and frees its rejected actions when the work never started', () => {
    const s = state(false, [consumed()]), row = turn(s), out = published();
    expect(syncTurn(s, row, facts({ taskId: 'task', conclusion: 'expired' }), OPTIONS, out.publish)).toBeUndefined();
    expect([row.status, row.conclusion, row.reported, s.rejected[0]!.consumedBy]).toEqual(['failed', 'expired', true, undefined]);
    syncTurn(s, row, facts({ taskId: 'task', conclusion: 'expired' }), OPTIONS, out.publish);
    expect(out.rows.map(([id]) => id)).toEqual(['bot-turn:t1']);

    const started = state(false, [consumed()]), other = turn(started);
    syncTurn(started, other, facts({ taskId: 'task', conclusion: 'failed' }, true), OPTIONS, () => {});
    expect(started.rejected[0]!.consumedBy).toBe('t1');
  });

  it('cancels a Turn of an archived Bot that has no intent, and reports a concluded Turn without an intent as ended', () => {
    const s = state(true), row = turn(s, { status: 'queued' });
    expect(syncTurn(s, row, facts(), OPTIONS, () => {})).toEqual({ kind: 'ended' });
    expect([row.status, row.conclusion]).toEqual(['failed', 'cancelled']);
  });

  it('fails a retired Turn of an archived Bot, and keeps the conclusion of a concluded Turn of an archived Bot', () => {
    const s = state(true), row = turn(s, { status: 'queued' });
    expect(syncTurn(s, row, facts(undefined, false, 'result_retired'), OPTIONS, () => {})).toBeUndefined();
    expect([row.status, row.conclusion]).toEqual(['failed', 'failed']);
    const done = turn(state(true), { status: 'succeeded', conclusion: 'succeeded' });
    expect(syncTurn(state(true), done, facts(undefined, false, 'result_retired'), OPTIONS, () => {})).toEqual({ kind: 'ended' });
    expect([done.status, done.conclusion]).toEqual(['succeeded', 'succeeded']);
  });

  it('fails a retired Turn with the reason, an audit line and one report', () => {
    for (const [reason, line] of [['result_retired', 'Turn result retired before sync: t1'], ['turn_retired', 'Turn identity retired: t1']] as const) {
      const s = state(), row = turn(s, { status: 'queued', source: 'room_slot' }), out = published();
      s.team.seats.t1 = { id: 't1', roundId: 'round', botId: 'main', status: 'queued', released: false, late: false };
      expect(syncTurn(s, row, facts(undefined, false, reason), OPTIONS, out.publish)).toBeUndefined();
      expect(s.team.seats.t1).toMatchObject({ status: 'failed', released: true, reason });
      expect([row.status, row.conclusion, row.reported, s.audit]).toEqual(['failed', 'failed', true, [line]]);
      expect(out.rows).toEqual([['bot-turn:t1', expect.objectContaining({ reason })]]);
    }
  });

  it('#956: holds a Turn whose Bot device is refused with one fixed projection, and freezes it once the device is bound', () => {
    const s = state(), row = turn(s, { status: 'queued' }), out = published();
    let refusal: DeviceRefusal | undefined = 'unbound';
    const refused: SyncFacts = { ...facts(), deviceRefusal: botId => botId === 'main' ? refusal : undefined };
    expect(syncTurn(s, row, refused, OPTIONS, out.publish)).toBeUndefined();
    expect([row.status, row.held, s.schemas.t1]).toEqual(['queued', DEVICE_NOT_BOUND, undefined]);
    // The reason changes, but the projection id keeps its one body, and the hold is not published again.
    refusal = 'revoked';
    expect(syncTurn(s, row, refused, OPTIONS, out.publish)).toBeUndefined();
    expect(out.rows).toEqual([['held:t1', { owner: 'main', turnId: 't1', code: DEVICE_NOT_BOUND }]]);
    expect(s.audit).toEqual([`Turn held ${DEVICE_NOT_BOUND} unbound: t1`]);
    refusal = undefined;
    expect(syncTurn(s, row, refused, OPTIONS, out.publish)).toMatchObject({ kind: 'freeze', input: { key: 't1' } });
    expect(row.status).toBe('processing');
    expect(row).not.toHaveProperty('held');
  });

  it('#956: holds a refused Turn before its profile check, and never checks a Turn that already has an intent', () => {
    const s = state(), row = turn(s, { status: 'queued' }), out = published();
    (s.team.bots.main as { readyRevision: string | null }).readyRevision = null;
    const refused: SyncFacts = { ...facts(), deviceRefusal: () => 'mode' };
    expect(syncTurn(s, row, refused, OPTIONS, out.publish)).toBeUndefined();
    expect(out.rows.map(([id]) => id)).toEqual(['held:t1']);
    const running = state(), work = turn(running), seen = published();
    expect(syncTurn(running, work, { ...facts({ taskId: 'task' }), deviceRefusal: () => 'revoked' }, OPTIONS, seen.publish)).toBeUndefined();
    expect([work.held, seen.rows]).toEqual([undefined, []]);
  });

  it('#957: holds a switching device under its own projection id, so each hold code keeps one body across holds', () => {
    const s = state(), row = turn(s, { status: 'queued' }), out = published();
    let refusal: SyncRefusal | undefined = 'unbound';
    const refused: SyncFacts = { ...facts(), deviceRefusal: () => refusal };
    syncTurn(s, row, refused, OPTIONS, out.publish);
    // Released, but its profile is not ready, so it neither freezes nor stays held.
    (s.team.bots.main as { readyRevision: string | null }).readyRevision = null;
    refusal = undefined;
    expect(syncTurn(s, row, refused, OPTIONS, out.publish)).toBeUndefined();
    expect(row).not.toHaveProperty('held');
    refusal = 'switching';
    expect(syncTurn(s, row, refused, OPTIONS, out.publish)).toBeUndefined();
    expect([row.status, row.held]).toEqual(['queued', DEVICE_SWITCHING]);
    syncTurn(s, row, refused, OPTIONS, out.publish);
    refusal = 'mode';
    syncTurn(s, row, refused, OPTIONS, out.publish);
    const notBound = { owner: 'main', turnId: 't1', code: DEVICE_NOT_BOUND }, switching = { owner: 'main', turnId: 't1', code: DEVICE_SWITCHING };
    expect(out.rows).toEqual([['held:t1', notBound], ['held-switching:t1', switching], ['held:t1', notBound]]);
    expect(s.audit).toEqual([`Turn held ${DEVICE_NOT_BOUND} unbound: t1`, `Turn held ${DEVICE_SWITCHING} switching: t1`, `Turn held ${DEVICE_NOT_BOUND} mode: t1`]);
  });

  it('waits for the profile of a Bot that is not ready, and for the history row in history mode', () => {
    const s = state(), row = turn(s, { status: 'queued' });
    (s.team.bots.main as { readyRevision: string | null }).readyRevision = null;
    expect(syncTurn(s, row, facts(), OPTIONS, () => {})).toBeUndefined();
    expect(row.status).toBe('queued');
    const ready = state(), waiting = turn(ready, { status: 'queued' });
    expect(syncTurn(ready, waiting, facts(), { ...OPTIONS, historyMode: true }, () => {})).toBeUndefined();
    expect([waiting.status, ready.schemas.t1]).toEqual(['queued', undefined]);
  });

  it('#881: freezes a prompt with only the offered actions in both team modes, and the full prompt otherwise', () => {
    const prompt = (external: boolean, offer?: CheckedOffer) => {
      const s = state();
      if (external) Object.assign(s.team, { external: { revision: 1 } });
      const step = syncTurn(s, turn(s, { status: 'queued' }), facts(), { ...OPTIONS, ...(offer ? { offer } : {}) }, () => {});
      if (step?.kind !== 'freeze') throw new Error('The Turn did not freeze');
      return (step.input.execution as { payload: { instruction: string } }).payload.instruction.split('\n\nRequest:\n')[0];
    };
    const delegateOnly = outcomeOffer({ actions: { turn: ['delegate'] } });
    expect(prompt(true, delegateOnly)).toBe(systemPrompt(['delegate']));
    expect(prompt(true, delegateOnly)).not.toContain('ask_user');
    expect(prompt(false, delegateOnly)).toBe(systemPrompt(['delegate']));
    // No offer, or an offer that does not narrow the Turn actions: the prompt is unchanged.
    for (const external of [true, false]) {
      expect(prompt(external)).toBe(SYSTEM_PROMPT);
      expect(prompt(external, outcomeOffer({ timeZones: ['Asia/Shanghai'] }))).toBe(SYSTEM_PROMPT);
    }
  });
});

describe('a sealed routine Turn (#953)', () => {
  const agentRef = { agentId: 'main', profileRevision: '1' };
  const sealedTemplate: SealedRoutineTemplate = {
    sealing: { scopeId: 'scope-1', epoch: 1, categories: ['task-input'] }, agentRef, notAfter: '2099-01-01T00:00:00.000Z',
    template: { ciphertext: 'c' } as unknown as SealedRoutineTemplate['template'],
  };
  const ref = { routineId: 'r-1', definitionVersion: 2 };
  function sealedState(revision = '1'): SyncState<FreezeExecution> {
    const s = state();
    const bot = s.team.bots.main!;
    (s.team.bots as Record<string, typeof bot>).main = { ...bot, execution: { payload: { agentRef: { ...agentRef, profileRevision: revision },
      instruction: 'template default', requiredToolsets: [] } as FreezeExecution['payload'] } };
    return s;
  }
  const sealedOptions = (lookup = (r: typeof ref) => r.routineId === ref.routineId && r.definitionVersion === ref.definitionVersion ? sealedTemplate : undefined):
    SyncOptions<never> => ({ ...OPTIONS, historyMode: true, sealedTemplate: lookup });

  it('freezes the template byte for byte with its routineRef and the plaintext result contract, and no instruction or history', () => {
    const s = sealedState(), row = turn(s, { id: 'occurrence:o1', root: 'occurrence:o1', source: 'routine', request: '', status: 'queued', sealedRoutine: ref });
    const step = syncTurn(s, row, facts(), sealedOptions(), () => {});
    expect(step?.kind).toBe('routine');
    const { payload } = (step as { execution: { payload: Record<string, unknown> } }).execution;
    expect(payload).not.toHaveProperty('instruction');
    expect(payload).toMatchObject({ agentRef, requiredToolsets: [], sealing: sealedTemplate.sealing, sealed: sealedTemplate.template,
      routineRef: { ...ref, notAfter: sealedTemplate.notAfter }, terminalProjection: { mode: 'result-document', schema: s.schemas['occurrence:o1'] } });
    expect(payload.sealed).toBe(sealedTemplate.template);
    expect([row.status, row.request, s.rejected]).toEqual(['processing', '', []]);
  });

  it('fails and ends a Turn with no template or a changed Agent, with one projection, and never blocks it', () => {
    for (const [s, options, reason] of [
      [sealedState(), sealedOptions(() => undefined), 'sealed_routine_template_missing'],
      [sealedState(), { ...OPTIONS }, 'sealed_routine_template_missing'],
      [sealedState('2'), sealedOptions(), 'sealed_routine_agent_changed'],
    ] as const) {
      const row = turn(s, { id: 'occurrence:o1', root: 'occurrence:o1', source: 'routine', request: '', status: 'queued', sealedRoutine: ref });
      const out = published();
      expect(syncTurn(s, row, facts(), options, out.publish)).toEqual({ kind: 'ended' });
      expect([row.status, row.conclusion, row.blockedReason]).toEqual(['failed', 'failed', undefined]);
      expect(s.audit).toEqual([`Sealed routine Turn failed ${reason}: occurrence:o1`]);
      expect(out.rows).toEqual([[`sealed-routine-failed:occurrence:o1`, { owner: 'main', turnId: 'occurrence:o1', ...ref, reason,
        ...(reason === 'sealed_routine_agent_changed' ? { sealedAgentRef: agentRef } : {}),
        agentRef: { agentId: 'main', profileRevision: reason === 'sealed_routine_agent_changed' ? '2' : '1' } }]]);
      expect(syncTurn(s, row, facts(), options, out.publish)).toEqual({ kind: 'ended' });
      expect(out.rows).toHaveLength(1);
    }
  });

  it('blocks a Turn whose outcome schema stays over budget, with no sealed failure, and freezes it once the state shrinks', () => {
    // The schema size depends on the state, not on the routine version, so a reseal cannot fix it and the Turn waits.
    let oversized = true;
    const compose = protocol.composeBotTurnOutcomeSchema;
    const spy = vi.spyOn(protocol, 'composeBotTurnOutcomeSchema').mockImplementation((...args) => {
      if (oversized) throw new protocol.BotTurnOutcomeSchemaError('schema-over-budget', 'still too large');
      return compose(...args);
    });
    try {
      const s = sealedState(), out = published();
      const row = turn(s, { id: 'occurrence:o1', root: 'occurrence:o1', source: 'routine', request: '', status: 'queued', sealedRoutine: ref });
      expect(syncTurn(s, row, facts(), sealedOptions(), out.publish)).toBeUndefined();
      expect([row.status, row.conclusion, row.blockedReason]).toEqual(['blocked', undefined, 'Outcome schema over budget after flat fallback: still too large']);
      expect(out.rows.map(([id]) => id)).toEqual(['blocked:occurrence:o1']);
      oversized = false;
      expect(syncTurn(s, row, facts(), sealedOptions(), out.publish)?.kind).toBe('routine');
      expect([row.status, row.blockedReason]).toEqual(['processing', undefined]);
      expect(out.rows.map(([id]) => id)).toEqual(['blocked:occurrence:o1']);
    } finally { spy.mockRestore(); }
  });
});
