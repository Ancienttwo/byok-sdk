import {
  isTenantId,
  TimelineEventSchema,
  type ActivityTail,
  type TenantId,
  type TimelineEvent,
} from '@byok-sdk/cloud';
import { replayTimeline, type TaskTimelineSnapshot } from '@byok-sdk/ui-runtime';

export const LIVE_ACTIVITY_ROUTE_PREFIX = '/api/tasks/';
export const LIVE_ACTIVITY_ROUTE_SUFFIX = '/activity';

export const LIVE_ACTIVITY_HOST_ERROR_CODES = [
  'configuration_invalid',
  'authorization_binding_invalid',
  'activity_binding_invalid',
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
  readonly redact: (
    event: TimelineEvent,
    context: LiveActivityRedactionContext<User>,
  ) => TimelineEvent | Promise<TimelineEvent>;
  readonly present: (
    snapshot: TaskTimelineSnapshot,
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

async function timelineEtag(tail: ActivityTail, representationRevision: string): Promise<string> {
  const payload = JSON.stringify({
    representationRevision,
    taskId: tail.taskId,
    cursor: tail.cursor ?? null,
    dropped: tail.dropped,
    capacity: tail.capacity,
    expiresAt: tail.expiresAt,
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

        const tail = await options.readActivity(authorized.tenantId, authorized.taskId);
        if (tail === undefined) return jsonResponse(404, { error: 'not_found' });
        if (tail.tenantId !== authorized.tenantId || tail.taskId !== authorized.taskId) {
          throw new LiveActivityHostError(
            'activity_binding_invalid',
            'Activity read returned a tail outside the authorized tenant/task binding.',
          );
        }

        const etag = await timelineEtag(tail, options.representationRevision);
        const responseHeaders = new Headers({
          'cache-control': 'private, no-cache',
          etag,
          vary: 'Authorization, Cookie',
        });
        if (etagMatches(request.headers.get('if-none-match'), etag)) {
          return new Response(null, { status: 304, headers: responseHeaders });
        }

        const sanitizedTail = await redactActivityTail(tail, user, options.redact);
        const snapshot = replayTimeline(sanitizedTail);
        const representation = await options.present(snapshot, {
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
