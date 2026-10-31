import type { ToolAuthorizationHomeAccess, ToolAuthorizationLane } from '../../tool-authorization';

/**
 * The local support matrix of the explicit file-scope policy (#1061 slice 1,
 * D10/D14). The policy is admitted per offer, but v1 can only enforce it on
 * the ordinary Pi RPC lane on darwin/linux; every other combination declines
 * before claim with `file_scope_unsupported` instead of running the task
 * without the scope.
 *
 * This is deliberately local admission, not a wire capability: v1 adds no
 * RuntimeCapabilities field and the Host cannot see the matrix before
 * dispatch (docs/plans/2026-10-31-1061-explicit-file-scope.md, section 4.1).
 */
export interface FileScopeAdmissionFacts {
  readonly runtimeId: string;
  readonly lane: ToolAuthorizationLane;
  readonly homeAccess: ToolAuthorizationHomeAccess;
  /** Defaults to `process.platform`; injectable so tests can prove the Windows refusal. */
  readonly platform?: NodeJS.Platform;
}

export type FileScopeAdmission =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

/** Whether the configured scope can be enforced for this offer, and why not when it cannot. */
export function fileScopeAdmission(facts: FileScopeAdmissionFacts): FileScopeAdmission {
  const platform = facts.platform ?? process.platform;
  if (facts.homeAccess === 'memory-reader') {
    return { supported: false, reason: 'memory-reader offers have no file-scope authority in this release' };
  }
  if (facts.runtimeId !== 'pi') {
    return { supported: false, reason: `runtime ${facts.runtimeId} cannot enforce a file scope; v1 supports ordinary Pi RPC only` };
  }
  if (facts.lane === 'prepared') {
    return { supported: false, reason: 'the prepared lane has no native file tools to scope' };
  }
  if (facts.lane === 'durable') {
    return { supported: false, reason: 'the durable Pi worker has no validated file-scope authority' };
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    return { supported: false, reason: `file-scope policies are not supported on ${platform}` };
  }
  return { supported: true };
}
