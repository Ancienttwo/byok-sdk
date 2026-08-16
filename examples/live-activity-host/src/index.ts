import {
  ApprovalObservationSchema,
  isTenantId,
  TimelineEventSchema,
  type ActivityTail,
  type ApprovalObservation,
  type ApprovalTimelineTail,
  type TenantId,
  type TimelineEvent,
} from '@byok-sdk/cloud';
import {
  createApprovalProjectionState,
  projectApprovalTimeline,
  replayApprovalTimeline,
  replayTimeline,
  type TaskApprovalSnapshot,
  type TaskTimelineSnapshot,
} from '@byok-sdk/ui-runtime';

export const LIVE_ACTIVITY_ROUTE_PREFIX = '/api/tasks/';
export const LIVE_ACTIVITY_ROUTE_SUFFIX = '/activity';

export const LIVE_ACTIVITY_HOST_ERROR_CODES = [
  'configuration_invalid',
  'authorization_binding_invalid',
  'activity_binding_invalid',
  'approval_binding_invalid',
  'redaction_invalid',
] as const;

export type LiveActivityHostErrorCode = (typeof LIVE_ACTIVITY_HOST_ERROR_CODES)[number];

export class LiveActivityHostError extends Error {
  readonly code: LiveActivityHostErrorCode;

  constructor(code: LiveActivityHostErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LiveActivityHostError';
    this.code = code;
  }
}

export interface AuthorizedActivity {
  readonly tenantId: TenantId;
  readonly taskId: string;
}

export interface LiveActivityRedactionContext<User> {
  readonly user: User;
  readonly tenantId: TenantId;
  readonly taskId: string;
}

export interface LiveActivityPresentationContext<User> {
  readonly user: User;
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly etag: string;
}

export interface LiveActivitySnapshots {
  readonly activity: TaskTimelineSnapshot;
  readonly approvals: TaskApprovalSnapshot;
}

export interface LiveActivityHostOptions<User, Representation> {
  readonly representationRevision: string;
  readonly authenticate: (request: Request) => User | undefined | Promise<User | undefined>;
  readonly authorize: (
    user: User,
    taskId: string,
  ) => AuthorizedActivity | undefined | Promise<AuthorizedActivity | undefined>;
  readonly readActivity: (
    tenantId: TenantId,
    taskId: string,
  ) => ActivityTail | undefined | Promise<ActivityTail | undefined>;
  readonly readApprovals: (
    tenantId: TenantId,
    taskId: string,
  ) => ApprovalTimelineTail | undefined | Promise<ApprovalTimelineTail | undefined>;
  readonly redact: (
    event: TimelineEvent,
    context: LiveActivityRedactionContext<User>,
  ) => TimelineEvent | Promise<TimelineEvent>;
  readonly redactApproval: (
    observation: ApprovalObservation,
    context: LiveActivityRedactionContext<User>,
  ) => ApprovalObservation | Promise<ApprovalObservation>;
  readonly present: (
    snapshots: LiveActivitySnapshots,
    context: LiveActivityPresentationContext<User>,
  ) => Representation | Promise<Representation>;
}

export interface LiveActivityHost {
  readonly fetch: (request: Request) => Promise<Response>;
}

function jsonResponse(status: number, body: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
      vary: 'Authorization, Cookie',
    },
  });
}

function parseTaskId(request: Request): { readonly matched: boolean; readonly taskId?: string } {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(LIVE_ACTIVITY_ROUTE_PREFIX) || !pathname.endsWith(LIVE_ACTIVITY_ROUTE_SUFFIX)) {
    return { matched: false };
  }
  const encoded = pathname.slice(LIVE_ACTIVITY_ROUTE_PREFIX.length, -LIVE_ACTIVITY_ROUTE_SUFFIX.length);
  if (encoded.length === 0 || encoded.includes('/')) return { matched: true };
  try {
    const taskId = decodeURIComponent(encoded);
    return taskId.length > 0 && taskId.length <= 200 && /\S/.test(taskId)
      ? { matched: true, taskId }
      : { matched: true };
  } catch {
    return { matched: true };
  }
}

function sameOptional(left: unknown, right: unknown): boolean {
  return left === right;
}

