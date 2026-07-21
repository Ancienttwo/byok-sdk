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

  it('M4 Phase 3: mode "confirm" is supported — deny-by-default --permission-mode default, plus a flag telling start() to wire the approval-mcp channel (the actual --permission-prompt-tool/--mcp-config flags are appended by start() itself, not here — see needsApprovalMcp\'s own doc comment)', () => {
    const policy: PermissionPolicy = { mode: 'confirm' };
    const result = mapPermissionPolicyToClaudeArgs(policy);
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'default'], needsApprovalMcp: true });
  });

  it('confirm mode still fails closed on network:false, same as every other mode', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'confirm', network: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/network/i);
  });

  // Finding F2 (cross-model adversarial review): the confirm branch used to
  // return unconditionally before ever looking at allowTools/denyTools,
  // silently discarding both. The four tests below pin the fixed behavior:
  // allowTools alone is honored (mirrors auto), denyTools alone fails
  // closed (mirrors auto's identical reasoning — confirm has no bounded
  // base tool list to subtract from), the combination still fails closed
  // (denyTools is inexpressible regardless of an accompanying allowTools),
  // and an inexpressible constraint (network:false) fails closed even
  // alongside an otherwise-expressible allowTools.
  it('confirm+allowTools: maps to an explicit --tools restriction, mirroring auto (finding F2 fix)', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'confirm', allowTools: ['Bash', 'Read'] });
    expect(result).toEqual({
      ok: true,
      args: ['--permission-mode', 'default', '--tools', 'Bash,Read'],
      needsApprovalMcp: true,
    });
  });

  it('confirm+denyTools: fails closed (finding F2 fix — no bounded base tool list to subtract from, same as auto)', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'confirm', denyTools: ['Bash'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/denyTools/);
    expect(result.reason).toMatch(/confirm/i);
    expect(result.args).toEqual([]);
    expect(result.needsApprovalMcp).toBeUndefined();
  });

  it('confirm+both (allowTools and denyTools together): still fails closed — denyTools is inexpressible regardless of an accompanying allowTools', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'confirm', allowTools: ['Read'], denyTools: ['Bash'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/denyTools/);
  });

  it('confirm+inexpressible: an inexpressible constraint (network:false) fails closed even alongside an otherwise-expressible allowTools', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'confirm', allowTools: ['Read'], network: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/network/i);
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
