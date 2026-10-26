import { agentKey, canonical, frozenInput, hash, isOccurrenceIntentKey, occurrenceIntentKey, parseRoutineWakeKey, routineWakeKey, taskId,
  type HostLedger, type Intent, type Json, type LedgerDump, type LedgerState, type Occurrence, type Routine } from '@byok-sdk/example-host-execution-core';
import { stateOf, type CollaborationState } from './model';
import { sealSwitchExport, switchAttempts, SwitchExportError, verifySwitchExport, type ExecutionRecord, type IntentRecord, type OccurrenceRecord, type OutboxRecord,
  type RoutineRecord, type SwitchContent, type SwitchDevice, type SwitchExport, type SwitchExportRefusal } from './migration';

// The L side of the #975 state move. `switchContent` reads an L ledger into the neutral form, both for the old owner's export
// and for the new owner's read-back, so one function states what an L ledger holds. `switchDump` writes the neutral form
// into a K4 dump for one tenant. Each value either moves, is derived from values that move (the checks below), or is a
// named scheduler value of a concluded row or of the SDK's wakes, which a target writes for itself.

/** The header fields of a document: the source's, also on the target's read-back. */
export type SwitchHeader = Pick<SwitchContent, 'source' | 'domain' | 'devices' | 'exportedAt'>;
/** The import record of a new L owner: from the load until the commit toward L. */
export interface SwitchImport { digest: string; devices: string[]; verified: boolean; discarding?: true }
/** What a new owner returns after its read-back: the digest the old owner commits away on. */
export interface SwitchReceipt { digest: string; devices: string[] }
/**
 * The export record of an old L owner: from the export on, also after the commit, so the ledger keeps the exported state.
 * `devices` and `exportedAt` are the document's header, which the commit seals the ledger under again.
 */
export interface SwitchExportMark { digest: string; exportedAt: number; devices: SwitchDevice[] }

/** The domain was exported for a switch, so this L Host writes nothing to its ledger. Abort the switch to resume it. */
export class SwitchExportedError extends Error {
  readonly code = 'switch_exported' as const;
  constructor(readonly digest: string) {
    super(`This Host exported its domain for a switch (${digest}); it writes nothing until the switch is aborted`);
    this.name = 'SwitchExportedError';
  }
}
/** Throws while the domain has an export mark. Each L write calls it after its own refusals, so those come first. */
export function refuseExported(state: CollaborationState): void {
  if (state.switchExport) throw new SwitchExportedError(state.switchExport.digest);
}
/**
 * A restart reads the switch records before any write. A ledger with an import is not committed toward L yet, so no
 * `BotCollaboration` may run on it; a malformed export mark fails closed.
 */
export function checkSwitchRecords(state: CollaborationState): void {
  if (state.switchImport) throw new Error(`This ledger holds the switch import ${state.switchImport.digest}; commit it toward L or discard it first`);
  const mark = state.switchExport;
  if (mark === undefined) return;
  const valid = !!mark && Object.keys(mark).sort().join(',') === 'devices,digest,exportedAt' && typeof mark.digest === 'string'
    && Number.isSafeInteger(mark.exportedAt) && Array.isArray(mark.devices) && mark.devices.length > 0
    && mark.devices.every(device => !!device && Object.keys(device).sort().join(',') === 'deviceId,frozenRevision'
      && typeof device.deviceId === 'string' && Number.isSafeInteger(device.frozenRevision) && device.frozenRevision > 0);
  if (!valid) throw new Error('Invalid switch export record');
}


