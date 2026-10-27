// #1014: device-measured admission phase durations on the message that ends admission.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OFFER_ADMISSION_MAX_DURATION_MS, OfferAdmissionTimingsSchema, TaskClaimPayloadSchema, TaskDeclinePayloadSchema } from '../index';

const ALL_PHASES = {
  totalMs: 812,
  agentHomeWaitMs: 300,
  messageHelperPreflightMs: 40,
  resultHelperPreflightMs: 45,
  toolsetProbeMs: 120,
  runtimeLaunchMs: 9,
};
const sealedDecline = readFileSync(new URL('./golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n').map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> })
  .find((line) => line.type === 'task.decline' && line.payload.sealed !== undefined)!.payload;

describe('offer admission timings (#1014)', () => {
  it.each([{ totalMs: 0 }, ALL_PHASES])('rides on task.claim and on both task.decline branches: %j', (admission) => {
    expect(TaskClaimPayloadSchema.parse({ deviceId: 'device-1', admission })).toEqual({ deviceId: 'device-1', admission });
    expect(TaskDeclinePayloadSchema.parse({ reason: 'busy', retryable: true, admission })).toEqual({ reason: 'busy', retryable: true, admission });
    expect(TaskDeclinePayloadSchema.parse({ ...sealedDecline, admission })).toEqual({ ...sealedDecline, admission });
  });

  it('caps each duration at seven days', () => {
    expect(OFFER_ADMISSION_MAX_DURATION_MS).toBe(604_800_000);
    expect(OfferAdmissionTimingsSchema.parse({ totalMs: OFFER_ADMISSION_MAX_DURATION_MS })).toEqual({ totalMs: OFFER_ADMISSION_MAX_DURATION_MS });
  });

  it.each([
    ['no totalMs', { agentHomeWaitMs: 1 }],
    ['a negative duration', { totalMs: -1 }],
    ['a fractional duration', { totalMs: 1.5 }],
    ['an over-cap total', { totalMs: OFFER_ADMISSION_MAX_DURATION_MS + 1 }],
    ['an over-cap phase', { totalMs: 1, toolsetProbeMs: OFFER_ADMISSION_MAX_DURATION_MS + 1 }],
    ['an unknown phase', { totalMs: 1, sealedOpenMs: 1 }],
  ])('rejects %s', (_label, admission) => {
    expect(OfferAdmissionTimingsSchema.safeParse(admission).success).toBe(false);
    expect(TaskClaimPayloadSchema.safeParse({ deviceId: 'device-1', admission }).success).toBe(false);
    expect(TaskDeclinePayloadSchema.safeParse({ reason: 'busy', admission }).success).toBe(false);
  });
});
