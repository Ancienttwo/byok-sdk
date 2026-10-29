import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS, hash, occurrenceIntentKey, type ExecutionServer, type ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { template as k4template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration } from './host';
import { botCompactVeto } from './compaction';
import { RetentionRefused } from './retention';
import { retainInLedger } from './commit';
import { stateOf } from './model';

// #798: the Host retention API on a real K4 ledger.
const base = k4template('device');
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
  const bot = new BotCollaboration(server as never, ledger, { botId: 'main', execution: template, now: () => now, contextTurnLimit: 1, connector: async () => ({}) });
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
  const retain = (roots: string[]) => retainInLedger(ledger, { acknowledgedRoots: roots, now: 10_000, retentionMs: MIN_TOMBSTONE_RETENTION_MS }, { contextTurnLimit: 1 });
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
