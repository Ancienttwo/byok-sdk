import { expect, it } from 'vitest';
import { ROUTINE_DAYS_OF_WEEK as coreDays } from '@byok-sdk/core';
import { ROUTINE_DAYS_OF_WEEK as protocolDays } from '@byok-sdk/protocol';

it('keeps core and protocol routine weekday names equal', () => {
  expect(coreDays).toEqual(protocolDays);
});
