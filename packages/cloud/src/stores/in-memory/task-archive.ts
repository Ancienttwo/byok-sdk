import { tenantKey, type TenantId } from '@byok-sdk/core';
import type {
  TaskArchiveListInput,
  TaskArchiveStore,
  TaskArchiveStoreInput,
  TaskArchiveStoreResult,
  TaskArchiveWork,
} from '../../task-archive';
import type { TaskAttempt } from '../ports';
import { deleteActivityTail, type InMemoryActivityStore } from './activity';
import { deleteAgentMessageDraft, type InMemoryAgentMessageDraftStore } from './agent-message-draft';
import { deleteApprovalTimelineTail, type InMemoryApprovalTimelineStore } from './approval-timeline';
import type { InMemoryMailboxArchiveAccess, InMemoryObjectArchiveAccess } from './core-access';
import { receiptBodyOf, setReceiptBody, type InMemoryRequestReceiptStore } from './receipts';
import type { InMemoryTaskAttemptState } from './task-attempts';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'failed', 'cancelled']);

type Tombstone = Awaited<ReturnType<TaskArchiveStoreInput['codec']['tombstone']>>;

export interface InMemoryTaskArchiveDependencies {
  readonly state: InMemoryTaskAttemptState;
  readonly receipts: InMemoryRequestReceiptStore;
  readonly activity: InMemoryActivityStore;
  readonly approvals: InMemoryApprovalTimelineStore;
  readonly drafts: InMemoryAgentMessageDraftStore;
  readonly mailbox: InMemoryMailboxArchiveAccess;
  readonly objects: InMemoryObjectArchiveAccess;
}

/**
 * In-memory {@link TaskArchiveStore}. The tombstones are computed first, since
 * the codec is async, and the whole mutation then runs without an await. If a
 * body appears meanwhile that has no tombstone yet, the attempt returns before
 * it writes anything and runs again.
 */
export class InMemoryTaskArchiveStore implements TaskArchiveStore {
  readonly #deps: InMemoryTaskArchiveDependencies;

  constructor(deps: InMemoryTaskArchiveDependencies) {
    this.#deps = deps;
  }

  async listWork(tenant: TenantId, input: TaskArchiveListInput): Promise<readonly TaskArchiveWork[]> {
    const { attempts, archiveSettled } = this.#deps.state;
    const mine = [...attempts.values()].filter((attempt) => attempt.tenantId === tenant);
    const work = (attempt: TaskAttempt, phase: TaskArchiveWork['phase']): TaskArchiveWork => ({
      taskId: attempt.taskId,
      deviceId: attempt.deviceId,
      ...(attempt.agentRef === undefined ? {} : { agentRef: attempt.agentRef }),
      phase,
    });
    const settle = mine
      .filter((attempt) => attempt.archivedAt !== undefined && !archiveSettled.has(tenantKey(tenant, attempt.taskId)))
      .sort((left, right) => compare(left.taskId, right.taskId));
    // `terminalAt` is the first entry into a terminal status, which is the archive_after instant.
    const archive = mine
      .filter((attempt) => attempt.archivedAt === undefined && TERMINAL_STATUSES.has(attempt.status)
        && attempt.terminalAt !== undefined && attempt.terminalAt < input.archiveBefore)
      .sort((left, right) => compare(left.terminalAt!, right.terminalAt!) || compare(left.taskId, right.taskId));
    return [...settle.map((attempt) => work(attempt, 'settle')), ...archive.map((attempt) => work(attempt, 'archive'))]
      .slice(0, input.limit);
  }

