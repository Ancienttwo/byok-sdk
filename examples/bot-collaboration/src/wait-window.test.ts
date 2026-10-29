import { expect, it } from 'vitest';
import { DEFAULT_RETRY } from '@byok-sdk/server/execution-core';
import { ROUTINE_WAIT_MS } from './routines';
import { OFFER_WAIT_MS } from './rules/sync';

// #793 D2d option A: L never retries a K8 Turn, because K4 retries only when the first delay ends inside the wait.
// H relies on that and keeps each task at generation 0. A longer K8 wait would let L retry and H would drift.
it('keeps every K8 wait window within the first K4 retry delay', () => {
  expect(OFFER_WAIT_MS).toBeLessThanOrEqual(DEFAULT_RETRY.delaysMs[0]!);
  expect(ROUTINE_WAIT_MS).toBeLessThanOrEqual(DEFAULT_RETRY.delaysMs[0]!);
});
