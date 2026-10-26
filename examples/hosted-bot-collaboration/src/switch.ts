import type { PoolClient } from 'pg';
import { agentKey, occurrenceIntentKey, taskId, type FrozenExecutionInput, type Intent, type Json, type RetryPolicy, type Routine,
  type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { SwitchExportError, type ArchivedRecord, type ExecutionRecord, type IntentRecord, type OccurrenceRecord, type OutboxRecord, type RoutineRecord,
  type SwitchContent, type SwitchDevice, type SwitchExportRefusal, type TombstoneRecord } from '@byok-sdk/example-bot-collaboration/migration';
import { storedKey } from './layout';
import { hostJobRowKey } from './routines';

// The H side of the #975 state move. `hostedSwitchContent` reads one scope into the neutral form: the old owner's export
// and the new owner's read-back, so one function states what an H scope holds. `writeSwitchRows` writes the rows of an
// import other than the K8 state, which the store writes as every state transaction does.

/** The header fields of a document, which a read-back copies as they are. */
export type SwitchHeader = Pick<SwitchContent, 'source' | 'domain' | 'devices' | 'exportedAt'>;
/** The export record of an old H owner (`scope.switch_export`): from the export on, also after the commit away. */
export interface SwitchExportMark { digest: string; exportedAt: number; devices: SwitchDevice[] }

/** The scope was exported for a switch, so H writes nothing to it. Abort the switch to resume it. Nothing was written. */
export class SwitchExportedError extends Error {
  readonly code = 'switch_exported' as const;
  constructor(readonly digest: string) {
    super(`This scope was exported for a switch (${digest}); it writes nothing until the switch is aborted`);
    this.name = 'SwitchExportedError';
  }
}

/** The import record of a new H owner (`scope.switch_import`): from the import until `commitImport`. */
export interface SwitchImportMark { digest: string; devices: string[] }
/** What a new owner returns after its read-back: the digest the old owner commits away on. */
export interface SwitchReceipt { digest: string; devices: string[] }

/**
 * The scope holds a switch import that is not committed yet, so no work runs on it (#975). Commit it toward H or discard
 * it first. Nothing was written.
 */
export class SwitchImportedError extends Error {
  readonly code = 'switch_imported' as const;
  constructor(readonly digest: string) {
    super(`This scope holds the switch import ${digest}; commit it toward H or discard it first`);
    this.name = 'SwitchImportedError';
  }
}

/** A stored import record, checked field by field: a malformed one fails closed. */
export function importMarkOf(value: unknown): SwitchImportMark {
  const mark = value as SwitchImportMark;
  const valid = typeof value === 'object' && value !== null && Object.keys(value).sort().join(',') === 'devices,digest'
    && typeof mark.digest === 'string' && Array.isArray(mark.devices) && mark.devices.length > 0
    && mark.devices.every(device => typeof device === 'string' && device.length > 0);
  if (!valid) throw new Error('Invalid switch import record');
  return mark;
}

/** A stored export mark, checked field by field: a malformed one fails closed. */
export function exportMarkOf(value: unknown): SwitchExportMark {
  const mark = value as SwitchExportMark;
  const valid = typeof value === 'object' && value !== null && Object.keys(value).sort().join(',') === 'devices,digest,exportedAt'
    && typeof mark.digest === 'string' && Number.isSafeInteger(mark.exportedAt) && Array.isArray(mark.devices) && mark.devices.length > 0
    && mark.devices.every(device => !!device && Object.keys(device).sort().join(',') === 'deviceId,frozenRevision'
      && typeof device.deviceId === 'string' && Number.isSafeInteger(device.frozenRevision) && device.frozenRevision > 0);
  if (!valid) throw new Error('Invalid switch export record');
  return mark;
}

function refuse(reason: SwitchExportRefusal, message: string): never { throw new SwitchExportError(reason, `Switch export source: ${message}`); }
/** A stored copy that differs from the value it is derived from. */
function derived(ok: boolean, message: string): void { if (!ok) refuse('reference', message); }
/** The fields of `source` whose value is neither undefined nor null. */
function defined<T extends object>(source: T): { [K in keyof T]?: Exclude<T[K], null> } {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== null)) as { [K in keyof T]?: Exclude<T[K], null> };
}
const parse = <T>(text: string) => JSON.parse(text) as T;
const optionalTime = (value: string | null) => value === null ? undefined : Number(value);
/** The positions of `rows` in the order of their stored ordinals (#975: a routine's or occurrence's ordinal is its position). */
const ranked = <T extends { ordinal: string }>(rows: readonly T[]) => [...rows].sort((a, b) => Number(a.ordinal) - Number(b.ordinal));

