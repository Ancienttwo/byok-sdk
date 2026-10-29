import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompactVetoError, HostLedger, MIN_TOMBSTONE_RETENTION_MS, hash, type ExecutionServer, type ExecutionTemplate, type LedgerState } from '@byok-sdk/server/execution-core';
import { template as k4template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration } from './host';
import { botCompactVeto } from './compaction';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { stateOf, type Delegation, type Turn } from './model';
import { archiveBot } from './rules/team';

// #816: a K4 compaction of a Turn intent that K8 still reads.
const base = k4template('device');
const template: ExecutionTemplate = { ...base, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'k8' },
  payload: { ...base.payload, messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } };
const server = {
  executions: { submit: async () => ({}) },
  tasks: { offer: async () => undefined, deviceTerminal: async () => undefined, attempt: async () => undefined, cancel: async () => undefined },
  wakes: { pending: async () => [], schedule: async () => undefined, cancel: async () => undefined },
} as unknown as ExecutionServer;
const roots: string[] = [], closers: Array<() => Promise<void> | void> = [];
let fixture: TestTeam | undefined;
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await fixture?.close(); fixture = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function open(now: () => number) {
  const root = mkdtempSync(join(tmpdir(), 'k8-compact-')); roots.push(root);
  const file = join(root, 'host.sqlite'), ledger = new HostLedger(file, 'tenant', { compactVeto: botCompactVeto });
  const bot = new BotCollaboration(server as never, ledger, { botId: 'main', execution: template, now, connector: async () => ({}) });
  closers.push(() => ledger.close(), () => bot.close());
  /** A maintenance writer that opens the same file without the veto. */
  const unguarded = () => { const other = new HostLedger(file, 'tenant'); closers.push(() => other.close()); return other; };
  return { ledger, bot, unguarded };
}
const retention = (now: number) => ({ now, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS });
function refusal(run: () => unknown): unknown { try { run(); } catch (error) { return error; } return undefined; }

it('refuses to compact a Turn intent before K8 syncs its result, and the Host keeps working', async () => {
  let now = 1_000_000;
  const { ledger, bot } = open(() => now);
  const turnId = await bot.input('k1', 'hello');
  expect(ledger.snapshot().intents[hash(turnId)]?.phase).toBe('inflight');
  // K4 settles the intent in its own drain, outside a K8 pass.
  await bot.core.cancel(turnId);
  expect(ledger.snapshot().intents[hash(turnId)]).toMatchObject({ phase: 'settled', conclusion: 'cancelled' });
  expect(bot.snapshot().turns[turnId]).toMatchObject({ status: 'processing' });
  await bot.core.flushProjections(async () => {});
  const before = ledger.snapshot();
  const error = refusal(() => ledger.compact({ acknowledgedIntentKeys: [turnId], ...retention(now) }));
  expect(error).toBeInstanceOf(CompactVetoError);
  expect(error).toMatchObject({ intentKey: turnId, message: 'Compaction refused: The Turn is not concluded and reported' });
  expect(ledger.snapshot()).toEqual(before);
  expect(ledger.hasTombstone('intent', turnId, now)).toBe(false);
  now += 1000;
  await bot.drain();
  expect(bot.snapshot().turns[turnId]).toMatchObject({ status: 'failed', conclusion: 'cancelled', reported: true });
  await bot.core.flushProjections(async () => {});
  expect(ledger.compact({ acknowledgedIntentKeys: [turnId], ...retention(now) })).toMatchObject({ compactedIntents: 1 });
  await bot.drain();
  await bot.recover();
  const next = await bot.input('k2', 'next');
  expect(ledger.snapshot().intents[hash(next)]).toBeDefined();
});