const INTENT_KEYS = ['id', 'key', 'source', 'execution', 'waitUntil', 'retry', 'agent', 'sequence', 'phase', 'generation', 'taskId', 'notBefore', 'attempts'];
const INTENT_OPTIONAL = ['memoryBlocked', 'preparationError', 'occurrence', 'retryUntil', 'cancelReason', 'conclusion'];
const EXECUTION_KEYS = ['input', 'submission', 'started'], EXECUTION_OPTIONAL = ['messageReceipt', 'attempt', 'terminal'];
const ROUTINE_KEYS = ['definition', 'lifecycle', 'status', 'next'];
const ROUTINE_OPTIONAL = ['pending', 'scheduleRetryAt', 'scheduleRetryCount', 'lastError', 'calendarErrors'];
const OCCURRENCE_KEYS = ['key', 'routineId', 'definitionVersion', 'trigger', 'wakeKey', 'recordedAt', 'nextAt', 'attempts'];
const OCCURRENCE_OPTIONAL = ['intentId', 'job', 'hook', 'conclusion', 'slotReplayCount'];
const LEDGER_KEYS = ['version', 'sequence', 'scanSequence', 'intents', 'executions', 'routines', 'occurrences', 'slots', 'outbox', 'applied',
  'application', 'scanWake'];
const LEDGER_OPTIONAL = ['memory', 'ignoredWakes'];

function refuse(reason: SwitchExportRefusal, message: string): never { throw new SwitchExportError(reason, `Switch export source: ${message}`); }
/** A stored copy that differs from the value it is derived from. */
function derived(ok: boolean, message: string): void { if (!ok) refuse('reference', message); }
/** Exact keys: a field that the neutral form does not name would be dropped, so it is refused. */
function exact(value: object, required: readonly string[], optional: readonly string[], what: string): void {
  const own = Object.keys(value);
  if (!required.every(key => own.includes(key)) || !own.every(key => required.includes(key) || optional.includes(key))) {
    refuse('invalid', `${what} has keys ${own.join(', ')}`);
  }
}
const same = (a: unknown, b: unknown) => canonical(a as Json) === canonical(b as Json);
/** The fields of `source` whose value is not undefined. */
function defined<T extends object>(source: T): Partial<T> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** The K8 state of a ledger without the source Host's owner records, which a target writes for itself. */
function liveState(state: CollaborationState): CollaborationState {
  const live = structuredClone(state);
  delete live.topology; delete live.hostIntents; delete live.switchExport; delete live.switchImport;
  return live;
}

/**
 * Reads an L ledger dump into the neutral form, and refuses a stored copy that differs from the value it is derived from
 * (#975 "Export builder must check"). `tenant` names the ledger (its `agent` keys); `header` is the document's.
 */
