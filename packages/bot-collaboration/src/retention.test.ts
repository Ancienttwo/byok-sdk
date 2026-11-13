import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS, hash, occurrenceIntentKey, taskId, type ExecutionServer, type ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { template as baseTemplate } from './k4-fixtures.test-support';
import { BotCollaboration } from './host';
import { botCompactVeto } from './compaction';
import { RetentionRefused } from './retention';
import { migrateWouldDo, retainInLedger } from './commit';
import { stateOf } from './model';
import { inspectLedger } from './index';

// #798: the Host retention API on a real K4 ledger.
const base = baseTemplate('device');
const template: ExecutionTemplate = { ...base, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'k8' },
  payload: { ...base.payload, messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } };
const server = {
  executions: { submit: async () => ({}) },
  tasks: { offer: async () => undefined, deviceTerminal: async () => undefined, attempt: async () => undefined, cancel: async () => undefined },
  wakes: { pending: async () => [], schedule: async () => undefined, cancel: async () => undefined },
} as unknown as ExecutionServer;
const roots: string[] = [], closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('archives a settled root out of the window, replays its input, and refuses a root in use', async () => {
  let now = 1_000_000;
  const root = mkdtempSync(join(tmpdir(), 'k8-retain-')); roots.push(root);
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'tenant', { compactVeto: botCompactVeto });
  const bot = new BotCollaboration(server as never, ledger, { botId: 'main', execution: template, now: () => now, dreaming: false, contextTurnLimit: 1, handoff: { recentBytes: 200, earlyBytes: 0, totalBytes: 1024 }, connector: async () => ({}) });
  closers.push(() => ledger.close(), () => bot.close());
  const first = await bot.input('k1', 'hello');
  await bot.core.cancel(first);
  now += 1000; await bot.drain();
  expect(bot.snapshot().turns[first]).toMatchObject({ conclusion: 'cancelled', reported: true });
  const retention = { now, retentionMs: MIN_TOMBSTONE_RETENTION_MS };
  // The only Turn of the Bot is in its ContextPack window.
  const before = ledger.snapshot();
  await expect(bot.retain({ acknowledgedRoots: [first], ...retention })).rejects.toThrow(RetentionRefused);
  expect(ledger.snapshot()).toEqual(before);
  const second = await bot.input('k2', 'next');
  await expect(bot.retain({ acknowledgedRoots: [second], ...retention })).rejects.toThrow('Retention refused: A Turn of the root is not concluded');
  expect(await bot.retain({ acknowledgedRoots: [first], ...retention })).toMatchObject({ archivedRoots: 1, archivedCommands: 1 });
  const state = bot.snapshot();
  expect(state.turns[first]).toBeUndefined();
  expect(state.commands?.[hash(['input', 'main', 'k1'])]).toBeUndefined();
  const revision = state.revision;
  // #1407: the moved record still answers inputRoot, and the read changes no ledger state.
  const archived = ledger.snapshot();
  expect(bot.inputRoot('k1')).toBe(first);
  expect(ledger.snapshot()).toEqual(archived);
  // A retry of the owner input replays its moved record.
  expect(await bot.input('k1', 'hello')).toBe(first);
  expect(bot.snapshot().revision).toBe(revision);
  expect(bot.snapshot().turns[first]).toBeUndefined();
  // K4 can still compact the archived Turn's intent: the veto sees no Turn.
  await bot.core.flushProjections(async () => {});
  expect(ledger.compact({ acknowledgedIntentKeys: [first], ...retention, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ compactedIntents: 1 });
  await bot.drain();
  expect(bot.snapshot().turns[first]).toBeUndefined();
});

it('reads the root of an input whose drain threw, without a drain or a write, also after a restart (#1407)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'k8-input-root-')), file = join(root, 'host.sqlite'); roots.push(root);
  const options = { botId: 'main', execution: template, connector: async () => ({}) };
  const open = () => { const ledger = new HostLedger(file, 'tenant', { compactVeto: botCompactVeto });
    return { ledger, bot: new BotCollaboration(server as never, ledger, options) }; };
  const { ledger, bot } = open();
  const drain = vi.spyOn(bot as unknown as { process(): Promise<void> }, 'process').mockRejectedValueOnce(new Error('drain failed'));
  await expect(bot.input('k1', 'hello')).rejects.toThrow('drain failed');
  const before = ledger.snapshot(), turn = bot.inputRoot('k1');
  expect([turn && bot.snapshot().turns[turn]?.source, bot.inputRoot('k2'), drain.mock.calls.length]).toEqual(['user', undefined, 1]);
  expect(ledger.snapshot()).toEqual(before);
  await bot.close(); ledger.close();
  const restarted = open(); closers.push(() => restarted.ledger.close(), () => restarted.bot.close());
  expect([restarted.bot.inputRoot('k1'), restarted.bot.inputRoot('k2')]).toEqual([turn, undefined]);
});