function assertRedactionPreservesAuthority(original: TimelineEvent, redacted: TimelineEvent): void {
  const stableEnvelope =
    original.taskId === redacted.taskId &&
    original.sourceEnvelopeId === redacted.sourceEnvelopeId &&
    original.batchSeq === redacted.batchSeq &&
    original.eventIndex === redacted.eventIndex &&
    original.receivedAt === redacted.receivedAt &&
    original.event.type === redacted.event.type;
  if (!stableEnvelope) {
    throw new LiveActivityHostError(
      'redaction_invalid',
      'Redaction must preserve timeline identity, order, timestamp, and event type.',
    );
  }

  if (original.event.type === 'tool_use' && redacted.event.type === 'tool_use') {
    if (
      original.event.tool !== redacted.event.tool ||
      !sameOptional(original.event.toolCallId, redacted.event.toolCallId)
    ) {
      throw new LiveActivityHostError(
        'redaction_invalid',
        'Redaction must preserve tool-use correlation authority.',
      );
    }
  }
  if (original.event.type === 'tool_result' && redacted.event.type === 'tool_result') {
    if (
      original.event.tool !== redacted.event.tool ||
      !sameOptional(original.event.toolCallId, redacted.event.toolCallId) ||
      !sameOptional(original.event.isError, redacted.event.isError)
    ) {
      throw new LiveActivityHostError(
        'redaction_invalid',
        'Redaction must preserve tool-result correlation and outcome authority.',
      );
    }
  }
}

export async function redactActivityTail<User>(
  tail: ActivityTail,
  user: User,
  redact: LiveActivityHostOptions<User, unknown>['redact'],
): Promise<ActivityTail> {
  const entries: TimelineEvent[] = [];
  for (const value of tail.entries) {
    const original = TimelineEventSchema.parse(value) as TimelineEvent;
    let redacted: TimelineEvent;
    try {
      redacted = TimelineEventSchema.parse(
        await redact(original, { user, tenantId: tail.tenantId, taskId: tail.taskId }),
      ) as TimelineEvent;
    } catch (error) {
      if (error instanceof LiveActivityHostError) throw error;
      throw new LiveActivityHostError('redaction_invalid', 'Redactor returned an invalid timeline event.', {
        cause: error,
      });
    }
    assertRedactionPreservesAuthority(original, redacted);
    entries.push(redacted);
  }
  return { ...tail, entries: Object.freeze(entries) };
}

function assertApprovalRedactionPreservesAuthority(
  original: ApprovalObservation,
  redacted: ApprovalObservation,
): void {
  const stableObservation = original.taskId === redacted.taskId
    && original.sourceEnvelopeId === redacted.sourceEnvelopeId
    && original.revision === redacted.revision
    && original.receivedAt === redacted.receivedAt
    && original.event.type === redacted.event.type;
  if (!stableObservation) {
    throw new LiveActivityHostError(
      'redaction_invalid',
      'Approval redaction must preserve task, source identity, revision, timestamp, and event type.',
    );
  }
  if (
    original.event.type === 'approval_requested'
    && redacted.event.type === 'approval_requested'
    && original.event.approvalId !== redacted.event.approvalId
  ) {
    throw new LiveActivityHostError(
      'redaction_invalid',
      'Approval redaction must preserve native request identity.',
    );
  }
  if (
    original.event.type === 'approval_resolved'
    && redacted.event.type === 'approval_resolved'
    && (
      original.event.approvalId !== redacted.event.approvalId
      || original.event.decision !== redacted.event.decision
      || original.event.resolvedBy !== redacted.event.resolvedBy
      || original.event.at !== redacted.event.at
    )
  ) {
    throw new LiveActivityHostError(
      'redaction_invalid',
      'Approval redaction must preserve native resolution authority.',
    );
  }
}

export async function redactApprovalTail<User>(
  tail: ApprovalTimelineTail,
  user: User,
  redact: LiveActivityHostOptions<User, unknown>['redactApproval'],
): Promise<ApprovalTimelineTail> {
  const entries: ApprovalObservation[] = [];
  for (const value of tail.entries) {
    const original = ApprovalObservationSchema.parse(value) as ApprovalObservation;
    let redacted: ApprovalObservation;
    try {
      redacted = ApprovalObservationSchema.parse(
        await redact(original, { user, tenantId: tail.tenantId, taskId: tail.taskId }),
      ) as ApprovalObservation;
    } catch (error) {
      if (error instanceof LiveActivityHostError) throw error;
      throw new LiveActivityHostError(
        'redaction_invalid',
        'Approval redactor returned an invalid observation.',
        { cause: error },
      );
    }
    assertApprovalRedactionPreservesAuthority(original, redacted);
    entries.push(redacted);
  }
  return { ...tail, entries: Object.freeze(entries) };
}

