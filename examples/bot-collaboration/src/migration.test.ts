import { hash } from '@byok-sdk/example-host-execution-core/canonical';
import { describe, expect, it } from 'vitest';
import { sealSwitchExport, switchAttempts, SwitchExportError, verifySwitchExport, type ExecutionRecord, type IntentRecord, type OccurrenceRecord, type RoutineRecord,
  type SwitchContent, type SwitchExport, type SwitchExportRefusal } from './migration';
import { stateOf, type CollaborationState } from './model';
import type { BotProfile, HomeOperation } from './team-model';

const bot = (id: string, deviceId: string, archived = false) =>
  ({ id, name: id, role: 'r', persona: 'p', model: 'm', mainBot: false, archived, revision: '1', readyRevision: '1', execution: { deviceId, agentId: 'main' } }) as unknown as BotProfile;
const home = (sequence: number, extra: Partial<HomeOperation> = {}) =>
  ({ sequence, botId: 'b1', request: {}, retries: [], status: 'pending', ...extra }) as unknown as HomeOperation;

const SCHEDULE = { version: 1, timeZone: 'UTC', rule: { every: 'day' }, waitMs: 0, lateAfterMs: 60_000 };
/**
 * A Host job routine and an occurrence hook routine, each with one occurrence: `O1` has a pending Host job, and `O2` is
 * promoted to an intent.
 */
const ROUTINES: RoutineRecord[] = [
  { id: 'r1', ordinal: 0, definition: { id: 'r1', ...SCHEDULE, hostJob: { type: 'job', input: {} } }, lifecycle: 'active', status: 'ok', nextAt: 2_000 },
  { id: 'r2', ordinal: 1, definition: { id: 'r2', ...SCHEDULE, hostOccurrence: { type: 'bot-routine', input: {} } }, lifecycle: 'active', status: 'ok', nextAt: null },
];
const TRIGGER = { kind: 'scheduled', plannedAt: 900 } as const;
/** K4's occurrence key of a routine slot and trigger. */
const keyOf = (routineId: string, trigger: OccurrenceRecord['trigger'] = TRIGGER) => hash([routineId, 1, trigger]);
const O1 = keyOf('r1'), O2 = keyOf('r2');
const occurrence = (key: string, ordinal: number, routineId: string, extra: Partial<OccurrenceRecord> = {}): OccurrenceRecord => ({
  key, ordinal, routineId, definitionVersion: 1, trigger: { ...TRIGGER }, recordedAt: 900, nextAt: null, job: null,
  executionSuperseded: false, ...extra });
const OCCURRENCES = [occurrence(O1, 0, 'r1', { job: { attempts: 1 } }), occurrence(O2, 1, 'r2')];
/** A generation that K4 began and that came back with a failure it retried. */
const EARLIER: ExecutionRecord = { submission: 'delivered', started: true, attempt: { id: 'a0' }, terminal: { type: 'task.failed' } };
const frozen = (taskId: string) => ({ taskId, deviceId: 'd1', payload: { agentRef: { agentId: 'main' } } });
const intent = (key: string, ordinal: number, extra: Partial<IntentRecord> = {}): IntentRecord => {
  const generation = extra.generation ?? 1, taskId = hash([key, generation]);
  return { key, source: 'user', ordinal, taskId, generation, input: frozen(taskId), waitUntil: 5_000,
    retry: { maxAttempts: 3, delaysMs: [300_000, 900_000], retryFailures: false }, submission: 'delivered', started: true,
    earlierExecutions: Array.from({ length: generation }, () => structuredClone(EARLIER)), conclusion: 'succeeded', ...extra };
};
/** `i2` has an accepted message: its K4 receipt and its K8 reply. */
const RECEIPT = { messageId: 'm1', contentHash: 'h1' };
const REPLY = { turnId: 'i2', ...RECEIPT, contentType: 'text/plain', acceptedAt: 1_000 };

