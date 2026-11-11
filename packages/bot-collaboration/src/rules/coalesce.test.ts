import { expect, it } from 'vitest';
import { admitUserInput, COALESCE_DEFAULTS, sealAtBoundary, sealBatchForCancel, sealDueBatches, type BotFacts, type CoalescePolicy,
  type CoalesceState, type InputFields } from './coalesce';

// Plain input rows and Bot facts. The rules need no ledger and no Host.
const POLICY: CoalescePolicy = { ...COALESCE_DEFAULTS };
const IDLE: BotFacts = { busy: false, configKey: ['1', 'default'], archived: false };
const BUSY: BotFacts = { ...IDLE, busy: true };
const input = (id: string, request = id, fields: Partial<InputFields> = {}): InputFields =>
  ({ id, key: id, botId: 'main', request, sender: 'owner', authority: 'owner', ...fields });
function opened(...ids: string[]): CoalesceState {
  const state: CoalesceState = {};
  ids.forEach((id, index) => admitUserInput(state, input(id), { bot: BUSY }, POLICY, 1000 + index));
  return state;
}

it('seals the first input of an idle Bot at once and returns the fields of its Turn', () => {
  const state: CoalesceState = {};
  expect(admitUserInput(state, input('a', 'hello'), { bot: IDLE }, POLICY, 1000)).toEqual({ id: 'a', turn: false,
    sealed: [{ id: 'a', botId: 'main', request: 'hello', authority: 'owner', inputIds: ['a'] }] });
  expect(state.inputBatches!.a).toMatchObject({ state: 'sealed', sealReason: 'idle', openedAt: 1000, sealAt: 11_000 });
  expect(state.inputBatches!.a).not.toHaveProperty('request');
});

it('merges the inputs to a busy Bot into one open batch and seals it when the Bot is idle', () => {
  const state = opened('a', 'b');
  expect(state.inputBatches!.a).toMatchObject({ state: 'open', inputIds: ['a', 'b'] });
  expect([state.inputs!.a!.batchId, state.inputs!.b!.batchId]).toEqual(['a', 'a']);
  expect(sealDueBatches(state, { main: BUSY }, POLICY, 3000)).toEqual([]);
  const [turn] = sealDueBatches(state, { main: IDLE }, POLICY, 3000);
  expect(turn).toMatchObject({ id: 'a', botId: 'main', authority: 'owner', inputIds: ['a', 'b'] });
  expect(turn!.request).toContain('The owner sent 2 messages while you were busy.');
  expect(state.inputBatches!.a).toMatchObject({ state: 'sealed', sealReason: 'idle' });
});

it('counts a batch that the same call seals as queued work, so the new batch stays open', () => {
  const state = opened('a');
  expect(admitUserInput(state, input('b'), { bot: { ...IDLE, configKey: ['2', 'default'] } }, POLICY, 2000)).toEqual({ id: 'b', turn: false,
    sealed: [{ id: 'a', botId: 'main', request: 'a', authority: 'owner', inputIds: ['a'] }] });
  expect(state.inputBatches!.a).toMatchObject({ state: 'sealed', sealReason: 'key_changed' });
  expect(state.inputBatches!.b).toMatchObject({ state: 'open', inputIds: ['b'] });
});

it('seals the open batch of a Bot at the boundary of its next Turn and leaves other Bots alone', () => {
  const state = opened('a');
  admitUserInput(state, input('x', 'x', { botId: 'other' }), { bot: BUSY }, POLICY, 1001);
  expect(sealAtBoundary(state, 'main')).toEqual({ id: 'a', botId: 'main', request: 'a', authority: 'owner', inputIds: ['a'] });
  expect(state.inputBatches!.a).toMatchObject({ state: 'sealed', sealReason: 'boundary' });
  expect(state.inputBatches!.x!.state).toBe('open');
  expect(sealAtBoundary(state, 'main')).toBeUndefined();
});

it('seals a due batch at the window, a configuration change, an archived or absent Bot and a disabled policy', () => {
  const cases: Array<[Record<string, BotFacts>, CoalescePolicy | undefined, number, string]> = [
    [{ main: BUSY }, POLICY, 11_000, 'window'], [{ main: { ...BUSY, configKey: ['2', 'default'] } }, POLICY, 1001, 'key_changed'],
    [{ main: { ...BUSY, archived: true } }, POLICY, 1001, 'archived'], [{}, POLICY, 1001, 'archived'], [{ main: BUSY }, undefined, 1001, 'policy_off'],
  ];
  for (const [bots, policy, now, reason] of cases) {
    const state = opened('a');
    expect(sealDueBatches(state, bots, policy, now).map(turn => turn.id)).toEqual(['a']);
    expect(state.inputBatches!.a).toMatchObject({ state: 'sealed', sealReason: reason });
  }
  const state = opened('a');
  expect(sealDueBatches(state, { main: BUSY }, POLICY, 10_999)).toEqual([]);
  expect(state.inputBatches!.a!.state).toBe('open');
});

it('replays an input to its batch, keeps an own Turn without a policy or for an older Turn, and refuses changed text', () => {
  const state = opened('a', 'b');
  expect(admitUserInput(state, input('b'), { bot: IDLE }, undefined, 2000)).toEqual({ id: 'a', turn: false, sealed: [] });
  expect(() => admitUserInput(state, input('b', 'changed'), { bot: BUSY }, POLICY, 2000)).toThrow('Input identity conflict');
  expect(admitUserInput(state, input('old'), { bot: BUSY, turn: { request: 'old' } }, POLICY, 2001)).toEqual({ id: 'old', turn: true, sealed: [] });
  expect(() => admitUserInput(state, input('old', 'new'), { bot: BUSY, turn: { request: 'old' } }, POLICY, 2001)).toThrow('Input identity conflict');
  expect(admitUserInput(state, input('c'), { bot: BUSY }, undefined, 2002)).toEqual({ id: 'c', turn: true, sealed: [{ id: 'a', botId: 'main',
    request: expect.stringContaining('The owner sent 2 messages'), authority: 'owner', inputIds: ['a', 'b'] }] });
  expect(state.inputBatches!.a!.sealReason).toBe('policy_off');
  expect(Object.keys(state.inputs!)).toEqual(['a', 'b']);
});

it('seals a whole open batch for a cancel through its id or a member id', () => {
  const state = opened('a', 'b');
  expect(sealBatchForCancel(state, 'b')).toEqual({ id: 'a', sealed: { id: 'a', botId: 'main', request: expect.any(String), authority: 'owner', inputIds: ['a', 'b'] } });
  expect(state.inputBatches!.a).toMatchObject({ state: 'sealed', sealReason: 'cancel' });
  expect([sealBatchForCancel(state, 'a'), sealBatchForCancel(state, 'other')]).toEqual([{ id: 'a' }, { id: 'other' }]);
});
