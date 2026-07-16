import type { PermissionMode, PermissionPolicy } from '@byok/protocol';

/**
 * Permissiveness ranking used only to compare an offered policy against the
 * device operator's configured ceiling (`permissionDefaults`). The wire
 * protocol doesn't define an ordering for `PermissionMode`, so this is a
 * judgment call: `plan` produces no side effects (safest), `readonly` allows
 * autonomous but non-mutating tools, `confirm` allows anything but gates each
 * action on a human, `auto` allows anything with no gate at all (most
 * latitude without a human in the loop).
 */
const MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  readonly: 1,
  confirm: 2,
  auto: 3,
};

export interface PolicyDecision {
  ok: boolean;
  /** The merged, effective policy. Only meaningful when `ok` is true. */
  policy: PermissionPolicy;
  /** Present when `ok` is false. */
  reason?: string;
}

function intersectOptional(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  const bSet = new Set(b);
  return a.filter((tool) => bSet.has(tool));
}

function unionOptional(a: string[] | undefined, b: string[] | undefined): string[] {
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

/**
 * `network` merge: an explicit `false` on either side wins (it's a request
 * to restrict that nothing here should silently overrule); otherwise an
 * explicit `true` on either side wins; if neither side expressed an opinion
 * the result is `undefined`; and it's left to the adapter mapping to decide
 * what "unspecified" defaults to for that runtime.
 */
function mergeNetwork(offered: boolean | undefined, ceiling: boolean | undefined): boolean | undefined {
  if (offered === false || ceiling === false) return false;
  if (offered === true || ceiling === true) return true;
  return undefined;
}

/**
 * Merge an offered task policy against the daemon operator's configured
 * ceiling, fail-closed. This is a runtime-agnostic safety gate independent
 * of whether the eventually-chosen adapter can even express the result — see
 * each adapter's own permission mapping for that second, adapter-specific
 * gate (e.g. `mapPermissionPolicyToPiArgs`).
 */
export function computeEffectivePolicy(
  offered: PermissionPolicy,
  ceiling: PermissionPolicy | undefined,
): PolicyDecision {
  if (!ceiling) {
    return { ok: true, policy: offered };
  }

  if (MODE_RANK[offered.mode] > MODE_RANK[ceiling.mode]) {
    return {
      ok: false,
      policy: offered,
      reason: `offered policy mode "${offered.mode}" exceeds this device's configured ceiling "${ceiling.mode}"`,
    };
  }

  const allowTools = intersectOptional(offered.allowTools, ceiling.allowTools);
  const denyTools = unionOptional(offered.denyTools, ceiling.denyTools);
  const network = mergeNetwork(offered.network, ceiling.network);
  const workspaceRoot = offered.workspaceRoot ?? ceiling.workspaceRoot;

  return {
    ok: true,
    policy: {
      mode: offered.mode,
      ...(allowTools ? { allowTools } : {}),
      ...(denyTools.length > 0 ? { denyTools } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      ...(network !== undefined ? { network } : {}),
    },
  };
}
