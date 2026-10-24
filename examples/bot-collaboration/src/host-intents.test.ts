import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS, type ExecutionServer, type IntentInput } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, IntentOutcomeError, type BotOptions, type HostIntentHandler } from './host';
import { botCompactVeto } from './compaction';

/**
 * #882: the Host's own K4 work on the Bot tenant's core. A fake server: a submitted task with the K4 test contract
 * completes at once unless `paused`; a Bot Turn task never completes, so its intent stays in flight.
 */
const submitted = new Map<string, { taskId: string; deviceId: string; payload: { agentRef: unknown; terminalProjection: { contract: string } } }>();
let paused = false;
const server = {
  executions: { submit: async (input: { taskId: string; deviceId: string; payload: { agentRef: unknown; terminalProjection: { contract: string } } }) => {
    submitted.set(input.taskId, input); return {};
  } },
  tasks: {
    offer: async (taskId: string) => {
      const input = submitted.get(taskId);
      return input && { taskId, deviceId: input.deviceId, type: 'task.offer_for_agent_with_egress_fresh', payload: input.payload, delivered: true };
    },
    deviceTerminal: async (taskId: string) => {
      const input = submitted.get(taskId);
      return input && !paused && input.payload.terminalProjection.contract === 'host-core-test-v1'
        ? { envelope: { type: 'task.complete', task_id: taskId, payload: { document: { summary: 'host research done' } } } } : undefined;
    },
    attempt: async (taskId: string) => {
      const input = submitted.get(taskId);
      return input && { taskId, deviceId: input.deviceId, agentRef: input.payload.agentRef, status: 'completed', claimedRuntime: 'r', ownerDeviceId: input.deviceId };
    },
    cancel: async () => undefined,
  },
  wakes: { pending: async () => [], schedule: async () => undefined, cancel: async () => undefined },
} as unknown as ExecutionServer;

let root: string | undefined, ledger: HostLedger | undefined, bot: BotCollaboration | undefined;
afterEach(async () => {
  await bot?.close(); ledger?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = ledger = bot = undefined; paused = false;
  submitted.clear();
});
function openBot(hostIntents: Record<string, HostIntentHandler>, extra: Partial<BotOptions> = {}): BotCollaboration {
  root ??= mkdtempSync(join(tmpdir(), 'k8-host-intents-'));
  ledger ??= new HostLedger(join(root, 'host.sqlite'), 'tenant', { compactVeto: botCompactVeto });
  return new BotCollaboration(server as never, ledger, { botId: 'main', execution: template('device'), connector: async () => null, hostIntents, ...extra });
}
async function restart(hostIntents: Record<string, HostIntentHandler>): Promise<BotCollaboration> {
  await bot!.close(); ledger!.close();
  bot = ledger = undefined;
  return openBot(hostIntents);
}
const KEY = 'host-research-1', WAIT_UNTIL = Date.now() + 600_000;
const input = (extra: Partial<IntentInput> = {}): IntentInput => ({ key: KEY, source: 'user', execution: template('device', 'research'), waitUntil: WAIT_UNTIL, ...extra });
const refusals = () => bot!.snapshot().audit.filter(row => row.startsWith('Intent outcome refused'));

it('settles a Host intent through its handler in the terminal transaction, and keeps the K8 revision', async () => {
  const seen: unknown[] = [];
  bot = openBot({ research: (document, tx) => { seen.push(document); tx.application.research = { done: true }; } });
  const revision = bot.snapshot().revision;
  const intent = await bot.enqueueHostIntent(input(), 'research');
  expect({ conclusion: intent.conclusion, seen, research: ledger!.snapshot().application.research, revision: bot.snapshot().revision })
    .toEqual({ conclusion: 'succeeded', seen: [{ summary: 'host research done' }], research: { done: true }, revision });
  expect(bot.snapshot().hostIntents).toEqual({ [KEY]: { handler: 'research' } });
  // An exact replay returns the settled intent, and the handler does not run again.
  expect((await bot.enqueueHostIntent(input(), 'research')).id).toBe(intent.id);
  expect(seen).toHaveLength(1);
});

it('refuses a handler name, a key or an execution that the Host intent cannot own', async () => {
  paused = true;
  bot = openBot({ research: () => {}, other: () => {} });
  await expect(bot.enqueueHostIntent(input(), 'missing')).rejects.toThrow('Unknown Host intent handler: missing');
  await expect(bot.enqueueHostIntent(input({ execution: { ...template('device', 'research'),
    payload: { ...template('device', 'research').payload, requiredToolsets: ['market.write'] } } }), 'research')).rejects.toThrow('market.write');
  await bot.enqueueHostIntent(input(), 'research');
  await expect(bot.enqueueHostIntent(input(), 'other')).rejects.toThrow('Host intent identity conflict');
  await expect(bot.enqueueHostIntent(input({ waitUntil: WAIT_UNTIL + 1 }), 'research')).rejects.toThrow('Intent identity conflict');
  const turnId = await bot.input('k1', 'hello');
  await expect(bot.enqueueHostIntent(input({ key: turnId }), 'research')).rejects.toThrow('the key is a Bot Turn');
  await bot.core.enqueue(input({ key: 'direct' }));
  await expect(bot.enqueueHostIntent(input({ key: 'direct' }), 'research')).rejects.toThrow('Host intent identity conflict');
});

