import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import { enqueue, hash, HostLedger, type LedgerState } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { addTurn, stateOf, type CollaborationState, type Turn } from './model';
import { admitUserInput, batchRequest, COALESCE_DEFAULTS, coalescePolicy, sealBatchForCancel, sealDueBatches, type CoalescePolicy } from './coalesce';
import { botCompactVeto } from './compaction';

const POLICY: CoalescePolicy = { ...COALESCE_DEFAULTS };
const BOUNDARIES: Turn['source'][] = ['answer', 'action_result', 'routine', 'room_slot', 'bot_request', 'bot_reply', 'continuation'];
const idOf = (key: string, botId = 'main') => hash(['user', botId, key]);
const owner = (key: string, request: string, botId = 'main') => ({ id: idOf(key, botId), key, botId, request, sender: 'owner', authority: 'owner' as const });
function team(...bots: string[]): CollaborationState {
  const state = stateOf({});
  for (const id of ['main', ...bots]) state.team.bots[id] = { id, name: id, role: 'Bot', persona: '', model: 'default', mainBot: id === 'main',
    archived: false, revision: '1', readyRevision: '1', execution: template('device', id) };
  return state;
}
/** A Turn without a conclusion keeps the Bot busy. */
function occupy(state: CollaborationState, botId = 'main'): Turn {
  return addTurn(state, { id: `running-${botId}`, root: `running-${botId}`, source: 'user', request: 'running', botId, hop: 0, authority: 'owner' });
}
function conclude(turn: Turn, conclusion = 'succeeded'): void { turn.status = conclusion === 'succeeded' ? 'succeeded' : 'failed'; turn.conclusion = conclusion; }

let root: string | undefined;
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
/** Real SDK server and Host ledger without a device: an offer freezes its input and then waits. */
async function host(options: Partial<BotOptions>, name: string) {
  root ??= await mkdtemp(path.join(tmpdir(), 'bot-coalesce-'));
  const ledger = new HostLedger(path.join(root, `${name}.sqlite`), 'coalesce-test', { compactVeto: botCompactVeto });
  const server = createByokServer({ productId: 'coalesce-test', storage: { kind: 'sqlite', path: path.join(root, `${name}-server.sqlite`) }, wake: { consume: async () => {} } });
  closers.push(() => ledger.close(), () => server.close());
  const bot = new BotCollaboration(server, ledger, { botId: 'main', execution: template('device'), connector: async () => null, ...options });
  closers.push(() => bot.close());
  return { bot, ledger };
}

it('validates the policy at construction and applies the ruled defaults', async () => {
  expect(coalescePolicy({}, 32 * 1024)).toEqual({ windowMs: 10_000, maxItems: 8, maxBytes: 8192 });
  expect(coalescePolicy({ windowMs: 1000, maxItems: 16, maxBytes: 1024 }, 32 * 1024)).toEqual({ windowMs: 1000, maxItems: 16, maxBytes: 1024 });
  for (const [options, message] of [
    [{ windowMs: 999 }, 'coalesce.windowMs must be an integer from 1000 to 60000'], [{ windowMs: 60_001 }, 'coalesce.windowMs must be an integer from 1000 to 60000'],
    [{ windowMs: 1000.5 }, 'coalesce.windowMs must be an integer from 1000 to 60000'],
    [{ maxItems: 1 }, 'coalesce.maxItems must be an integer from 2 to 16'], [{ maxItems: 17 }, 'coalesce.maxItems must be an integer from 2 to 16'],
    [{ maxBytes: 1023 }, 'coalesce.maxBytes must be an integer from 1024 to 8192'], [{ maxBytes: 8193 }, 'coalesce.maxBytes must be an integer from 1024 to 8192'],
  ] as const) expect(() => coalescePolicy(options, 32 * 1024)).toThrow(message);
  // The bound follows the configured ContextPack budget: maxBytes <= floor(contextMaxBytes / 4).
  await expect(host({ contextMaxBytes: 16_384, coalesce: {} }, 'over')).rejects.toThrow('coalesce.maxBytes must be an integer from 1024 to 4096');
  await host({ contextMaxBytes: 16_384, coalesce: { maxBytes: 4096 } }, 'fits');
});