export function switchContent(dump: LedgerDump, tenant: string, header: SwitchHeader): SwitchContent {
  const s = dump.body;
  exact(s, LEDGER_KEYS, LEDGER_OPTIONAL, 'The K4 ledger');
  // D4: memory binds the tenant inside its digests, and K4 cannot load it into another tenant.
  if (s.memory && Object.values(s.memory).some(rows => rows && Object.keys(rows).length) || dump.memoryTombstones.length) {
    refuse('invalid', 'the domain has Agent memory state, which a switch does not move');
  }
  exact(s.application, ['collaboration'], [], 'The K4 application state');
  const state = stateOf(s.application);
  const handlers = state.hostIntents ?? {};

  const intents: IntentRecord[] = [], tasks = new Set<string>(), succeeded = new Set<string>();
  for (const [id, intent] of Object.entries(s.intents)) {
    exact(intent, INTENT_KEYS, INTENT_OPTIONAL, `Intent ${intent.key}`);
    if (!intent.conclusion || intent.phase !== 'settled') refuse('open_work', `intent ${intent.key} is open`);
    derived(id === hash(intent.key), `intent ${intent.key} is stored under ${id}`);
    derived(intent.agent === agentKey(tenant, intent.execution), `intent ${intent.key} queues under another tenant`);
    derived(intent.taskId === taskId(intent.key, intent.generation), `intent ${intent.key} task id is not that of its generation`);
    derived(isOccurrenceIntentKey(intent.key) ? intent.occurrence !== undefined && intent.key === occurrenceIntentKey(intent.occurrence)
      : intent.occurrence === undefined,
      `intent ${intent.key} names occurrence ${String(intent.occurrence)}`);
    const current = s.executions[intent.taskId];
    if (!current) refuse('reference', `intent ${intent.key} has no execution`);
    exact(current, EXECUTION_KEYS, EXECUTION_OPTIONAL, `Execution ${intent.taskId}`);
    derived(same(current.input, frozenInput(intent.execution, intent.taskId)), `intent ${intent.key} execution differs from its frozen input`);
    derived(intent.attempts === switchAttempts({ submission: current.submission, generation: intent.generation }), `intent ${intent.key} attempts`);
    tasks.add(intent.taskId);
    const earlierExecutions: ExecutionRecord[] = [];
    for (let generation = 0; generation < intent.generation; generation++) {
      const task = taskId(intent.key, generation), earlier = s.executions[task];
      if (!earlier) refuse('reference', `intent ${intent.key} has no execution of generation ${generation}`);
      exact(earlier, EXECUTION_KEYS, EXECUTION_OPTIONAL, `Execution ${task}`);
      derived(same(earlier.input, frozenInput(intent.execution, task)), `intent ${intent.key} generation ${generation} input differs`);
      if (earlier.submission === 'reserved') refuse('invalid', `intent ${intent.key} generation ${generation} was never begun`);
      // A missing attempt or terminal stays missing, and the format refuses it.
      earlierExecutions.push(defined({ submission: earlier.submission, started: earlier.started, attempt: earlier.attempt as unknown as Json,
        terminal: earlier.terminal as unknown as Json, messageReceipt: earlier.messageReceipt }) as ExecutionRecord);
      tasks.add(task);
    }
    if (intent.conclusion === 'succeeded') succeeded.add(intent.taskId);
    const handler = Object.hasOwn(handlers, intent.key) ? handlers[intent.key]!.handler : undefined;
    intents.push(defined({
      key: intent.key, source: intent.source, handler, ordinal: intent.sequence, taskId: intent.taskId, generation: intent.generation,
      input: current.input as unknown as Json, waitUntil: intent.waitUntil, retry: intent.retry, submission: current.submission, started: current.started,
      attempt: current.attempt as unknown as Json | undefined, terminal: current.terminal as unknown as Json | undefined, messageReceipt: current.messageReceipt,
      earlierExecutions, preparationError: intent.preparationError, memoryBlocked: intent.memoryBlocked, cancelReason: intent.cancelReason,
      retryUntil: intent.retryUntil, conclusion: intent.conclusion,
    }) as IntentRecord);
  }
  // An execution that no intent names, a handler of no intent, or an `applied` entry other than a succeeded current task
  // would be dropped; K4 sets `applied` only with the success settle (`core.ts` terminal).
  for (const task of Object.keys(s.executions)) derived(tasks.has(task), `execution ${task} belongs to no intent`);
  for (const key of Object.keys(handlers)) derived(!!s.intents[hash(key)], `Host intent ${key} has no K4 intent`);
  derived(same(Object.keys(s.applied).sort(), [...succeeded].sort()), 'K4 applied is not the succeeded current tasks');

  const routines: RoutineRecord[] = Object.entries(s.routines).map(([id, routine], ordinal) => {
    exact(routine, ROUTINE_KEYS, ROUTINE_OPTIONAL, `Routine ${routine.definition.id}`);
    const { definition } = routine;
    derived(id === hash(definition.id), `routine ${definition.id} is stored under ${id}`);
    if (routine.next) {
      exact(routine.next, ['dedupKey', 'availableAt'], [], `Routine ${definition.id} next wake`);
      const parsed = parseRoutineWakeKey(routine.next.dedupKey);
      derived(parsed?.id === definition.id && parsed.version === definition.version && parsed.at === routine.next.availableAt
        && routine.next.dedupKey === routineWakeKey(definition.id, definition.version, routine.next.availableAt), `routine ${definition.id} next wake key`);
    }
    return defined({
      id: definition.id, ordinal, definition, pending: routine.pending, lifecycle: routine.lifecycle, status: routine.status,
      nextAt: routine.next?.availableAt ?? null, calendarErrors: routine.calendarErrors?.length ? routine.calendarErrors : undefined,
      scheduleRetryAt: routine.scheduleRetryAt, scheduleRetryCount: routine.scheduleRetryCount, lastError: routine.lastError,
    }) as RoutineRecord;
  });

  // The format pairs each Host job row with its open occurrence (`migration.ts` checkReferences).
  const slots = new Map<string, string>(), outbox: OutboxRecord[] = [];
  for (const [key, row] of Object.entries(s.outbox)) {
    if (row.kind === 'projection') refuse('projection_pending', `projection ${row.id} is not sent; flush it first`);
    if (row.kind === 'intent') refuse('open_work', `intent ${row.intentId} has a pending submit`);
    if (row.kind !== 'host-job') continue; // `schedule` and `cancel-wake` are this SDK's wakes; a target schedules its own.
    exact(row, ['kind', 'occurrenceKey'], [], `Host job ${row.occurrenceKey}`);
    derived(key === `host-job:${row.occurrenceKey}`, `Host job row ${key}`);
    outbox.push({ kind: 'host-job', occurrenceKey: row.occurrenceKey });
  }
  const occurrences: OccurrenceRecord[] = Object.entries(s.occurrences).map(([key, row], ordinal) => {
    exact(row, OCCURRENCE_KEYS, OCCURRENCE_OPTIONAL, `Occurrence ${key}`);
    derived(row.key === key, `occurrence ${row.key} is stored under ${key}`);
    const parsed = parseRoutineWakeKey(row.wakeKey);
    derived(parsed?.id === row.routineId && parsed.version === row.definitionVersion && parsed.at === row.trigger.plannedAt
      && row.wakeKey === routineWakeKey(row.routineId, row.definitionVersion, row.trigger.plannedAt), `occurrence ${key} wake key`);
    slots.set(hash(row.wakeKey), key);
    const intent = s.intents[hash(occurrenceIntentKey(key))];
    derived(intent ? row.intentId === intent.id : row.intentId === undefined, `occurrence ${key} intent id`);
    derived(row.attempts === switchAttempts(intent && { submission: s.executions[intent.taskId]!.submission, generation: intent.generation }),
      `occurrence ${key} attempts`);
    // A promoted occurrence's conclusion is its intent's (K4 `settle`), so it is not carried.
    derived(intent ? row.conclusion === intent.conclusion : true, `occurrence ${key} conclusion differs from its intent's`);
    if ((row.job === undefined) === (row.hook === undefined)) refuse('invalid', `occurrence ${key} is not exactly one of a Host job and a hook`);
    if (row.job) exact(row.job, ['attempts'], ['summary', 'executionSuperseded'], `Occurrence ${key} job`);
    if (row.hook) exact(row.hook, [], ['executionSuperseded'], `Occurrence ${key} hook`);
    return defined({
      key, ordinal, routineId: row.routineId, definitionVersion: row.definitionVersion, trigger: row.trigger, recordedAt: row.recordedAt,
      nextAt: row.nextAt, job: row.job ? defined({ attempts: row.job.attempts, summary: row.job.summary }) as OccurrenceRecord['job'] : null,
      executionSuperseded: !!(row.job ?? row.hook)!.executionSuperseded, conclusion: intent ? undefined : row.conclusion,
      slotReplayCount: row.slotReplayCount,
    }) as OccurrenceRecord;
  });
  derived(same(Object.entries(s.slots).sort(), [...slots].sort()), 'K4 slots are not one per occurrence');

  return {
    version: 1, ...header, collaboration: liveState(state),
    archived: dump.rows.map(row => defined({ namespace: row.namespace, id: row.id, body: row.value, expiresAt: row.expiresAt ?? undefined }) as SwitchContent['archived'][number]),
    intents, routines, occurrences, outbox,
    tombstones: dump.tombstones.map(row => defined({ kind: row.kind, digest: row.identity, expiresAt: row.expiresAt ?? undefined }) as SwitchContent['tombstones'][number]),
  };
}

