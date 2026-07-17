import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@byok/protocol';
import { mapPermissionPolicyToClaudeArgs } from '../adapters/claude/permission-mapping';

describe('mapPermissionPolicyToClaudeArgs', () => {
  it('auto with no restrictions maps to acceptEdits, empirically confirmed to auto-accept both Write and Bash', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'auto' });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'acceptEdits'] });
  });

  it('auto with allowTools adds a --tools restriction on top of acceptEdits', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'auto', allowTools: ['Bash', 'Read'] });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'acceptEdits', '--tools', 'Bash,Read'] });
  });

  it('readonly with no allowTools maps to the default readonly tool set via the replacive --tools flag, never --allowedTools', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'readonly' });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'default', '--tools', 'Read,Glob,Grep'] });
  });

  it('readonly intersects a caller-provided allowTools with the readonly set', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'readonly', allowTools: ['Read', 'Bash'] });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'default', '--tools', 'Read'] });
  });

  it('readonly falls back to an explicit empty --tools "" when allowTools has no overlap with the readonly set (never an absent flag, which would silently widen to the full active set)', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'readonly', allowTools: ['Bash', 'Write'] });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'default', '--tools', ''] });
  });

  it('readonly subtracts denyTools from the intersected set (default-mode + explicit --tools is the one regime this mapper trusts denyTools within)', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'readonly', denyTools: ['Read'] });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'default', '--tools', 'Glob,Grep'] });
  });

  it('readonly + denyTools removing everything falls back to explicit --tools ""', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'readonly', allowTools: ['Read'], denyTools: ['Read'] });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'default', '--tools', ''] });
  });

  it('an empty denyTools array behaves exactly like no denyTools at all', () => {
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'auto', denyTools: [] })).toEqual({
      ok: true,
      args: ['--permission-mode', 'acceptEdits'],
    });
  });

  it('fails closed on mode "confirm": claude\'s headless approval model resolves synchronously, with nothing to pause on', () => {
    const policy: PermissionPolicy = { mode: 'confirm' };
    const result = mapPermissionPolicyToClaudeArgs(policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/confirm/);
    expect(result.reason).toMatch(/synchronously/);
  });

  it('fails closed on network:false (claude has no network sandbox for its Bash tool either)', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'auto', network: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/network/i);
  });

  it('proceeds when network is true or unset', () => {
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'auto', network: true }).ok).toBe(true);
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'auto' }).ok).toBe(true);
  });

  // Central, empirically-discovered finding this mapper exists specifically
  // to avoid: --allowedTools/--disallowedTools do NOT reliably restrict
  // anything once a permissive --permission-mode is also in effect (a
  // denied tool is trivially bypassed via Bash), so `auto` + denyTools has
  // no mechanism this mapper trusts — it fails closed rather than emit an
  // arg combination that looks restrictive but empirically isn't.
  it('fails closed on denyTools under auto mode (no reliable subtractive tool-restriction mechanism exists for a permissive base)', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'auto', denyTools: ['Bash'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/denyTools/);
    expect(result.args).toEqual([]);
  });

  it('fails closed on denyTools under plan mode too (shares auto\'s tool-restriction branch)', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'plan', denyTools: ['Bash'] });
    expect(result.ok).toBe(false);
  });

  it('plan mode maps to --permission-mode plan, empirically confirmed to never execute a mutating call against the real target', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'plan' });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'plan'] });
  });

  it('plan mode with allowTools restricts the offered tool set the same way auto does', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'plan', allowTools: ['Read'] });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'plan', '--tools', 'Read'] });
  });
});
