import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  tenantId,
  type ActivityTail,
  type ApprovalObservation,
  type ApprovalTimelineTail,
  type TimelineEvent,
} from '@byok-sdk/cloud';
import {
  createLiveActivityHost,
  LiveActivityHostError,
  redactApprovalTail,
  redactActivityTail,
  type LiveActivityHostOptions,
} from '../index';

const AUTHORIZED_TENANT = tenantId('tenant-authorized');
const NOW = '2026-08-16T13:00:00.000Z';

function timelineEvent(
  event: TimelineEvent['event'],
  overrides: Partial<Omit<TimelineEvent, 'event'>> = {},
): TimelineEvent {
  return {
    taskId: 'task-1',
    sourceEnvelopeId: 'envelope-1',
    batchSeq: 1,
    eventIndex: 0,
    receivedAt: NOW,
    event,
    ...overrides,
  };
}

function activityTail(entries: readonly TimelineEvent[]): ActivityTail {
  return {
    tenantId: AUTHORIZED_TENANT,
    taskId: 'task-1',
    entries,
    cursor: { batchSeq: 1, eventIndex: entries.length - 1 },
    dropped: 0,
    capacity: 50,
    expiresAt: '2026-08-16T14:00:00.000Z',
  };
}

function approvalObservation(
  revision: number,
  event: ApprovalObservation['event'],
): ApprovalObservation {
  return {
    taskId: 'task-1',
    sourceEnvelopeId: `approval-envelope-${revision}`,
    revision,
    receivedAt: NOW,
    event,
  };
}

function approvalTail(entries: readonly ApprovalObservation[]): ApprovalTimelineTail {
  return {
    tenantId: AUTHORIZED_TENANT,
    taskId: 'task-1',
    entries,
    cursor: entries.at(-1)?.revision,
    dropped: 0,
    capacity: 50,
    expiresAt: '2026-08-16T14:00:00.000Z',
  };
}

type TestUser = { readonly id: string };

function hostOptions(
  overrides: Partial<LiveActivityHostOptions<TestUser, unknown>> = {},
): LiveActivityHostOptions<TestUser, unknown> {
  return {
    representationRevision: 'policy-v1',
    authenticate: (request) =>
      request.headers.get('authorization') === 'Bearer valid' ? { id: 'user-1' } : undefined,
    authorize: (_user, taskId) => ({ tenantId: AUTHORIZED_TENANT, taskId }),
    readActivity: () => activityTail([timelineEvent({ type: 'progress', text: 'working' })]),
    readApprovals: () => undefined,
    redact: (event) => event,
    redactApproval: (observation) => observation,
    present: ({ activity, approvals }) => ({ timeline: activity, approvals }),
    ...overrides,
  };
}

function request(path = '/api/tasks/task-1/activity', init: RequestInit = {}): Request {
  return new Request(`https://host.example${path}`, {
    headers: { authorization: 'Bearer valid', ...init.headers },
    ...init,
  });
}

