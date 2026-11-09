import { describe, expect, it } from 'vitest';
import { CAPABILITY_FLAGS, PROTOCOL_VERSION, PROVIDER_PROFILE_BINDING_CAPABILITY, WIRE_ADDITIONS } from '../index';

describe('protocol version and capability flags', () => {
  it('PROTOCOL_VERSION is 6', () => {
    expect(PROTOCOL_VERSION).toBe(6);
  });

  it('includes the steer flag and none of the flags v6 retired', () => {
    expect(CAPABILITY_FLAGS).toContain('steer');
    const retired = ['blob-upload', 'custom-harness', 'mailbox-read-ahead', 'terminal-projection-selection', 'runtime-unavailable-cause',
      'agent-message-draft', 'runtime-failure-class', 'runtime-quota-scope', 'resident-memory-over-limit', 'sealed-output-ciphertext-ref'];
    expect(CAPABILITY_FLAGS.filter((flag) => (retired as readonly string[]).includes(flag))).toEqual([]);
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
