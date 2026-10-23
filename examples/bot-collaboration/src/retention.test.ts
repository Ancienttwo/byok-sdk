import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS, hash, type ExecutionServer, type ExecutionTemplate } from '@byok-sdk/example-host-execution-core';
import { template as k4template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration } from './host';
import { botCompactVeto } from './compaction';
import { RetentionRefused } from './retention';

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