it('rejects each drain for a terminal whose key K8 never wrote, and audits it once', async () => {
  bot = openBot({});
  // A direct `core.enqueue` is not a Host intent. Its success must not settle as a Bot outcome or as a silent success.
  await bot.core.enqueue(input());
  const refused = { name: 'IntentOutcomeError', key: KEY, code: 'unknown_intent', message: 'No Bot Turn or Host intent has this key' };
  await expect(bot.drain()).rejects.toMatchObject(refused);
  await expect(bot.drain()).rejects.toBeInstanceOf(IntentOutcomeError);
  // Every API that runs a pass rejects too, after its own commit.
  await expect(bot.input('k1', 'hello')).rejects.toMatchObject(refused);
  expect(bot.core.intent(KEY)).toMatchObject({ phase: 'inflight' });
  expect(bot.core.intent(KEY)?.conclusion).toBeUndefined();
  expect(refusals()).toEqual([`Intent outcome refused unknown_intent: ${KEY} No Bot Turn or Host intent has this key`]);
});

it('keeps a failed handler intent open across a restart, and a fixed handler settles it', async () => {
  bot = openBot({ research: () => { throw new Error('research store offline'); } });
  await expect(bot.enqueueHostIntent(input(), 'research')).rejects.toMatchObject({ code: 'handler_failed', message: 'research store offline' });
  await expect(bot.drain()).rejects.toMatchObject({ code: 'handler_failed' });
  expect(bot.core.intent(KEY)?.conclusion).toBeUndefined();
  expect(refusals()).toEqual([`Intent outcome refused handler_failed: ${KEY} research store offline`]);
  // The ledger stores the handler name, so a restart without that handler fails closed.
  await expect(restart({})).rejects.toThrow('An open Host intent needs the handler research');
  const seen: unknown[] = [];
  bot = openBot({ research: document => { seen.push(document); } });
  await bot.recover();
  await bot.drain();
  expect({ conclusion: bot.core.intent(KEY)?.conclusion, seen }).toEqual({ conclusion: 'succeeded', seen: [{ summary: 'host research done' }] });
});

it('refuses an async handler, and consumes its rejection', async () => {
  const unhandled: unknown[] = [], record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  onTestFinished(() => { process.off('unhandledRejection', record); });
  bot = openBot({ research: async () => { throw new Error('async research failed'); } });
  await expect(bot.enqueueHostIntent(input(), 'research')).rejects.toMatchObject({ code: 'handler_failed', message: 'Host intent handler must be synchronous' });
  expect(bot.core.intent(KEY)?.conclusion).toBeUndefined();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(unhandled).toEqual([]);
});

it('holds the Main Bot FIFO only until its Host intent settles', async () => {
  paused = true;
  bot = openBot({ research: () => {} });
  // The Main Bot's agentRef: one FIFO for the Host intent and the Bot's Turns.
  await bot.enqueueHostIntent(input({ execution: template('device') }), 'research');
  const turnId = await bot.input('k1', 'hello');
  const turnIntent = () => Object.values(ledger!.snapshot().intents).find(row => row.key === turnId);
  expect({ host: bot.core.intent(KEY)?.phase, turn: turnIntent()?.phase, submitted: submitted.size }).toEqual({ host: 'inflight', turn: 'queued', submitted: 1 });
  paused = false;
  await bot.drain();
  expect({ host: bot.core.intent(KEY)?.conclusion, turn: turnIntent()?.phase, submitted: submitted.size }).toEqual({ host: 'succeeded', turn: 'inflight', submitted: 2 });
});

it('removes the ownership record once K4 compacts the intent', async () => {
  bot = openBot({ research: () => {} });
  await bot.enqueueHostIntent(input(), 'research');
  await bot.core.flushProjections(async () => {});
  expect(ledger!.compact({ acknowledgedIntentKeys: [KEY], now: Date.now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ compactedIntents: 1 });
  await bot.drain();
  expect(bot.snapshot().hostIntents).toEqual({});
});

it('opens without the handler of a Host intent that K4 compacted before the next pass', async () => {
  bot = openBot({ research: () => {} });
  await bot.enqueueHostIntent(input(), 'research');
  await bot.core.flushProjections(async () => {});
  await bot.close(); bot = undefined;
  // No pass runs between this compaction and the restart, so the ownership record is still stored.
  ledger!.compact({ acknowledgedIntentKeys: [KEY], now: Date.now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS });
  bot = openBot({});
  expect(bot.snapshot().hostIntents).toEqual({ [KEY]: { handler: 'research' } });
  await bot.drain();
  expect(bot.snapshot().hostIntents).toEqual({});
});

it('passes reconcileMs and onOutbox to the K4 core', async () => {
  expect(() => openBot({}, { reconcileMs: 0 })).toThrow('Reconciliation interval must be positive');
  const hints: string[] = [];
  bot = openBot({ research: (_document, tx) => { tx.publish('research', { done: true }); } }, { onOutbox: () => { hints.push('outbox'); } });
  await bot.enqueueHostIntent(input(), 'research');
  await vi.waitFor(() => expect(hints).not.toEqual([]));
});
