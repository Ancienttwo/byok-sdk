import { describe, expect, it } from 'vitest';
import { CAPABILITY_FLAGS, PROTOCOL_VERSION } from '../index';

describe('protocol version and capability flags', () => {
  it('PROTOCOL_VERSION is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('includes at least the steer and blob-upload capability flags', () => {
    expect(CAPABILITY_FLAGS).toContain('steer');
    expect(CAPABILITY_FLAGS).toContain('blob-upload');
  });

  it('includes the interactive-approval flag (RESERVED: gates routing an approval-requiring policy to a daemon)', () => {
    expect(CAPABILITY_FLAGS).toContain('interactive-approval');
  });
});