it('without a policy keeps the K8a state change byte for byte (S1)', () => {
  const state = team(); occupy(state);
  const legacy = structuredClone(state);
  for (const [key, request] of [['a', 'first'], ['b', 'second'], ['a', 'first']] as const) {
    expect(admitUserInput(state, owner(key, request), undefined, 1000)).toBe(idOf(key));
    // The K8a input transaction, verbatim.
    const id = idOf(key), old = legacy.turns[id];
    if (old && old.request !== request) throw new Error('Input identity conflict');
    legacy.budgets[id] ??= { continuation: 0, delegation: 0 };
    addTurn(legacy, { id, root: id, source: 'user', request, botId: 'main', hop: 0, authority: 'owner' });
  }
  expect(JSON.stringify(state)).toBe(JSON.stringify(legacy));
  expect(state).not.toHaveProperty('inputs');
  expect(state).not.toHaveProperty('inputBatches');
  expect(() => admitUserInput(state, owner('a', 'changed'), undefined, 1000)).toThrow('Input identity conflict');
  sealDueBatches(state, undefined, 2000);
  expect(JSON.stringify(state)).toBe(JSON.stringify(legacy));
});

it('takes the first input of an idle Bot at once, with the same Turn id and Request (S2)', () => {
  const state = team(), id = idOf('a');
  expect(admitUserInput(state, owner('a', 'hello'), POLICY, 1000)).toBe(id);
  expect(state.turns[id]).toEqual({ id, root: id, source: 'user', request: 'hello', botId: 'main', hop: 0, authority: 'owner', inputIds: [id], status: 'queued' });
  expect(state.inputs![id]).toEqual({ id, key: 'a', botId: 'main', request: 'hello', sender: 'owner', authority: 'owner', bytes: 5, receivedAt: 1000, batchId: id });
  expect(state.inputBatches![id]).toEqual({ id, botId: 'main', key: expect.any(String), inputIds: [id], bytes: 5,
    openedAt: 1000, sealAt: 11_000, state: 'sealed', sealReason: 'idle' });
  expect(state.inputBatches![id]).not.toHaveProperty('request');
});

it('freezes the same intent key and instruction for an idle first input as without coalescing (S2)', async () => {
  const frozen = async (name: string, coalesce?: BotOptions['coalesce']) => {
    const { bot, ledger } = await host(coalesce ? { coalesce } : {}, name);
    const id = await bot.input('first', 'Plan my day');
    const intent = bot.core.intent(id)!;
    return { id, key: intent.key, instruction: ledger.snapshot().executions[intent.taskId]!.input.payload.instruction, turn: bot.snapshot().turns[id]! };
  };
  const off = await frozen('off'), on = await frozen('on', {});
  expect(on.id).toBe(idOf('first'));
  expect([on.id, on.key, off.key]).toEqual([off.id, off.id, off.id]);
  expect(on.instruction).toBe(off.instruction);
  expect(on.turn).toEqual({ ...off.turn, inputIds: [off.id] });
});

it('blocks one input over the ContextPack budget as before: raw, unframed and visible (S7)', async () => {
  const { bot } = await host({ contextMaxBytes: 4096, coalesce: { maxBytes: 1024 } }, 'large');
  const id = await bot.input('too-large', 'z'.repeat(5000));
  expect(bot.snapshot().turns[id]).toMatchObject({ status: 'blocked', request: 'z'.repeat(5000), inputIds: [id],
    blockedReason: expect.stringContaining('budget is 4096 bytes') });
  expect(bot.core.intent(id)).toBeUndefined();
});

