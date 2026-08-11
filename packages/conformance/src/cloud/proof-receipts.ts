import { describe, expect, it } from 'vitest';
import { TENANT_A } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

const FIRST = {
  deviceId: 'device-a',
  requestId: 'request-1',
  operation: 'truth.write',
  resource: 'memory/profile',
  bodySha256: `sha256:${'a'.repeat(64)}`,
  bodySize: 7n,
  responseStatus: 200,
  responseBody: '{"rev":1}',
} as const;

export function runProofReceiptConformance(factory: CloudCompositionFactory): void {
  describe('proof request receipts', () => {
    it('records the first result and returns it unchanged on replay', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const first = await stores.proofReceipts.record(TENANT_A, FIRST);
        expect(first.created).toBe(true);
        expect(first.receipt).toMatchObject(FIRST);

        const replay = await stores.proofReceipts.record(TENANT_A, {
          ...FIRST,
          operation: 'different',
          responseBody: 'different',
        });
        expect(replay.created).toBe(false);
        expect(replay.receipt).toEqual(first.receipt);
      });
    });

    it('scopes the same request id by device', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const left = await stores.proofReceipts.record(TENANT_A, FIRST);
        const right = await stores.proofReceipts.record(TENANT_A, {
          ...FIRST,
          deviceId: 'device-b',
          responseBody: '{"rev":2}',
        });
        expect(left.created).toBe(true);
        expect(right.created).toBe(true);
        expect(
          await stores.proofReceipts.get(TENANT_A, 'device-b', FIRST.requestId),
        ).toEqual(right.receipt);
      });
    });
  });
}
