import type { PoolClient } from 'pg';
import { agentKey, occurrenceIntentKey, taskId, type FrozenExecutionInput, type Json, type RetryPolicy, type Routine,
  type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { SwitchExportError, type ArchivedRecord, type IntentRecord, type OccurrenceRecord, type RoutineRecord, type SwitchContent, type SwitchDevice,
  type SwitchExportRefusal, type TombstoneRecord } from '@byok-sdk/example-bot-collaboration/migration';
import { storedKey } from './layout';
import { hostJobRowKey } from './routines';

// The H side of the #975 state move. `hostedSwitchContent` reads one scope into the neutral form: the old owner's export
// and, once H imports, the new owner's read-back, so one function states what an H scope holds.

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
type IntentRow = { key: string; task_id: string; ordinal: string; agent: string; source: IntentRecord['source']; handler: string | null;
  retry_until: string | null; input: FrozenExecutionInput; retry: RetryPolicy; wait_until: string; submission: IntentRecord['submission'];
  cancel_reason: IntentRecord['cancelReason'] | null; conclusion: IntentRecord['conclusion'] | null; started: boolean; attempt: Json | null;
  terminal: Json | null; preparation_error: string | null };
type RoutineRow = { id: string; ordinal: string; definition: RoutineDefinition; pending: RoutineDefinition | null; lifecycle: Routine['lifecycle'];
  status: Routine['status']; next_at: string | null; calendar_errors: Routine['calendarErrors'] | null; schedule_retry_at: string | null;
  schedule_retry_count: number | null; last_error: Routine['lastError'] | null };
type OccurrenceRow = { key: string; ordinal: string; routine_id: string; definition_version: number; trigger_kind: 'scheduled' | 'catch_up';
  planned_at: string; recorded_at: string; next_at: string | null; execution_superseded: boolean; job: { summary?: Json } | null;
  conclusion: OccurrenceRecord['conclusion'] | null };
type OutboxRow = { key: string; kind: 'projection' | 'delivery' | 'card' | 'home' | 'host_job'; tries: number; settled: boolean };

/**
 * Reads scope `scope` into the neutral form, under the header of the document, and refuses what the format cannot carry
 * or a stored copy that differs from the value it is derived from (#975 "Export builder must check"). `state` is the
 * scope's K8 state in the caller's transaction, every command record included. The caller holds the scope lock.
 *
 * H stores one generation of each intent (the task id CHECK pins generation 0), so each intent moves with no earlier
 * execution. Its message receipt is the K8 accepted reply of its task id, live or retained (#975 D4): H keeps no other
 * copy. A Host job's `attempts` are its outbox row's `tries`. Routines and occurrences move in the order of their
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

  const outbox = await rows<OutboxRow>('SELECT key, kind, tries, settled_at IS NOT NULL AS settled FROM outbox WHERE scope = $1');
  for (const row of outbox) {
    if (row.settled) continue;
    if (row.kind === 'projection') refuse('projection_pending', `projection ${row.key} is not sent; let the sender flush it first`);
    if (row.kind === 'card' && row.tries > 0) refuse('card_call', `card ${row.key} has a connector call in flight`);
    // As L: a pending Host job would run while the export waits for its commit.
    if (row.kind === 'host_job') refuse('open_work', `Host job ${row.key} is pending; let it run first`);
  }
  const jobTries = new Map(outbox.filter(row => row.kind === 'host_job').map(row => [row.key, row.tries]));

  const intents: IntentRecord[] = [];
  const intentKeys = new Set<string>();
  for (const row of await rows<IntentRow>(`SELECT key, task_id, ordinal::text, agent, source, handler, retry_until::text, input, retry,
    wait_until::text, submission, cancel_reason, conclusion, started, attempt, terminal, preparation_error FROM intent WHERE scope = $1`)) {
    const key = parse<string>(row.key), { taskId: task, ...execution } = row.input;
    if (row.conclusion === null) refuse('open_work', `intent ${key} is open`);
    derived(row.task_id === taskId(key, 0) && task === row.task_id, `intent ${key} task id is not that of generation 0`);
    derived(row.agent === agentKey(scope, execution), `intent ${key} queues under another scope`);
    const reply = replyOf(row.task_id);
    intentKeys.add(key);
    intents.push(defined({
      key, source: row.source, handler: row.handler, ordinal: Number(row.ordinal), taskId: row.task_id, generation: 0, input: row.input as unknown as Json,
      waitUntil: Number(row.wait_until), retry: row.retry, submission: row.submission, started: row.started, attempt: row.attempt, terminal: row.terminal,
      messageReceipt: reply && { messageId: reply.messageId, contentHash: reply.contentHash }, earlierExecutions: [],
      preparationError: row.preparation_error, cancelReason: row.cancel_reason, retryUntil: optionalTime(row.retry_until), conclusion: row.conclusion,
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
    planned_at::text, recorded_at::text, next_at::text, execution_superseded, job, conclusion FROM occurrence WHERE scope = $1`)).map((row, ordinal) => {
    const key = parse<string>(row.key), promoted = intentKeys.has(occurrenceIntentKey(key));
    // A promoted occurrence reads its intent's conclusion, so H stores none on it.
    derived(!(promoted && row.conclusion !== null), `occurrence ${key} has an intent and its own conclusion`);
    let job: OccurrenceRecord['job'] = null;
    if (row.job !== null) {
      const tries = jobTries.get(hostJobRowKey(key));
      derived(tries !== undefined, `Host job occurrence ${key} has no outbox row`);
      job = defined({ attempts: tries!, summary: row.job.summary }) as NonNullable<OccurrenceRecord['job']>;
    }
    return { ...defined({ conclusion: row.conclusion }), key, ordinal, routineId: parse<string>(row.routine_id), definitionVersion: row.definition_version,
      trigger: { kind: row.trigger_kind, plannedAt: Number(row.planned_at) }, recordedAt: Number(row.recorded_at),
      nextAt: optionalTime(row.next_at) ?? null, job, executionSuperseded: row.execution_superseded };
  });

  const tombstones = (await rows<{ kind: TombstoneRecord['kind']; identity: string; expires_at: string | null }>(
    'SELECT kind, identity, expires_at::text FROM retired_identity WHERE scope = $1'))
    .map(row => defined({ kind: row.kind, digest: row.identity, expiresAt: optionalTime(row.expires_at) }) as TombstoneRecord);

  return { version: 1, ...header, collaboration: structuredClone(state), archived, intents, routines, occurrences, outbox: [], tombstones };
}