async function timelineEtag(
  tail: ActivityTail,
  approvals: ApprovalTimelineTail | undefined,
  representationRevision: string,
): Promise<string> {
  const payload = JSON.stringify({
    representationRevision,
    activity: {
      taskId: tail.taskId,
      cursor: tail.cursor ?? null,
      dropped: tail.dropped,
      capacity: tail.capacity,
      expiresAt: tail.expiresAt,
    },
    approvals: approvals === undefined ? null : {
      taskId: approvals.taskId,
      cursor: approvals.cursor ?? null,
      dropped: approvals.dropped,
      capacity: approvals.capacity,
      expiresAt: approvals.expiresAt,
    },
  });
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `"${hex}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(',').some((candidate) => candidate.trim() === '*' || candidate.trim() === etag);
}

export function createLiveActivityHost<User, Representation>(
  options: LiveActivityHostOptions<User, Representation>,
): LiveActivityHost {
  if (
    typeof options.representationRevision !== 'string' ||
    options.representationRevision.trim().length === 0
  ) {
    throw new LiveActivityHostError(
      'configuration_invalid',
      'representationRevision must contain a non-whitespace character.',
    );
  }

  return {
    async fetch(request) {
      const route = parseTaskId(request);
      if (!route.matched) return jsonResponse(404, { error: 'not_found' });
      if (request.method !== 'GET') {
        const response = jsonResponse(405, { error: 'method_not_allowed' });
        response.headers.set('allow', 'GET');
        return response;
      }
      if (route.taskId === undefined) return jsonResponse(400, { error: 'bad_request' });

      try {
        const user = await options.authenticate(request);
        if (user === undefined) return jsonResponse(401, { error: 'unauthorized' });

        const authorized = await options.authorize(user, route.taskId);
        if (authorized === undefined) return jsonResponse(404, { error: 'not_found' });
        if (!isTenantId(authorized.tenantId) || authorized.taskId !== route.taskId) {
          throw new LiveActivityHostError(
            'authorization_binding_invalid',
            'Authorization returned a task binding different from the requested task.',
          );
        }

        const [tail, approvals] = await Promise.all([
          options.readActivity(authorized.tenantId, authorized.taskId),
          options.readApprovals(authorized.tenantId, authorized.taskId),
        ]);
        if (tail === undefined) return jsonResponse(404, { error: 'not_found' });
        if (tail.tenantId !== authorized.tenantId || tail.taskId !== authorized.taskId) {
          throw new LiveActivityHostError(
            'activity_binding_invalid',
            'Activity read returned a tail outside the authorized tenant/task binding.',
          );
        }
        if (
          approvals !== undefined
          && (approvals.tenantId !== authorized.tenantId || approvals.taskId !== authorized.taskId)
        ) {
          throw new LiveActivityHostError(
            'approval_binding_invalid',
            'Approval read returned a tail outside the authorized tenant/task binding.',
          );
        }

        const etag = await timelineEtag(tail, approvals, options.representationRevision);
        const responseHeaders = new Headers({
          'cache-control': 'private, no-cache',
          etag,
          vary: 'Authorization, Cookie',
        });
        if (etagMatches(request.headers.get('if-none-match'), etag)) {
          return new Response(null, { status: 304, headers: responseHeaders });
        }

        const sanitizedTail = await redactActivityTail(tail, user, options.redact);
        const sanitizedApprovals = approvals === undefined
          ? undefined
          : await redactApprovalTail(approvals, user, options.redactApproval);
        const snapshots: LiveActivitySnapshots = Object.freeze({
          activity: replayTimeline(sanitizedTail),
          approvals: sanitizedApprovals === undefined
            ? projectApprovalTimeline(createApprovalProjectionState(authorized.taskId))
            : replayApprovalTimeline(sanitizedApprovals),
        });
        const representation = await options.present(snapshots, {
          user,
          tenantId: authorized.tenantId,
          taskId: authorized.taskId,
          etag,
        });
        const body = JSON.stringify(representation);
        if (body === undefined) throw new TypeError('Presentation result is not JSON serializable.');
        responseHeaders.set('content-type', 'application/json; charset=utf-8');
        return new Response(body, { status: 200, headers: responseHeaders });
      } catch {
        return jsonResponse(500, { error: 'internal_error' });
      }
    },
  };
}
