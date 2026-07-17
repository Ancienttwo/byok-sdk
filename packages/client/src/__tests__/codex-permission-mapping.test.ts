import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@byok/protocol';
import { mapPermissionPolicyToCodexArgs } from '../adapters/codex/permission-mapping';

describe('mapPermissionPolicyToCodexArgs', () => {
  it('auto maps to workspace-write sandbox + approval_policy=never', () => {
    const result = mapPermissionPolicyToCodexArgs({ mode: 'auto' });
    expect(result).toEqual({ ok: true, args: ['-c', 'sandbox_mode=workspace-write', '-c', 'approval_policy=never'] });
  });

  it('readonly maps to read-only sandbox + approval_policy=never', () => {
    const result = mapPermissionPolicyToCodexArgs({ mode: 'readonly' });
    expect(result).toEqual({ ok: true, args: ['-c', 'sandbox_mode=read-only', '-c', 'approval_policy=never'] });
  });

  // `-a`/`--ask-for-approval` is documented in `codex exec --help` yet
  // rejected outright by the real arg parser ("unexpected argument") — this
  // adapter must never even consider selecting it, for any mode. Confirmed
  // against the real installed codex-cli 0.144.5.
  it.each(['confirm', 'plan'] as const)('fails closed on mode "%s" (no interactive approval channel on codex exec)', (mode) => {
    const policy: PermissionPolicy = { mode };
    const result = mapPermissionPolicyToCodexArgs(policy);
    expect(result.ok).toBe(false);
    // No args at all — in particular, never the broken -a/--ask-for-approval
    // flag (mentioning it BY NAME in the human-readable `reason` as context
    // for why the mode is rejected is fine and intentional; it's the args
    // array — what's actually handed to argv — that must never contain it).
    expect(result.args).toEqual([]);
    expect(result.reason).toMatch(new RegExp(mode));
  });

  it('fails closed on network:true (network_access override empirically did not restore real network access)', () => {
    const result = mapPermissionPolicyToCodexArgs({ mode: 'auto', network: true });
    expect(result.ok).toBe(false);
    expect(result.args).toEqual([]);
    expect(result.reason).toMatch(/network/i);
  });

  it('proceeds when network is false or unset (both sandbox modes have no network by default — nothing to enforce)', () => {
    expect(mapPermissionPolicyToCodexArgs({ mode: 'auto', network: false }).ok).toBe(true);
    expect(mapPermissionPolicyToCodexArgs({ mode: 'auto' }).ok).toBe(true);
    expect(mapPermissionPolicyToCodexArgs({ mode: 'readonly', network: false }).ok).toBe(true);
  });

  it('fails closed on a non-empty allowTools (no verified per-tool allow surface)', () => {
    const result = mapPermissionPolicyToCodexArgs({ mode: 'auto', allowTools: ['bash'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/allowTools|denyTools/);
  });

  it('fails closed on a non-empty denyTools (no verified per-tool deny surface)', () => {
    const result = mapPermissionPolicyToCodexArgs({ mode: 'readonly', denyTools: ['read'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/allowTools|denyTools/);
  });

  it('an empty allowTools/denyTools array behaves exactly like neither being set', () => {
    expect(mapPermissionPolicyToCodexArgs({ mode: 'auto', allowTools: [], denyTools: [] })).toEqual({
      ok: true,
      args: ['-c', 'sandbox_mode=workspace-write', '-c', 'approval_policy=never'],
    });
  });

  it('never uses -s/--sandbox or -a/--ask-for-approval — only -c config overrides (the only mechanism confirmed to work identically on both a fresh `codex exec` and `codex exec resume`)', () => {
    for (const mode of ['auto', 'readonly'] as const) {
      const result = mapPermissionPolicyToCodexArgs({ mode });
      expect(result.args).not.toContain('-s');
      expect(result.args).not.toContain('--sandbox');
      expect(result.args).not.toContain('-a');
      expect(result.args).not.toContain('--ask-for-approval');
      expect(result.args[0]).toBe('-c');
    }
  });
});
