import { expect, it } from 'vitest';
import { classifyInbound, type ChannelPort, type Delivery, type InboundMessage } from './channel';
import { acceptDeliveryEcho, deliveryId, readbackDelivery, recoverDelivery, settleDelivery, startDelivery, unknownDelivery } from './delivery';

type SendResult = Awaited<ReturnType<ChannelPort['send']>>;
const reply: Delivery['route'] = { kind: 'reply', inboundId: 'inbound-key' };
const accepted: SendResult = { result: 'accepted', platformMessageId: 'platform-1' };
const retryable: SendResult = { result: 'rejected', code: '429', retryable: true };
function delivery(fields: Partial<Delivery> = {}): Delivery {
  return { id: deliveryId('task', 'message', reply), taskId: 'task', turnId: 'turn', messageId: 'message', body: 'Final reply',
    conversation: { kind: 'direct', id: 'main' }, channel: 'fake', route: reply, state: 'pending', attempts: 0, ...fields };
}

it('uses stable delivery identities and new identities for distinct routes and manual resends', () => {
  const id = deliveryId('task', 'message', reply);
  expect(deliveryId('task', 'message', { ...reply })).toBe(id);
  const alternatives = [
    deliveryId('task-2', 'message', reply),
    deliveryId('task', 'message-2', reply),
    deliveryId('task', 'message', { kind: 'reply', inboundId: 'other' }),
    deliveryId('task', 'message', { kind: 'push', pushRouteId: 'inbound-key' }),
    deliveryId('task', 'message', reply, 'resend-1'),
    deliveryId('task', 'message', reply, 'resend-2'),
  ];
  expect(new Set([id, ...alternatives]).size).toBe(7);
});

it('claims a due pending delivery once and clears the previous attempt metadata', () => {
  const row = delivery({ attempts: 1, nextAttemptAt: 500, code: '429' });
  const before = structuredClone(row);
  expect(startDelivery(row, 499)).toBe(false);
  expect(row).toEqual(before);
  expect(startDelivery(row, 500)).toBe(true);
  expect(row).toMatchObject({ state: 'sending', attempts: 2 });
  expect(row).not.toHaveProperty('nextAttemptAt');
  expect(row).not.toHaveProperty('code');
  expect(startDelivery(row, 500)).toBe(false);
  for (const state of ['sending', 'unknown', 'accepted', 'rejected'] as const) {
    expect(startDelivery(delivery({ state }), 500)).toBe(false);
  }
  expect(startDelivery(delivery({ attempts: 3 }), 500)).toBe(false);
});

it('accepts the current send and keeps platform acceptance final', () => {
  const row = delivery();
  expect(startDelivery(row, 0)).toBe(true);
  settleDelivery(row, 1, accepted, 1);
  expect(row).toMatchObject({ state: 'accepted', attempts: 1, platformMessageId: 'platform-1' });
  const before = structuredClone(row);
  settleDelivery(row, 1, retryable, 2);
  unknownDelivery(row, 1, 'timeout');
  recoverDelivery(row);
  readbackDelivery(row, 1, 'absent', 2);
  expect(row).toEqual(before);
});

it('waits for Retry-After and never starts early', () => {
  const row = delivery();
  startDelivery(row, 0);
  settleDelivery(row, 1, { ...retryable, retryAfterMs: 10_000 }, 20);
  expect(row).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: 10_020, code: '429' });
  expect(startDelivery(row, 10_019)).toBe(false);
  expect(startDelivery(row, 10_020)).toBe(true);
  settleDelivery(row, 2, { ...retryable, retryAfterMs: 500 }, 10_021);
  expect(row).toMatchObject({ state: 'pending', attempts: 2, nextAttemptAt: 12_021 });
});

it('uses the exponential backoff and stops after three sends', () => {
  const row = delivery();
  expect(startDelivery(row, 0)).toBe(true);
  settleDelivery(row, 1, retryable, 0);
  expect(row.nextAttemptAt).toBe(1_000);
  expect(startDelivery(row, 1_000)).toBe(true);
  settleDelivery(row, 2, retryable, 1_000);
  expect(row.nextAttemptAt).toBe(3_000);
  expect(startDelivery(row, 3_000)).toBe(true);
  settleDelivery(row, 3, retryable, 3_000);
  expect(row).toMatchObject({ state: 'rejected', attempts: 3, code: '429' });
  expect(row).not.toHaveProperty('nextAttemptAt');
  expect(startDelivery(row, 100_000)).toBe(false);
});