/**
 * Writes the neutral form into a K4 dump bound to `tenant`. The K8 owner records the target needs are passed in `owner`.
 * A concluded row gets K4's values of a new row for its scheduler cursors (#975 D6): `phase: 'settled'`, `notBefore: 0`.
 */
export function switchDump(content: SwitchContent, tenant: string, owner: Pick<CollaborationState, 'topology' | 'switchImport'>): LedgerDump {
  // K4 keeps routines and occurrences in insertion order, and the format makes their ordinals their positions.
  const byOrdinal = <T extends { ordinal: number }>(rows: readonly T[]) => [...rows].sort((a, b) => a.ordinal - b.ordinal);
  const records = new Map(content.intents.map(row => [row.key, row]));
  const s: LedgerState = { version: 1, sequence: Math.max(0, ...content.intents.map(row => row.ordinal)), scanSequence: 0, intents: {}, executions: {},
    routines: {}, occurrences: {}, slots: {}, outbox: {}, applied: {}, application: {}, scanWake: null };
  const hostIntents: Record<string, { handler: string }> = {};
  for (const row of byOrdinal(content.intents)) {
    const { taskId: _task, ...execution } = row.input as unknown as Intent['execution'] & { taskId: string };
    const intent: Intent = defined({
      key: row.key, source: row.source, execution, waitUntil: row.waitUntil, retry: row.retry, id: hash(row.key), agent: agentKey(tenant, execution),
      sequence: row.ordinal, phase: 'settled', generation: row.generation, taskId: row.taskId, notBefore: 0,
      attempts: switchAttempts(row), memoryBlocked: row.memoryBlocked, preparationError: row.preparationError,
      retryUntil: row.retryUntil,
      cancelReason: row.cancelReason, conclusion: row.conclusion,
    }) as Intent;
    s.intents[intent.id] = intent;
    s.executions[row.taskId] = defined({ input: row.input, submission: row.submission, started: row.started, attempt: row.attempt,
      terminal: row.terminal, messageReceipt: row.messageReceipt }) as unknown as LedgerState['executions'][string];
    row.earlierExecutions.forEach((earlier, generation) => {
      const task = taskId(row.key, generation);
      s.executions[task] = defined({ input: frozenInput(execution, task), ...earlier }) as unknown as LedgerState['executions'][string];
    });
    if (row.conclusion === 'succeeded') s.applied[row.taskId] = true;
    if (row.handler !== undefined) Object.defineProperty(hostIntents, row.key, { value: { handler: row.handler }, enumerable: true, writable: true, configurable: true });
  }
  for (const row of byOrdinal(content.routines)) {
    s.routines[hash(row.id)] = defined({
      definition: row.definition, pending: row.pending, lifecycle: row.lifecycle, status: row.status,
      next: row.nextAt === null ? null : { dedupKey: routineWakeKey(row.id, row.definition.version, row.nextAt), availableAt: row.nextAt },
      calendarErrors: row.calendarErrors, scheduleRetryAt: row.scheduleRetryAt, scheduleRetryCount: row.scheduleRetryCount, lastError: row.lastError,
    }) as Routine;
  }
  for (const row of byOrdinal(content.occurrences)) {
    const wakeKey = routineWakeKey(row.routineId, row.definitionVersion, row.trigger.plannedAt);
    // The occurrence names its intent (K4 `promote`): the format checks that each occurrence intent names one.
    const intent = s.intents[hash(occurrenceIntentKey(row.key))];
    if (intent) intent.occurrence = row.key;
    const superseded = row.executionSuperseded ? { executionSuperseded: true as const } : {};
    s.occurrences[row.key] = defined({
      key: row.key, routineId: row.routineId, definitionVersion: row.definitionVersion, trigger: row.trigger, wakeKey, recordedAt: row.recordedAt,
      nextAt: row.nextAt, intentId: intent?.id, job: row.job ? { ...row.job, ...superseded } : undefined, hook: row.job ? undefined : superseded,
      attempts: switchAttempts(records.get(occurrenceIntentKey(row.key))), conclusion: intent ? intent.conclusion : row.conclusion, slotReplayCount: row.slotReplayCount,
    }) as Occurrence;
    s.slots[hash(wakeKey)] = row.key;
  }
  for (const row of content.outbox) s.outbox[`host-job:${row.occurrenceKey}`] = { kind: 'host-job', occurrenceKey: row.occurrenceKey };
  s.application.collaboration = { ...structuredClone(content.collaboration), ...(Object.keys(hostIntents).length ? { hostIntents } : {}),
    ...defined(owner) } as unknown as Json;
  return {
    version: 1, body: s, memoryTombstones: [],
    tombstones: content.tombstones.map(row => ({ kind: row.kind, identity: row.digest, expiresAt: row.expiresAt ?? null })),
    rows: content.archived.map(row => ({ namespace: row.namespace, id: row.id, value: row.body, expiresAt: row.expiresAt ?? null })),
  };
}

