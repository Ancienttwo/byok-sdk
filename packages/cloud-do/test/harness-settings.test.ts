import { describe, expect, it } from 'vitest';
import { CLOUD_HARNESS_SETTINGS } from '../src/session-runtime';

describe('cloud Harness settings', () => {
  it('never parks a task that evictions or crashes cut off, as with Pi 1.3', () => {
    expect(CLOUD_HARNESS_SETTINGS.restartLimit).toBe(Infinity);
  });
});