it('makes a permanent platform rejection final', () => {
  const row = delivery();
  startDelivery(row, 0);
  settleDelivery(row, 1, { result: 'rejected', code: 'forbidden', retryable: false }, 1);
  expect(row).toMatchObject({ state: 'rejected', code: 'forbidden', attempts: 1 });
  expect(acceptDeliveryEcho(row, 'platform-1')).toBe(false);
  readbackDelivery(row, 1, 'accepted', 2);
  expect(row.state).toBe('rejected');
});

it('allows the 60-second wait boundary and rejects longer waits without sending early', () => {
  const row = delivery();
  startDelivery(row, 0);
  settleDelivery(row, 1, { ...retryable, retryAfterMs: 60_000 }, 10);
  expect(row).toMatchObject({ state: 'pending', nextAttemptAt: 60_010 });
  const over = delivery();
  startDelivery(over, 0);
  settleDelivery(over, 1, { ...retryable, retryAfterMs: 60_001 }, 10);
  expect(over).toMatchObject({ state: 'rejected', code: '429' });
  expect(over).not.toHaveProperty('nextAttemptAt');
  expect(startDelivery(over, 60_011)).toBe(false);
});

it('does not retry an explicit rejection with an invalid Retry-After', () => {
  for (const retryAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, '1000']) {
    const row = delivery();
    startDelivery(row, 0);
    settleDelivery(row, 1, { ...retryable, retryAfterMs } as SendResult, 10);
    expect(row).toMatchObject({ state: 'rejected', attempts: 1, code: 'invalid_retry_after' });
    expect(row).not.toHaveProperty('nextAttemptAt');
  }
});

it('keeps malformed channel results unknown without scheduling another send', () => {
  for (const result of [null, {}, { result: 'accepted' }, { result: 'accepted', platformMessageId: '' },
    { result: 'rejected', retryable: true }, { result: 'rejected', code: '429', retryable: 'yes' }]) {
    const row = delivery();
    startDelivery(row, 0);
    settleDelivery(row, 1, result as SendResult, 1);
    expect(row).toMatchObject({ state: 'unknown', attempts: 1, code: 'invalid_send_result' });
    expect(row).not.toHaveProperty('nextAttemptAt');
    expect(startDelivery(row, 100_000)).toBe(false);
  }
});

it('ignores late send results and timeouts from an earlier attempt', () => {
  const row = delivery();
  startDelivery(row, 0);
  settleDelivery(row, 1, retryable, 0);
  startDelivery(row, 1_000);
  const before = structuredClone(row);
  settleDelivery(row, 1, accepted, 1_001);
  unknownDelivery(row, 1, 'late_timeout');
  expect(row).toEqual(before);
  settleDelivery(row, 2, accepted, 1_002);
  expect(row).toMatchObject({ state: 'accepted', attempts: 2, platformMessageId: 'platform-1' });
});

it('leaves uncertain sends unknown until authoritative readback or echo', () => {
  const row = delivery();
  startDelivery(row, 0);
  unknownDelivery(row, 1, 'timeout');
  expect(row).toMatchObject({ state: 'unknown', attempts: 1, code: 'timeout' });
  settleDelivery(row, 1, accepted, 1);
  expect(row.state).toBe('unknown');
  readbackDelivery(row, 1, 'unsupported', 2);
  expect(row).toMatchObject({ state: 'unknown', code: 'timeout' });
  expect(startDelivery(row, 100_000)).toBe(false);
  readbackDelivery(row, 1, 'accepted', 3);
  expect(row.state).toBe('accepted');
  expect(row).not.toHaveProperty('code');
});

it('requires authoritative absence to retry unknown and applies the same attempt limit', () => {
  const row = delivery({ state: 'unknown', attempts: 2, code: 'timeout' });
  readbackDelivery(row, 2, 'absent', 50);
  expect(row).toMatchObject({ state: 'pending', nextAttemptAt: 2_050 });
  expect(row).not.toHaveProperty('code');
  expect(startDelivery(row, 2_049)).toBe(false);
  expect(startDelivery(row, 2_050)).toBe(true);
  unknownDelivery(row, 3, 'timeout');
  readbackDelivery(row, 3, 'absent', 2_060);
  expect(row).toMatchObject({ state: 'rejected', attempts: 3, code: 'attempts_exhausted' });
  expect(startDelivery(row, 100_000)).toBe(false);
});

