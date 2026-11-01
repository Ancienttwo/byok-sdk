/**
 * Approval retention bounds (#1113 A3): every adapter retains through
 * `retainApprovalObservations`, so the byte bound is proved once here. The
 * count bound and pending protection run against each adapter in conformance.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_APPROVAL_EVENT_BYTES,
  MAX_APPROVAL_TIMELINE_BYTES,
  retainApprovalObservations,
  validateApprovalTimelineAppend,
  type ApprovalObservation,
} from '../approval-timeline';

function observation(revision: number, event: ApprovalObservation['event']): ApprovalObservation {
  return { taskId: 'task', sourceEnvelopeId: `envelope-${revision}`, revision, receivedAt: '2026-11-01T00:00:00.000Z', event };
}

/** A host reject's reason is the one unbounded field an event can carry. */
function hostReject(approvalId: string, reasonBytes: number) {
  return { type: 'approval_resolved' as const, approvalId, decision: 'reject' as const, resolvedBy: 'host' as const, reason: 'x'.repeat(reasonBytes), at: '2026-11-01T00:00:00.000Z' };
}

const bytes = (entries: readonly ApprovalObservation[]) => new TextEncoder().encode(JSON.stringify(entries)).byteLength;

describe('approval timeline retention', () => {
  it('evicts the oldest observations past the byte bound and keeps the pending request', () => {
    const filler = (revision: number) => observation(revision, hostReject(`other-${revision}`, 400 * 1024));
    let entries: readonly ApprovalObservation[] = [observation(1, { type: 'approval_requested', summary: 'Allow', approvalId: 'pending' })];
    let evicted = 0;
    for (let revision = 2; revision <= 5; revision += 1) {
      const retained = retainApprovalObservations(entries, filler(revision), 50);
      entries = retained.entries;
      evicted += retained.evicted;
    }
    expect(entries.map((entry) => entry.revision)).toEqual([1, 4, 5]);
    expect(evicted).toBe(2);
    expect(bytes(entries)).toBeLessThanOrEqual(MAX_APPROVAL_TIMELINE_BYTES);
  });

  it('refuses one event past its serialized bound', () => {
    const fits = hostReject('a', 1024);
    const overhead = new TextEncoder().encode(JSON.stringify(fits)).byteLength - 1024;
    const append = (reasonBytes: number) => validateApprovalTimelineAppend({ taskId: 'task', sourceEnvelopeId: 'envelope', event: hostReject('a', reasonBytes) });
    expect(append(MAX_APPROVAL_EVENT_BYTES - overhead).event).toBeDefined();
    expect(() => append(MAX_APPROVAL_EVENT_BYTES - overhead + 1)).toThrow(expect.objectContaining({ code: 'coordination_input_invalid' }));
  });
});