type AcceptedReply = { messageId: string; contentHash: string };
type IntentRow = { key: string; task_id: string; generation: number; ordinal: string; agent: string; source: IntentRecord['source'];
  handler: string | null; retry_until: string | null; input: FrozenExecutionInput; retry: RetryPolicy; wait_until: string;
  submission: IntentRecord['submission']; cancel_reason: IntentRecord['cancelReason'] | null; conclusion: IntentRecord['conclusion'] | null;
  started: boolean; attempt: Json | null; terminal: Json | null; preparation_error: string | null; memory_blocked: Intent['memoryBlocked'] | null };
type ExecutionRow = { key: string; generation: number; task_id: string; submission: ExecutionRecord['submission']; started: boolean; attempt: Json;
  terminal: Json };
type RoutineRow = { id: string; ordinal: string; definition: RoutineDefinition; pending: RoutineDefinition | null; lifecycle: Routine['lifecycle'];
  status: Routine['status']; next_at: string | null; calendar_errors: Routine['calendarErrors'] | null; schedule_retry_at: string | null;
  schedule_retry_count: number | null; last_error: Routine['lastError'] | null };
type OccurrenceRow = { key: string; ordinal: string; routine_id: string; definition_version: number; trigger_kind: 'scheduled' | 'catch_up';
  planned_at: string; recorded_at: string; next_at: string | null; execution_superseded: boolean; job: { summary?: Json } | null;
  conclusion: OccurrenceRecord['conclusion'] | null; slot_replay_count: number | null };
type OutboxRow = { key: string; kind: 'projection' | 'delivery' | 'card' | 'home' | 'host_job'; tries: number; settled: boolean };

/**
 * Reads scope `scope` into the neutral form, under the header of the document, and refuses what the format cannot carry
 * or a stored copy that differs from the value it is derived from (#975 "Export builder must check"). `state` is the
 * scope's K8 state in the caller's transaction, every command record included. The caller holds the scope lock.
 *
 * An intent moves with its earlier generations from `intent_execution`. The message receipt of each generation is the K8
 * accepted reply of its task id, live or retained (#975 D4): H keeps no other copy. A Host job's `attempts` are its outbox
 * row's `tries`, and a pending Host job moves as an outbox record. Routines and occurrences move in the order of their
 * ordinals, as their positions; an intent keeps its ordinal.
 */