it('lets an exact echo win over a later send result or timeout', () => {
  for (const state of ['sending', 'unknown'] as const) {
    const row = delivery({ state, attempts: 1, code: 'timeout' });
    expect(acceptDeliveryEcho(row, 'echo-id')).toBe(true);
    settleDelivery(row, 1, accepted, 1);
    unknownDelivery(row, 1, 'timeout');
    expect(row).toMatchObject({ state: 'accepted', platformMessageId: 'echo-id' });
    expect(row).not.toHaveProperty('code');
  }
  const acceptedRow = delivery({ state: 'accepted', attempts: 1 });
  expect(acceptDeliveryEcho(acceptedRow, 'echo-id')).toBe(true);
  expect(acceptDeliveryEcho(acceptedRow, 'echo-id')).toBe(true);
  expect(acceptDeliveryEcho(acceptedRow, 'different-id')).toBe(false);
  expect(acceptedRow.platformMessageId).toBe('echo-id');
  expect(acceptDeliveryEcho(delivery(), 'echo-id')).toBe(false);
  expect(acceptDeliveryEcho(delivery({ state: 'sending' }), '')).toBe(false);
});

it('accepts a late exact echo during the retry wait after absent readback', () => {
  const row = delivery();
  expect(startDelivery(row, 0)).toBe(true);
  unknownDelivery(row, 1, 'timeout');
  readbackDelivery(row, 1, 'absent', 50);
  expect(row).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: 1_050 });
  expect(acceptDeliveryEcho(row, 'late-echo')).toBe(true);
  expect(row).toMatchObject({ state: 'accepted', attempts: 1, platformMessageId: 'late-echo' });
  expect(row).not.toHaveProperty('nextAttemptAt');
  expect(row).not.toHaveProperty('code');
  expect(startDelivery(row, 1_050)).toBe(false);
});

it('recovers only sending rows as unknown and makes restart recovery idempotent', () => {
  for (const state of ['pending', 'sending', 'unknown', 'accepted', 'rejected'] as const) {
    const row = delivery({ state, attempts: 1, code: 'previous' });
    const before = structuredClone(row);
    recoverDelivery(row);
    if (state === 'sending') {
      expect(row).toMatchObject({ state: 'unknown', attempts: 1, code: 'interrupted' });
      expect(startDelivery(row, 100_000)).toBe(false);
    } else expect(row).toEqual(before);
    const recovered = structuredClone(row);
    recoverDelivery(row);
    expect(row).toEqual(recovered);
  }
});

it('classifies echoes only for verified bot principals configured on that channel', () => {
  const inbound: InboundMessage = { channel: 'fake', platformMessageId: 'platform-1', conversation: { kind: 'direct', id: 'main' },
    sender: { id: 'self', kind: 'bot' }, text: 'Final reply', mentions: [], deliveryId: 'delivery-1' };
  const self = { fake: ['self'], other: ['other-self'] };
  expect(classifyInbound(inbound, 'owner', self)).toBe('echo');
  expect(classifyInbound({ ...inbound, conversation: { kind: 'group', id: 'room' } }, 'owner', self)).toBe('echo');
  expect(classifyInbound(inbound, 'owner')).toBe('bot_audit');
  expect(classifyInbound({ ...inbound, channel: 'other' }, 'owner', self)).toBe('bot_audit');
  expect(classifyInbound({ ...inbound, channel: '__proto__' }, 'owner', self)).toBe('bot_audit');
  expect(classifyInbound({ ...inbound, channel: 'constructor' }, 'owner', self)).toBe('bot_audit');
  expect(classifyInbound({ ...inbound, sender: { id: 'other-bot', kind: 'bot' } }, 'owner', self)).toBe('bot_audit');
  expect(classifyInbound({ ...inbound, sender: { id: 'self', kind: 'human' } }, 'owner', self)).toBe('not_owner');
  expect(classifyInbound({ ...inbound, sender: undefined }, 'owner', self)).toBe('unverified_sender');
  expect(classifyInbound({ ...inbound, sender: { id: '', kind: 'bot' } }, 'owner', { fake: [''] })).toBe('unverified_sender');
});
