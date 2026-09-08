import assert from 'node:assert/strict';

/** Identity is supplied by the manifest and the observed wire, never text/phase. */
export function validateStarts(events, taskIds, expectedCounts) {
  const starts = events.filter(event => event.kind === 'start');
  const allowed = new Set(taskIds);
  for (const start of starts) {
    assert.ok(allowed.has(start.taskId), 'start references an unbound task');
    assert.equal(typeof start.sessionRef, 'string');
    assert.ok(start.sessionRef.length > 0);
    const offers = events.filter(event => event.kind === 'offer' &&
      event.stage === start.stage && event.pid === start.pid && event.taskId === start.taskId &&
      event.offerId === start.offerId && event.seq === start.seq && event.order < start.order);
    assert.ok(offers.length > 0, 'start lacks a preceding observed offer for the same process/task');
    assert.equal(start.runtimeId, 'pi');
  }
  assert.equal(new Set(starts.map(start => start.sessionRef)).size, starts.length, 'fixture session identity reused');
  const counts = Object.fromEntries(taskIds.map(taskId => [taskId, starts.filter(start => start.taskId === taskId).length]));
  assert.deepEqual(counts, expectedCounts, 'per-task start counts differ');
  return counts;
}

/** Missing cursor is acceptable only for an explicit new-namespace ACKed control. */
export function hasAcknowledgedOffer(state, deviceId, taskId, { allowAbsentCursor = false } = {}) {
  const offer = state.mailbox.find(row => row.taskId === taskId && row.type.startsWith('task.offer'));
  const cursor = state.serverCursors.find(row => row.device_id === deviceId);
  if (!offer || offer.state !== 'acked' || !cursor || cursor.acked_seq < offer.seq) return false;
  if (state.localCursor === null) return allowAbsentCursor;
  return Number.isSafeInteger(state.localCursor) && state.localCursor >= offer.seq;
}