export async function hostedSwitchContent(client: PoolClient, scope: string, state: CollaborationState, header: SwitchHeader): Promise<SwitchContent> {
  const scopeKey = storedKey(scope), rows = <T extends object>(text: string) => client.query<T>(text, [scopeKey]).then(found => found.rows);

  const archivedRows = await rows<{ namespace: string; id: string; body: Json; expires_at: string | null }>(
    'SELECT namespace, id, body, expires_at::text FROM archived_row WHERE scope = $1');
  const archived: ArchivedRecord[] = archivedRows.map(row =>
    defined({ namespace: row.namespace, id: parse<string>(row.id), body: row.body, expiresAt: optionalTime(row.expires_at) }) as ArchivedRecord);
  const retainedReplies = new Map(archivedRows.filter(row => row.namespace === 'replies').map(row => [parse<string>(row.id), row.body as AcceptedReply]));
  const replyOf = (task: string): AcceptedReply | undefined => Object.hasOwn(state.replies, task) ? state.replies[task] : retainedReplies.get(task);

  const outboxRows = await rows<OutboxRow>('SELECT key, kind, tries, settled_at IS NOT NULL AS settled FROM outbox WHERE scope = $1');
  for (const row of outboxRows) {
    if (row.settled) continue;
    if (row.kind === 'projection') refuse('projection_pending', `projection ${row.key} is not sent; let the sender flush it first`);
    if (row.kind === 'card' && row.tries > 0) refuse('card_call', `card ${row.key} has a connector call in flight`);
  }
  const jobTries = new Map(outboxRows.filter(row => row.kind === 'host_job').map(row => [row.key, row.tries]));
  const outbox: OutboxRecord[] = outboxRows.filter(row => row.kind === 'host_job' && !row.settled)
    .map(row => ({ kind: 'host-job', occurrenceKey: parse<[string, string]>(row.key)[1] }));

  const executions = new Map<string, ExecutionRow[]>();
  for (const row of await rows<ExecutionRow>(`SELECT key, generation, task_id, submission, started, attempt, terminal FROM intent_execution
    WHERE scope = $1 ORDER BY key, generation`)) {
    const key = parse<string>(row.key);
    executions.set(key, [...executions.get(key) ?? [], row]);
  }
  const receiptOf = (task: string) => {
    const reply = replyOf(task);
    return reply && { messageId: reply.messageId, contentHash: reply.contentHash };
  };

  const intents: IntentRecord[] = [];
  const intentKeys = new Set<string>();
  for (const row of await rows<IntentRow>(`SELECT key, task_id, generation, ordinal::text, agent, source, handler, retry_until::text, input, retry,
    wait_until::text, submission, cancel_reason, conclusion, started, attempt, terminal, preparation_error, memory_blocked FROM intent WHERE scope = $1`)) {
    const key = parse<string>(row.key), { taskId: task, ...execution } = row.input;
    if (row.conclusion === null) refuse('open_work', `intent ${key} is open`);
    derived(row.task_id === taskId(key, row.generation) && task === row.task_id, `intent ${key} task id is not that of its generation`);
    derived(row.agent === agentKey(scope, execution), `intent ${key} queues under another scope`);
    const earlier = executions.get(key) ?? [];
    executions.delete(key);
    derived(earlier.length === row.generation && earlier.every((entry, generation) => entry.generation === generation),
      `intent ${key} has no execution of each earlier generation`);
    intentKeys.add(key);
    intents.push(defined({
      key, source: row.source, handler: row.handler, ordinal: Number(row.ordinal), taskId: row.task_id, generation: row.generation,
      input: row.input as unknown as Json, waitUntil: Number(row.wait_until), retry: row.retry, submission: row.submission, started: row.started,
      attempt: row.attempt, terminal: row.terminal, messageReceipt: receiptOf(row.task_id),
      earlierExecutions: earlier.map(entry => defined({ submission: entry.submission, started: entry.started, attempt: entry.attempt, terminal: entry.terminal,
        messageReceipt: receiptOf(entry.task_id) }) as ExecutionRecord),
      preparationError: row.preparation_error, memoryBlocked: row.memory_blocked, cancelReason: row.cancel_reason,
      retryUntil: optionalTime(row.retry_until), conclusion: row.conclusion,
    }) as IntentRecord);
  }

  const routines: RoutineRecord[] = ranked(await rows<RoutineRow>(`SELECT id, ordinal::text, definition, pending, lifecycle, status, next_at::text,
    calendar_errors, schedule_retry_at::text, schedule_retry_count, last_error FROM routine WHERE scope = $1`)).map((row, ordinal) => {
    derived(row.definition.id === parse<string>(row.id), `routine ${row.id} holds the definition of ${row.definition.id}`);
    return { ...defined({ pending: row.pending, calendarErrors: row.calendar_errors?.length ? row.calendar_errors : undefined,
      scheduleRetryAt: optionalTime(row.schedule_retry_at), scheduleRetryCount: row.schedule_retry_count, lastError: row.last_error }),
    id: row.definition.id, ordinal, definition: row.definition, lifecycle: row.lifecycle, status: row.status, nextAt: optionalTime(row.next_at) ?? null };
  });

  const occurrences: OccurrenceRecord[] = ranked(await rows<OccurrenceRow>(`SELECT key, ordinal::text, routine_id, definition_version, trigger_kind,
    planned_at::text, recorded_at::text, next_at::text, execution_superseded, job, conclusion, slot_replay_count FROM occurrence WHERE scope = $1`))
    .map((row, ordinal) => {
    const key = parse<string>(row.key), promoted = intentKeys.has(occurrenceIntentKey(key));
    // A promoted occurrence reads its intent's conclusion, so H stores none on it.
    derived(!(promoted && row.conclusion !== null), `occurrence ${key} has an intent and its own conclusion`);
    let job: OccurrenceRecord['job'] = null;
    if (row.job !== null) {
      const tries = jobTries.get(hostJobRowKey(key));
      derived(tries !== undefined, `Host job occurrence ${key} has no outbox row`);
      // A stored summary moves as it is, null included: K4 stores a handler's { summary: null } (#975).
      job = { attempts: tries!, ...(Object.hasOwn(row.job, 'summary') ? { summary: row.job.summary } : {}) } as NonNullable<OccurrenceRecord['job']>;
    }
    return { ...defined({ conclusion: row.conclusion, slotReplayCount: row.slot_replay_count }), key, ordinal, routineId: parse<string>(row.routine_id),
      definitionVersion: row.definition_version,
      trigger: { kind: row.trigger_kind, plannedAt: Number(row.planned_at) }, recordedAt: Number(row.recorded_at),
      nextAt: optionalTime(row.next_at) ?? null, job, executionSuperseded: row.execution_superseded };
  });

  const tombstones = (await rows<{ kind: TombstoneRecord['kind']; identity: string; expires_at: string | null }>(
    'SELECT kind, identity, expires_at::text FROM retired_identity WHERE scope = $1'))
    .map(row => defined({ kind: row.kind, digest: row.identity, expiresAt: optionalTime(row.expires_at) }) as TombstoneRecord);

  return { version: 1, ...header, collaboration: structuredClone(state), archived, intents, routines, occurrences, outbox, tombstones };
}

