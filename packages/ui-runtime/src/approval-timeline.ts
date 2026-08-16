import {
  ApprovalObservationSchema,
  type ApprovalObservation,
  type ApprovalTimelineTail,
} from '@byok-sdk/cloud';
import {
  ApprovalProjectionError,
  type ApprovalProjectionItem,
  type ApprovalProjectionMetadata,
  type ApprovalProjectionState,
  type TaskApprovalSnapshot,
} from './approval-types';

const DEFAULT_METADATA: ApprovalProjectionMetadata = Object.freeze({ dropped: 0 });

function fail(
  code: ConstructorParameters<typeof ApprovalProjectionError>[0],
  message: string,
  cause?: unknown,
): never {
  throw new ApprovalProjectionError(code, message, cause === undefined ? undefined : { cause });
}

function validTaskId(taskId: unknown): taskId is string {
  return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 200;
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateMetadata(metadata: ApprovalProjectionMetadata): ApprovalProjectionMetadata {
  if (!Number.isSafeInteger(metadata.dropped) || metadata.dropped < 0) {
    fail('approval_input_invalid', 'Approval metadata dropped must be a non-negative integer.');
  }
  if (metadata.capacity !== undefined && (!Number.isSafeInteger(metadata.capacity) || metadata.capacity <= 0)) {
    fail('approval_input_invalid', 'Approval metadata capacity must be a positive integer when present.');
  }
  if (metadata.expiresAt !== undefined && !canonicalTimestamp(metadata.expiresAt)) {
    fail('approval_input_invalid', 'Approval metadata expiresAt must be a canonical ISO timestamp when present.');
  }
  if (metadata.cursor !== undefined && (!Number.isSafeInteger(metadata.cursor) || metadata.cursor <= 0)) {
    fail('approval_input_invalid', 'Approval metadata cursor must be a positive integer when present.');
  }
  return Object.freeze({ ...metadata });
}

function parseObservation(value: ApprovalObservation): ApprovalObservation {
  try {
    return Object.freeze(structuredClone(ApprovalObservationSchema.parse(value))) as ApprovalObservation;
  } catch (error) {
    fail('approval_input_invalid', 'Approval observation must satisfy the typed cloud authority.', error);
  }
}

function structurallyEqual(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const prior = seen.get(left);
  if (prior !== undefined) return prior === right;
  seen.set(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((entry, index) => structurallyEqual(entry, right[index], seen));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => key === rightKeys[index]
        && structurallyEqual(leftRecord[key], rightRecord[key], seen),
    );
}

function freezeItem(item: ApprovalProjectionItem): ApprovalProjectionItem {
  return Object.freeze({
    ...item,
    sourceRevisions: Object.freeze([...item.sourceRevisions]),
    sourceEnvelopeIds: Object.freeze([...item.sourceEnvelopeIds]),
  });
}

interface ApprovalAccumulator {
  readonly approvalId: string;
  readonly observations: ApprovalObservation[];
  request?: Extract<ApprovalObservation['event'], { type: 'approval_requested' }>;
  resolution?: Extract<ApprovalObservation['event'], { type: 'approval_resolved' }>;
}

function accumulatedItem(accumulator: ApprovalAccumulator): ApprovalProjectionItem {
  const observations = [...accumulator.observations].sort((left, right) => left.revision - right.revision);
  const resolution = accumulator.resolution;
  return freezeItem({
    kind: 'approval',
    approvalId: accumulator.approvalId,
    lifecycle: resolution === undefined ? 'approval-requested' : 'approval-responded',
    status: resolution === undefined ? 'pending' : resolution.decision === 'approve' ? 'approved' : 'rejected',
    correlation: accumulator.request === undefined
      ? 'unpaired-resolution'
      : resolution === undefined
        ? 'unpaired-request'
        : 'paired',
    firstRevision: observations[0]!.revision,
    sourceRevisions: observations.map(({ revision }) => revision),
    sourceEnvelopeIds: observations.map(({ sourceEnvelopeId }) => sourceEnvelopeId),
    ...(accumulator.request !== undefined ? { summary: accumulator.request.summary } : {}),
    ...(resolution !== undefined ? {
      decision: resolution.decision,
      resolvedBy: resolution.resolvedBy,
      resolvedAt: resolution.at,
    } : {}),
  });
}

function unpairedRequest(observation: ApprovalObservation): ApprovalProjectionItem {
  const event = observation.event;
  if (event.type !== 'approval_requested') {
    fail('approval_input_invalid', 'Only approval requests may omit native approval identity.');
  }
  return freezeItem({
    kind: 'approval',
    lifecycle: 'approval-requested',
    status: 'pending',
    correlation: 'unpaired-request',
    firstRevision: observation.revision,
    sourceRevisions: [observation.revision],
    sourceEnvelopeIds: [observation.sourceEnvelopeId],
    summary: event.summary,
  });
}

function projectItems(observations: readonly ApprovalObservation[]): readonly ApprovalProjectionItem[] {
  const items: ApprovalProjectionItem[] = [];
  const identified = new Map<string, ApprovalAccumulator>();

  for (const observation of observations) {
    const event = observation.event;
    if (event.type === 'approval_requested' && event.approvalId === undefined) {
      items.push(unpairedRequest(observation));
      continue;
    }

    const approvalId = event.approvalId;
    if (approvalId === undefined) {
      fail('approval_input_invalid', 'Approval resolution requires native approval identity.');
    }
    const accumulator = identified.get(approvalId) ?? { approvalId, observations: [] };
    identified.set(approvalId, accumulator);
    accumulator.observations.push(observation);

    if (event.type === 'approval_requested') {
      if (accumulator.request !== undefined && !structurallyEqual(accumulator.request, event)) {
        fail('approval_authority_collision', `Approval ${approvalId} has conflicting request authority.`);
      }
      accumulator.request = event;
    } else {
      if (accumulator.resolution !== undefined && !structurallyEqual(accumulator.resolution, event)) {
        fail('approval_authority_collision', `Approval ${approvalId} has conflicting resolution authority.`);
      }
      accumulator.resolution = event;
    }
  }

  for (const accumulator of identified.values()) items.push(accumulatedItem(accumulator));
  return Object.freeze(items.sort((left, right) => left.firstRevision - right.firstRevision));
}

export function createApprovalProjectionState(
  taskId: string,
  metadata: ApprovalProjectionMetadata = DEFAULT_METADATA,
): ApprovalProjectionState {
  if (!validTaskId(taskId)) {
    fail('approval_input_invalid', 'Approval taskId must contain 1 to 200 characters.');
  }
  return Object.freeze({
    taskId,
    observations: Object.freeze([]),
    metadata: validateMetadata(metadata),
  });
}

export function withApprovalProjectionMetadata(
  state: ApprovalProjectionState,
  metadata: ApprovalProjectionMetadata,
): ApprovalProjectionState {
  if (!validTaskId(state.taskId)) fail('approval_input_invalid', 'Approval state taskId is invalid.');
  return Object.freeze({
    taskId: state.taskId,
    observations: state.observations,
    metadata: validateMetadata(metadata),
  });
}

export function foldApprovalObservation(
  state: ApprovalProjectionState,
  input: ApprovalObservation,
): ApprovalProjectionState {
  if (!validTaskId(state.taskId)) fail('approval_input_invalid', 'Approval state taskId is invalid.');
  const observation = parseObservation(input);
  if (observation.taskId !== state.taskId) {
    fail(
      'approval_task_mismatch',
      `Approval observation task ${observation.taskId} does not match state task ${state.taskId}.`,
    );
  }
  const identical = state.observations.find(
    ({ sourceEnvelopeId }) => sourceEnvelopeId === observation.sourceEnvelopeId,
  );
  if (identical !== undefined) {
    if (structurallyEqual(identical, observation)) return state;
    fail('approval_identity_collision', 'Approval source identity was reused for different content.');
  }
  if (state.observations.some(({ revision }) => revision === observation.revision)) {
    fail('approval_revision_collision', 'Approval revision was claimed by different source identity.');
  }
  const observations = [...state.observations, observation]
    .sort((left, right) => left.revision - right.revision);
  return Object.freeze({
    taskId: state.taskId,
    observations: Object.freeze(observations),
    metadata: state.metadata,
  });
}

export function foldApprovalTail(
  state: ApprovalProjectionState,
  tail: ApprovalTimelineTail,
): ApprovalProjectionState {
  if (tail === null || typeof tail !== 'object' || !validTaskId(tail.taskId) || !Array.isArray(tail.entries)) {
    fail('approval_input_invalid', 'Approval tail must contain a valid taskId and entries array.');
  }
  if (tail.taskId !== state.taskId) {
    fail('approval_task_mismatch', `Approval tail task ${tail.taskId} does not match state task ${state.taskId}.`);
  }
  const revisions = tail.entries.map(({ revision }) => revision);
  if (revisions.some((revision) => !Number.isSafeInteger(revision) || revision <= 0)) {
    fail('approval_input_invalid', 'Approval tail revisions must be positive integers.');
  }
  if (revisions.some((revision, index) => index > 0 && revision <= revisions[index - 1]!)) {
    fail('approval_input_invalid', 'Approval tail entries must be strictly ordered by native revision.');
  }
  if (tail.cursor !== revisions.at(-1)) {
    fail('approval_input_invalid', 'Approval tail cursor must equal its last retained revision.');
  }
  const stateCursor = state.observations.at(-1)?.revision;
  if (stateCursor !== undefined && (tail.cursor === undefined || tail.cursor < stateCursor)) {
    fail('approval_input_invalid', 'Approval tail cursor must not move behind incremental state.');
  }
  for (const observation of tail.entries) {
    const sameIdentity = state.observations.find(
      ({ sourceEnvelopeId }) => sourceEnvelopeId === observation.sourceEnvelopeId,
    );
    if (sameIdentity !== undefined && !structurallyEqual(sameIdentity, observation)) {
      fail('approval_identity_collision', 'Approval source identity changed across tail snapshots.');
    }
    const sameRevision = state.observations.find(({ revision }) => revision === observation.revision);
    if (sameRevision !== undefined && sameRevision.sourceEnvelopeId !== observation.sourceEnvelopeId) {
      fail('approval_revision_collision', 'Approval revision changed source identity across tail snapshots.');
    }
  }
  let next = createApprovalProjectionState(state.taskId, {
    dropped: tail.dropped,
    capacity: tail.capacity,
    expiresAt: tail.expiresAt,
    ...(tail.cursor !== undefined ? { cursor: tail.cursor } : {}),
  });
  for (const observation of tail.entries) next = foldApprovalObservation(next, observation);
  return next;
}

export function projectApprovalTimeline(state: ApprovalProjectionState): TaskApprovalSnapshot {
  if (!validTaskId(state.taskId)) fail('approval_input_invalid', 'Approval state taskId is invalid.');
  return Object.freeze({
    taskId: state.taskId,
    items: projectItems(state.observations),
    dropped: state.metadata.dropped,
    ...(state.metadata.capacity !== undefined ? { capacity: state.metadata.capacity } : {}),
    ...(state.metadata.expiresAt !== undefined ? { expiresAt: state.metadata.expiresAt } : {}),
    ...(state.metadata.cursor !== undefined ? { cursor: state.metadata.cursor } : {}),
  });
}

export function replayApprovalTimeline(tail: ApprovalTimelineTail): TaskApprovalSnapshot {
  if (tail === null || typeof tail !== 'object' || !validTaskId(tail.taskId) || !Array.isArray(tail.entries)) {
    fail('approval_input_invalid', 'Approval tail must contain a valid taskId and entries array.');
  }
  return projectApprovalTimeline(foldApprovalTail(createApprovalProjectionState(tail.taskId), tail));
}
