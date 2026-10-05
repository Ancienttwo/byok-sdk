import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@byok-sdk/protocol';
import { mapPermissionPolicyToClaudeArgs } from '../adapters/claude/permission-mapping';
import { computeEffectivePolicy } from '../daemon/policy';

describe('mapPermissionPolicyToClaudeArgs', () => {
  it('auto with no restrictions maps to acceptEdits, empirically confirmed to auto-accept both Write and Bash', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'auto' });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'acceptEdits'] });
  });

  it('auto with allowTools adds a --tools restriction on top of acceptEdits', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'auto', allowTools: ['Bash', 'Read'] });
    expect(result).toEqual({ ok: true, args: ['--permission-mode', 'acceptEdits', '--tools', 'Bash,Read'] });
  });

  it.each([
    ['auto', 'acceptEdits'],
    ['plan', 'plan'],
  ] as const)('%s with an explicit empty allowTools disables every built-in', (mode, permissionMode) => {
    expect(mapPermissionPolicyToClaudeArgs({ mode, allowTools: [] })).toEqual({
      ok: true,
      args: ['--permission-mode', permissionMode, '--tools', ''],
    });
  });

  it.each(['auto', 'plan'] as const)('%s preserves a disjoint device ceiling as zero built-ins', (mode) => {
    const decision = computeEffectivePolicy(
      { mode, allowTools: ['Bash'] },
      { mode: 'auto', allowTools: ['Read'] },
    );
    expect(decision.ok).toBe(true);
    expect(decision.policy.allowTools).toEqual([]);
    expect(mapPermissionPolicyToClaudeArgs(decision.policy)).toEqual({
      ok: true,
      args: ['--permission-mode', mode === 'auto' ? 'acceptEdits' : 'plan', '--tools', ''],
    });
  });

  it('rejects confirm with every tool restriction without preparing CLI grants', () => {
    for (const policy of [
      { mode: 'confirm' as const },
      { mode: 'confirm' as const, allowTools: ['Read'] },
      { mode: 'confirm' as const, denyTools: ['Bash'] },
      { mode: 'confirm' as const, allowTools: ['Read'], denyTools: ['Bash'] },
    ]) {
      expect(mapPermissionPolicyToClaudeArgs(policy)).toEqual({
        ok: false, args: [], reason: 'claude adapter does not support confirm mode or interactive approval',
      });
    }
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

  // Projected MCP toolset grant. Live-confirmed against claude 2.1.251: an
  // `mcp__<server>__<tool>` call is auto-denied under BOTH `default` and
  // `acceptEdits` unless the identifier is in --allowedTools, and adding it
  // leaves `--tools ""` (no built-ins) intact. See the module doc comment.
  const ECHO_GRANT = [{ server: 'saleskoprobe', tools: ['echo'] }];

  it('readonly + allowTools:[] grants exactly the observed toolset tools while --tools stays empty', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'readonly', allowTools: [] }, ECHO_GRANT);
    expect(result).toEqual({
      ok: true,
      args: ['--permission-mode', 'default', '--tools', '', '--allowedTools', 'mcp__saleskoprobe__echo'],
    });
  });

  it('readonly with no projected toolset grants nothing at all (no --allowedTools flag)', () => {
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'readonly', allowTools: [] }, [])).toEqual({
      ok: true,
      args: ['--permission-mode', 'default', '--tools', ''],
    });
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'readonly', allowTools: [] })).toEqual({
      ok: true,
      args: ['--permission-mode', 'default', '--tools', ''],
    });
  });

  it('grants every observed tool of every projected server, deterministically ordered, and nothing else', () => {
    const result = mapPermissionPolicyToClaudeArgs({ mode: 'readonly', allowTools: [] }, [
      { server: 'mail', tools: ['send', 'list'] },
      { server: 'crm', tools: ['find_leads'] },
    ]);
    expect(result.args[result.args.indexOf('--allowedTools') + 1]).toBe(
      'mcp__crm__find_leads,mcp__mail__list,mcp__mail__send',
    );
    // Never a server-scoped wildcard: that form was never verified and would
    // silently grant tools the server adds later.
    expect(result.args).not.toContain('mcp__crm');
    expect(result.args).not.toContain('mcp__mail');
  });

  it('auto takes the same grant (acceptEdits does NOT imply MCP permission — live-confirmed)', () => {
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'auto' }, ECHO_GRANT)).toEqual({
      ok: true,
      args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__saleskoprobe__echo'],
    });
  });

  it('auto with zero built-ins still grants exactly the observed MCP tools', () => {
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'auto', allowTools: [] }, [
      { server: 'mail', tools: ['send', 'list'] },
      { server: 'crm', tools: ['find_leads'] },
    ])).toEqual({
      ok: true,
      args: [
        '--permission-mode', 'acceptEdits', '--tools', '',
        '--allowedTools', 'mcp__crm__find_leads,mcp__mail__list,mcp__mail__send',
      ],
    });
  });

  it('plan with zero built-ins still withholds MCP pre-grants', () => {
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'plan', allowTools: [] }, ECHO_GRANT)).toEqual({
      ok: true,
      args: ['--permission-mode', 'plan', '--tools', ''],
    });
  });

  it('plan never pre-grants a projected toolset tool — an opaque MCP tool may mutate, which plan mode promises not to do', () => {
    expect(mapPermissionPolicyToClaudeArgs({ mode: 'plan' }, ECHO_GRANT)).toEqual({
      ok: true,
      args: ['--permission-mode', 'plan'],
    });
  });
});