/**
 * Writes the rows of an imported document into the new scope `scope`, all but the K8 state (#975): each device in mode L
 * at revision 1, owned by the old owner until `commitImport`; the intents with their earlier generations; the routines and
 * occurrences in the order of their ordinals; the archived rows and the tombstones. Each derived value comes from the
 * format: `agent` for this scope, the task id of every generation, and a Host job occurrence's outbox row, whose `tries`
 * are its attempts, settled at `now` once the occurrence has a conclusion and due at once while it is pending. A concluded
 * intent gets H's cursors of a new row (#975 D6): no tries, no backoff, no readback time, no `last_error`. The caller
 * holds the scope lock.
 */
export async function writeSwitchRows(client: PoolClient, scope: string, content: SwitchContent, now: number): Promise<void> {
  const scopeKey = storedKey(scope), byOrdinal = <T extends { ordinal: number }>(rows: readonly T[]) => [...rows].sort((a, b) => a.ordinal - b.ordinal);
  for (const [ordinal, device] of content.devices.entries()) {
    await client.query(`INSERT INTO device_binding (scope, device, ordinal, mode, mode_revision) VALUES ($1, $2, $3, 'L', 1)`,
      [scopeKey, storedKey(device.deviceId), ordinal]);
  }
  for (const row of content.intents) {
    const { taskId: _task, ...execution } = row.input as unknown as FrozenExecutionInput;
    await client.query(`INSERT INTO intent (scope, key, task_id, generation, ordinal, agent, source, handler, retry_until, input, retry, wait_until,
        submission, tries, next_at, last_error, preparation_error, memory_blocked, cancel_reason, conclusion, started, attempt, terminal, reconcile_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::json, $11::json, $12, $13, 0, 0, NULL, $14, $15::json, $16, $17, $18, $19::json, $20::json, 0)`,
    [scopeKey, storedKey(row.key), row.taskId, row.generation, row.ordinal, agentKey(scope, execution), row.source, row.handler ?? null,
      row.retryUntil ?? null, JSON.stringify(row.input), JSON.stringify(row.retry), row.waitUntil, row.submission, row.preparationError ?? null,
      row.memoryBlocked ? JSON.stringify(row.memoryBlocked) : null, row.cancelReason ?? null, row.conclusion, row.started,
      row.attempt === undefined ? null : JSON.stringify(row.attempt), row.terminal === undefined ? null : JSON.stringify(row.terminal)]);
    for (const [generation, earlier] of row.earlierExecutions.entries()) {
      await client.query(`INSERT INTO intent_execution (scope, key, generation, task_id, submission, started, attempt, terminal)
        VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8::json)`, [scopeKey, storedKey(row.key), generation, taskId(row.key, generation), earlier.submission,
        earlier.started, JSON.stringify(earlier.attempt), JSON.stringify(earlier.terminal)]);
    }
  }
  for (const row of byOrdinal(content.routines)) {
    await client.query(`INSERT INTO routine (scope, id, ordinal, definition, pending, lifecycle, status, next_at, calendar_errors, retry_at,
        schedule_retry_at, schedule_retry_count, last_error)
      VALUES ($1, $2, $3, $4::json, $5::json, $6, $7, $8, $9::json, NULL, $10, $11, $12::json)`,
    [scopeKey, storedKey(row.id), row.ordinal, JSON.stringify(row.definition), row.pending ? JSON.stringify(row.pending) : null, row.lifecycle, row.status,
      row.nextAt, row.calendarErrors ? JSON.stringify(row.calendarErrors) : null, row.scheduleRetryAt ?? null, row.scheduleRetryCount ?? null,
      row.lastError ? JSON.stringify(row.lastError) : null]);
  }
  const pendingJobs = new Set(content.outbox.map(row => row.occurrenceKey));
  for (const row of byOrdinal(content.occurrences)) {
    // H keeps a Host job's attempts in its outbox row, so the occurrence stores only its summary (`{}` while it has none).
    const job = row.job && (Object.hasOwn(row.job, 'summary') ? { summary: row.job.summary } : {});
    await client.query(`INSERT INTO occurrence (scope, key, ordinal, routine_id, definition_version, trigger_kind, planned_at, recorded_at, next_at,
        execution_superseded, job, conclusion, slot_replay_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::json, $12, $13)`,
    [scopeKey, storedKey(row.key), row.ordinal, storedKey(row.routineId), row.definitionVersion, row.trigger.kind, row.trigger.plannedAt,
      row.recordedAt, row.nextAt, row.executionSuperseded, job ? JSON.stringify(job) : null, row.conclusion ?? null, row.slotReplayCount ?? null]);
    if (row.job) {
      await client.query(`INSERT INTO outbox (scope, key, ordinal, kind, next_at, tries, settled_at)
        SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'host_job', 0, $3, $4 FROM outbox WHERE scope = $1`,
      [scopeKey, hostJobRowKey(row.key), row.job.attempts, pendingJobs.has(row.key) ? null : now]);
    }
  }
  for (const row of content.archived) {
    await client.query('INSERT INTO archived_row (scope, namespace, id, body, expires_at) VALUES ($1, $2, $3, $4::json, $5)',
      [scopeKey, row.namespace, storedKey(row.id), JSON.stringify(row.body), row.expiresAt ?? null]);
  }
  for (const row of content.tombstones) {
    await client.query('INSERT INTO retired_identity (scope, kind, identity, expires_at) VALUES ($1, $2, $3, $4)',
      [scopeKey, row.kind, row.digest, row.expiresAt ?? null]);
  }
}
