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

  // `--exclude-tools` is NOT a real pi CLI flag — confirmed against the
  // installed pi 0.74.2 binary (`Error: Unknown option: --exclude-tools`,
  // exit code 1, before any model call) and its own `dist/cli/args.js`
  // parser, which recognizes only `--tools`/`-t`, `--no-tools`/`-nt`,
  // `--no-builtin-tools`/`-nbt` for tool control. This is a second,
  // self-discovered instance of the exact same bug class as the
  // `--session-id` finding this task's live GLM run root-caused: it crashed
  // every real pi invocation for any policy with a non-empty `denyTools`,
  // unconditionally, and (like `--session-id`) was never caught by this
  // repo's test suite because `fake-pi.mjs` never validated argv. Fixed by
  // resolving `denyTools` to an equivalent `--tools` allowlist in-process
  // (pi has no "default set minus these" flag — `--tools` always replaces
  // the active set wholesale).
  it('denyTools resolves to an equivalent --tools allowlist (pi\'s real default active set minus the denied names), never --exclude-tools', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', denyTools: ['bash'] });
    expect(result.ok).toBe(true);
    // pi's real default active tools (confirmed against dist/core/sdk.js's
    // own `defaultActiveToolNames`): read, bash, edit, write — minus bash.
    expect(result.args).toEqual(['--tools', 'read,edit,write']);
  });

  it('denyTools subtracts from an explicit allowTools instead of the default set, when both are given', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', allowTools: ['bash', 'edit'], denyTools: ['edit'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'bash']);
  });

  it('denyTools that removes every candidate tool falls back to --no-tools, never an absent flag', () => {
    const result = mapPermissionPolicyToPiArgs({
      mode: 'auto',
      allowTools: ['bash'],
      denyTools: ['bash'],
    });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--no-tools']);
  });

  it('readonly + denyTools intersects with the readonly set first, then subtracts the denied names', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'readonly', denyTools: ['read'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'grep,find,ls']);
  });

  it('an empty denyTools array behaves exactly like no denyTools at all', () => {
    expect(mapPermissionPolicyToPiArgs({ mode: 'auto', denyTools: [] })).toEqual({ ok: true, args: [] });
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