it('merges consecutive inputs to a busy Bot into one batch Turn with framed messages (S3)', () => {
  const state = team(), running = occupy(state);
  const [a, b, c] = ['a', 'b', 'c'].map(key => idOf(key));
  expect([admitUserInput(state, owner('a', 'first'), POLICY, 1000), admitUserInput(state, owner('b', 'second'), POLICY, 2000),
    admitUserInput(state, owner('c', 'third 😀'), POLICY, 3000)]).toEqual([a, a, a]);
  expect(state.turns[a!]).toBeUndefined();
  expect(state.inputBatches![a!]).toMatchObject({ state: 'open', inputIds: [a, b, c], openedAt: 1000, sealAt: 11_000 });
  expect([b, c].map(id => state.inputs![id!]!.batchId)).toEqual([a, a]);
  sealDueBatches(state, POLICY, 4000);
  expect(state.inputBatches![a!]!.state).toBe('open');
  conclude(running);
  sealDueBatches(state, POLICY, 4000);
  const turn = state.turns[a!]!;
  expect(turn).toMatchObject({ id: a, root: a, source: 'user', botId: 'main', hop: 0, authority: 'owner', inputIds: [a, b, c] });
  expect(turn.request).toBe([
    'The owner sent 3 messages while you were busy. Read them in order and answer them together.',
    `--- message 1/3 (5 bytes) ---\n{"inputId":"${a}","receivedAt":1000}\nfirst\n--- end message 1/3 ---`,
    `--- message 2/3 (6 bytes) ---\n{"inputId":"${b}","receivedAt":2000}\nsecond\n--- end message 2/3 ---`,
    `--- message 3/3 (10 bytes) ---\n{"inputId":"${c}","receivedAt":3000}\nthird 😀\n--- end message 3/3 ---`,
  ].join('\n'));
  expect(state.inputBatches![a!]).toEqual({ id: a, botId: 'main', key: expect.any(String), inputIds: [a, b, c],
    bytes: Buffer.byteLength(turn.request), openedAt: 1000, sealAt: 11_000, state: 'sealed', sealReason: 'idle' });
});

it('counts the window from the first input; a later input never extends it (S4)', () => {
  const state = team(); occupy(state);
  const [a, b, c] = ['a', 'b', 'c'].map(key => idOf(key));
  admitUserInput(state, owner('a', 'first'), POLICY, 1000);
  expect(admitUserInput(state, owner('b', 'second'), POLICY, 10_999)).toBe(a);
  expect(state.inputBatches![a!]!.sealAt).toBe(11_000);
  // The window is due when c arrives, so c starts the next batch.
  expect(admitUserInput(state, owner('c', 'third'), POLICY, 11_000)).toBe(c);
  expect(state.inputBatches![a!]).toMatchObject({ state: 'sealed', sealReason: 'window', inputIds: [a, b] });
  expect(state.inputBatches![c!]).toMatchObject({ state: 'open', openedAt: 11_000, sealAt: 21_000 });
  sealDueBatches(state, POLICY, 20_999);
  expect(state.inputBatches![c!]!.state).toBe('open');
  sealDueBatches(state, POLICY, 21_000);
  expect(state.inputBatches![c!]).toMatchObject({ state: 'sealed', sealReason: 'window', inputIds: [c] });
});

it('seals the open batch as soon as the Bot is idle, before the window ends (S4)', () => {
  for (const finish of [(turn: Turn) => conclude(turn, 'failed'), (turn: Turn) => { turn.status = 'blocked'; }]) {
    const state = team(), running = occupy(state), a = idOf('a');
    admitUserInput(state, owner('a', 'first'), POLICY, 1000);
    sealDueBatches(state, POLICY, 1500);
    expect(state.inputBatches![a]!.state).toBe('open');
    finish(running);
    sealDueBatches(state, POLICY, 1501);
    expect(state.inputBatches![a]).toMatchObject({ state: 'sealed', sealReason: 'idle', sealAt: 11_000 });
    expect(state.turns[a]).toMatchObject({ request: 'first', inputIds: [a] });
  }
});

it('opens a new batch at the item cap and drops no input (S7)', () => {
  const state = team(); occupy(state);
  const ids = Array.from({ length: 9 }, (_, n) => idOf(`m${n}`));
  const turns = ids.map((_, n) => admitUserInput(state, owner(`m${n}`, `message ${n}`), POLICY, 1000 + n));
  expect(turns).toEqual([...Array(8).fill(ids[0]), ids[8]]);
  expect(state.inputBatches![ids[0]!]).toMatchObject({ state: 'sealed', sealReason: 'items', inputIds: ids.slice(0, 8) });
  expect(state.inputBatches![ids[8]!]).toMatchObject({ state: 'open', inputIds: [ids[8]] });
  expect(state.turns[ids[0]!]!.request).toContain('The owner sent 8 messages');
  expect(ids.map(id => state.inputs![id]!.batchId)).toEqual(turns);
});

