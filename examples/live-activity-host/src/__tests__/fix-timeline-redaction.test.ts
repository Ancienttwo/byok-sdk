import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalObservationSchema, TimelineEventSchema, tenantId,
  type ActivityTail, type ApprovalObservation, type ApprovalTimelineTail, type TimelineEvent,
} from '@byok-sdk/cloud';
import { createLiveActivityHost, redactActivityTail, redactApprovalTail, type LiveActivityHostOptions } from '../index';

const tenant = tenantId('tenant-1');
const now = '2026-08-16T13:00:00.000Z';
const later = '2026-08-16T13:01:00.000Z';
const use = { type: 'tool_use', tool: 'lookup', toolCallId: 'call-1', input: 'secret-input' } as const;
const result = { type: 'tool_result', tool: 'lookup', toolCallId: 'call-1', isError: true, output: 'secret-output' } as const;
const requested = { type: 'approval_requested', approvalId: 'approval-1', summary: 'secret-summary' } as const;
const resolved = { type: 'approval_resolved', approvalId: 'approval-1', decision: 'reject', resolvedBy: 'local', at: now } as const;

function activity(event: TimelineEvent['event'] = result): ActivityTail {
  return {
    tenantId: tenant, taskId: 'task-1', dropped: 0, capacity: 50, expiresAt: later,
    entries: [{ taskId: 'task-1', sourceEnvelopeId: 'env-1', batchSeq: 1, eventIndex: 0, receivedAt: now, event }],
  };
}
function approvals(event: ApprovalObservation['event'] = resolved): ApprovalTimelineTail {
  return {
    tenantId: tenant, taskId: 'task-1', dropped: 0, capacity: 50, expiresAt: later,
    cursor: 1, entries: [{ taskId: 'task-1', sourceEnvelopeId: 'env-1', revision: 1, receivedAt: now, event }],
  };
}
function options(overrides: Partial<LiveActivityHostOptions<string, unknown>>): LiveActivityHostOptions<string, unknown> {
  return {
    representationRevision: 'v1', authenticate: () => 'user-1',
    authorize: () => ({ tenantId: tenant, taskId: 'task-1' }),
    readActivity: () => activity(), readApprovals: () => approvals(),
    redact: (entry) => entry, redactApproval: (entry) => entry,
    present: (snapshots) => snapshots, ...overrides,
  };
}
const request = () => new Request('https://host.example/api/tasks/task-1/activity');
const failure = { name: 'LiveActivityHostError', code: 'redaction_invalid' };

type Mutation<T> = { name: string; event: T extends TimelineEvent ? TimelineEvent['event'] : ApprovalObservation['event']; mutate: (entry: T) => void };
const activityCases: Mutation<TimelineEvent>[] = [
  ...Object.entries({ taskId: 'task-2', sourceEnvelopeId: 'env-2', batchSeq: 2, eventIndex: 1, receivedAt: later })
    .map(([field, value]) => ({ name: field, event: result, mutate: (entry: TimelineEvent) => { Object.assign(entry, { [field]: value }); } })),
  { name: 'event type', event: result, mutate: (entry) => { Object.assign(entry, { event: { type: 'progress', text: 'changed' } }); } },
  ...([use, result] as const).flatMap((event) => [
    { name: `${event.type} tool`, event, mutate: (entry: TimelineEvent) => { Object.assign(entry.event, { tool: 'other' }); } },
    { name: `${event.type} call ID`, event, mutate: (entry: TimelineEvent) => { Object.assign(entry.event, { toolCallId: 'other' }); } },
    { name: `${event.type} removed call ID`, event, mutate: (entry: TimelineEvent) => { Reflect.deleteProperty(entry.event, 'toolCallId'); } },
  ]),
  { name: 'outcome', event: result, mutate: (entry) => { Object.assign(entry.event, { isError: false }); } },
  { name: 'removed outcome', event: result, mutate: (entry) => { Reflect.deleteProperty(entry.event, 'isError'); } },
];
const approvalCases: Mutation<ApprovalObservation>[] = [
  ...Object.entries({ taskId: 'task-2', sourceEnvelopeId: 'env-2', revision: 2, receivedAt: later })
    .map(([field, value]) => ({ name: field, event: resolved, mutate: (entry: ApprovalObservation) => { Object.assign(entry, { [field]: value }); } })),
  { name: 'event type', event: resolved, mutate: (entry) => { Object.assign(entry, { event: requested }); } },
  ...([requested, resolved] as const).flatMap((event) => [
    { name: `${event.type} ID`, event, mutate: (entry: ApprovalObservation) => { Object.assign(entry.event, { approvalId: 'other' }); } },
    { name: `${event.type} removed ID`, event, mutate: (entry: ApprovalObservation) => { Reflect.deleteProperty(entry.event, 'approvalId'); } },
  ]),
  { name: 'decision', event: resolved, mutate: (entry) => { Object.assign(entry.event, { decision: 'approve' }); } },
  { name: 'resolver', event: resolved, mutate: (entry) => { Object.assign(entry.event, { resolvedBy: 'host', reason: null }); } },
  { name: 'resolution time', event: resolved, mutate: (entry) => { Object.assign(entry.event, { at: later }); } },
];