it('fails a Turn whose intent a writer without the veto retired, and the Host keeps working', async () => {
  let now = 1_000_000;
  const { ledger, bot, unguarded } = open(() => now);
  const turnId = await bot.input('k1', 'hello');
  await bot.core.cancel(turnId);
  await bot.core.flushProjections(async () => {});
  expect(unguarded().compact({ acknowledgedIntentKeys: [turnId], ...retention(now) })).toMatchObject({ compactedIntents: 1 });
  now += 1000;
  await bot.drain();
  await bot.drain();
  await bot.recover();
  const state = bot.snapshot();
  // K8 never saw the K4 conclusion, so the Turn fails once, with an audit line and one report.
  expect(state.turns[turnId]).toMatchObject({ status: 'failed', conclusion: 'failed', reported: true });
  expect(state.audit.filter(line => line === `Turn result retired before sync: ${turnId}`)).toHaveLength(1);
  const reports = Object.values(ledger.snapshot().outbox).filter(row => row.kind === 'projection' && row.id === `bot-turn:${turnId}`);
  expect(reports).toEqual([expect.objectContaining({ value: expect.objectContaining({ conclusion: 'failed', reason: 'result_retired' }) })]);
  const next = await bot.input('k2', 'next');
  expect(ledger.snapshot().intents[hash(next)]).toBeDefined();
});

it('fails a retired Turn of a Bot archived before the next pass, and does not report it as cancelled', async () => {
  let now = 1_000_000;
  const { ledger, bot, unguarded } = open(() => now);
  const turnId = await bot.input('k1', 'hello');
  await bot.core.cancel(turnId);
  await bot.core.flushProjections(async () => {});
  expect(unguarded().compact({ acknowledgedIntentKeys: [turnId], ...retention(now) })).toMatchObject({ compactedIntents: 1 });
  // The archive only marks the Bot, as `delete_bot` does.
  ledger.transaction(s => { archiveBot(stateOf(s.application).team, 'main'); });
  now += 1000;
  await bot.drain();
  const state = bot.snapshot();
  expect(state.turns[turnId]).toMatchObject({ status: 'failed', conclusion: 'failed', reported: true });
  expect(state.audit).toContain(`Turn result retired before sync: ${turnId}`);
  const reports = Object.values(ledger.snapshot().outbox).filter(row => row.kind === 'projection' && row.id === `bot-turn:${turnId}`);
  expect(reports).toEqual([expect.objectContaining({ value: expect.objectContaining({ conclusion: 'failed', reason: 'result_retired' }) })]);
});

it('refuses a ledger opened without the K8 compact veto', () => {
  const root = mkdtempSync(join(tmpdir(), 'k8-compact-')); roots.push(root);
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'tenant'); closers.push(() => ledger.close());
  expect(() => new BotCollaboration(server as never, ledger, { botId: 'main', execution: template, connector: async () => ({}) }))
    .toThrow('Open the Host ledger with { compactVeto: botCompactVeto }');
  const other = new HostLedger(join(root, 'other.sqlite'), 'tenant', { compactVeto: (state, key) => botCompactVeto(state, key) });
  closers.push(() => other.close());
  expect(() => new BotCollaboration(server as never, other, { botId: 'main', execution: template, connector: async () => ({}) }))
    .toThrow('Open the Host ledger with { compactVeto: botCompactVeto }');
});

