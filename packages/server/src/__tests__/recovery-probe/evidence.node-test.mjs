import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStarts, hasAcknowledgedOffer } from './evidence.mjs';
const offer = { kind: 'offer', stage: 'first', pid: 1, order: 1, taskId: 'A', offerId: 'offer-A', seq: 3 };
const start = { ...offer, kind: 'start', order: 2, sessionRef: 'session-A', runtimeId: 'pi' };
test('requires task-bound counts even when total count matches', () => {
  assert.throws(() => validateStarts([offer, start, { ...start, order: 3, sessionRef: 'second' }], ['A', 'B'], { A: 1, B: 1 }));
});
test('rejects missing or cross-process offer attribution', () => {
  assert.throws(() => validateStarts([start], ['A'], { A: 1 }));
  assert.throws(() => validateStarts([offer, { ...start, pid: 2 }], ['A'], { A: 1 }));
});
test('rejects unknown manifest task and matches exact wire identity', () => {
  assert.throws(() => validateStarts([offer, { ...start, taskId: 'unknown' }], ['A'], { A: 1 }));
  assert.throws(() => validateStarts([offer, { ...start, seq: 4 }], ['A'], { A: 1 }));
  assert.deepEqual(validateStarts([offer, start], ['A'], { A: 1 }), { A: 1 });
});

test('missing new-URL cursor never substitutes for a durable server ACK', () => {
  const state = { localCursor: null,
    mailbox: [{ taskId: 'A', type: 'task.offer', seq: 3, state: 'acked' }],
    serverCursors: [{ device_id: 'device', acked_seq: 3 }] };
  assert.equal(hasAcknowledgedOffer(state, 'device', 'A'), false);
  assert.equal(hasAcknowledgedOffer(state, 'device', 'A', { allowAbsentCursor: true }), true);
  assert.equal(hasAcknowledgedOffer({ ...state, serverCursors: [{ device_id: 'device', acked_seq: 2 }] }, 'device', 'A', { allowAbsentCursor: true }), false);
  assert.equal(hasAcknowledgedOffer({ ...state, mailbox: [{ ...state.mailbox[0], state: 'pending' }] }, 'device', 'A', { allowAbsentCursor: true }), false);
});
