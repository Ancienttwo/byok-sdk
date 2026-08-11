/**
 * Per-device delivery sequence conformance: starts at 1, never repeats, never
 * goes backwards, and is scoped to one (tenant, device).
 *
 * The daemon's redelivery cursor IS this number, so a repeat is not a cosmetic
 * defect: two envelopes sharing a seq make the cursor ambiguous and one of them
 * unacknowledgeable. Starting at 1 matches what a mailbox numbers its first
 * row, which is what lets the enqueue path assert the two agreed
 * (`mailbox_seq_mismatch`) instead of letting two counters drift apart.
 */
import { describe, expect, it } from 'vitest';
import { TENANT_A } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

export function runSequenceConformance(factory: CloudCompositionFactory): void {
  describe('device sequence', () => {
    it('starts at 1 and increments by one', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.sequence.next(TENANT_A, 'device-1')).toBe(1);
        expect(await stores.sequence.next(TENANT_A, 'device-1')).toBe(2);
        expect(await stores.sequence.next(TENANT_A, 'device-1')).toBe(3);
      });
    });

    it('counts each device separately', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.sequence.next(TENANT_A, 'device-1')).toBe(1);
        expect(await stores.sequence.next(TENANT_A, 'device-2')).toBe(1);
        expect(await stores.sequence.next(TENANT_A, 'device-1')).toBe(2);
      });
    });

    it('hands out no number twice under concurrent allocation', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const allocated = await Promise.all(
          Array.from({ length: 16 }, () => stores.sequence.next(TENANT_A, 'device-1')),
        );
        expect(new Set(allocated).size).toBe(16);
        expect([...allocated].sort((left, right) => left - right)).toEqual(
          Array.from({ length: 16 }, (_unused, index) => index + 1),
        );
      });
    });
  });
}