/** The header of a document, which a read-back copies as it is. */
const headerOf = (document: SwitchContent): SwitchHeader =>
  ({ source: document.source, domain: document.domain, devices: document.devices, exportedAt: document.exportedAt });
/** Seals the content that a ledger holds now, under a given header. */
export function sealLedger(ledger: HostLedger, header: SwitchHeader): SwitchExport {
  return sealSwitchExport(switchContent(ledger.dumpForSwitch(), ledger.tenant, header));
}

const importOf = (state: CollaborationState): SwitchImport => {
  if (!state.switchImport) throw new Error('This ledger holds no switch import record');
  return state.switchImport;
};

/**
 * Step 2 of a switch to L (#975): writes an H export into an empty L ledger tenant and verifies it. The document must verify,
 * and each of its devices is recorded as owned by H until `commitImport`. The ledger then reads its own rows back into the
 * neutral form under the document's header, and the digest must be the document's: a mismatch throws, and the caller runs
 * `discardImport`. Returns the receipt the old owner commits away on. No `BotCollaboration` may open the ledger before the
 * commit; a `BotCollaboration` refuses a ledger with an import.
 */
export function importForSwitch(ledger: HostLedger, document: SwitchExport): SwitchReceipt {
  const manifest = verifySwitchExport(document);
  if (document.source !== 'H') throw new SwitchExportError('invalid', `An L owner imports only an H export, not one from ${document.source}`);
  const devices = document.devices.map((device: SwitchDevice) => device.deviceId);
  const topology = {};
  for (const id of devices) Object.defineProperty(topology, id, { value: { mode: 'H', revision: 1 }, enumerable: true, writable: true, configurable: true });
  ledger.loadForSwitch(switchDump(document, ledger.tenant, { topology, switchImport: { digest: manifest.digest, devices, verified: false } }));
  const back = sealLedger(ledger, headerOf(document)).manifest.digest;
  if (back !== manifest.digest) throw new SwitchExportError('manifest', `The imported ledger reads back as ${back}, not ${manifest.digest}; discard the import first`);
  ledger.transaction(s => {
    const record = importOf(stateOf(s.application));
    if (record.digest !== manifest.digest || record.discarding) throw new Error('The switch import changed during its verification');
    record.verified = true;
  });
  return { digest: manifest.digest, devices };
}