it('seals before a merged Request passes maxBytes; a long single input stays unframed alone (S7, S9)', () => {
  const policy = { ...POLICY, maxBytes: 1024 };
  const state = team(); occupy(state);
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(key => idOf(key));
  admitUserInput(state, owner('a', 'x'.repeat(300)), policy, 1000);
  expect(admitUserInput(state, owner('b', 'x'.repeat(300)), policy, 1001)).toBe(a);
  const pair = state.inputBatches![a!]!;
  expect(pair.bytes).toBe(Buffer.byteLength(pair.request!));
  expect(pair.bytes).toBeLessThanOrEqual(1024);
  const third = owner('c', 'x'.repeat(300));
  expect(Buffer.byteLength(batchRequest([...pair.inputIds.map(id => state.inputs![id]!), { ...third, bytes: 300, receivedAt: 1002, batchId: a! }]))).toBeGreaterThan(1024);
  expect(admitUserInput(state, third, policy, 1002)).toBe(c);
  expect(state.inputBatches![a!]).toMatchObject({ state: 'sealed', sealReason: 'bytes', inputIds: [a, b] });
  expect(Buffer.byteLength(state.turns[a!]!.request)).toBeLessThanOrEqual(1024);
  // A long input seals the open batch and stays alone and raw. The next input starts another batch.
  const long = '长'.repeat(1000);
  expect(admitUserInput(state, owner('d', long), policy, 1003)).toBe(d);
  expect(state.inputBatches![c!]).toMatchObject({ state: 'sealed', sealReason: 'bytes', inputIds: [c] });
  expect(admitUserInput(state, owner('e', 'short'), policy, 1004)).toBe(e);
  expect(state.inputBatches![d!]).toMatchObject({ state: 'sealed', sealReason: 'bytes', inputIds: [d], bytes: 3000 });
  expect(state.turns[d!]!.request).toBe(long);
  expect(Object.values(state.inputs!).map(input => input.batchId)).toEqual([a, a, c, d, e]);
});

it('does not merge inputs with another sender, authority, Bot or Bot configuration (S5)', () => {
  const state = team('other'); occupy(state); occupy(state, 'other');
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(key => idOf(key));
  admitUserInput(state, owner('a', 'owner text'), POLICY, 1000);
  expect(admitUserInput(state, { ...owner('b', 'guest text'), sender: 'guest' }, POLICY, 1001)).toBe(b);
  expect(admitUserInput(state, { ...owner('c', 'bot text'), authority: 'bot' }, POLICY, 1002)).toBe(c);
  expect([a, b].map(id => state.inputBatches![id!]!.sealReason)).toEqual(['key_changed', 'key_changed']);
  // Another Bot has its own batch. It does not seal this Bot's batch.
  const other = idOf('x', 'other');
  expect(admitUserInput(state, owner('x', 'to other', 'other'), POLICY, 1003)).toBe(other);
  expect(state.inputBatches![c!]!.state).toBe('open');
  // A profile revision or model change seals at the next sync, and a new input after it starts a new batch.
  expect(admitUserInput(state, owner('d', 'before update'), POLICY, 1004)).toBe(d);
  state.team.bots.main!.revision = '2';
  sealDueBatches(state, POLICY, 1005);
  expect(state.inputBatches![d!]).toMatchObject({ state: 'sealed', sealReason: 'key_changed' });
  expect(state.inputBatches![other]!.state).toBe('open');
  expect(admitUserInput(state, owner('e', 'after update'), POLICY, 1006)).toBe(e);
  state.team.bots.main!.model = 'large';
  expect(admitUserInput(state, owner('f', 'after model change'), POLICY, 1007)).toBe(idOf('f'));
  expect(state.inputBatches![e!]).toMatchObject({ state: 'sealed', sealReason: 'key_changed', inputIds: [e] });
});

it('seals the open batch before any other new Turn of its Bot, so the queue keeps arrival order (S5)', () => {
  for (const source of BOUNDARIES) {
    const state = team('other'); occupy(state);
    const a = idOf('a');
    admitUserInput(state, owner('a', 'first'), POLICY, 1000);
    addTurn(state, { id: `${source}-other`, root: 'r', source, request: 'x', botId: 'other', hop: 0, authority: 'bot' });
    occupy(state);
    expect(state.inputBatches![a]!.state).toBe('open');
    addTurn(state, { id: source, root: 'r', source, request: 'x', botId: 'main', hop: 0, authority: 'bot' });
    expect(state.inputBatches![a]).toMatchObject({ state: 'sealed', sealReason: 'boundary' });
    expect(Object.keys(state.turns)).toEqual(['running-main', `${source}-other`, a, source]);
  }
});

