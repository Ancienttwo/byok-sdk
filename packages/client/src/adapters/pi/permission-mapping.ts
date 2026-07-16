import type { PermissionPolicy } from '@byok/protocol';

export interface PiPermissionMapping {
  ok: boolean;
  /** CLI args to append to `pi --mode rpc ...`. Only meaningful when `ok` is true. */
  args: string[];
  /** Present when `ok` is false. */
  reason?: string;
}

/** pi's own read-only built-ins, per `pi --help`'s documented example: `pi --tools read,grep,find,ls -p ...`. */
const READONLY_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/**
 * Map an effective {@link PermissionPolicy} to `pi --mode rpc` CLI args,
 * fail-closed. Empirically grounded (see the M0-3 report):
 *
 * - `auto` / `readonly` are expressible via `--tools` / `--exclude-tools` /
 *   `--no-tools`.
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

  const args: string[] = [];

  if (policy.mode === 'readonly') {
    const effective = policy.allowTools
      ? policy.allowTools.filter((tool) => READONLY_TOOLS.includes(tool))
      : [...READONLY_TOOLS];
    // Never fall through to an absent `--tools` flag here — that would run
    // pi's full default toolset, silently widening a readonly request.
    args.push(...(effective.length === 0 ? ['--no-tools'] : ['--tools', effective.join(',')]));
  } else if (policy.allowTools && policy.allowTools.length > 0) {
    args.push('--tools', policy.allowTools.join(','));
  }

  if (policy.denyTools && policy.denyTools.length > 0) {
    args.push('--exclude-tools', policy.denyTools.join(','));
  }

  return { ok: true, args };
}