it('L: refuses a Turn that still has its K4 intent and is not reported, and a routine Turn with an open occurrence', () => {
  const root = mkdtempSync(join(tmpdir(), 'k8-retain-')); roots.push(root);
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'tenant'); closers.push(() => ledger.close());
  const occurrenceKey = hash(['routine', 1, 'slot']), routineTurn = occurrenceIntentKey(occurrenceKey);
  const settled = (id: string, source: 'user' | 'routine' = 'user') => ({ id, root: id, botId: 'main', source, request: id, hop: 0,
    status: 'succeeded' as const, conclusion: 'succeeded', authority: 'owner' as const });
  ledger.transaction(s => {
    const state = stateOf(s.application);
    state.turns.a = settled('a');
    state.turns[routineTurn] = { ...settled(routineTurn, 'routine'), reported: true };
    state.turns.newest = { ...settled('newest'), reported: true };
    // Only the facts that retention reads: the intent row exists, the occurrence has no conclusion.
    (s.intents as Record<string, unknown>)[hash('a')] = { id: hash('a'), key: 'a' };
    (s.occurrences as Record<string, unknown>)[occurrenceKey] = { key: occurrenceKey };
  });
  const retain = (roots: string[]) => retainInLedger(ledger, { acknowledgedRoots: roots, now: 10_000, retentionMs: MIN_TOMBSTONE_RETENTION_MS }, { contextTurnLimit: 1, handoff: { recentBytes: 200, earlyBytes: 0, totalBytes: 1024 } });
  const before = ledger.snapshot();
  expect(() => retain(['a'])).toThrow('Retention refused: A Turn of the root is not reported');
  expect(() => retain([routineTurn])).toThrow('Retention refused: A routine occurrence of the root is open');
  expect(ledger.snapshot()).toEqual(before);
  ledger.transaction(s => {
    stateOf(s.application).turns.a!.reported = true;
    (s.occurrences as Record<string, { conclusion?: string }>)[occurrenceKey]!.conclusion = 'succeeded';
  });
  expect(retain(['a', routineTurn])).toMatchObject({ archivedRoots: 2 });
});

it('L: migrateWouldDo gives each row the Turn of its task id over every generation, and archives and counts a row with no live Turn (#1756)', () => {
  const root = mkdtempSync(join(tmpdir(), 'k8-would-do-')); roots.push(root);
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'tenant'); closers.push(() => ledger.close());
  const row = (id: string, task: string) => ({ id, botId: 'main', taskId: task, action: 'delegate', index: 0, at: 0, detail: null });
  ledger.transaction(s => {
    const state = stateOf(s.application);
    state.turns.a = { id: 'a', root: 'a', botId: 'main', source: 'user', request: 'a', hop: 0, status: 'succeeded', conclusion: 'succeeded', authority: 'owner' };
    (s.intents as Record<string, unknown>)[hash('a')] = { id: hash('a'), key: 'a', generation: 1 };
    state.wouldDo = { w0: row('w0', taskId('a', 0)), w1: row('w1', taskId('a', 1)), gone: row('gone', taskId('b', 0)) } as never;
  });
  const file = join(root, 'host.sqlite');
  const files = () => Object.fromEntries(readdirSync(root).sort().map(name => [name, readFileSync(join(root, name)).toString('hex')]));
  const before = files();
  expect(inspectLedger(file, 'tenant')).toMatchObject({ verdict: 'migration-required', reason: expect.stringContaining('turnId') });
  expect(files()).toEqual(before);
  expect(inspectLedger(join(root, 'missing'), 'tenant').verdict).toBe('absent');
  expect(migrateWouldDo(ledger)).toEqual({ backfilled: 2, archived: 1 });
  expect(inspectLedger(file, 'tenant').verdict).toBe('accepted');
  expect(Object.values(stateOf(ledger.snapshot().application).wouldDo ?? {}).map(r => [r.id, r.turnId])).toEqual([['w0', 'a'], ['w1', 'a']]);
  expect(ledger.transaction((_, rows) => rows.get('wouldDo', 'gone'))).toEqual(row('gone', taskId('b', 0)));
  expect(migrateWouldDo(ledger)).toEqual({ backfilled: 0, archived: 0 });
  for (const version of [2, 999]) {
    ledger.transaction(s => { (s.application.collaboration as { version: number }).version = version; });
    const unsupported = files();
    expect(inspectLedger(file, 'tenant').verdict).toBe('rejected');
    expect(files()).toEqual(unsupported);
  }
  ledger.transaction(s => { s.version = 999 as 1; });
  expect(inspectLedger(file, 'tenant').verdict).toBe('rejected');
  const damaged = join(root, 'damaged.sqlite'); writeFileSync(damaged, 'not sqlite');
  expect(inspectLedger(damaged, 'tenant').verdict).toBe('rejected');
});
