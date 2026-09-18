import type { PermissionPolicy } from '@byok-sdk/protocol';
import type { McpToolsetGrant } from '../mcp-tool-grants';
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
 *
 * ## Reserved grants: a name inside the allowlist, because the allowlist IS
 * ## the registry (#180)
 *
 * `resolveReservedMcpToolGrants` decides WHICH reserved tools a task may
 * call; this mapper decides how pi hears about it. Pi's `--tools` flag is
 * not a permission pre-grant the way claude's `--allowedTools` is — it is a
 * registry allowlist over builtin AND extension-registered tools alike (the
 * fork's `_refreshToolRegistry` drops every tool the list does not name),
 * and the SDK's MCP extension registers the reserved helpers under their
 * bare protocol names (`send_agent_message`, `memory_save`). So a reserved
 * grant a projected `byokagentmessage` server implies is inexpressible
 * UNLESS its bare name rides whatever allowlist this mapper emits; the same
 * task under codex/claude is granted the identical tool from the identical
 * table. The names never come from `policy.allowTools`: a reserved lane is
 * admitted by the offer's server projection, and routing it through
 * `allowTools` would make the grant depend on an operator list the reserved
 * protocol cannot see. When NO allowlist is emitted (`auto` without
 * `allowTools`), none is invented for the reserved lane either: pi's
 * undefined allowlist admits every extension tool, the reserved one
 * included, and a list naming only the reserved names would cage pi's
 * native default registry. `denyTools` still wins on top of everything: it
 * travels as `--exclude-tools`, and pi's exclusion filter applies after the
 * allowlist, so an operator denial of a reserved tool name keeps its force.
 */
export function mapPermissionPolicyToPiArgs(
  policy: PermissionPolicy,
  reservedGrants: readonly McpToolsetGrant[] = [],
): PiPermissionMapping {
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
  // Bare names in the table's own server order: the extension registers the
  // reserved helpers under exactly these strings, so the allowlist and the
  // registry agree by construction rather than by a rename happening to line
  // up. Deduplicated against the native list below — an operator who names a
  // reserved tool in `allowTools` gets one entry, not two.
  const grantedReserved = [...new Set(reservedGrants.flatMap((grant) => [...grant.tools]))];

  if (policy.mode === 'readonly') {
    const base = policy.allowTools ? policy.allowTools.filter((tool) => READONLY_TOOLS.includes(tool)) : [...READONLY_TOOLS];
    // The reserved lane joins the readonly base rather than waiting on
    // pi's new-registry-name activation (the `--no-tools` path): readonly
    // with an emptied native list and a projected message server emits
    // `--tools send_agent_message`, which keeps every native off and the
    // granted lane on, explicitly.
    const allowed = [...base, ...grantedReserved.filter((tool) => !base.includes(tool))];
    // Never fall through to an absent `--tools` flag here — that would run
    // pi's full default toolset, silently widening a readonly request.
    if (allowed.length === 0) return { ok: true, args: ['--no-tools'] };
    return {
      ok: true,
      args: ['--tools', allowed.join(','), ...(denyTools.length > 0 ? ['--exclude-tools', denyTools.join(',')] : [])],
    };
  }

  const args: string[] = [];
  if (policy.allowTools && policy.allowTools.length > 0) {
    args.push('--tools', [...new Set([...policy.allowTools, ...grantedReserved])].join(','));
  }
  if (denyTools.length > 0) args.push('--exclude-tools', denyTools.join(','));

  return { ok: true, args };
}

/**
 * The SAME policy decision as {@link mapPermissionPolicyToPiArgs}, resolved to
 * concrete tool NAMES instead of CLI flags.
 *
 * The prepared launch entry (`./prepared-tools.ts`) runs pi in-process and must
 * hand `createPreparedAgentSession` an explicit, complete tool array: there is
 * no `--tools` flag for pi to interpret and no default registry for it to fall
 * back to. Resolving the same allow/deny arithmetic a second time inside that
 * entry would be a second opinion about one policy, so it is resolved here,
 * beside the flag mapping it must agree with.
 *
 * The ONE case that cannot be resolved to names is `auto` with no `allowTools`:
 * on the CLI path that deliberately emits no `--tools` flag so PI stays the
 * authority on its own default set. Naming that set here would copy pi's
 * default registry into this package, where it would silently rot against the
 * next fork bump — so it is refused instead, by name.
 *
 * Reserved grants are deliberately NOT threaded in: this resolves the NATIVE
 * tool set a prepared session binds, and a reserved helper's tools are
 * registered by the extension from its own config, never counted as natives.
 */
export type PiNativeToolSelection =
  | {
    readonly ok: true;
    /** Model-visible native tool names, deduplicated, in the policy's own order. */
    readonly names: readonly string[];
  }
  | {
    readonly ok: false;
    /** Why the policy has no nameable native tool set. */
    readonly reason: string;
  };

export function resolvePiNativeToolSelection(policy: PermissionPolicy): PiNativeToolSelection {
  const mapping = mapPermissionPolicyToPiArgs(policy);
  if (!mapping.ok) return { ok: false, reason: mapping.reason ?? 'policy rejected by pi adapter' };
  const denied = new Set(policy.denyTools ?? []);
  if (policy.mode === 'readonly') {
    const base = policy.allowTools
      ? policy.allowTools.filter((tool) => READONLY_TOOLS.includes(tool))
      : [...READONLY_TOOLS];
    return { ok: true, names: Object.freeze([...new Set(base)].filter((tool) => !denied.has(tool))) };
  }
  if (policy.allowTools === undefined || policy.allowTools.length === 0) {
    return {
      ok: false,
      reason: 'permission mode "auto" without an explicit allowTools list leaves the tool set to pi\'s own'
        + ' default registry, which an in-process prepared session cannot enumerate without copying it',
    };
  }
  return { ok: true, names: Object.freeze([...new Set(policy.allowTools)].filter((tool) => !denied.has(tool))) };
}