/**
 * Step 4 of a switch to L, after the old owner committed away on the receipt: L owns each device of the import. Only
 * a verified import of this digest that is not being discarded commits. Then a `BotCollaboration` can open the ledger.
 */
export function commitImport(ledger: HostLedger, digest: string): void {
  ledger.transaction(s => {
    const state = stateOf(s.application), record = importOf(state);
    if (!record.verified || record.discarding) throw new Error('The switch import is not verified');
    if (record.digest !== digest) throw new Error(`The switch import is ${record.digest}, not ${digest}`);
    for (const id of record.devices) {
      const row = state.topology && Object.hasOwn(state.topology, id) ? state.topology[id] : undefined;
      if (row?.mode !== 'H' || row.revision !== 1 || row.switching) throw new Error(`Device ${id} is not an imported device`);
      state.topology![id] = { mode: 'L', revision: 2 };
    }
    delete state.switchImport;
  });
}

/**
 * Deletes an import that was not committed: after a failed read-back, or when the old owner aborts. It first records
 * that the import is being discarded, so `commitImport` refuses it from then on, then deletes the tenant (K4 `discard`).
 * A committed tenant has no import record, so it is refused; no `BotCollaboration` ran work on an uncommitted one.
 */
export function discardImport(ledger: HostLedger): void {
  ledger.transaction(s => { importOf(stateOf(s.application)).discarding = true; });
  ledger.discard();
}
