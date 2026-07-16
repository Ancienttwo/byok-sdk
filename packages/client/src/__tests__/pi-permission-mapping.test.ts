import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@byok/protocol';
import { mapPermissionPolicyToPiArgs } from '../adapters/pi/permission-mapping';

describe('mapPermissionPolicyToPiArgs', () => {
  it('auto with no restrictions maps to no args', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto' });
    expect(result).toEqual({ ok: true, args: [] });
  });

  it('auto with allowTools maps to --tools', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', allowTools: ['bash', 'edit'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'bash,edit']);
  });

  it('readonly with no allowTools maps to the default readonly tool set', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'readonly' });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'read,grep,find,ls']);
  });

  it('readonly intersects a caller-provided allowTools with the readonly set', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'readonly', allowTools: ['read', 'bash'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'read']);
  });

  it('readonly falls back to --no-tools when allowTools has no overlap with the readonly set (never silently widens)', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'readonly', allowTools: ['bash', 'write'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--no-tools']);
  });

  it('denyTools maps to --exclude-tools in any expressible mode', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', denyTools: ['bash'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--exclude-tools', 'bash']);
  });

  it.each(['confirm', 'plan'] as const)('fails closed on mode "%s" (no built-in pi equivalent)', (mode) => {
    const policy: PermissionPolicy = { mode };
    const result = mapPermissionPolicyToPiArgs(policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(new RegExp(mode));
  });

  it('fails closed on network:false (pi has no network sandbox)', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', network: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/network/i);
  });

  it('proceeds when network is true or unset', () => {
    expect(mapPermissionPolicyToPiArgs({ mode: 'auto', network: true }).ok).toBe(true);
    expect(mapPermissionPolicyToPiArgs({ mode: 'auto' }).ok).toBe(true);
  });
});
