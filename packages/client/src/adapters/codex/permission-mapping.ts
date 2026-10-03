import type { PermissionPolicy } from '@byok-sdk/protocol';
export interface CodexPermissionMapping {
  ok: boolean;
  args: string[];
  reason?: string;
}
/** YOLO-only admission over the already merged effective policy, before any runtime side effect. */
export function mapPermissionPolicyToCodexArgs(
  policy: PermissionPolicy,
): CodexPermissionMapping {
  if (policy.mode !== 'auto')
    return {
      ok: false,
      args: [],
      reason: `codex cannot enforce permission mode "${policy.mode}" under danger-full-access`,
    };
  if (policy.network === false)
    return {
      ok: false,
      args: [],
      reason: 'codex cannot enforce network:false under danger-full-access',
    };
  if (
    (policy.allowTools?.length ?? 0) > 0 ||
    (policy.denyTools?.length ?? 0) > 0
  )
    return {
      ok: false,
      args: [],
      reason:
        'codex cannot enforce allowTools/denyTools under danger-full-access',
    };
  return { ok: true, args: [] };
}