describe('live activity host security boundary', () => {
  it('authenticates first and makes denial indistinguishable from an absent tail', async () => {
    const readActivity = vi.fn(hostOptions().readActivity);
    const readApprovals = vi.fn(hostOptions().readApprovals);
    const unauthenticated = createLiveActivityHost(hostOptions({ readActivity, readApprovals }));
    const noSession = await unauthenticated.fetch(
      new Request('https://host.example/api/tasks/task-1/activity'),
    );
    expect(noSession.status).toBe(401);
    expect(await noSession.json()).toEqual({ error: 'unauthorized' });
    expect(noSession.headers.get('cache-control')).toBe('private, no-store');
    expect(noSession.headers.get('vary')).toBe('Authorization, Cookie');
    expect(readActivity).not.toHaveBeenCalled();
    expect(readApprovals).not.toHaveBeenCalled();

    const denied = await createLiveActivityHost(
      hostOptions({ authorize: () => undefined }),
    ).fetch(request());
    const absent = await createLiveActivityHost(
      hostOptions({ readActivity: () => undefined }),
    ).fetch(request());
    expect(denied.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await denied.text()).toBe(await absent.text());
  });

  it('derives tenant only from authorization and ignores browser tenant inputs', async () => {
    const readActivity = vi.fn((tenant: typeof AUTHORIZED_TENANT, taskId: string) =>
      activityTail([timelineEvent({ type: 'progress', text: taskId })]),
    );
    const readApprovals = vi.fn(() => undefined);
    const host = createLiveActivityHost(hostOptions({ readActivity, readApprovals }));
    const response = await host.fetch(
      request('/api/tasks/task-1/activity?tenantId=tenant-attacker', {
        headers: {
          authorization: 'Bearer valid',
          'x-tenant-id': 'tenant-attacker',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(readActivity).toHaveBeenCalledWith(AUTHORIZED_TENANT, 'task-1');
    expect(readApprovals).toHaveBeenCalledWith(AUTHORIZED_TENANT, 'task-1');
  });

  it('redacts tool input and output before presentation or browser serialization', async () => {
    const tail = activityTail([
      timelineEvent({ type: 'tool_use', tool: 'lookup', toolCallId: 'call-1', input: { token: 'raw-input-secret' } }),
      timelineEvent(
        { type: 'tool_result', tool: 'lookup', toolCallId: 'call-1', isError: false, output: { token: 'raw-output-secret' } },
        { eventIndex: 1 },
      ),
    ]);
    const present = vi.fn(({ activity, approvals }) => ({ timeline: activity, approvals }));
    const host = createLiveActivityHost(
      hostOptions({
        readActivity: () => tail,
        redact: (entry) => {
          if (entry.event.type === 'tool_use') {
            return { ...entry, event: { ...entry.event, input: { value: '[redacted-input]' } } };
          }
          if (entry.event.type === 'tool_result') {
            return { ...entry, event: { ...entry.event, output: { value: '[redacted-output]' } } };
          }
          return entry;
        },
        present,
      }),
    );

    const response = await host.fetch(request());
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain('raw-input-secret');
    expect(body).not.toContain('raw-output-secret');
    expect(body).toContain('[redacted-input]');
    expect(body).toContain('[redacted-output]');
    expect(present).toHaveBeenCalledOnce();
    expect(JSON.stringify(present.mock.calls[0]?.[0])).not.toContain('raw-');
  });

  it.each([
    ['identity', (entry: TimelineEvent) => ({ ...entry, sourceEnvelopeId: 'changed' })],
    ['order', (entry: TimelineEvent) => ({ ...entry, batchSeq: entry.batchSeq + 1 })],
    ['type', (entry: TimelineEvent) => ({ ...entry, event: { type: 'progress' as const, text: 'changed' } })],
    [
      'tool correlation',
      (entry: TimelineEvent) =>
        entry.event.type === 'tool_use'
          ? { ...entry, event: { ...entry.event, toolCallId: 'changed-call' } }
          : entry,
    ],
  ])('fails closed when redaction changes %s authority', async (_name, mutate) => {
    const tail = activityTail([
      timelineEvent({ type: 'tool_use', tool: 'lookup', toolCallId: 'call-1', input: 'secret' }),
    ]);
    const response = await createLiveActivityHost(
      hostOptions({ readActivity: () => tail, redact: mutate }),
    ).fetch(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('exposes typed redaction failure for direct host tests', async () => {
    const tail = activityTail([
      timelineEvent({ type: 'tool_result', tool: 'lookup', toolCallId: 'call-1', isError: true }),
    ]);
    await expect(
      redactActivityTail(tail, { id: 'user-1' }, (entry) => ({
        ...entry,
        event:
          entry.event.type === 'tool_result'
            ? { ...entry.event, isError: false }
            : entry.event,
      })),
    ).rejects.toMatchObject({
      name: 'LiveActivityHostError',
      code: 'redaction_invalid',
    });
  });

  it('authorizes and reads before returning a matching conditional response', async () => {
    const calls: string[] = [];
    const host = createLiveActivityHost(
      hostOptions({
        authenticate: () => {
          calls.push('authenticate');
          return { id: 'user-1' };
        },
        authorize: (_user, taskId) => {
          calls.push('authorize');
          return { tenantId: AUTHORIZED_TENANT, taskId };
        },
        readActivity: () => {
          calls.push('read-activity');
          return activityTail([timelineEvent({ type: 'progress', text: 'working' })]);
        },
        readApprovals: () => {
          calls.push('read-approvals');
          return undefined;
        },
        redact: (entry) => {
          calls.push('redact');
          return entry;
        },
      }),
    );
    const first = await host.fetch(request());
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);

    calls.length = 0;
    const second = await host.fetch(request(undefined, { headers: { authorization: 'Bearer valid', 'if-none-match': etag! } }));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(calls).toEqual(['authenticate', 'authorize', 'read-activity', 'read-approvals']);
    expect(second.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('changes ETag when representation policy changes', async () => {
    const first = await createLiveActivityHost(
      hostOptions({ representationRevision: 'policy-v1' }),
    ).fetch(request());
    const second = await createLiveActivityHost(
      hostOptions({ representationRevision: 'policy-v2' }),
    ).fetch(request());
    expect(first.headers.get('etag')).not.toBe(second.headers.get('etag'));

    const movedCursor = await createLiveActivityHost(
      hostOptions({
        readActivity: () => ({
          ...activityTail([timelineEvent({ type: 'progress', text: 'working' })]),
          cursor: { batchSeq: 2, eventIndex: 0 },
        }),
      }),
    ).fetch(request());
    expect(first.headers.get('etag')).not.toBe(movedCursor.headers.get('etag'));

    const movedApprovalCursor = await createLiveActivityHost(
      hostOptions({
        readApprovals: () => approvalTail([
          approvalObservation(1, {
            type: 'approval_requested', approvalId: 'approval-1', summary: 'Continue?',
          }),
        ]),
      }),
    ).fetch(request());
    expect(first.headers.get('etag')).not.toBe(movedApprovalCursor.headers.get('etag'));
  });

  it('redacts approval summaries before folding while preserving native authority', async () => {
    const raw = approvalTail([
      approvalObservation(1, {
        type: 'approval_requested', approvalId: 'approval-1', summary: 'secret approval details',
      }),
      approvalObservation(2, {
        type: 'approval_resolved', approvalId: 'approval-1', decision: 'approve',
        resolvedBy: 'local', at: '2026-08-16T13:01:00.000Z',
      }),
    ]);
    const response = await createLiveActivityHost(hostOptions({
      readApprovals: () => raw,
      redactApproval: (observation) => observation.event.type === 'approval_requested'
        ? { ...observation, event: { ...observation.event, summary: '[redacted-approval]' } }
        : observation,
    })).fetch(request());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('secret approval details');
    expect(body).toContain('[redacted-approval]');
    expect(JSON.parse(body)).toMatchObject({
      approvals: { items: [{ approvalId: 'approval-1', correlation: 'paired', status: 'approved' }] },
    });
  });

  it.each([
    ['identity', (entry: ApprovalObservation) => ({ ...entry, sourceEnvelopeId: 'changed' })],
    ['revision', (entry: ApprovalObservation) => ({ ...entry, revision: entry.revision + 1 })],
    [
      'approval ID',
      (entry: ApprovalObservation) => entry.event.type === 'approval_requested'
        ? { ...entry, event: { ...entry.event, approvalId: 'changed' } }
        : entry,
    ],
    [
      'resolution decision',
      (entry: ApprovalObservation) => entry.event.type === 'approval_resolved'
        ? { ...entry, event: { ...entry.event, decision: 'reject' as const } }
        : entry,
    ],
  ])('fails closed when approval redaction changes %s authority', async (_name, mutate) => {
    const requested = approvalObservation(1, {
      type: 'approval_requested', approvalId: 'approval-1', summary: 'secret',
    });
    const resolved = approvalObservation(2, {
      type: 'approval_resolved', approvalId: 'approval-1', decision: 'approve',
      resolvedBy: 'local', at: '2026-08-16T13:01:00.000Z',
    });
    const response = await createLiveActivityHost(hostOptions({
      readApprovals: () => approvalTail(_name === 'resolution decision' ? [resolved] : [requested]),
      redactApproval: mutate,
    })).fetch(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('exposes typed approval redaction failure for direct host tests', async () => {
    const tail = approvalTail([
      approvalObservation(1, { type: 'approval_requested', approvalId: 'approval-1', summary: 'secret' }),
    ]);
    await expect(redactApprovalTail(tail, { id: 'user-1' }, (entry) => ({
      ...entry,
      event: entry.event.type === 'approval_requested'
        ? { ...entry.event, approvalId: 'changed' }
        : entry.event,
    }))).rejects.toMatchObject({ name: 'LiveActivityHostError', code: 'redaction_invalid' });
  });

  it('rejects approval tails outside the authorized binding', async () => {
    const wrongTenant = await createLiveActivityHost(hostOptions({
      readApprovals: () => ({ ...approvalTail([]), tenantId: tenantId('tenant-other') }),
    })).fetch(request());
    const wrongTask = await createLiveActivityHost(hostOptions({
      readApprovals: () => ({ ...approvalTail([]), taskId: 'task-other' }),
    })).fetch(request());

    expect(wrongTenant.status).toBe(500);
    expect(wrongTask.status).toBe(500);
  });

  it('preserves unknown events and loss/gap metadata through the host path', async () => {
    const tail: ActivityTail = {
      ...activityTail([]),
      entries: [
        timelineEvent({ type: 'progress', text: 'start' }, { batchSeq: 0 }),
        timelineEvent({ type: 'future_event', privateValue: '[redacted]' }, { batchSeq: 2, sourceEnvelopeId: 'envelope-2' }),
      ],
      cursor: { batchSeq: 2, eventIndex: 0 },
      dropped: 3,
    };
    const response = await createLiveActivityHost(
      hostOptions({ readActivity: () => tail }),
    ).fetch(request());
    const body = (await response.json()) as {
      timeline: { dropped: number; gaps: unknown[]; items: Array<{ kind: string; eventType?: string }> };
    };
    expect(body.timeline.dropped).toBe(3);
    expect(body.timeline.gaps).toHaveLength(1);
    expect(body.timeline.items.at(-1)).toMatchObject({ kind: 'unknown', eventType: 'future_event' });
  });

  it('strictly validates route, method, binding, configuration, and serialization', async () => {
    expect(() =>
      createLiveActivityHost(hostOptions({ representationRevision: '   ' })),
    ).toThrowError(LiveActivityHostError);

    const host = createLiveActivityHost(hostOptions());
    expect((await host.fetch(request('/other'))).status).toBe(404);
    expect((await host.fetch(request('/api/tasks/%20/activity'))).status).toBe(400);
    const wrongMethod = await host.fetch(request(undefined, { method: 'POST' }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');

    const wrongBinding = await createLiveActivityHost(
      hostOptions({ authorize: () => ({ tenantId: AUTHORIZED_TENANT, taskId: 'task-other' }) }),
    ).fetch(request());
    expect(wrongBinding.status).toBe(500);

    const invalidTenant = await createLiveActivityHost(
      hostOptions({
        authorize: (_user, taskId) => ({
          tenantId: '' as typeof AUTHORIZED_TENANT,
          taskId,
        }),
      }),
    ).fetch(request());
    expect(invalidTenant.status).toBe(500);

    const unserializable = await createLiveActivityHost(
      hostOptions({ present: () => ({ secret: 'must-not-leak', value: 1n }) }),
    ).fetch(request());
    expect(unserializable.status).toBe(500);
    expect(await unserializable.text()).toBe('{"error":"internal_error"}');
  });

  it('contains read and redaction error details', async () => {
    const readFailure = await createLiveActivityHost(
      hostOptions({ readActivity: () => Promise.reject(new Error('database-secret')) }),
    ).fetch(request());
    expect(await readFailure.text()).toBe('{"error":"internal_error"}');

    const redactionFailure = await createLiveActivityHost(
      hostOptions({ redact: () => Promise.reject(new Error('raw-tool-secret')) }),
    ).fetch(request());
    expect(await redactionFailure.text()).toBe('{"error":"internal_error"}');

    const malformedRedaction = await createLiveActivityHost(
      hostOptions({ redact: () => ({ invalid: true } as unknown as TimelineEvent) }),
    ).fetch(request());
    expect(await malformedRedaction.text()).toBe('{"error":"internal_error"}');
  });

  it('stays a private composition package outside the public release train', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { private?: boolean; name?: string };
    expect(manifest).toMatchObject({
      name: '@byok-sdk/example-live-activity-host',
      private: true,
    });
  });
});