function content(edit: (state: CollaborationState) => void = () => {}): SwitchContent {
  const state = stateOf({});
  state.team.bots.b1 = bot('b1', 'd1');
  state.replies[hash(['i2', 1])] = structuredClone(REPLY);
  edit(state);
  return {
    version: 1, source: 'L', domain: 'tenant-1', devices: [{ deviceId: 'd2', frozenRevision: 1 }, { deviceId: 'd1', frozenRevision: 3 }], exportedAt: 1_000,
    collaboration: state,
    archived: [{ namespace: 'turns', id: 't2', body: { n: 2 }, expiresAt: 9_000 }, { namespace: 'commands', id: 'c1', body: { n: 1 } }],
    intents: [intent('i2', 0, { attempt: { id: 'a' }, terminal: { type: 'task.complete' }, messageReceipt: { ...RECEIPT } }),
      intent('i1', 1, { generation: 0, submission: 'reserved', started: false, conclusion: 'cancelled', cancelReason: 'cancelled', handler: 'h' }),
      intent(`occurrence:${O2}`, 2, { source: 'routine', conclusion: 'failed', retryUntil: 4_000 })],
    routines: structuredClone(ROUTINES),
    occurrences: structuredClone(OCCURRENCES),
    outbox: [{ kind: 'host-job', occurrenceKey: O1 }],
    tombstones: [{ kind: 'row', digest: hash('r'), expiresAt: 5_000 }, { kind: 'intent', digest: hash('i0') }],
  };
}
function refused(run: () => unknown, reason: SwitchExportRefusal) {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(SwitchExportError);
    expect((error as SwitchExportError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected a ${reason} refusal`);
}
/** Each edit, applied to fresh content, is refused for `reason` when sealed. */
function refusesEach(reason: SwitchExportRefusal, cases: Array<(value: SwitchContent) => void>) {
  for (const [index, edit] of cases.entries()) {
    const value = content();
    edit(value);
    try { refused(() => sealSwitchExport(value), reason); } catch (error) { throw new Error(`case ${index}: ${String(error)}`); }
  }
}

describe('switch export format (#975)', () => {
  it('seals each section in identity order with a manifest that verifies, and leaves the content unchanged', () => {
    const input = content();
    const before = structuredClone(input);
    const sealed = sealSwitchExport(input);
    expect(input).toEqual(before);
    expect(sealed.devices.map(device => device.deviceId)).toEqual(['d1', 'd2']);
    expect(sealed.archived.map(row => row.id)).toEqual(['c1', 't2']);
    expect(sealed.intents.map(row => row.key)).toEqual(['i1', 'i2', `occurrence:${O2}`]);
    expect(sealed.tombstones.map(row => row.kind)).toEqual(['intent', 'row']);
    expect(sealed.manifest.counts).toEqual({ collaboration: 1, archived: 2, intents: 3, routines: 2, occurrences: 2, outbox: 1, tombstones: 2 });
    expect(sealed.manifest.digests.archived).toBe(hash(sealed.archived));
    expect(verifySwitchExport(sealed)).toEqual(sealed.manifest);
    // A target's read-back is a JSON round trip of what it wrote: the digest does not depend on key order or row order.
    const readBack = JSON.parse(JSON.stringify({ ...sealed, intents: [...sealed.intents] })) as SwitchExport;
    expect(verifySwitchExport(readBack).digest).toBe(sealed.manifest.digest);
    const shuffled = content();
    for (const list of [shuffled.devices, shuffled.archived, shuffled.intents, shuffled.routines, shuffled.occurrences, shuffled.outbox, shuffled.tombstones]) {
      list.reverse();
    }
    expect(sealSwitchExport(shuffled).manifest.digest).toBe(sealed.manifest.digest);
  });

  it('refuses a document whose content or header no longer matches its manifest', () => {
    const sealed = sealSwitchExport(content());
    refused(() => verifySwitchExport({ ...sealed, archived: [{ ...sealed.archived[0]!, body: { n: 9 } }, sealed.archived[1]!] }), 'manifest');
    refused(() => verifySwitchExport({ ...sealed, exportedAt: 1_001 }), 'manifest');
    refused(() => verifySwitchExport({ ...sealed, devices: [{ deviceId: 'd1', frozenRevision: 4 }, sealed.devices[1]!] }), 'manifest');
    refused(() => verifySwitchExport({ ...sealed, tombstones: sealed.tombstones.slice(1) }), 'manifest');
    // The same Turns in another insertion order: K8 reads them in that order, so the state differs.
    const turns = content(state => { state.turns.a = { id: 'a', conclusion: 'answered' } as CollaborationState['turns'][string];
      state.turns.b = { id: 'b', conclusion: 'answered' } as CollaborationState['turns'][string]; });
    const reordered = structuredClone(turns.collaboration);
    reordered.turns = { b: reordered.turns.b!, a: reordered.turns.a! };
    const ordered = sealSwitchExport(turns);
    refused(() => verifySwitchExport({ ...ordered, collaboration: reordered }), 'manifest');
    refused(() => verifySwitchExport({ ...sealed, routines: [{ ...sealed.routines[0]!, ordinal: 1 }, { ...sealed.routines[1]!, ordinal: 0 }] }), 'manifest');
  });

  it('refuses rows out of identity order and repeated identities or ordinals', () => {
    const sealed = sealSwitchExport(content());
    refused(() => verifySwitchExport({ ...sealed, intents: [...sealed.intents].reverse() }), 'unsorted');
    refused(() => verifySwitchExport({ ...sealed, devices: [...sealed.devices].reverse() }), 'unsorted');
    refusesEach('duplicate', [
      value => { value.intents.push({ ...value.intents[0]! }); },
      value => { value.devices = [{ deviceId: 'd1', frozenRevision: 3 }, { deviceId: 'd1', frozenRevision: 3 }]; },
      value => { value.routines[1]!.ordinal = 0; },
      value => { value.occurrences[1]!.ordinal = 0; },
      value => { value.intents[1]!.ordinal = 0; },
    ]);
  });

  it('refuses a key that no record of the format has, at every level', () => {
    const sealed = sealSwitchExport(content());
    refused(() => verifySwitchExport({ ...sealed, memory: [] } as SwitchExport), 'invalid');
    refused(() => verifySwitchExport({ ...sealed, manifest: { ...sealed.manifest, extra: 1 } } as SwitchExport), 'invalid');
    refused(() => verifySwitchExport({ ...sealed, manifest: { ...sealed.manifest, counts: { ...sealed.manifest.counts, memory: 0 } } } as SwitchExport), 'invalid');
    const extra = (row: object) => Object.assign(row, { extra: 1 });
    refusesEach('invalid', [
      value => { Object.assign(value, { memory: [] }); },
      value => { extra(value.devices[0]!); },
      value => { extra(value.archived[0]!); },
      value => { Object.assign(value.intents[0]!, { attempts: 1 }); },
      // Derived by each target from its own domain (K4 `agentKey`).
      value => { Object.assign(value.intents[0]!, { agent: hash(['tenant-1', 'd1', 'main']) }); },
      value => { Object.assign(value.intents[0]!.earlierExecutions[0]!, { input: frozen(hash(['i2', 0])) }); },
      value => { Object.assign(value.intents[0]!.input as object, { tenant: 'tenant-1' }); },
      value => { Object.assign(value.routines[0]!, { next: null }); },
      value => { Object.assign(value.routines[0]!.definition, { extra: 1 }); },
      value => { Object.assign(value.occurrences[0]!, { wakeKey: 'r1:1:900' }); },
      value => { Object.assign(value.occurrences[0]!.trigger, { extra: 1 }); },
      value => { Object.assign(value.occurrences[0]!.job!, { executionSuperseded: true }); },
      value => { extra(value.outbox[0]!); },
      value => { extra(value.tombstones[0]!); },
      value => { Object.assign(value.collaboration, { memory: {} }); },
    ]);
  });

  it('refuses a record that names a record the export does not hold, or a task id that is not its key and generation', () => {
    refusesEach('reference', [
      value => { value.intents[0]!.taskId = hash(['i2', 0]); },
      value => {
        const key = `occurrence:${hash('o9')}`, taskId = hash([key, 1]);
        Object.assign(value.intents[2]!, { key, taskId, input: frozen(taskId) });
      },
      value => { value.outbox.push({ kind: 'host-job', occurrenceKey: hash('o9') }); },
      // `O2` is an occurrence hook, not a Host job.
      value => { value.outbox.push({ kind: 'host-job', occurrenceKey: O2 }); },
      value => { value.occurrences.push(occurrence(keyOf('r9'), 2, 'r9')); },
      // An occurrence key is K4's hash of its routine slot and trigger.
      value => { value.occurrences[0]!.trigger.plannedAt = 901; },
      value => { value.occurrences[0]!.definitionVersion = 2; },
    ]);
    refusesEach('invalid', [
      value => { value.intents[0]!.input = frozen(hash(['other', 1])); },
      // A promoted occurrence's conclusion is its intent's.
      value => { value.occurrences[1]!.conclusion = 'failed'; },
      // K4 runs a pending Host job only for an open occurrence (`core.ts` runHostJobs: `Invalid pending Host job`).
      value => { Object.assign(value.occurrences[0]!, { job: { attempts: 1, summary: { ok: true } }, conclusion: 'succeeded' }); },
      // ... and only for one with no intent.
      value => { value.intents.push(intent(`occurrence:${O1}`, 3, { source: 'routine' })); },
      // K8 never promotes a Host job occurrence (#954): L runs K4 with `hostJobExecution: 'fail'`, and H concludes it `failed`.
      value => { value.intents.push(intent(`occurrence:${O1}`, 3, { source: 'routine' })); value.outbox = []; },
      // A routine's or occurrence's ordinal is its position: a gap, or a first ordinal other than 0.
      value => { value.routines[1]!.ordinal = 2; },
      value => { for (const row of value.occurrences) row.ordinal += 1; },
      // An open Host job occurrence without its pending job would never run or compact.
      value => { value.outbox = []; },
      // A Host job routine's occurrence has a job, and a hook routine's has none.
      value => { value.occurrences[0]!.job = null; },
      value => { value.occurrences[1]!.job = { attempts: 0 }; },
    ]);
    // A concluded Host job occurrence has no pending job.
    expect(() => sealSwitchExport(Object.assign(content(), {
      occurrences: [occurrence(O1, 0, 'r1', { job: { attempts: 1, summary: { ok: true } }, conclusion: 'succeeded' }), occurrence(O2, 1, 'r2')],
      outbox: [] }))).not.toThrow();
    // K8 domains hold only Turn and Host intents (#954 C), so an execution routine is not theirs.
    refusesEach('execution_routine', [
      value => { value.routines.push({ id: 'r3', ordinal: 2, definition: { id: 'r3', ...SCHEDULE, execution: frozen('t') }, lifecycle: 'active', status: 'ok', nextAt: null } as unknown as RoutineRecord); },
    ]);
    // Another occurrence of the same slot: the target derives one slot from each occurrence.
    refusesEach('duplicate', [
      value => {
        const trigger = { kind: 'catch_up', plannedAt: 900 } as const;
        value.occurrences.push(occurrence(keyOf('r1', trigger), 2, 'r1', { trigger }));
      },
    ]);
    // Only K4's occurrence intent key names an occurrence; any other key is a Host's own.
    expect(() => sealSwitchExport(Object.assign(content(), { intents: [...content().intents, intent('occurrence:x', 3)] }))).not.toThrow();
  });

  it('carries the K4 routine schedule retry fields and slot replay count, and the intent fields only K4 keeps (#975 D2, D3, D5)', () => {
    const value = content();
    Object.assign(value.routines[0]!, { status: 'schedule_retrying', scheduleRetryAt: 70_000, scheduleRetryCount: 2,
      lastError: { code: 'WAKE_AVAILABLE_AT_INVALID', message: 'too far' } });
    value.occurrences[0]!.slotReplayCount = 3;
    Object.assign(value.intents[1]!, { preparationError: 'sealed_dispatch_unavailable', memoryBlocked: { resume: 'queued', reason: 'locked' } });
    const sealed = sealSwitchExport(value);
    expect(sealed.routines[0]).toMatchObject({ scheduleRetryAt: 70_000, scheduleRetryCount: 2, lastError: { code: 'WAKE_AVAILABLE_AT_INVALID' } });
    expect(verifySwitchExport(sealed)).toEqual(sealed.manifest);
    refusesEach('invalid', [
      value => { value.routines[0]!.scheduleRetryCount = 0; },
      value => { value.routines[0]!.lastError = { code: '', message: 'm' }; },
      value => { Object.assign(value.routines[0]!, { lastError: { code: 'c', message: 'm', at: 1 } }); },
      value => { value.occurrences[0]!.slotReplayCount = 0; },
      value => { delete (value.intents[0] as { retry?: unknown }).retry; },
      value => { value.intents[0]!.retry = { maxAttempts: 3, delaysMs: [-1], retryFailures: false }; },
      // The bounds of K4 `validateRetry`: 1 to 100 attempts, a delay for each retry.
      value => { value.intents[0]!.retry = { maxAttempts: 0, delaysMs: [], retryFailures: false }; },
      value => { value.intents[0]!.retry = { maxAttempts: 101, delaysMs: Array(100).fill(1), retryFailures: false }; },
      value => { value.intents[0]!.retry = { maxAttempts: 2.5, delaysMs: [1, 1], retryFailures: false }; },
      value => { value.intents[0]!.retry = { maxAttempts: 3, delaysMs: [300_000], retryFailures: false }; },
      // A routine definition's policy, current or staged, takes the same bounds (K4 `routines.ts` validateDefinition).
      value => { Object.assign(value.routines[0]!.definition, { retry: { maxAttempts: 101, delaysMs: Array(100).fill(1), retryFailures: false } }); },
      value => { value.routines[0]!.pending = { ...value.routines[0]!.definition, version: 2, retry: { maxAttempts: 2, delaysMs: [], retryFailures: false } }; },
      // A `reserved` intent was never submitted: K4 begins a new generation in the transaction that opens it (`core.ts` begin).
      value => { Object.assign(value.intents[1]!, { generation: 1, taskId: hash(['i1', 1]), input: frozen(hash(['i1', 1])), earlierExecutions: [{ ...EARLIER }] }); },
      value => { value.intents[1]!.started = true; },
      value => { value.intents[1]!.attempt = { id: 'a' }; },
      value => { value.intents[1]!.terminal = { type: 'task.failed' }; },
      value => { value.intents[1]!.messageReceipt = { messageId: 'm9', contentHash: 'h9' }; },
      value => { value.intents[0]!.preparationError = ''; },
      value => { Object.assign(value.intents[0]!, { memoryBlocked: { resume: 'inflight', reason: 'r' } }); },
      value => { Object.assign(value.intents[0]!, { messageReceipt: { messageId: 'm1' } }); },
    ]);
  });

  it('refuses a message receipt that is not the K8 accepted reply of the same task, live or retained (#975 D4)', () => {
    // The reply may have been retained into archived rows.
    const retained = content(state => { delete state.replies[hash(['i2', 1])]; });
    retained.archived.push({ namespace: 'replies', id: hash(['i2', 1]), body: structuredClone(REPLY) });
    expect(verifySwitchExport(sealSwitchExport(retained)).counts.archived).toBe(3);
    refusesEach('receipt_mismatch', [
      value => { delete value.intents[0]!.messageReceipt; },
      value => { value.intents[0]!.messageReceipt = { ...RECEIPT, contentHash: 'h2' }; },
      value => { value.intents[0]!.messageReceipt = { ...RECEIPT, messageId: 'm2' }; },
      value => { delete value.collaboration.replies[hash(['i2', 1])]; },
      value => { value.intents[2]!.messageReceipt = { messageId: 'm9', contentHash: 'h9' }; },
    ]);
  });

  it('carries the K4 execution facts of every earlier generation, each receipt matching the K8 reply of its task id (#975 D1)', () => {
    // `i2` is in generation 1. Generation 0 also had an accepted message before it failed.
    const earlier = { messageId: 'm0', contentHash: 'h0' };
    const withEarlier = (edit: (state: CollaborationState) => void = () => {}) => {
      const value = content(state => { state.replies[hash(['i2', 0])] = { ...REPLY, ...earlier }; edit(state); });
      value.intents[0]!.earlierExecutions[0]!.messageReceipt = { ...earlier };
      return value;
    };
    const sealed = sealSwitchExport(withEarlier());
    expect(sealed.intents.find(row => row.key === 'i2')!.earlierExecutions).toEqual([{ ...EARLIER, messageReceipt: earlier }]);
    expect(verifySwitchExport(sealed).counts.intents).toBe(3);
    // A K8 reply of an earlier task with no receipt, a receipt with no reply, or one that differs: the fact has forked.
    refused(() => sealSwitchExport(content(state => { state.replies[hash(['i2', 0])] = { ...REPLY, ...earlier }; })), 'receipt_mismatch');
    refused(() => sealSwitchExport(withEarlier(state => { delete state.replies[hash(['i2', 0])]; })), 'receipt_mismatch');
    refused(() => sealSwitchExport(withEarlier(state => { state.replies[hash(['i2', 0])] = { ...REPLY, ...earlier, contentHash: 'other' }; })), 'receipt_mismatch');
    refusesEach('invalid', [
      // Exactly generations 0 to `generation - 1`: K4 compacts an intent only with the execution of each one.
      value => { value.intents[0]!.earlierExecutions = []; },
      value => { value.intents[0]!.earlierExecutions.push({ ...EARLIER }); },
      // K4 began each earlier generation before it opened the next.
      value => { value.intents[0]!.earlierExecutions[0]!.submission = 'reserved' as ExecutionRecord['submission']; },
      value => { delete (value.intents[0]!.earlierExecutions[0] as { started?: boolean }).started; },
      // K4 enters backoff only after it stores the generation's terminal and attempt (`core.ts` finish).
      value => { delete (value.intents[0]!.earlierExecutions[0] as { terminal?: unknown }).terminal; },
      value => { delete (value.intents[0]!.earlierExecutions[0] as { attempt?: unknown }).attempt; },
      value => { value.intents[0]!.earlierExecutions[0]!.messageReceipt = { messageId: 'm0' } as ExecutionRecord['messageReceipt']; },
      value => { Object.assign(value.intents[0]!.earlierExecutions[0]!, { taskId: hash(['i2', 0]) }); },
      // A generation K4 could not have opened under the intent's retry policy.
      value => { Object.assign(value.intents[0]!, { generation: 3, taskId: hash(['i2', 3]), input: frozen(hash(['i2', 3])),
        earlierExecutions: [0, 1, 2].map(() => ({ ...EARLIER })) }); },
      // A huge generation is refused before the receipt check walks the generations: its earlier executions and delays are
      // too few. The 100-attempt cap itself is the `maxAttempts: 101` case.
      value => {
        Object.assign(value.intents[0]!, { generation: 1e9, taskId: hash(['i2', 1e9]), input: frozen(hash(['i2', 1e9])),
          retry: { maxAttempts: 2 ** 31, delaysMs: [], retryFailures: false } });
      },
    ]);
  });

  it('refuses the source owner records and a live Bot whose device the export does not move', () => {
    refused(() => sealSwitchExport(content(state => { state.topology = {}; })), 'owner_record');
    refused(() => sealSwitchExport(content(state => { state.hostIntents = { i1: { handler: 'h' } }; })), 'owner_record');
    refused(() => sealSwitchExport(content(state => { state.switchExport = { digest: 'd', exportedAt: 1, devices: [{ deviceId: 'd1', frozenRevision: 3 }] }; })), 'owner_record');
    refused(() => sealSwitchExport(content(state => { state.switchImport = { digest: 'd', devices: ['d1'] }; })), 'owner_record');
    refused(() => sealSwitchExport(content(state => { state.team.bots.b2 = bot('b2', 'd3'); })), 'device_missing');
    expect(() => sealSwitchExport(content(state => { state.team.bots.b2 = bot('b2', 'd3', true); }))).not.toThrow();
  });

  it('refuses open work: an open Turn, an open input batch, an intent without a conclusion, a card call in flight', () => {
    refused(() => sealSwitchExport(content(state => { state.turns.t1 = { id: 't1' } as CollaborationState['turns'][string]; })), 'open_work');
    expect(() => sealSwitchExport(content(state => { state.turns.t1 = { id: 't1', conclusion: 'answered' } as CollaborationState['turns'][string]; }))).not.toThrow();
    refused(() => sealSwitchExport(content(state => {
      state.inputBatches = { x: { id: 'x', botId: 'b1', key: 'k', inputIds: [], bytes: 0, openedAt: 0, sealAt: 1, state: 'open' } };
    })), 'open_work');
    const open = content();
    delete (open.intents[0] as { conclusion?: string }).conclusion;
    refused(() => sealSwitchExport(open), 'open_work');
    refused(() => sealSwitchExport(content(state => { state.cardCalls = { card1: true }; })), 'card_call');
  });

  it('moves an unsent pending Agent home write and refuses one that may have reached a device', () => {
    expect(() => sealSwitchExport(content(state => { state.team.homeOperations.push(home(1), home(2, { status: 'applied', sent: true })); }))).not.toThrow();
    refused(() => sealSwitchExport(content(state => { state.team.homeOperations.push(home(1, { sent: true })); })), 'home_sent');
    refused(() => sealSwitchExport(content(state => { state.team.homeOperations.push(home(1, { retryAt: 10 })); })), 'home_sent');
  });

  it('refuses a pending projection, which H receivers deduplicate under the source scope', () => {
    refusesEach('projection_pending', [
      value => { value.outbox.push({ kind: 'projection', id: 'p1', value: { v: 1 } } as unknown as SwitchContent['outbox'][number]); },
    ]);
  });

  it('refuses malformed content', () => {
    refusesEach('invalid', [
      value => { (value as { version: number }).version = 2; },
      value => { (value as { source: string }).source = 'K'; },
      value => { value.domain = ''; },
      value => { value.exportedAt = -1; },
      value => { value.devices = []; },
      value => { value.devices = [{ deviceId: 'd1', frozenRevision: 0 }]; },
      value => { (value.collaboration as { version: number }).version = 2; },
      value => { value.intents[0]!.taskId = 'not-a-digest'; },
      value => { (value.intents[0] as { submission: string }).submission = 'sent'; },
      value => { (value.intents[0] as { input: unknown }).input = 'frozen'; },
      // The device and Agent from which the target derives the intent's FIFO key.
      value => { delete (value.intents[0]!.input as { deviceId?: string }).deviceId; },
      value => { value.intents[0]!.input = { ...frozen(value.intents[0]!.taskId), payload: {} }; },
      value => { delete (value.intents[0] as { waitUntil?: number }).waitUntil; },
      value => { value.tombstones[0]!.digest = 'short'; },
      value => { (value.tombstones[0] as { kind: string }).kind = 'other'; },
      value => { (value.outbox[0] as { kind: string }).kind = 'intent'; },
      value => { value.archived[0]!.expiresAt = 1.5; },
      value => { (value.intents[0] as { conclusion: string }).conclusion = 'done'; },
      value => { (value.collaboration.team as { bots: unknown }).bots = null; },
      value => { value.archived[0]!.body = { n: Number.NaN }; },
      value => { value.archived[0]!.body = { at: new Date(0) } as unknown as Record<string, number>; },
      // Checked before the seal's clone, which would turn the instance into a plain object.
      value => { value.archived[0]!.body = new (class Body { n = 2; })() as unknown as Record<string, number>; },
      value => { (value.archived[1] as { expiresAt?: number }).expiresAt = undefined; },
      value => { value.routines[0]!.definition = { ...value.routines[0]!.definition, id: 'r9' }; },
      value => { Object.assign(value.routines[0]!.definition, { execution: {} }); },
      value => { (value.routines[0] as { lifecycle: string }).lifecycle = 'gone'; },
      value => { value.routines[0]!.ordinal = -1; },
      value => { value.routines[0]!.calendarErrors = []; },
      value => { delete (value.occurrences[0] as { executionSuperseded?: boolean }).executionSuperseded; },
      value => { (value.occurrences[0]!.trigger as { kind: string }).kind = 'late'; },
      value => { value.occurrences[0]!.nextAt = -1; },
      value => { (value.collaboration.team as { homeOperations: unknown }).homeOperations = {}; },
      value => { (value.collaboration.team.bots.b1 as { execution: unknown }).execution = null; },
      value => { value.collaboration.turns.t1 = null as unknown as CollaborationState['turns'][string]; },
    ]);
  });

  it('derives K4 attempts: one per generation begun, and an occurrence has its intent\'s', () => {
    expect(switchAttempts({ submission: 'reserved', generation: 0 })).toBe(0);
    expect(switchAttempts({ submission: 'uncertain', generation: 0 })).toBe(1);
    expect(switchAttempts({ submission: 'delivered', generation: 2 })).toBe(3);
    expect(switchAttempts(undefined)).toBe(0);
  });
});
