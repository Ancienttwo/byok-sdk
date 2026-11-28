import { describe, expect, it } from 'vitest';
import { CAPABILITY_FLAGS, PROTOCOL_VERSION, SKILL_SELECTION_CAPABILITY, WIRE_ADDITIONS } from '../index';

describe('protocol version and capability flags', () => {
  it('PROTOCOL_VERSION is 8', () => {
    expect(PROTOCOL_VERSION).toBe(8);
  });

  it('includes none of the flags v6 and v7 retired', () => {
    const retired = ['blob-upload', 'custom-harness', 'mailbox-read-ahead', 'terminal-projection-selection', 'runtime-unavailable-cause',
      'agent-message-draft', 'runtime-failure-class', 'runtime-quota-scope', 'resident-memory-over-limit', 'sealed-output-ciphertext-ref',
      'steer', 'provider-profile-binding', 'dispatch-selection', 'task-execution-options'];
    expect(CAPABILITY_FLAGS.filter((flag) => (retired as readonly string[]).includes(flag))).toEqual([]);
  });

  it('has no approval flag: v4 approval targeting and task.approval_resolved are baseline', () => {
    expect(CAPABILITY_FLAGS.filter((flag) => flag.includes('approval'))).toEqual([]);
    expect(WIRE_ADDITIONS.filter((entry) => entry.surface === 'task.approval_resolved')).toEqual([]);
  });

  it('keeps the MCP toolset and skill selection gates', () => {
    expect(CAPABILITY_FLAGS).toContain('toolset-selection');
    expect(CAPABILITY_FLAGS).toContain(SKILL_SELECTION_CAPABILITY);
  });
});
