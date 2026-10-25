import { canonical, hash } from '@byok-sdk/example-host-execution-core/canonical';
import { taskId as taskIdOf, validateJson, type Conclusion, type Intent, type Json, type Occurrence, type RetryPolicy, type Routine,
  type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from './model';

/**
 * The state that an L/H owner switch moves (#975, design §8): one coordination domain, an L ledger tenant or an H scope,
 * exported by the old owner after every device of the domain is frozen and drained, and imported by the new owner into an
 * empty domain. Both Hosts read and write this one neutral form, so neither Host's storage is the format. The old owner
 * seals it; the new owner verifies it, writes it, reads its own rows back into this form, and compares the digest.
 *
 * A record holds what a target needs to rebuild the row. Each value is one the source stores, never a default. H stores
 * only part of it today: the K4-only fields (#975 D1 to D5) get H columns in the H slice that imports them, and until then
 * H cannot import a record that has them. Every object has an exact set of keys, so nothing an importer would drop can
 * ride along.
 *
 * A value that a Host derives from others is not in the record, and the target derives its own. The format never sees
 * the source's stored copies, so each Host's export builder checks its copies against these rules and refuses to build an
 * export where one differs:
 * - an intent's `agent`, K4 `agentKey(domain, execution)` (`transitions.ts`, H `intents.ts` with its scope). It names the
 *   source's tenant or scope, and K4 `loadForSwitch` refuses another tenant's, so each target derives it with its domain;
 * - the K4 execution input of an earlier generation, and K4 `intent.execution`: `input` with that generation's task id, and
 *   `input` without `taskId`. That holds while K4 runs without its memory option, which rewrites the frozen instruction
 *   (`core.ts` begin); K8 passes none;
 * - K4 `applied`: the current task id exactly when `conclusion` is `succeeded`, which K4 sets only with that settle
 *   (`core.ts` terminal);
 * - a K4 occurrence's wake key and slot, `${routineId}:${definitionVersion}:${trigger.plannedAt}` and its hash. K4 records
 *   and compacts one slot with each occurrence (`routines.ts` recordOccurrence, `ledger.ts` compact), and H's slot is the
 *   occurrence's unique `(routine_id, definition_version, planned_at)`, so the format has no slot section;
 * - an occurrence's intent id, and K4 `attempts` (see `IntentRecord` and `OccurrenceRecord`).
 * An occurrence key is checked here as well: K4 `hash([routineId, definitionVersion, trigger])`.
 *
 * The digest covers the header too: `domain` is the source's tenant or scope id, never the target's (a switch back to L
 * opens a new tenant). So the target's read-back copies the document's header as it is and rebuilds only the sections
 * from its own rows. Devices are in JS string order of `deviceId`, and each section in JS string order of
 * `canonical(identity)`, so a read-back sorts that way in JS or reseals; a database `ORDER BY` would give `unsorted`.
 *
 * A channel delivery moves under its id, `hash([taskId, messageId, route])` (`delivery.ts`), which names no domain, so
 * the target's readback or resend of a `sending` or `unknown` delivery uses the source's idempotency key. Whether a
 * platform honors that key is its adapter's concern (`docs/host-im-adapter.md`), and the switch does not change it. A
 * projection does not move: H's receiver deduplicates by `(scope, id)` (H `sender.ts` ProjectionPort), and neither Host
 * records whether a pending projection was sent, so the source flushes its projections before the export.
 */
export const SWITCH_EXPORT_VERSION = 1;
export const SWITCH_SECTIONS = ['collaboration', 'archived', 'intents', 'routines', 'occurrences', 'outbox', 'tombstones'] as const;
export type SwitchSection = typeof SWITCH_SECTIONS[number];

/** A device of the domain and its revision on the source Host, frozen by the source's open switch. */
export interface SwitchDevice { deviceId: string; frozenRevision: number }
/** A K8 retention row (#798), `commands` included, with its absolute expiry. The importer keeps the expiry. */
export interface ArchivedRecord { namespace: string; id: string; body: Json; expiresAt?: number }
/** An accepted Agent message of one task: the K4 execution's `messageReceipt`. */
export interface MessageReceipt { messageId: string; contentHash: string }
/** The K4 execution facts of one earlier generation of an intent. K4 begins each generation before it opens the next. */
export interface ExecutionRecord {
  submission: 'uncertain' | 'delivered'; started: boolean; attempt?: Json; terminal?: Json; messageReceipt?: MessageReceipt;
}
/**
 * A concluded intent, moved as a row: L K4 `intents` and `executions[taskId]` with K8 `hostIntents`, H `intent`. `input` is
 * the frozen execution input that was submitted, a sealed one still sealed. A late terminal or message for it is refused
 * by its conclusion; one for a compacted intent, by its `intent` tombstone.
 *
 * `earlierExecutions` holds generations 0 to `generation - 1`, in order, each with the execution facts K4 stores
 * (#975 D1). Its task id is `hash([key, generation])` and its input is `input` with that task id, so neither is stored.
 * K4 compacts an intent only with the execution of every generation (`ledger.ts` compact: `Missing execution evidence`).
 * A message for an earlier task is answered from its execution, by its receipt or else `stale_generation`, never
 * `unknown_task` (`core.ts` consumeMessage); H stores the same generations in its H slice. Nothing here relies on a
 * replay after the switch getting `accepted`: the target's SDK passes an Agent message to the Host only when its own
 * stores hold the device's task and offer binding (`packages/cloud` `inbound.ts`), which this export does not carry and
 * no code moves.
 *
 * Each receipt, current or earlier, is the same fact as the K8 accepted reply of its task id, so the two must agree. A
 * `reserved` intent is in generation 0 and was never submitted: K4 begins a new generation in the transaction that
 * opens it. So K4 `attempts` is not carried: it is `generation + 1` once the intent began, and 0 while `reserved`.
 *
 * The scheduler cursors of a concluded row are not carried either (#975 D6, the one exception to "no defaults"): K4
 * `phase` and `notBefore`, H `tries`, `next_at`, `reconcile_at` and `last_error`. Nothing reads them on a concluded row,
 * so a target writes its own initial values of a new row.
 */
export interface IntentRecord {
  key: string; source: 'user' | 'bot' | 'routine'; handler?: string; ordinal: number;
  taskId: string; generation: number; input: Json; waitUntil: number; retry: RetryPolicy;
  submission: 'reserved' | 'uncertain' | 'delivered'; started: boolean; attempt?: Json; terminal?: Json;
  messageReceipt?: MessageReceipt; earlierExecutions: ExecutionRecord[];
  preparationError?: string; memoryBlocked?: NonNullable<Intent['memoryBlocked']>;
  cancelReason?: 'expired' | 'cancelled'; retryUntil?: number; conclusion: Conclusion;
}
/**
 * A routine: L K4 `routines` (its insertion order is `ordinal`), H `routine`. `nextAt` is the planned slot. The schedule
 * retry fields and `lastError` are K4's pacing of a slot past the SDK's furthest wake, and `lastError` is never cleared.
 */
export interface RoutineRecord {
  id: string; ordinal: number; definition: RoutineDefinition; pending?: RoutineDefinition;
  lifecycle: Routine['lifecycle']; status: Routine['status']; nextAt: number | null; calendarErrors?: NonNullable<Routine['calendarErrors']>;
  scheduleRetryAt?: number; scheduleRetryCount?: number; lastError?: NonNullable<Routine['lastError']>;
}
/**
 * An occurrence: L K4 `occurrences` (its insertion order is `ordinal`), H `occurrence`. `job` is a Host job's tries and
 * summary, `null` for an occurrence hook. `conclusion` is set only on one with no intent; a promoted one has its intent's.
 * K4 `attempts` is not carried: it is its intent's, or 0. `slotReplayCount` counts redelivered wakes of its slot.
 */
export interface OccurrenceRecord {
  key: string; ordinal: number; routineId: string; definitionVersion: number; trigger: Occurrence['trigger'];
  recordedAt: number; nextAt: number | null; job: { attempts: number; summary?: Json } | null; executionSuperseded: boolean;
  conclusion?: Conclusion; slotReplayCount?: number;
}
/** A pending Host job of an open occurrence. The target runs it again, as K4 does after a crash. */
export interface OutboxRecord { kind: 'host-job'; occurrenceKey: string }
/** A permanent or expiring tombstone in the K4 scheme: the digest of the retired identity, by kind. */
export interface TombstoneRecord { kind: 'intent' | 'row' | 'slot' | 'application'; digest: string; expiresAt?: number }

export interface SwitchContent {
  version: typeof SWITCH_EXPORT_VERSION; source: 'L' | 'H'; domain: string; devices: SwitchDevice[]; exportedAt: number;
  /** The live state. The source Host's owner records (L `topology`, L `hostIntents`, now on each intent) are not part of it. */
  collaboration: CollaborationState;
  archived: ArchivedRecord[]; intents: IntentRecord[]; routines: RoutineRecord[]; occurrences: OccurrenceRecord[];
  outbox: OutboxRecord[]; tombstones: TombstoneRecord[];
}
/** The count and digest of each section, and `digest` over them and the header: the identity of one export. */
export interface SwitchManifest { counts: Record<SwitchSection, number>; digests: Record<SwitchSection, string>; digest: string }
export interface SwitchExport extends SwitchContent { manifest: SwitchManifest }

export type SwitchExportRefusal = 'invalid' | 'unsorted' | 'duplicate' | 'reference' | 'receipt_mismatch' | 'owner_record' | 'device_missing' | 'open_work'
  | 'home_sent' | 'projection_pending' | 'card_call' | 'manifest';
/** An export that the format refuses. Nothing may be imported or committed from it. */
export class SwitchExportError extends Error {
  readonly code = 'switch_export_refused' as const;
  constructor(readonly reason: SwitchExportRefusal, message: string) { super(message); this.name = 'SwitchExportError'; }
}

type ListSection = Exclude<SwitchSection, 'collaboration'>;
/** The identity that orders each section and must be unique in it. */
const IDENTITY: { [S in ListSection]: (row: SwitchContent[S][number]) => Json } = {
  archived: row => [(row as ArchivedRecord).namespace, (row as ArchivedRecord).id],
  intents: row => (row as IntentRecord).key,
  routines: row => (row as RoutineRecord).id,
  occurrences: row => (row as OccurrenceRecord).key,
  outbox: row => [(row as OutboxRecord).kind, (row as OutboxRecord).occurrenceKey],
  tombstones: row => [(row as TombstoneRecord).kind, (row as TombstoneRecord).digest],
};
const LISTS = SWITCH_SECTIONS.filter((section): section is ListSection => section !== 'collaboration');
const HEADER = ['version', 'source', 'domain', 'devices', 'exportedAt'] as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Seals the old owner's content: checks it, orders each section by its identity and computes the manifest. Returns a new
 * document; the content is not changed. Throws `SwitchExportError` for content that no target may import.
 */
export function sealSwitchExport(content: SwitchContent): SwitchExport {
  // Before the clone, which would turn a class instance into a plain object that `validateJson` accepts.
  checkContent(content, [...HEADER, ...SWITCH_SECTIONS]);
  const sealed = structuredClone(content);
  sealed.devices.sort((a, b) => compare(a.deviceId, b.deviceId));
  for (const section of LISTS) {
    const key = IDENTITY[section] as (row: unknown) => Json;
    (sealed[section] as unknown[]).sort((a, b) => compare(canonical(key(a)), canonical(key(b))));
  }
  checkOrder(sealed);
  return { ...sealed, manifest: manifestOf(sealed) };
}

/**
 * Verifies a document before an import, and the new owner's read-back after it: the format checks, each section in its
 * one order with unique identities, and the manifest recomputed from the content. Returns the manifest.
 */
export function verifySwitchExport(document: SwitchExport): SwitchManifest {
  checkContent(document, [...HEADER, ...SWITCH_SECTIONS, 'manifest']);
  ensure(keys(document.manifest, ['counts', 'digests', 'digest']) && keys(document.manifest.counts, SWITCH_SECTIONS)
    && keys(document.manifest.digests, SWITCH_SECTIONS), 'manifest keys');
  checkOrder(document);
  const manifest = manifestOf(document);
  if (canonical(manifest) !== canonical(document.manifest)) {
    throw new SwitchExportError('manifest', `Switch export manifest does not match its content: ${document.manifest.digest} != ${manifest.digest}`);
  }
  return manifest;
}

function manifestOf(content: SwitchContent): SwitchManifest {
  const counts = {} as Record<SwitchSection, number>, digests = {} as Record<SwitchSection, string>;
  counts.collaboration = 1;
  digests.collaboration = hash(content.collaboration);
  for (const section of LISTS) {
    counts[section] = content[section].length;
    digests[section] = hash(content[section]);
  }
  const header = { version: content.version, source: content.source, domain: content.domain, devices: content.devices, exportedAt: content.exportedAt };
  return { counts, digests, digest: hash({ header, counts, digests }) };
}

function checkOrder(content: SwitchContent): void {
  for (let i = 1; i < content.devices.length; i++) {
    if (compare(content.devices[i - 1]!.deviceId, content.devices[i]!.deviceId) > 0) {
      throw new SwitchExportError('unsorted', `Switch export devices are not in id order at ${content.devices[i]!.deviceId}`);
    }
  }
  for (const section of LISTS) {
    const key = IDENTITY[section] as (row: unknown) => Json;
    const ids = (content[section] as unknown[]).map(row => canonical(key(row)));
    for (let i = 1; i < ids.length; i++) {
      const order = compare(ids[i - 1]!, ids[i]!);
      if (order === 0) throw new SwitchExportError('duplicate', `Switch export ${section} repeats ${ids[i]}`);
      if (order > 0) throw new SwitchExportError('unsorted', `Switch export ${section} is not in identity order at ${ids[i]}`);
    }
  }
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const digestText = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
/** Keyed by K4's `Conclusion`, so a new K4 conclusion fails to compile here until the format names it. */
const CONCLUSIONS: Record<Conclusion, true> = { succeeded: true, failed: true, declined: true, cancelled: true, expired: true, superseded: true };
const conclusionText = (value: unknown) => typeof value === 'string' && Object.hasOwn(CONCLUSIONS, value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const oneOf = (values: readonly string[]) => (value: unknown) => typeof value === 'string' && values.includes(value);
/** An object with every `required` key and no key outside `required` and `allowed`. */
function keys(value: unknown, required: readonly string[], allowed: readonly string[] = []): value is Record<string, unknown> {
  return object(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || allowed.includes(key));
}
const receiptShape = (value: unknown) => keys(value, ['messageId', 'contentHash']) && text(value.messageId) && text(value.contentHash);
/** K4's JSON rule: a value that serialization would change (`NaN`, `undefined`, a class instance) cannot be digested. */
/** K4 `ledger.ts` OCCURRENCE_INTENT_KEY: a routine occurrence's intent key. */
const OCCURRENCE_INTENT_KEY = /^occurrence:[0-9a-f]{64}$/;
function json(value: unknown): boolean { try { validateJson(value); return true; } catch { return false; } }
function invalid(message: string): never { throw new SwitchExportError('invalid', `Invalid switch export: ${message}`); }
function ensure(ok: boolean, message: string): void { if (!ok) invalid(message); }
function reference(ok: boolean, message: string): void { if (!ok) throw new SwitchExportError('reference', `Switch export ${message}`); }

/** The K4 `RoutineDefinition` keys, with exactly one of its three run kinds. */
function definition(value: unknown, id: string): boolean {
  const runs = ['execution', 'hostJob', 'hostOccurrence'];
  if (!keys(value, ['id', 'version', 'timeZone', 'rule', 'waitMs', 'lateAfterMs'], ['retry', 'endAt', ...runs])) return false;
  const present = runs.filter(run => value[run] !== undefined);
  if (present.length !== 1) return false;
  const run = value[present[0]!];
  return value.id === id && time(value.version) && value.version >= 1 && text(value.timeZone)
    && time(value.waitMs) && time(value.lateAfterMs) && optional(value.endAt, time)
    && optional(value.retry, retryPolicy)
    && (present[0] === 'execution' ? object(run) : keys(run, ['type', 'input']) && text(run.type));
}
function routineRecord(row: unknown): boolean {
  return keys(row, ['id', 'ordinal', 'definition', 'lifecycle', 'status', 'nextAt'],
    ['pending', 'calendarErrors', 'scheduleRetryAt', 'scheduleRetryCount', 'lastError']) && text(row.id) && time(row.ordinal)
    && definition(row.definition, row.id) && optional(row.pending, pending => definition(pending, row.id as string))
    && oneOf(['active', 'paused', 'completed'])(row.lifecycle)
    && oneOf(['ok', 'schedule_retrying', 'no_occurrence_within_horizon', 'calendar_error'])(row.status)
    && (row.nextAt === null || time(row.nextAt))
    && optional(row.calendarErrors, errors => Array.isArray(errors) && errors.length > 0
      && errors.every(error => keys(error, ['at', 'message'], ['wakeKey']) && time(error.at) && typeof error.message === 'string'
        && optional(error.wakeKey, text)))
    && optional(row.scheduleRetryAt, time) && optional(row.scheduleRetryCount, count => time(count) && count >= 1)
    && optional(row.lastError, error => keys(error, ['code', 'message']) && text(error.code) && typeof error.message === 'string');
}
function occurrenceRecord(row: unknown): boolean {
  return keys(row, ['key', 'ordinal', 'routineId', 'definitionVersion', 'trigger', 'recordedAt', 'nextAt', 'job', 'executionSuperseded'],
    ['conclusion', 'slotReplayCount'])
    && text(row.key) && time(row.ordinal) && text(row.routineId) && time(row.definitionVersion) && row.definitionVersion >= 1
    && keys(row.trigger, ['kind', 'plannedAt']) && oneOf(['scheduled', 'catch_up'])(row.trigger.kind) && time(row.trigger.plannedAt)
    && time(row.recordedAt) && (row.nextAt === null || time(row.nextAt))
    && (row.job === null || keys(row.job, ['attempts'], ['summary']) && time(row.job.attempts))
    && typeof row.executionSuperseded === 'boolean' && optional(row.conclusion, conclusionText)
    && optional(row.slotReplayCount, count => time(count) && count >= 1);
}
/** The policy K4 `validateRetry` (`model.ts`) accepts. K4 does not export it from its package index. */
function retryPolicy(retry: unknown): retry is { maxAttempts: number } {
  return keys(retry, ['maxAttempts', 'delaysMs', 'retryFailures'])
    && Number.isSafeInteger(retry.maxAttempts) && (retry.maxAttempts as number) >= 1 && (retry.maxAttempts as number) <= 100
    && Array.isArray(retry.delaysMs) && retry.delaysMs.length >= (retry.maxAttempts as number) - 1 && retry.delaysMs.every(time)
    && typeof retry.retryFailures === 'boolean';
}
const executionShape = (row: Record<string, unknown>) => typeof row.started === 'boolean'
  && optional(row.attempt, object) && optional(row.terminal, object) && optional(row.messageReceipt, receiptShape);
function intentRecord(row: unknown): boolean {
  return keys(row, ['key', 'source', 'ordinal', 'taskId', 'generation', 'input', 'waitUntil', 'retry', 'submission', 'started',
    'earlierExecutions', 'conclusion'], ['handler', 'attempt', 'terminal', 'messageReceipt', 'preparationError', 'memoryBlocked', 'cancelReason', 'retryUntil'])
    && text(row.key) && oneOf(['user', 'bot', 'routine'])(row.source) && optional(row.handler, text) && time(row.ordinal)
    && digestText(row.taskId) && time(row.generation) && time(row.waitUntil)
    // The target derives `agent` from the device and Agent of the frozen input, plain or sealed (K4 `agentKey`).
    && keys(row.input, ['taskId', 'deviceId', 'payload'], ['agentMessageContext']) && text(row.input.deviceId) && object(row.input.payload)
    && object(row.input.payload.agentRef) && text(row.input.payload.agentRef.agentId)
    // K4 opens a generation only for a retry within `maxAttempts` (`core.ts` reconcile and begin), and its policy is
    // bounded by `validateRetry`, so the receipt check below walks at most 100 generations.
    && retryPolicy(row.retry) && row.generation < row.retry.maxAttempts
    && oneOf(['reserved', 'uncertain', 'delivered'])(row.submission) && executionShape(row)
    // Never submitted, so nothing came back (K4 `admit`; `begin` moves it to `uncertain`).
    && (row.submission !== 'reserved' || row.generation === 0 && !row.started && row.attempt === undefined && row.terminal === undefined
      && row.messageReceipt === undefined)
    && Array.isArray(row.earlierExecutions) && row.earlierExecutions.length === row.generation
    && row.earlierExecutions.every(entry => keys(entry, ['submission', 'started'], ['attempt', 'terminal', 'messageReceipt'])
      && oneOf(['uncertain', 'delivered'])(entry.submission) && executionShape(entry))
    && optional(row.preparationError, text)
    && optional(row.memoryBlocked, blocked => keys(blocked, ['resume', 'reason']) && oneOf(['queued', 'backoff'])(blocked.resume)
      && typeof blocked.reason === 'string')
    && optional(row.cancelReason, oneOf(['expired', 'cancelled'])) && optional(row.retryUntil, time) && optional(row.conclusion, conclusionText);
}

function checkContent(content: SwitchContent, top: readonly string[]): void {
  ensure(keys(content, top), 'document keys');
  ensure(json(content), 'not JSON');
  ensure(content.version === SWITCH_EXPORT_VERSION, `version ${String(content.version)}`);
  ensure(content.source === 'L' || content.source === 'H', 'source');
  ensure(text(content.domain), 'domain');
  ensure(time(content.exportedAt), 'exportedAt');
  ensure(Array.isArray(content.devices) && content.devices.length > 0, 'devices');
  for (const device of content.devices) {
    ensure(keys(device, ['deviceId', 'frozenRevision']) && text(device.deviceId) && time(device.frozenRevision) && device.frozenRevision >= 1, 'device');
  }
  if (new Set(content.devices.map(device => device.deviceId)).size !== content.devices.length) {
    throw new SwitchExportError('duplicate', 'Switch export lists a device twice');
  }
  for (const section of LISTS) ensure(Array.isArray(content[section]), section);
  checkCollaboration(content);
  for (const row of content.archived) {
    ensure(keys(row, ['namespace', 'id', 'body'], ['expiresAt']) && text(row.namespace) && text(row.id) && optional(row.expiresAt, time), 'archived row');
  }
  for (const row of content.intents) {
    // An intent with no conclusion fails the shape too; report it as the open work it is.
    if (object(row) && row.conclusion === undefined) throw new SwitchExportError('open_work', `Switch export has an open intent: ${String(row.key)}`);
    ensure(intentRecord(row), 'intent');
  }
  for (const row of content.routines) ensure(routineRecord(row), 'routine');
  for (const row of content.occurrences) ensure(occurrenceRecord(row), 'occurrence');
  for (const row of content.outbox as unknown[]) {
    if (object(row) && row.kind === 'projection') {
      throw new SwitchExportError('projection_pending', `Switch export has a pending projection; flush it first: ${String(row.id)}`);
    }
    ensure(keys(row, ['kind', 'occurrenceKey']) && row.kind === 'host-job' && text(row.occurrenceKey), 'outbox row');
  }
  for (const row of content.tombstones) {
    ensure(keys(row, ['kind', 'digest'], ['expiresAt']) && oneOf(['intent', 'row', 'slot', 'application'])(row.kind) && digestText(row.digest)
      && optional(row.expiresAt, time), 'tombstone');
  }
  checkReferences(content);
}

/** Each record that names another names one in the export, and each identity that K4 derives matches its source. */
function checkReferences(content: SwitchContent): void {
  for (const section of ['intents', 'routines', 'occurrences'] as const) {
    const ordinals = content[section].map(row => row.ordinal);
    if (new Set(ordinals).size !== ordinals.length) throw new SwitchExportError('duplicate', `Switch export ${section} repeats an ordinal`);
  }
  const routines = new Set(content.routines.map(row => row.id));
  const occurrences = new Map(content.occurrences.map(row => [row.key, row]));
  const promoted = new Set<string>();
  for (const row of content.intents) {
    reference(row.taskId === taskIdOf(row.key, row.generation), `intent ${row.key} has task id ${row.taskId}, not that of generation ${row.generation}`);
    ensure((row.input as { taskId?: unknown }).taskId === row.taskId, `intent ${row.key} input is not frozen for its task id`);
    // K4's own test for an occurrence intent (`ledger.ts` OCCURRENCE_INTENT_KEY, not exported); any other key is a Host's.
    if (OCCURRENCE_INTENT_KEY.test(row.key)) {
      const key = row.key.slice('occurrence:'.length);
      reference(occurrences.has(key), `intent ${row.key} names no occurrence of the export`);
      promoted.add(key);
    }
  }
  const slots = new Set<string>();
  for (const row of content.occurrences) {
    reference(routines.has(row.routineId), `occurrence ${row.key} names no routine of the export: ${row.routineId}`);
    reference(row.key === hash([row.routineId, row.definitionVersion, row.trigger]), `occurrence ${row.key} is not the key of its routine slot and trigger`);
    // One occurrence per slot: the target derives the slot from it.
    const slot = `${row.routineId}:${row.definitionVersion}:${row.trigger.plannedAt}`;
    if (slots.has(slot)) throw new SwitchExportError('duplicate', `Switch export has two occurrences of the slot of ${row.key}`);
    slots.add(slot);
    // A promoted occurrence's conclusion is its intent's, which K4 copies and H does not store.
    ensure(!(promoted.has(row.key) && row.conclusion !== undefined), `occurrence ${row.key} has an intent and its own conclusion`);
  }
  // The K8 accepted reply of a task, live or retained (#798), is the same fact as the K4 message receipt of that task.
  const archivedReplies = new Map(content.archived.filter(row => row.namespace === 'replies').map(row => [row.id, row.body]));
  const replyOf = (taskId: string) => (content.collaboration.replies as Record<string, unknown>)[taskId] ?? archivedReplies.get(taskId);
  for (const row of content.intents) {
    // Every generation of the intent, current and earlier: a receipt and a K8 reply of its task id come together or not at all.
    const receipts = [...row.earlierExecutions.map(entry => entry.messageReceipt), row.messageReceipt];
    for (let generation = 0; generation <= row.generation; generation++) {
      const reply = replyOf(taskIdOf(row.key, generation)), receipt = receipts[generation];
      const same = receipt === undefined ? reply === undefined
        : object(reply) && reply.messageId === receipt.messageId && reply.contentHash === receipt.contentHash;
      if (!same) {
        throw new SwitchExportError('receipt_mismatch', `Switch export intent ${row.key} generation ${generation} has a message receipt that differs from its K8 reply`);
      }
    }
  }
  const routineById = new Map(content.routines.map(row => [row.id, row]));
  for (const row of content.outbox) {
    const occurrence = occurrences.get(row.occurrenceKey);
    reference(occurrence?.job != null, `Host job ${row.occurrenceKey} names no Host job occurrence`);
    // K4 runs a pending Host job only for an open, unpromoted occurrence of a Host job routine (`core.ts` runHostJobs).
    ensure(occurrence!.conclusion === undefined && !promoted.has(occurrence!.key)
      && routineById.get(occurrence!.routineId)!.definition.hostJob !== undefined, `Host job ${row.occurrenceKey} is pending for a concluded occurrence`);
  }
}

/** The K8 state keys (`model.ts`). The source's owner records (`topology`, `hostIntents`) are refused as `owner_record`. */
const COLLABORATION_KEYS = ['version', 'team', 'turns', 'budgets', 'delegations', 'batches', 'units', 'replies', 'schemas', 'questions', 'cards',
  'rejected', 'audit', 'sequence'];
const COLLABORATION_OPTIONAL = ['inputs', 'inputBatches', 'channel', 'revision', 'commands', 'cardCalls'];

/**
 * The live state of a drained domain: no owner record of the source, every live Bot on a device of the export, no Turn or
 * input batch left open, no Agent home write that may have reached a device, and no card call in flight.
 */
function checkCollaboration(content: SwitchContent): void {
  const state = content.collaboration;
  ensure(object(state), 'collaboration state');
  if (state.topology !== undefined) throw new SwitchExportError('owner_record', 'Switch export carries the source owner records (topology)');
  if (state.hostIntents !== undefined) throw new SwitchExportError('owner_record', 'Switch export carries L hostIntents; each intent carries its handler');
  ensure(keys(state, COLLABORATION_KEYS, COLLABORATION_OPTIONAL) && state.version === 3 && object(state.team) && object(state.team.bots)
    && Array.isArray(state.team.homeOperations) && object(state.turns) && optional(state.inputBatches, object) && optional(state.cardCalls, object),
  'collaboration state');
  for (const bot of Object.values(state.team.bots)) ensure(object(bot) && object(bot.execution) && text(bot.execution.deviceId), 'bot');
  for (const turn of Object.values(state.turns)) ensure(object(turn), 'turn');
  for (const batch of Object.values(state.inputBatches ?? {})) ensure(object(batch), 'input batch');
  for (const op of state.team.homeOperations) ensure(object(op), 'home operation');
  const devices = new Set(content.devices.map(device => device.deviceId));
  for (const bot of Object.values(state.team.bots)) {
    if (!bot.archived && !devices.has(bot.execution.deviceId)) {
      throw new SwitchExportError('device_missing', `Bot ${bot.id} runs on device ${bot.execution.deviceId}, which the export does not move`);
    }
  }
  for (const turn of Object.values(state.turns)) {
    if (!turn.conclusion) throw new SwitchExportError('open_work', `Switch export has an open Turn: ${turn.id}`);
  }
  for (const batch of Object.values(state.inputBatches ?? {})) {
    if (batch.state === 'open') throw new SwitchExportError('open_work', `Switch export has an open input batch: ${batch.id}`);
  }
  for (const op of state.team.homeOperations) {
    // A write that may have reached a device is the old owner's to settle before the export (#957); only an unsent one moves.
    if (op.status === 'pending' && (op.sent || op.retryAt !== undefined)) {
      throw new SwitchExportError('home_sent', `Switch export has a pending Agent home write that may have been sent: ${op.sequence}`);
    }
  }
  if (Object.keys(state.cardCalls ?? {}).length) throw new SwitchExportError('card_call', 'Switch export has a card call in flight');
}