describe('S20-F2: in-place redaction preserves original authority', () => {
  it.each(activityCases)('rejects in-place activity $name changes', async ({ event, mutate }) => {
    const raw = activity(event);
    const before = structuredClone(raw);
    const redact = async (entry: TimelineEvent) => { mutate(entry); return entry; };
    // The mutation is schema-valid, so rejection must come from authority comparison.
    const changed = structuredClone(raw.entries[0]!);
    mutate(changed);
    expect(() => TimelineEventSchema.parse(changed)).not.toThrow();
    await expect(redactActivityTail(raw, 'user-1', redact)).rejects.toMatchObject(failure);
    const present = vi.fn();
    const response = await createLiveActivityHost(options({ readActivity: () => raw, redact, present })).fetch(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    expect(present).not.toHaveBeenCalled();
    expect(raw).toEqual(before);
  });

  it.each(approvalCases)('rejects in-place approval $name changes', async ({ event, mutate }) => {
    const raw = approvals(event);
    const before = structuredClone(raw);
    const redactApproval = async (entry: ApprovalObservation) => { mutate(entry); return entry; };
    const changed = structuredClone(raw.entries[0]!);
    mutate(changed);
    expect(() => ApprovalObservationSchema.parse(changed)).not.toThrow();
    await expect(redactApprovalTail(raw, 'user-1', redactApproval)).rejects.toMatchObject(failure);
    const present = vi.fn();
    const response = await createLiveActivityHost(options({ readApprovals: () => raw, redactApproval, present })).fetch(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    expect(present).not.toHaveBeenCalled();
    expect(raw).toEqual(before);
  });

  it('still accepts in-place content redaction for both streams', async () => {
    const raw = activity(use);
    const rawApprovals = approvals(requested);
    const before = structuredClone({ raw, rawApprovals });
    const redact = (entry: TimelineEvent) => {
      Object.assign(entry.event, entry.event.type === 'tool_use' ? { input: '[redacted-input]' } : { output: '[redacted-output]' });
      return entry;
    };
    const redactApproval = (entry: ApprovalObservation) => { Object.assign(entry.event, { summary: '[redacted-summary]' }); return entry; };
    expect((await redactActivityTail(raw, 'user-1', redact)).entries[0]?.event).toEqual({ ...use, input: '[redacted-input]' });
    expect((await redactActivityTail(activity(), 'user-1', redact)).entries[0]?.event).toEqual({ ...result, output: '[redacted-output]' });
    expect((await redactApprovalTail(rawApprovals, 'user-1', redactApproval)).entries[0]?.event).toEqual({ ...requested, summary: '[redacted-summary]' });
    const response = await createLiveActivityHost(options({ readActivity: () => raw, readApprovals: () => rawApprovals, redact, redactApproval })).fetch(request());
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('secret-');
    expect(body).toContain('[redacted-input]');
    expect(body).toContain('[redacted-summary]');
    expect({ raw, rawApprovals }).toEqual(before);
  });
});