it('keeps the chain intent of a reply_pending delegation, and its reply check survives a compaction without the veto', async () => {
  let offset = 0;
  fixture = await openTeam({ now: () => Date.now() + offset });
  const t = crossBot(() => fixture!);
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('pending', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Answer later' }] });
  const d = t.delegationOf(t.taskOf(root));
  await t.finish(d.id);
  expect(t.delegation(d.id)).toMatchObject({ status: 'reply_pending', checks: 1 });
  expect(t.host().snapshot().turns[d.id]).toMatchObject({ status: 'succeeded', reported: true });
  await t.host().core.flushProjections(async () => {});
  // The chain Turn is concluded and reported, but its open delegation still reads the intent.
  const before = fixture.ledger.snapshot();
  const error = refusal(() => fixture!.ledger.compact({ acknowledgedIntentKeys: [d.id], ...retention(Date.now()) }));
  expect(error).toMatchObject({ code: 'compact_vetoed', intentKey: d.id, message: 'Compaction refused: An unresolved delegation references the Turn' });
  expect(fixture.ledger.snapshot()).toEqual(before);
  expect(fixture.ledger.hasTombstone('intent', d.id, Date.now())).toBe(false);
  const other = new HostLedger(join(fixture.root, 'host.sqlite'), fixture.ledger.tenant); closers.push(() => other.close());
  expect(other.compact({ acknowledgedIntentKeys: [d.id], ...retention(Date.now()) })).toMatchObject({ compactedIntents: 1 });
  // The due reply check has no readback evidence. It retries and does not stop the pass.
  offset += 60_000;
  await t.host().drain();
  expect(t.delegation(d.id).checks).toBeGreaterThan(1);
  expect(t.delegation(d.id).verdict).toBeUndefined();
});

it('refuses each key that K8 still reads, and allows a settled Turn and a key without a Turn', () => {
  const ledger = { intents: {}, executions: {}, application: {} } as unknown as LedgerState;
  const state = stateOf(ledger.application);
  const turn = (id: string, fields: Partial<Turn> = {}) => {
    state.turns[id] = { id, root: id, botId: 'main', source: 'user', request: '', hop: 0, status: 'succeeded', conclusion: 'succeeded', reported: true, ...fields };
  };
  const intent = (id: string) => { (ledger.intents as Record<string, unknown>)[hash(id)] = { id: hash(id), key: id }; };
  const veto = (key: string) => botCompactVeto(ledger, key);
  turn('open', { status: 'processing', conclusion: undefined }); intent('open');
  turn('unreported', { reported: undefined }); intent('unreported');
  // A Turn that ended without an intent has nothing to report, for example an unpromoted routine Turn of an archived owner.
  turn('ended', { status: 'failed', conclusion: 'cancelled', reported: undefined });
  turn('chain'); turn('target'); turn('late'); turn('resolved');
  const delegation = (id: string, fields: Partial<Delegation>) => {
    state.delegations[id] = { id, root: 'r', fromBotId: 'main', fromTurnId: 'x', fromTaskId: 'x', index: 0, toBotId: 'b', request: '', hop: 1,
      chainTurnIds: [], batch: 'x', status: 'running', revision: 0, ...fields };
  };
  delegation('d1', { chainTurnIds: ['chain'] });
  delegation('d2', { chainTurnIds: ['other'], cancel: { requestedAt: 0, targetTurnId: 'target', delivered: true } });
  delegation('d3', { verdict: 'answered', status: 'resolved', chainTurnIds: ['resolved'], lateTurnId: 'late' });
  turn('seat'); state.team.seats.seat = { id: 'seat', roundId: 'round', botId: 'main', status: 'post', released: false, late: false };
  turn('receipt'); state.replies.task = { turnId: 'receipt', messageId: 'm', contentHash: 'h', contentType: 'text/markdown', acceptedAt: 0 };
  expect(veto('open')).toBe('The Turn is not concluded and reported');
  expect(veto('unreported')).toBe('The Turn is not concluded and reported');
  expect(veto('ended')).toBeUndefined();
  for (const key of ['chain', 'target', 'late']) expect(veto(key)).toBe('An unresolved delegation references the Turn');
  expect(veto('resolved')).toBeUndefined();
  expect(veto('seat')).toBe('The room seat of the Turn is not released');
  expect(veto('receipt')).toBe('The reply receipt of the Turn is not settled');
  (ledger.executions as Record<string, unknown>).task = { messageReceipt: { messageId: 'm', contentHash: 'h' } };
  expect(veto('receipt')).toBeUndefined();
  expect(veto('host-job')).toBeUndefined();
  expect(veto('constructor')).toBeUndefined();
});
