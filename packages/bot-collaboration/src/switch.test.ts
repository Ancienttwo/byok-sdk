import { afterEach, expect, it, vi } from 'vitest';
import { agentKey, hash, MIN_TOMBSTONE_RETENTION_MS, taskId, type IntentInput, type LedgerDump } from '@byok-sdk/server/execution-core';
import { openHost, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { template } from './k4-fixtures.test-support';
import { BotCollaboration, type BotOptions } from './host';
import { stateOf } from './model';
import { botCompactVeto } from './compaction';
import { DeviceSwitchingError, sealSwitchExport, SwitchExportedError, SwitchExportError, verifySwitchExport, type SwitchExport, type SwitchHeader } from './migration';
import { checkSwitchRecords, sealLedger, switchContent } from './switch';
import { deliverRoutine, routineOf, seedRoutine } from './routines.test-support';
import { DeviceModeError } from './topology';

// #975: L as the old owner exports a drained domain and commits away on the new owner's receipt.
let fixture: TestHost | undefined;
const bots: BotCollaboration[] = [];
let offset = 0;
const now = () => Date.now() + offset;
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.close();
  await fixture?.close(); fixture = undefined;
});
const schedule = { minute: 0, hour: (new Date().getUTCHours() + 12) % 24, tz: 'UTC' };
const options = (): BotOptions => ({ botId: 'main', execution: template(fixture!.deviceId), connector: async () => null, now,
  hostIntents: { research: () => {} }, dreaming: { timeZone: 'UTC' }, contextTurnLimit: 1, handoff: { recentBytes: 200, earlyBytes: 0, totalBytes: 1024 } });
