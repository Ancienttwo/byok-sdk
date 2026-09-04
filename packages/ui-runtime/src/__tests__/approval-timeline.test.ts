import { tenantId, type ApprovalObservation, type ApprovalTimelineTail } from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import {
  ApprovalProjectionError,
  createApprovalProjectionState,
  foldApprovalObservation,
  foldApprovalTail,
  projectApprovalTimeline,
  replayApprovalTimeline,
} from '../index';

const receivedAt = '2026-08-16T12:00:00.000Z';

function observation(
  revision: number,
  event: ApprovalObservation['event'],
  sourceEnvelopeId = `approval-envelope-${revision}`,
): ApprovalObservation {
  return { taskId: 'task-1', sourceEnvelopeId, revision, receivedAt, event };
}

function tail(entries: readonly ApprovalObservation[]): ApprovalTimelineTail {
  return {
    tenantId: tenantId('tenant-1'),
    taskId: 'task-1',
    entries,
    cursor: entries.at(-1)?.revision,
    dropped: 3,
    capacity: 50,
    expiresAt: '2026-08-16T13:00:00.000Z',
  };
}

function expectCode(run: () => unknown, code: ApprovalProjectionError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalProjectionError);
    expect((error as ApprovalProjectionError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ApprovalProjectionError(${code}).`);
}

describe('approval timeline projection', () => {
  it('projects native request and resolution authority with the declared vocabulary', () => {
    const snapshot = replayApprovalTimeline(tail([
      observation(1, { type: 'approval_requested', approvalId: 'approval-1', summary: 'Deploy?' }),
      observation(2, {
        type: 'approval_resolved', approvalId: 'approval-1', decision: 'approve',
        resolvedBy: 'local', at: '2026-08-16T12:01:00.000Z',
      }),
    ]));

    expect(snapshot).toMatchObject({
      taskId: 'task-1', dropped: 3, capacity: 50, cursor: 2,
      expiresAt: '2026-08-16T13:00:00.000Z',
      items: [{
        kind: 'approval', approvalId: 'approval-1', lifecycle: 'approval-responded',
        status: 'approved', correlation: 'paired', summary: 'Deploy?', decision: 'approve',
        resolvedBy: 'local', resolvedAt: '2026-08-16T12:01:00.000Z',
        firstRevision: 1, sourceRevisions: [1, 2],
      }],
    });
  });

  it('projects a host resolution without rewriting it as a local device decision', () => {
    const snapshot = replayApprovalTimeline(tail([
      observation(1, { type: 'approval_requested', approvalId: 'approval-host', summary: 'Deploy?' }),
      observation(2, {
        type: 'approval_resolved', approvalId: 'approval-host', decision: 'reject',
        resolvedBy: 'host', reason: null, at: '2026-08-16T12:01:00.000Z',
      }),
    ]));

    expect(snapshot.items).toMatchObject([{
      approvalId: 'approval-host', status: 'rejected', decision: 'reject', resolvedBy: 'host',
    }]);
  });

  it('keeps an id-less pre-M5 host resolution explicitly unpaired', () => {
    const snapshot = replayApprovalTimeline(tail([
      observation(1, { type: 'approval_requested', summary: 'Legacy approval' }),
      observation(2, {
        type: 'approval_resolved', decision: 'approve', resolvedBy: 'host',
        at: '2026-08-16T12:01:00.000Z',
      }),
    ]));

    expect(snapshot.items).toMatchObject([
      { lifecycle: 'approval-requested', status: 'pending', correlation: 'unpaired-request' },
      {
        lifecycle: 'approval-responded', status: 'approved', correlation: 'unpaired-resolution',
        decision: 'approve', resolvedBy: 'host',
      },
    ]);
    expect(snapshot.items.every((item) => item.approvalId === undefined)).toBe(true);
  });

  it('converges for resolution-before-request and out-of-order incremental folding', () => {
    const request = observation(2, {
      type: 'approval_requested', approvalId: 'approval-1', summary: 'Continue?',
    });
    const resolution = observation(1, {
      type: 'approval_resolved', approvalId: 'approval-1', decision: 'reject',
      resolvedBy: 'local', at: '2026-08-16T12:01:00.000Z',
    });
    const replayed = replayApprovalTimeline(tail([resolution, request]));
    let state = createApprovalProjectionState('task-1');
    state = foldApprovalObservation(state, request);
    state = foldApprovalObservation(state, resolution);
    state = foldApprovalTail(state, tail([resolution, request]));

    expect(projectApprovalTimeline(state)).toEqual(replayed);
    expect(replayed.items).toMatchObject([{
      approvalId: 'approval-1', lifecycle: 'approval-responded', status: 'rejected',
      correlation: 'paired', sourceRevisions: [1, 2],
    }]);
  });

  it('keeps every missing or unmatched native identity explicitly unpaired', () => {
    const snapshot = replayApprovalTimeline(tail([
      observation(1, { type: 'approval_requested', summary: 'First without ID' }),
      observation(2, { type: 'approval_requested', summary: 'Second without ID' }),
      observation(3, { type: 'approval_requested', approvalId: 'pending', summary: 'Pending' }),
      observation(4, {
        type: 'approval_resolved', approvalId: 'orphan', decision: 'approve',
        resolvedBy: 'local', at: '2026-08-16T12:02:00.000Z',
      }),
    ]));

    expect(snapshot.items).toMatchObject([
      { correlation: 'unpaired-request', status: 'pending', summary: 'First without ID' },
      { correlation: 'unpaired-request', status: 'pending', summary: 'Second without ID' },
      { approvalId: 'pending', correlation: 'unpaired-request', status: 'pending' },
      { approvalId: 'orphan', correlation: 'unpaired-resolution', status: 'approved' },
    ]);
    expect(snapshot.items.slice(0, 2).every((item) => item.approvalId === undefined)).toBe(true);
  });

  it('is idempotent for exact overlap and fails closed for every authority collision', () => {
    const request = observation(1, {
      type: 'approval_requested', approvalId: 'approval-1', summary: 'Original',
    }, 'identity');
    const state = foldApprovalObservation(createApprovalProjectionState('task-1'), request);
    expect(foldApprovalObservation(state, request)).toBe(state);

    expectCode(() => foldApprovalObservation(state, { ...request, revision: 2 }), 'approval_identity_collision');
    expectCode(() => foldApprovalObservation(state, { ...request, sourceEnvelopeId: 'other' }), 'approval_revision_collision');
    expectCode(() => foldApprovalObservation(state, {
      ...request, taskId: 'task-2', sourceEnvelopeId: 'other', revision: 2,
    }), 'approval_task_mismatch');

    const conflictingRequest = foldApprovalObservation(state, observation(2, {
      type: 'approval_requested', approvalId: 'approval-1', summary: 'Changed',
    }));
    expectCode(() => projectApprovalTimeline(conflictingRequest), 'approval_authority_collision');

    const resolved = foldApprovalObservation(state, observation(2, {
      type: 'approval_resolved', approvalId: 'approval-1', decision: 'approve',
      resolvedBy: 'local', at: '2026-08-16T12:02:00.000Z',
    }));
    const conflictingResolution = foldApprovalObservation(resolved, observation(3, {
      type: 'approval_resolved', approvalId: 'approval-1', decision: 'reject',
      resolvedBy: 'local', at: '2026-08-16T12:03:00.000Z',
    }));
    expectCode(() => projectApprovalTimeline(conflictingResolution), 'approval_authority_collision');
  });

  it('replaces evicted tail entries and rejects a stale tail cursor', () => {
    const first = tail([
      observation(1, { type: 'approval_requested', approvalId: 'old', summary: 'Old' }),
      observation(2, { type: 'approval_requested', approvalId: 'kept', summary: 'Kept' }),
    ]);
    let state = foldApprovalTail(createApprovalProjectionState('task-1'), first);
    const advanced: ApprovalTimelineTail = {
      ...tail([
        observation(2, { type: 'approval_requested', approvalId: 'kept', summary: 'Kept' }),
        observation(3, { type: 'approval_requested', approvalId: 'new', summary: 'New' }),
      ]),
      dropped: 4,
    };
    state = foldApprovalTail(state, advanced);
    expect(projectApprovalTimeline(state)).toMatchObject({
      dropped: 4,
      cursor: 3,
      items: [{ approvalId: 'kept' }, { approvalId: 'new' }],
    });
    expectCode(() => foldApprovalTail(state, first), 'approval_input_invalid');
  });

  it('rejects malformed tail metadata and observations instead of repairing authority', () => {
    expectCode(() => replayApprovalTimeline({ ...tail([]), dropped: -1 }), 'approval_input_invalid');
    expectCode(() => replayApprovalTimeline({ ...tail([]), cursor: 0 }), 'approval_input_invalid');
    expectCode(() => replayApprovalTimeline({
      ...tail([observation(1, { type: 'approval_requested', summary: 'x' })]), cursor: 2,
    }), 'approval_input_invalid');
    expectCode(() => replayApprovalTimeline(tail([
      observation(2, { type: 'approval_requested', summary: 'later' }),
      observation(1, { type: 'approval_requested', summary: 'earlier' }),
    ])), 'approval_input_invalid');
    expectCode(() => replayApprovalTimeline({
      ...tail([]), entries: [{ ...observation(1, { type: 'approval_requested', summary: 'x' }), revision: 1.5 }],
    }), 'approval_input_invalid');
  });
});
