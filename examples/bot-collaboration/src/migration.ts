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
 * A record holds the fields that both Hosts store. Each value is one the source stores, never a default; a field that a
 * source can rebuild from others (a K4 wake key, an occurrence's intent id) is not in the record, and the source refuses
 * an export where its stored copy differs. Every object has an exact set of keys, so nothing an importer would drop can
 * ride along.
 *
 * The digest covers the header too: `domain` is the source's tenant or scope id, never the target's (a switch back to L
 * opens a new tenant). So the target's read-back copies the document's header as it is and rebuilds only the sections
 * from its own rows. Sections are in JS string order of their identities, so a read-back sorts in JS or reseals; a
 * database `ORDER BY` under a non-C collation would give `unsorted`.
 */
export const SWITCH_EXPORT_VERSION = 1;
export const SWITCH_SECTIONS = ['collaboration', 'archived', 'intents', 'routines', 'occurrences', 'slots', 'outbox', 'tombstones'] as const;
export type SwitchSection = typeof SWITCH_SECTIONS[number];

/** A device of the domain and its revision on the source Host, frozen by the source's open switch. */
export interface SwitchDevice { deviceId: string; frozenRevision: number }
/** A K8 retention row (#798), `commands` included, with its absolute expiry. The importer keeps the expiry. */
export interface ArchivedRecord { namespace: string; id: string; body: Json; expiresAt?: number }
/** An accepted Agent message of one task: the K4 execution's `messageReceipt`. */
export interface MessageReceipt { messageId: string; contentHash: string }
/**
 * A concluded intent, moved as a row: L K4 `intents` and `executions[taskId]` with K8 `hostIntents`, H `intent`. `input` is
 * the frozen execution input that was submitted, a sealed one still sealed. A late terminal or message for it is refused
 * by its conclusion; one for a compacted intent, by its `intent` tombstone.
 *
 * `messageReceipt` is the accepted Agent message of the current task, which K4 answers a replay from. `earlierReceipts`
 * holds the same for each earlier generation that has one (#975 D1): a replay of its message must still get `accepted`.
 * Its task id is `hash([key, generation])` and its binding input is `input` with that task id, so neither is stored. An
 * earlier generation with no receipt is compacted history: a late message for it is refused on either Host, and a
 * refusal is computed again on replay. Each receipt is the same fact as the K8 accepted reply of its task id, so the two
 * must agree. K4 `attempts` is not carried: it is `generation + 1` once the intent began (`submission` is not
 * `reserved`), and 0 before.
 *
 * The scheduler cursors of a concluded row are not carried either (#975 D6, the one exception to "no defaults"): K4
 * `phase` and `notBefore`, H `tries`, `next_at`, `reconcile_at` and `last_error`. Nothing reads them on a concluded row,
 * so a target writes its own initial values of a new row.
 */
export interface IntentRecord {
  key: string; source: 'user' | 'bot' | 'routine'; handler?: string; ordinal: number; agent: string;
  taskId: string; generation: number; input: Json; waitUntil: number; retry: RetryPolicy;
  submission: 'reserved' | 'uncertain' | 'delivered'; started: boolean; attempt?: Json; terminal?: Json;
  messageReceipt?: MessageReceipt; earlierReceipts?: Array<{ generation: number; messageReceipt: MessageReceipt }>;
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
/** A routine slot's replay guard: the slot hash and its occurrence key. */
export interface SlotRecord { slot: string; occurrenceKey: string }
/** An unconfirmed outbox record under its original identity. The receiver deduplicates a projection by its id. */
export type OutboxRecord = { kind: 'projection'; id: string; value: Json } | { kind: 'host-job'; occurrenceKey: string };
/** A permanent or expiring tombstone in the K4 scheme: the digest of the retired identity, by kind. */
export interface TombstoneRecord { kind: 'intent' | 'row' | 'slot' | 'application'; digest: string; expiresAt?: number }

export interface SwitchContent {
  version: typeof SWITCH_EXPORT_VERSION; source: 'L' | 'H'; domain: string; devices: SwitchDevice[]; exportedAt: number;
  /** The live state. The source Host's owner records (L `topology`, L `hostIntents`, now on each intent) are not part of it. */
  collaboration: CollaborationState;
  archived: ArchivedRecord[]; intents: IntentRecord[]; routines: RoutineRecord[]; occurrences: OccurrenceRecord[];
  slots: SlotRecord[]; outbox: OutboxRecord[]; tombstones: TombstoneRecord[];
}
/** The count and digest of each section, and `digest` over them and the header: the identity of one export. */
export interface SwitchManifest { counts: Record<SwitchSection, number>; digests: Record<SwitchSection, string>; digest: string }
export interface SwitchExport extends SwitchContent { manifest: SwitchManifest }

export type SwitchExportRefusal = 'invalid' | 'unsorted' | 'duplicate' | 'reference' | 'receipt_mismatch' | 'owner_record' | 'device_missing' | 'open_work'
  | 'home_sent' | 'card_call' | 'manifest';
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
  slots: row => (row as SlotRecord).slot,
  outbox: row => { const out = row as OutboxRecord; return [out.kind, out.kind === 'projection' ? out.id : out.occurrenceKey]; },
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
  const sealed = structuredClone(content) as SwitchContent;
  checkContent(sealed, [...HEADER, ...SWITCH_SECTIONS]);
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
    && optional(value.retry, retry => keys(retry, ['maxAttempts', 'delaysMs', 'retryFailures']))
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
// The policy K4 `validateRetry` (`model.ts`) accepts; K4 does not export it from the package index.
function retryPolicy(retry: unknown): retry is { maxAttempts: number } {
  return keys(retry, ['maxAttempts', 'delaysMs', 'retryFailures'])
    && Number.isSafeInteger(retry.maxAttempts) && (retry.maxAttempts as number) >= 1 && (retry.maxAttempts as number) <= 100
    && Array.isArray(retry.delaysMs) && retry.delaysMs.length >= (retry.maxAttempts as number) - 1 && retry.delaysMs.every(time)
    && typeof retry.retryFailures === 'boolean';
}
function intentRecord(row: unknown): boolean {
  return keys(row, ['key', 'source', 'ordinal', 'agent', 'taskId', 'generation', 'input', 'waitUntil', 'retry', 'submission', 'started', 'conclusion'],
    ['handler', 'attempt', 'terminal', 'messageReceipt', 'earlierReceipts', 'preparationError', 'memoryBlocked', 'cancelReason', 'retryUntil'])
    && text(row.key) && oneOf(['user', 'bot', 'routine'])(row.source) && optional(row.handler, text) && time(row.ordinal) && text(row.agent)
    && digestText(row.taskId) && time(row.generation) && object(row.input) && time(row.waitUntil)
    // K4 opens a generation only for a retry within `maxAttempts` (`core.ts` reconcile and begin), and its policy is
    // bounded by `validateRetry`, so the receipt check below walks at most 100 generations.
    && retryPolicy(row.retry) && row.generation < row.retry.maxAttempts
    && oneOf(['reserved', 'uncertain', 'delivered'])(row.submission) && typeof row.started === 'boolean'
    && optional(row.attempt, object) && optional(row.terminal, object)
    && optional(row.messageReceipt, receiptShape)
    // Earlier generations only, each once, in generation order, and only those with a receipt.
    && optional(row.earlierReceipts, earlier => Array.isArray(earlier) && earlier.length > 0
      && earlier.every((entry, index) => keys(entry, ['generation', 'messageReceipt']) && time(entry.generation)
        && entry.generation < (row.generation as number) && (index === 0 || entry.generation > (earlier[index - 1] as { generation: number }).generation)
        && receiptShape(entry.messageReceipt)))
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
  for (const row of content.slots) ensure(keys(row, ['slot', 'occurrenceKey']) && digestText(row.slot) && text(row.occurrenceKey), 'slot');
  for (const row of content.outbox) {
    ensure(object(row) && (row.kind === 'projection' ? keys(row, ['kind', 'id', 'value']) && text(row.id) : keys(row, ['kind', 'occurrenceKey'])
      && row.kind === 'host-job' && text(row.occurrenceKey)), 'outbox row');
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
    if (row.key.startsWith('occurrence:')) {
      const key = row.key.slice('occurrence:'.length);
      reference(occurrences.has(key), `intent ${row.key} names no occurrence of the export`);
      promoted.add(key);
    }
  }
  for (const row of content.occurrences) {
    reference(routines.has(row.routineId), `occurrence ${row.key} names no routine of the export: ${row.routineId}`);
    // A promoted occurrence's conclusion is its intent's, which K4 copies and H does not store.
    ensure(!(promoted.has(row.key) && row.conclusion !== undefined), `occurrence ${row.key} has an intent and its own conclusion`);
  }
  for (const row of content.slots) reference(occurrences.has(row.occurrenceKey), `slot ${row.slot} names no occurrence of the export`);
  // The K8 accepted reply of a task, live or retained (#798), is the same fact as the K4 message receipt of that task.
  const archivedReplies = new Map(content.archived.filter(row => row.namespace === 'replies').map(row => [row.id, row.body]));
  const replyOf = (taskId: string) => (content.collaboration.replies as Record<string, unknown>)[taskId] ?? archivedReplies.get(taskId);
  for (const row of content.intents) {
    // Every generation of the intent, current and earlier: a receipt and a K8 reply of its task id come together or not at all.
    const receipts = new Map((row.earlierReceipts ?? []).map(entry => [entry.generation, entry.messageReceipt]));
    if (row.messageReceipt) receipts.set(row.generation, row.messageReceipt);
    for (let generation = 0; generation <= row.generation; generation++) {
      const reply = replyOf(taskIdOf(row.key, generation)), receipt = receipts.get(generation);
      const same = receipt === undefined ? reply === undefined
        : object(reply) && reply.messageId === receipt.messageId && reply.contentHash === receipt.contentHash;
      if (!same) {
        throw new SwitchExportError('receipt_mismatch', `Switch export intent ${row.key} generation ${generation} has a message receipt that differs from its K8 reply`);
      }
    }
  }
  for (const row of content.outbox) {
    if (row.kind === 'host-job') reference(occurrences.get(row.occurrenceKey)?.job != null, `Host job ${row.occurrenceKey} names no Host job occurrence`);
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
