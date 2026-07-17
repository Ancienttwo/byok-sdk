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
 * pi's real default active built-in tool set when no `--tools`/`--no-tools`
 * flag is given at all — confirmed against the installed CLI's own source
 * (`defaultActiveToolNames` in `dist/core/sdk.js`, 0.74.2), not inferred.
 * Used only to compute an equivalent `--tools` allowlist for `denyTools`
 * (see the second self-discovered finding in the doc comment below) — a
 * policy with no `allowTools`/`denyTools` at all still emits no args, same
 * as always, so this constant never changes that common-case behavior.
 */
const DEFAULT_ACTIVE_TOOLS: readonly string[] = ['read', 'bash', 'edit', 'write'];

/**
 * Map an effective {@link PermissionPolicy} to `pi --mode rpc` CLI args,
 * fail-closed. Empirically grounded (see the M0-3 report):
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
 * SECOND SELF-DISCOVERED FINDING, same class as the pi-adapter.ts
 * `--session-id` bug (this task, while hardening argv validation):
 * `--exclude-tools` — what `denyTools` used to map to — is ALSO not a real
 * pi CLI flag. Confirmed against real pi 0.74.2: `pi --mode rpc
 * --exclude-tools bash` → `Error: Unknown option: --exclude-tools`, exit
 * code 1, before any model call — and it's absent from both `pi --help`'s
 * own listing and the CLI's actual arg parser (`dist/cli/args.js`), which
 * recognizes only `--tools`/`-t`, `--no-tools`/`-nt`, `--no-builtin-tools`/
 * `-nbt` for tool control. This crashed EVERY real pi invocation for any
 * policy with a non-empty `denyTools`, unconditionally — never caught by
 * this repo's own test suite for the exact same reason as the
 * `--session-id` bug (`fake-pi.mjs` never validated argv; fixed alongside
 * this change). pi has no "start from the default set, minus these" flag at
 * all — `--tools` always REPLACES the active set wholesale — so `denyTools`
 * is now resolved to an equivalent allowlist in-process: readonly mode
 * intersects with `READONLY_TOOLS` (as before), any other mode starts from
 * an explicit `allowTools` or pi's own `DEFAULT_ACTIVE_TOOLS`, and
 * `denyTools` is subtracted from that resolved set before it's ever handed
 * to pi as a single `--tools`/`--no-tools` pair of args.
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
    const effective = subtractDenied(base, denyTools);
    // Never fall through to an absent `--tools` flag here — that would run
    // pi's full default toolset, silently widening a readonly request.
    return { ok: true, args: effective.length === 0 ? ['--no-tools'] : ['--tools', effective.join(',')] };
  }

  if (denyTools.length > 0) {
    const base = policy.allowTools && policy.allowTools.length > 0 ? policy.allowTools : [...DEFAULT_ACTIVE_TOOLS];
    const effective = subtractDenied(base, denyTools);
    // Same reasoning as readonly above: an empty result must be an explicit
    // `--no-tools`, never a silently-widening absent flag.
    return { ok: true, args: effective.length === 0 ? ['--no-tools'] : ['--tools', effective.join(',')] };
  }

  if (policy.allowTools && policy.allowTools.length > 0) {
    return { ok: true, args: ['--tools', policy.allowTools.join(',')] };
  }

  return { ok: true, args: [] };
}

function subtractDenied(tools: readonly string[], denyTools: readonly string[]): string[] {
  const denied = new Set(denyTools);
  return tools.filter((tool) => !denied.has(tool));
}
