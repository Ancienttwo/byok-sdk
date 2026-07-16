import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@byok/protocol';
import { computeEffectivePolicy } from '../daemon/policy';

describe('computeEffectivePolicy', () => {
  it('passes an offered policy through unchanged when there is no ceiling', () => {
    const offered: PermissionPolicy = { mode: 'auto', allowTools: ['bash'] };
    const decision = computeEffectivePolicy(offered, undefined);
    expect(decision.ok).toBe(true);
    expect(decision.policy).toEqual(offered);
  });

  it('accepts a mode within the ceiling', () => {
    const decision = computeEffectivePolicy({ mode: 'readonly' }, { mode: 'auto' });
    expect(decision.ok).toBe(true);
    expect(decision.policy.mode).toBe('readonly');
  });

  it('fails closed when the offered mode exceeds the device ceiling', () => {
    const decision = computeEffectivePolicy({ mode: 'auto' }, { mode: 'readonly' });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/exceeds/i);
  });

  it('intersects allowTools between offer and ceiling', () => {
    const decision = computeEffectivePolicy(
      { mode: 'auto', allowTools: ['bash', 'edit', 'read'] },
      { mode: 'auto', allowTools: ['read', 'edit'] },
    );
    expect(decision.ok).toBe(true);
    expect(decision.policy.allowTools).toEqual(['edit', 'read']);
  });

  it('unions denyTools between offer and ceiling', () => {
    const decision = computeEffectivePolicy(
      { mode: 'auto', denyTools: ['bash'] },
      { mode: 'auto', denyTools: ['write'] },
    );
    expect(decision.ok).toBe(true);
    expect(decision.policy.denyTools).toEqual(expect.arrayContaining(['bash', 'write']));
    expect(decision.policy.denyTools).toHaveLength(2);
  });

  it('network: an explicit false on either side wins over an explicit true', () => {
    expect(computeEffectivePolicy({ mode: 'auto', network: true }, { mode: 'auto', network: false }).policy.network).toBe(false);
    expect(computeEffectivePolicy({ mode: 'auto', network: false }, { mode: 'auto', network: true }).policy.network).toBe(false);
  });

  it('network: an explicit true wins when nothing says false', () => {
    expect(computeEffectivePolicy({ mode: 'auto', network: true }, { mode: 'auto' }).policy.network).toBe(true);
    expect(computeEffectivePolicy({ mode: 'auto' }, { mode: 'auto', network: true }).policy.network).toBe(true);
  });

  it('network: stays undefined when neither side expresses an opinion', () => {
    expect(computeEffectivePolicy({ mode: 'auto' }, { mode: 'auto' }).policy.network).toBeUndefined();
  });

  it('prefers the offered workspaceRoot, falling back to the ceiling', () => {
    expect(
      computeEffectivePolicy({ mode: 'auto', workspaceRoot: '/a' }, { mode: 'auto', workspaceRoot: '/b' }).policy
        .workspaceRoot,
    ).toBe('/a');
    expect(computeEffectivePolicy({ mode: 'auto' }, { mode: 'auto', workspaceRoot: '/b' }).policy.workspaceRoot).toBe(
      '/b',
    );
  });
});