  async archive(tenant: TenantId, input: TaskArchiveStoreInput): Promise<TaskArchiveStoreResult> {
    const key = tenantKey(tenant, input.taskId);
    return this.#deps.state.mutate(key, async () => {
      const tombstones = new Map<string, Tombstone>();
      for (;;) {
        const step = this.#attempt(tenant, key, input, tombstones);
        if (!('missing' in step)) return step;
        for (const body of step.missing) tombstones.set(body, await input.codec.tombstone(body));
      }
    });
  }

  async settle(tenant: TenantId, taskId: string, settledAt: string): Promise<void> {
    const key = tenantKey(tenant, taskId);
    const { attempts, archiveSettled } = this.#deps.state;
    if (attempts.get(key)?.archivedAt !== undefined && !archiveSettled.has(key)) archiveSettled.set(key, settledAt);
  }

  #attempt(
    tenant: TenantId,
    key: string,
    input: TaskArchiveStoreInput,
    tombstones: ReadonlyMap<string, Tombstone>,
  ): TaskArchiveStoreResult | { readonly missing: ReadonlySet<string> } {
    const { state, receipts, mailbox } = this.#deps;
    const { codec, taskId } = input;
    const task = state.attempts.get(key);
    if (task === undefined) return { outcome: 'not_found' };
    if (task.archivedAt !== undefined) return { outcome: 'already_archived' };
    if (!TERMINAL_STATUSES.has(task.status)) return { outcome: 'refused', reason: 'task_not_terminal' };

    const devices = task.ownerDeviceId === undefined || task.ownerDeviceId === task.deviceId
      ? [task.deviceId]
      : [task.deviceId, task.ownerDeviceId];
    const rows = devices.flatMap((deviceId) => mailbox.messagesOf(tenant, deviceId)
      .filter((message) => namesTask(message.body, taskId))
      .map((message) => ({ deviceId, message })));
    if (rows.some(({ message }) => message.state === 'pending')) return { outcome: 'refused', reason: 'pending_delivery' };
    const settled = rows.filter(({ message }) => message.state !== 'pending');

    const receiptBodies = input.receiptKeys.flatMap((receiptKey) => {
      const body = receiptBodyOf(receipts, tenant, receiptKey);
      return body === undefined ? [] : [{ receiptKey, body }];
    });
    const admission = state.messageAdmissions.get(key);
    const bodies = [
      ...receiptBodies.map(({ body }) => body),
      ...(admission === undefined ? [] : [admission.payloadBody, ...(admission.terminalBody === undefined ? [] : [admission.terminalBody])]),
      ...settled.map(({ message }) => message.body),
    ].filter((body) => !codec.isTombstone(body));
    const missing = new Set(bodies.filter((body) => !tombstones.has(body)));
    if (missing.size > 0) return { missing };
    const tombstoneOf = (body: string): Tombstone => tombstones.get(body)!;

    if (receiptBodyOf(receipts, tenant, input.terminalReceiptKey) === undefined) {
      setReceiptBody(receipts, tenant, input.terminalReceiptKey, codec.absent);
    }
    let receiptsRedacted = 0;
    for (const { receiptKey, body } of receiptBodies) {
      if (codec.isTombstone(body)) continue;
      setReceiptBody(receipts, tenant, receiptKey, tombstoneOf(body).body);
      receiptsRedacted += 1;
    }

    let admissionsRedacted = 0;
    if (admission !== undefined) {
      const payloadBody = codec.isTombstone(admission.payloadBody) ? admission.payloadBody : tombstoneOf(admission.payloadBody).body;
      const terminalBody = admission.terminalBody === undefined || codec.isTombstone(admission.terminalBody)
        ? admission.terminalBody
        : tombstoneOf(admission.terminalBody).body;
      if (payloadBody !== admission.payloadBody || terminalBody !== admission.terminalBody) {
        state.messageAdmissions.set(key, { ...admission, payloadBody, ...(terminalBody === undefined ? {} : { terminalBody }) });
        admissionsRedacted += 1;
      }
    }

    // A mailbox row is never deleted: a device's highest-seq expired row is the recovery floor (#1115).
    for (const { deviceId, message } of settled) {
      const { body, bodyHash, byteSize } = tombstoneOf(message.body);
      mailbox.replaceBody(tenant, deviceId, message.seq, { body, bodyHash, byteSize });
    }

    const { activity, approvals, drafts, objects } = this.#deps;
    const ephemeralRowsDeleted = deleteActivityTail(activity, tenant, taskId)
      + deleteApprovalTimelineTail(approvals, tenant, taskId)
      + deleteAgentMessageDraft(drafts, tenant, taskId);
    let referencesReleased = 0;
    for (const { refKind, refId } of input.releaseObjectReferences) {
      referencesReleased += objects.releaseReferences(tenant, refKind, refId);
    }

    const { terminalCause: _cause, cancellation, ...rest } = task;
    state.attempts.set(key, {
      ...rest,
      ...(cancellation === undefined ? {} : { cancellation: { requestedAt: cancellation.requestedAt } }),
      archivedAt: input.archivedAt,
    });
    return {
      outcome: 'archived',
      counts: { receiptsRedacted, admissionsRedacted, outboxRedacted: settled.length, ephemeralRowsDeleted, referencesReleased },
    };
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * An envelope names its task in a top-level `task_id`. A tombstone has none,
 * so a redacted row is not matched again.
 */
function namesTask(body: string, taskId: string): boolean {
  if (!body.includes(`"task_id":${JSON.stringify(taskId)}`)) return false;
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' && (value as { readonly task_id?: unknown }).task_id === taskId;
  } catch {
    return false;
  }
}