const device = () => fixture!.deviceId;
let bot: BotCollaboration;
async function setup(): Promise<BotCollaboration> {
  offset = 0;
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot.consume(wake, signal),
    agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  bot = new BotCollaboration(fixture.server, fixture.ledger, options());
  bots.push(bot);
  return bot;
}
/** Waits until K4 started the intent's current task, and returns its stub session. */
async function running(key: string) {
  await vi.waitFor(async () => {
    await bot.drain();
    expect(bot.ledger.snapshot().executions[bot.core.intent(key)!.taskId]?.started).toBe(true);
    expect(fixture!.adapter.sessions.has(bot.core.intent(key)!.taskId)).toBe(true);
  }, { timeout: 5000 });
  return fixture!.adapter.sessions.get(bot.core.intent(key)!.taskId)!;
}
async function settled(key: string, document: unknown = {}) {
  (await running(key)).finish(document);
  await vi.waitFor(async () => { await bot.drain(); expect(bot.core.intent(key)?.conclusion).toBeDefined(); }, { timeout: 5000 });
}
const hostInput = (key: string): IntentInput => ({ key, source: 'user', execution: template(device(), 'research'), waitUntil: now() + 600_000 });
/** A retained Bot Turn with its compacted intent, a settled Host intent and a settled routine occurrence and its Turn. */
async function work(): Promise<void> {
  const first = await bot.input('k1', 'hello');
  await settled(first);
  await bot.enqueueHostIntent(hostInput('host-1'), 'research');
  await settled('host-1');
  const id = await seedRoutine(bot, 'task-1', 'report', schedule);
  offset = routineOf(bot, id).next!.availableAt - Date.now();
  await deliverRoutine(bot, id, now());
  const occurrence = Object.values(fixture!.ledger.snapshot().intents).find(intent => intent.source === 'routine')!;
  await settled(occurrence.key);
  // The routine Turn is the Bot's ContextPack window, so the first Turn moves to K4 rows, and K4 compacts its intent.
  await bot.drain();
  expect(await bot.retain({ acknowledgedRoots: [first], now: now(), retentionMs: MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ archivedRoots: 1 });
  await bot.core.flushProjections(async () => {});
  expect(fixture!.ledger.compact({ acknowledgedIntentKeys: [first], now: now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS }))
    .toMatchObject({ compactedIntents: 1 });
}
/** Freezes and drains the device, uploads the projections and exports the domain. */
async function exportDomain(exportedAt = now()): Promise<SwitchExport> {
  await bot.freezeForSwitch(device(), 0);
  await bot.drain();
  await bot.core.flushProjections(async () => {});
  return bot.exportForSwitch([{ deviceId: device(), expectedRevision: 1 }], exportedAt);
}
const headerOf = (document: SwitchExport): SwitchHeader =>
  ({ source: document.source, domain: document.domain, devices: document.devices, exportedAt: document.exportedAt });
const digestOf = () => sealLedger(fixture!.ledger, headerOf(exported!)).manifest.digest;
let exported: SwitchExport | undefined;

it('exports a drained L domain and commits the old owner on its receipt', async () => {
  await setup();
  await work();
  exported = await exportDomain();
  expect(verifySwitchExport(exported).digest).toBe(exported.manifest.digest);
  expect(exported).toMatchObject({ source: 'L', domain: fixture!.ledger.tenant, devices: [{ deviceId: device(), frozenRevision: 1 }] });
  expect(exported.manifest.counts).toMatchObject({ intents: 2, routines: 2, occurrences: 1, outbox: 0 });
  expect(exported.archived.map(row => row.namespace)).toContain('turns');
  expect(exported.tombstones.map(row => row.kind)).toContain('intent');
  expect(exported.intents.find(row => row.key === 'host-1')).toMatchObject({ handler: 'research' });
  expect(stateOf(fixture!.ledger.snapshot().application).switchExport)
    .toEqual({ digest: exported.manifest.digest, exportedAt: exported.exportedAt, devices: exported.devices });

  // Step 5 on the old owner: the receipt of its own export.
  await expect(bot.commitSwitch(device(), 1, 'other')).rejects.toThrow("is not this Host's export");
  expect(await bot.commitSwitch(device(), 1, exported.manifest.digest)).toEqual({ mode: 'H', revision: 2 });
  expect(stateOf(fixture!.ledger.snapshot().application).switchExport?.digest).toBe(exported.manifest.digest);

});

it('carries every earlier generation of a retried intent and refuses an earlier one without its terminal and attempt', async () => {
  await setup();
  await settled(await bot.input('k1', 'hello'));
  exported = await exportDomain();
  // A retried intent as K4 stores it: generation 1 with the generation 0 execution and its own frozen input.
  const dump = retried(fixture!.ledger.dumpForSwitch());
  const content = switchContent(dump, fixture!.ledger.tenant, headerOf(exported));
  const [row] = content.intents.filter(intent => intent.generation === 1);
  expect(row!.earlierExecutions).toHaveLength(1);
  const changed = structuredClone(dump);
  (changed.body.executions[taskId(row!.key, 0)]!.input as { deviceId: string }).deviceId = 'device-2';
  expect(() => switchContent(changed, fixture!.ledger.tenant, headerOf(exported!))).toThrow('generation 0 input differs');
  const missing = structuredClone(dump);
  delete missing.body.executions[taskId(row!.key, 0)]!.terminal;
  expect(() => sealSwitchExport(switchContent(missing, fixture!.ledger.tenant, headerOf(exported!)))).toThrow(SwitchExportError);
});

/** The dump with its first Bot Turn intent moved to generation 1, as a retry leaves it. */
function retried(dump: LedgerDump): LedgerDump {
  const next = structuredClone(dump);
  const intent = Object.values(next.body.intents).find(row => row.source === 'user')!;
  const first = next.body.executions[intent.taskId]!;
  first.attempt ??= { taskId: intent.taskId } as never;
  first.terminal ??= { type: 'task.complete' } as never;
  const task = taskId(intent.key, 1);
  next.body.executions[task] = { ...structuredClone(first), input: { ...structuredClone(intent.execution), taskId: task } as never };
  delete next.body.applied[intent.taskId];
  if (intent.conclusion === 'succeeded') next.body.applied[task] = true;
  Object.assign(intent, { generation: 1, taskId: task, attempts: 2 });
  return next;
}

it('refuses a stored copy that differs from the value it is derived from, and state the format does not move', async () => {
  await setup();
  await work();
  exported = await exportDomain();
  const tenant = fixture!.ledger.tenant, base = fixture!.ledger.dumpForSwitch();
  const first = (dump: LedgerDump) => Object.values(dump.body.intents).find(row => row.source === 'user')!;
  const occurrenceOf = (dump: LedgerDump) => Object.values(dump.body.occurrences)[0]!;
  const cases: [string, string, (dump: LedgerDump) => void][] = [
    ['agent', 'queues under another tenant', dump => { first(dump).agent = agentKey('product:other', first(dump).execution); }],
    ['frozen input', 'differs from its frozen input', dump => {
      first(dump).execution.payload = { ...first(dump).execution.payload, instruction: 'changed' };
    }],
    ['intent id', 'is stored under', dump => {
      const intent = first(dump);
      delete dump.body.intents[intent.id];
      dump.body.intents[hash('other')] = intent;
    }],
    ['task id', 'task id is not that of its generation', dump => { first(dump).taskId = taskId(first(dump).key, 1); }],
    ['intent attempts', 'attempts', dump => { first(dump).attempts += 1; }],
    ['applied extra', 'K4 applied is not the succeeded current tasks', dump => { dump.body.applied.extra = true; }],
    ['applied missing', 'K4 applied is not the succeeded current tasks', dump => {
      delete dump.body.applied[Object.values(dump.body.intents).find(row => row.conclusion === 'succeeded')!.taskId];
    }],
    ['orphan execution', 'belongs to no intent', dump => { dump.body.executions.orphan = structuredClone(dump.body.executions[first(dump).taskId]!); }],
    ['wake key', 'wake key', dump => { occurrenceOf(dump).wakeKey = `${occurrenceOf(dump).wakeKey}0`; }],
    ['slot extra', 'K4 slots are not one per occurrence', dump => { dump.body.slots.extra = occurrenceOf(dump).key; }],
    ['slot missing', 'K4 slots are not one per occurrence', dump => { dump.body.slots = {}; }],
    ['intent id', 'intent id', dump => { delete occurrenceOf(dump).intentId; }],
    ['occurrence attempts', 'attempts', dump => { occurrenceOf(dump).attempts += 1; }],
    ['occurrence conclusion', 'conclusion differs', dump => { occurrenceOf(dump).conclusion = 'failed'; }],
    ['routine next', 'next wake key', dump => {
      const routine = Object.values(dump.body.routines)[0]!;
      routine.next = { ...routine.next!, availableAt: routine.next!.availableAt + 1 };
    }],
    ['unknown intent key', 'has keys', dump => { (first(dump) as unknown as Record<string, unknown>).extra = 1; }],
    ['unknown ledger key', 'has keys', dump => { (dump.body as unknown as Record<string, unknown>).extra = 1; }],
    ['handler of no intent', 'has no K4 intent', dump => {
      stateOf(dump.body.application).hostIntents!.ghost = { handler: 'research' };
    }],
    ['memory', 'Agent memory', dump => { dump.body.memory = { pending: { m: {} } } as never; }],
    ['projection', 'flush it first', dump => { dump.body.outbox.p = { kind: 'projection', id: 'p', value: 1 }; }],
    ['intent outbox', 'pending submit', dump => { dump.body.outbox.i = { kind: 'intent', intentId: first(dump).id } as never; }],
  ];
  expect(() => switchContent(structuredClone(base), tenant, headerOf(exported!))).not.toThrow();
  for (const [what, message, change] of cases) {
    const dump = structuredClone(base);
    change(dump);
    expect(() => switchContent(dump, tenant, headerOf(exported!)), what).toThrow(message);
  }
});

it('writes nothing after the export, refuses each entry, and commits away only on an unchanged ledger', async () => {
  await setup();
  await work();
  exported = await exportDomain();
  const digest = digestOf(), stored = JSON.stringify(fixture!.ledger.dumpForSwitch());
  // A new command on the frozen device gets its device refusal; the other writes here refuse with the export. A refusal the
  // write raises first (a replayed command id, `stale_revision`, `RetentionRefused`) also writes nothing.
  await expect(bot.input('k9', 'late')).rejects.toBeInstanceOf(DeviceSwitchingError);
  await expect(bot.retain({ acknowledgedRoots: [], now: now(), retentionMs: MIN_TOMBSTONE_RETENTION_MS })).rejects.toBeInstanceOf(SwitchExportedError);
  await expect(bot.recover()).rejects.toBeInstanceOf(SwitchExportedError);
  await expect(bot.drainForSwitch(device())).rejects.toBeInstanceOf(SwitchExportedError);
  await expect(bot.exportForSwitch([{ deviceId: device(), expectedRevision: 1 }])).rejects.toMatchObject({ code: 'switch_exported' });
  await expect(bot.consumeMessage({} as never)).rejects.toBeInstanceOf(SwitchExportedError);
  // K4 compaction asks the K8 veto, which keeps the exported domain whole.
  expect(() => fixture!.ledger.compact({ acknowledgedIntentKeys: ['host-1'], now: now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS }))
    .toThrow('switch_exported');
  // The routine mutators that K4 writes itself refuse too.
  const routine = Object.values(fixture!.ledger.snapshot().routines)[0]!.definition.id;
  await expect(bot.setRoutineLifecycle(routine, 'paused')).rejects.toBeInstanceOf(SwitchExportedError);
  await expect(bot.updateRoutine({ routineId: routine } as never)).rejects.toBeInstanceOf(SwitchExportedError);
  // Time passes and the K4 core keeps its timers: the passes and the timer run nothing.
  offset += 3_600_000;
  await bot.drain();
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(digestOf()).toBe(digest);
  expect(JSON.stringify(fixture!.ledger.dumpForSwitch())).toBe(stored);
  // A restart keeps the export, refuses the same way and can still commit.
  await bot.close();
  bot = new BotCollaboration(fixture!.server, fixture!.ledger, options());
  bots.push(bot);
  await expect(bot.retain({ acknowledgedRoots: [], now: now(), retentionMs: MIN_TOMBSTONE_RETENTION_MS })).rejects.toBeInstanceOf(SwitchExportedError);
  expect(JSON.stringify(fixture!.ledger.dumpForSwitch())).toBe(stored);
  // A Host for another Bot does not add it to the exported domain.
  await bot.close();
  bot = new BotCollaboration(fixture!.server, fixture!.ledger, { ...options(), botId: 'other', execution: template(device(), 'other') });
  bots.push(bot);
  expect(JSON.stringify(fixture!.ledger.dumpForSwitch())).toBe(stored);
  // A change to what moves, as only the K4 core could still write, refuses the commit.
  fixture!.ledger.transaction(s => { stateOf(s.application).audit.push('late'); });
  await expect(bot.commitSwitch(device(), 1, exported.manifest.digest)).rejects.toThrow('The ledger changed after its export');
  fixture!.ledger.transaction(s => { stateOf(s.application).audit.pop(); });
  expect(await bot.commitSwitch(device(), 1, exported.manifest.digest)).toEqual({ mode: 'H', revision: 2 });
});

it('refuses an export of a device that is not frozen, not drained or not every device, and a pending Host job', async () => {
  await setup();
  await expect(bot.exportForSwitch([{ deviceId: device(), expectedRevision: 0 }])).rejects.toThrow('not switching');
  await bot.freezeForSwitch(device(), 0);
  await expect(bot.exportForSwitch([{ deviceId: device(), expectedRevision: 0 }])).rejects.toMatchObject({ code: 'stale_revision' });
  const open = await bot.input('k0', 'x').catch(() => undefined);
  expect(open).toBeUndefined();
  fixture!.ledger.transaction(s => { s.outbox['host-job:x'] = { kind: 'host-job', occurrenceKey: 'x' }; });
  await bot.core.flushProjections(async () => {});
  await expect(bot.exportForSwitch([{ deviceId: device(), expectedRevision: 1 }])).rejects.toMatchObject({ reason: 'open_work' });
  fixture!.ledger.transaction(s => { delete s.outbox['host-job:x']; });
  // A live Bot on another device that the export does not name.
  fixture!.ledger.transaction(s => {
    const team = stateOf(s.application).team;
    team.bots.b = { ...structuredClone(team.bots.main!), id: 'b', mainBot: false, execution: template('device-2', 'b') };
  });
  await expect(bot.exportForSwitch([{ deviceId: device(), expectedRevision: 1 }])).rejects.toMatchObject({ reason: 'device_missing' });
  expect(stateOf(fixture!.ledger.snapshot().application).switchExport).toBeUndefined();
});

it('ends the export at an abort before the commit, and commits every device of the export together', async () => {
  await setup();
  fixture!.ledger.transaction(s => {
    const team = stateOf(s.application).team;
    team.bots.b = { ...structuredClone(team.bots.main!), id: 'b', mainBot: false, execution: template('device-2', 'b') };
  });
  await bot.freezeForSwitch(device(), 0);
  await bot.freezeForSwitch('device-2', 0);
  await bot.drain();
  await bot.core.flushProjections(async () => {});
  const devices = [{ deviceId: device(), expectedRevision: 1 }, { deviceId: 'device-2', expectedRevision: 1 }];
  const first = await bot.exportForSwitch(devices);
  await bot.abortSwitch('device-2', 1);
  expect(stateOf(fixture!.ledger.snapshot().application).switchExport).toBeUndefined();
  await expect(bot.commitSwitch(device(), 1, first.manifest.digest)).rejects.toThrow('has not exported');
  await bot.freezeForSwitch('device-2', 2);
  await bot.drain();
  await bot.core.flushProjections(async () => {});
  const second = await bot.exportForSwitch([devices[0]!, { deviceId: 'device-2', expectedRevision: 3 }]);
  // The receipt of an export that ended does not commit; the receipt of the current one commits both devices.
  await expect(bot.commitSwitch(device(), 1, first.manifest.digest)).rejects.toThrow("is not this Host's export");
  expect(await bot.commitSwitch(device(), 1, second.manifest.digest)).toEqual({ mode: 'H', revision: 2 });
  expect(bot.topology('device-2')).toEqual({ mode: 'H', revision: 4 });
  await expect(bot.abortSwitch('device-2', 4)).rejects.toBeInstanceOf(DeviceModeError);
  await expect(bot.commitSwitch('device-2', 3, second.manifest.digest)).rejects.toMatchObject({ code: 'stale_revision' });
});

it('refuses to open a ledger with a malformed export record', () => {
  const state = stateOf({});
  expect(() => checkSwitchRecords({ ...state, switchExport: { digest: 'd', exportedAt: 1, devices: [] } })).toThrow('Invalid switch export record');
  expect(() => checkSwitchRecords({ ...state, switchExport: { digest: 'd', exportedAt: 1, devices: [{ deviceId: 'x', frozenRevision: 0 }] } }))
    .toThrow('Invalid switch export record');
  expect(() => checkSwitchRecords({ ...state, switchExport: { digest: 'd', exportedAt: 1, devices: [{ deviceId: 'x', frozenRevision: 1 }] } })).not.toThrow();
});
