import { describe, expect, it } from 'vitest';
import { CAPABILITY_FLAGS, PROTOCOL_VERSION, PROVIDER_PROFILE_BINDING_CAPABILITY, WIRE_ADDITIONS } from '../index';

describe('protocol version and capability flags', () => {
  it('PROTOCOL_VERSION is 5', () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });

  it('includes at least the steer and blob-upload capability flags', () => {
    expect(CAPABILITY_FLAGS).toContain('steer');
    expect(CAPABILITY_FLAGS).toContain('blob-upload');
  });

  it('has no approval flag: v4 approval targeting and task.approval_resolved are baseline', () => {
    expect(CAPABILITY_FLAGS.filter((flag) => flag.includes('approval'))).toEqual([]);
    expect(WIRE_ADDITIONS.filter((entry) => entry.kind === 'envelope' && entry.surface === 'task.approval_resolved')).toEqual([]);
  });

  it('includes the dispatch-selection correctness gate', () => {
    expect(CAPABILITY_FLAGS).toContain('dispatch-selection');
    expect(CAPABILITY_FLAGS).toContain('toolset-selection');
    expect(CAPABILITY_FLAGS).toContain(PROVIDER_PROFILE_BINDING_CAPABILITY);
  });
});
