import type { PermissionPolicy } from '@byok-sdk/protocol';
import { BYOK_PI_READONLY_PARENT_TOOLS } from './subagents-policy-config';

export interface PiPermissionMapping {
  ok: boolean;
  /** CLI args to append to `pi --mode rpc ...`. Only meaningful when `ok` is true. */
  args: string[];
  /** Present when `ok` is false. */
  reason?: string;
}

/** Pi read-only built-ins plus SDK-contained planning/delegation tools. */
const READONLY_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls', ...BYOK_PI_READONLY_PARENT_TOOLS];

/**
 * Map an effective {@link PermissionPolicy} to `pi --mode rpc` CLI args,
 * fail-closed against the exact pi 0.84.2 CLI contract:
 *
 * - `auto` / `readonly` are expressible via `--tools` / `--no-tools`.
 * - `confirm` and `plan` are NOT expressible: pi ships no built-in per-call
 *   approval gate and explicitly "skips ... plan mode" (README); both exist
 *   only as example third-party extensions (`examples/extensions/
 *   permission-gate.ts`, `examples/extensions/plan-mode/`), which is
 *   out-of-scope, speculative surface for M0.
 * - `network: false` is NOT expressible: pi has no network sandbox for its
 *   bash tool ("Pi does not include a built-in sandbox" — docs/security.md).
 *   `network: true` or unset proceeds, since nothing needs enforcing then.
 *
 * Workspace confinement is NOT a pi flag — the caller spawns pi with
 * `cwd: ctx.workspaceDir`, the daemon-created per-task directory.
 *
 * - `--tools` is an allowlist and `--exclude-tools` is a denylist. Passing
 *   both lets pi remain the authority for its active tool registry instead
 *   of duplicating pi's default tool list in this adapter.
 */
export function mapPermissionPolicyToPiArgs(policy: PermissionPolicy): PiPermissionMapping {
  if (policy.network === false) {
    return {
      ok: false,
      args: [],
      reason: 'policy requires network:false, which the pi adapter cannot enforce (pi has no network sandbox)',
    };
  }

  if (policy.mode === 'confirm' || policy.mode === 'plan') {
    return {
      ok: false,
      args: [],
      reason: `pi adapter cannot express permission mode "${policy.mode}" (no built-in per-call approval gate or plan-only mode without a custom extension)`,
    };
  }

  const denyTools = policy.denyTools ?? [];

  if (policy.mode === 'readonly') {
    const base = policy.allowTools ? policy.allowTools.filter((tool) => READONLY_TOOLS.includes(tool)) : [...READONLY_TOOLS];
    // Never fall through to an absent `--tools` flag here — that would run
    // pi's full default toolset, silently widening a readonly request.
    if (base.length === 0) return { ok: true, args: ['--no-tools'] };
    return {
      ok: true,
      args: ['--tools', base.join(','), ...(denyTools.length > 0 ? ['--exclude-tools', denyTools.join(',')] : [])],
    };
  }

  const args: string[] = [];
  if (policy.allowTools && policy.allowTools.length > 0) {
    args.push('--tools', policy.allowTools.join(','));
  }
  if (denyTools.length > 0) args.push('--exclude-tools', denyTools.join(','));

  return { ok: true, args };
}