it('cancels a whole open batch through its id or a member id', () => {
  const state = team(); occupy(state);
  const [a, b] = ['a', 'b'].map(key => idOf(key));
  admitUserInput(state, owner('a', 'first'), POLICY, 1000);
  admitUserInput(state, owner('b', 'second'), POLICY, 1001);
  expect(sealBatchForCancel(state, b!)).toBe(a);
  expect(state.inputBatches![a!]).toMatchObject({ state: 'sealed', sealReason: 'cancel', inputIds: [a, b] });
  expect(state.turns[a!]!.inputIds).toEqual([a, b]);
  const sealed = JSON.stringify(state);
  expect([sealBatchForCancel(state, a!), sealBatchForCancel(state, b!), sealBatchForCancel(state, 'running-main')]).toEqual([a, a, 'running-main']);
  expect(JSON.stringify(state)).toBe(sealed);
});

it('replays an input to its batch Turn id and refuses a changed text (S8)', () => {
  const state = team(); occupy(state);
  const [a, b] = ['a', 'b'].map(key => idOf(key));
  admitUserInput(state, owner('a', 'first'), POLICY, 1000);
  admitUserInput(state, owner('b', 'second'), POLICY, 1001);
  expect(admitUserInput(state, owner('b', 'second'), POLICY, 1002)).toBe(a);
  expect(() => admitUserInput(state, owner('b', 'changed'), POLICY, 1002)).toThrow('Input identity conflict');
  sealDueBatches(state, POLICY, 20_000);
  for (const policy of [POLICY, undefined]) {
    expect(admitUserInput(state, owner('b', 'second'), policy, 20_001)).toBe(a);
    expect(admitUserInput(state, owner('a', 'first'), policy, 20_001)).toBe(a);
    expect(() => admitUserInput(state, owner('a', 'changed'), policy, 20_001)).toThrow('Input identity conflict');
  }
  expect(state.inputBatches![a!]!.inputIds).toEqual([a, b]);
  expect(Object.keys(state.turns)).toEqual(['running-main', a]);
  // A Turn from a time without coalescing replays as itself.
  const legacy = idOf('legacy');
  admitUserInput(state, owner('legacy', 'old'), undefined, 20_002);
  expect(admitUserInput(state, owner('legacy', 'old'), POLICY, 20_003)).toBe(legacy);
  expect(() => admitUserInput(state, owner('legacy', 'new'), POLICY, 20_003)).toThrow('Input identity conflict');
  expect(state.inputs![legacy]).toBeUndefined();
});

it('seals open batches when the policy is off or the Bot is archived', () => {
  const state = team('other'); occupy(state); occupy(state, 'other');
  const [a, b, x] = [idOf('a'), idOf('b'), idOf('x', 'other')];
  admitUserInput(state, owner('a', 'first'), POLICY, 1000);
  admitUserInput(state, owner('x', 'other first', 'other'), POLICY, 1000);
  // The policy is off after a restart: the open batch seals before the next input's own Turn.
  expect(admitUserInput(state, owner('b', 'second'), undefined, 1001)).toBe(b);
  expect(state.inputBatches![a]).toMatchObject({ state: 'sealed', sealReason: 'policy_off' });
  expect(Object.keys(state.turns)).toEqual(['running-main', 'running-other', a, b]);
  state.team.bots.other!.archived = true;
  sealDueBatches(state, POLICY, 1002);
  expect(state.inputBatches![x]).toMatchObject({ state: 'sealed', sealReason: 'archived' });
});

