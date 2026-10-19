import { expect, it } from 'vitest';
import { ROUTINE_HORIZON_MS } from '@byok-sdk/core';
import { WAKE_MAX_FUTURE_MS } from '../wakes/types';

it('keeps WAKE_MAX_FUTURE_MS equal to ROUTINE_HORIZON_MS (368 days)', () => {
  expect(WAKE_MAX_FUTURE_MS).toBe(ROUTINE_HORIZON_MS);
  expect(WAKE_MAX_FUTURE_MS).toBe(368 * 86_400_000);
  expect(ROUTINE_HORIZON_MS).toBe(368 * 86_400_000);
});