it('keeps every input in one batch, arrival order, frozen intents and the byte cap under random interleaving', () => {
  const random = (seed: number) => () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const policy: CoalescePolicy = { windowMs: 10_000, maxItems: 3, maxBytes: 1024 };
  const bots = ['main', 'other'];
  for (let run = 0; run < 150; run++) {
    const next = random(run + 1), pick = <T>(rows: readonly T[]) => rows[Math.floor(next() * rows.length)]!;
    const state = team('other'), ledger = { version: 1, sequence: 0, scanSequence: 0, intents: {}, executions: {}, routines: {}, occurrences: {},
      slots: {}, outbox: {}, applied: {}, application: {}, scanWake: null } as LedgerState;
    const arrivals: Record<string, string[]> = { main: [], other: [] };
    let now = 1_000, serial = 0;
    // Sync stand-in: seal due batches, then enqueue in Turn insertion order with each Turn's frozen Request.
    // Enqueue again for Turns that already have an intent: a changed Turn throws Intent identity conflict.
    const sync = () => {
      sealDueBatches(state, policy, now);
      for (const turn of Object.values(state.turns)) {
        if (!ledger.intents[hash(turn.id)] && (turn.conclusion || turn.status === 'blocked')) continue;
        const execution = template('device', turn.botId);
        enqueue(ledger, 'tenant', { key: turn.id, source: turn.source === 'user' ? 'user' : 'bot', waitUntil: 1,
          execution: { ...execution, payload: { ...execution.payload, instruction: turn.request } } });
      }
    };
    for (let step = 0; step < 40; step++) {
      const botId = pick(bots), roll = next();
      if (roll < 0.45) {
        const key = `k${serial++}`, text = pick(['ok', 'x'.repeat(200), '长'.repeat(150), 'y'.repeat(1500)]);
        const id = admitUserInput(state, { ...owner(key, text, botId), sender: next() < 0.1 ? 'guest' : 'owner' }, policy, now);
        expect(state.inputs![idOf(key, botId)]!.batchId).toBe(id);
        arrivals[botId]!.push(idOf(key, botId));
      } else if (roll < 0.6) {
        const id = `boundary-${serial++}`;
        addTurn(state, { id, root: id, source: pick(BOUNDARIES), request: 'boundary', botId, hop: 0, authority: 'bot' });
        arrivals[botId]!.push(id);
      } else if (roll < 0.75) {
        const open = Object.values(state.turns).filter(turn => turn.botId === botId && !turn.conclusion && turn.status !== 'blocked');
        if (open.length) {
          const turn = pick(open);
          if (next() < 0.2) turn.status = 'blocked'; else conclude(turn);
        }
      } else if (roll < 0.85) {
        now += Math.floor(next() * 8000);
      } else if (roll < 0.9) {
        const ids = Object.keys(state.inputs ?? {});
        if (ids.length) {
          const target = sealBatchForCancel(state, pick(ids));
          if (!ledger.intents[hash(target)]) conclude(state.turns[target]!, 'cancelled');
        }
      } else if (roll < 0.93) {
        state.team.bots[botId]!.revision = String(Number(state.team.bots[botId]!.revision) + 1);
      } else sync();
      // Invariant: at most one open batch per Bot.
      for (const id of bots) expect(Object.values(state.inputBatches ?? {}).filter(b => b.botId === id && b.state === 'open').length).toBeLessThanOrEqual(1);
    }
    sealDueBatches(state, undefined, now);
    sync();
    // 1. Each input belongs to exactly one batch.
    for (const input of Object.values(state.inputs ?? {})) {
      expect(Object.values(state.inputBatches!).filter(batch => batch.inputIds.includes(input.id)).map(batch => batch.id)).toEqual([input.batchId]);
    }
    // 2. Batches expanded to members equal arrival order for each Bot: in Turn order, and in K4 queue order.
    const queue = Object.values(ledger.intents).sort((x, y) => x.sequence - y.sequence).map(intent => state.turns[intent.key]!);
    const turnOf = (id: string) => state.inputs?.[id]?.batchId ?? id;
    for (const botId of bots) {
      const expand = (turns: Turn[]) => turns.filter(turn => turn.botId === botId).flatMap(turn => turn.inputIds ?? [turn.id]);
      expect(expand(Object.values(state.turns))).toEqual(arrivals[botId]);
      expect(expand(queue)).toEqual(arrivals[botId]!.filter(id => ledger.intents[hash(turnOf(id))]));
    }
    // 4. A merged Request never exceeds maxBytes.
    for (const turn of Object.values(state.turns)) {
      if ((turn.inputIds?.length ?? 0) > 1) expect(Buffer.byteLength(turn.request)).toBeLessThanOrEqual(policy.maxBytes);
    }
  }
});
