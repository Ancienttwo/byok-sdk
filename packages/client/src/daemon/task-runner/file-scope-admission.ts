import type { ToolAuthorizationHomeAccess, ToolAuthorizationLane } from '../../tool-authorization';
import type { RuntimeAdapterDescriptor } from '../../types';

/**
 * The local support matrix of the explicit file-scope policy (#1061 slice 1,
 * D10/D14). The policy is admitted per offer: the adapter declares the lanes
 * it can enforce a scope on (`RuntimeAdapterDescriptor.fileScope`), and every
 * other combination declines before claim with `file_scope_unsupported`
 * instead of running the task without the scope. Only Pi declares lanes
 * (ordinary RPC, prepared and durable), and only darwin/linux can carry one.
 *
 * This is deliberately local admission, not a wire capability: v1 adds no
 * RuntimeCapabilities field and the Host cannot see the matrix before
 * dispatch (docs/adr/ADR-043-explicit-file-scope.md, section 4.1).
 */
export interface FileScopeAdmissionFacts {
  readonly descriptor: Pick<RuntimeAdapterDescriptor, 'id' | 'fileScope'>;
  readonly lane: ToolAuthorizationLane;
  readonly homeAccess: ToolAuthorizationHomeAccess;
  /** Defaults to `process.platform`; injectable so tests can prove the Windows refusal. */
  readonly platform?: NodeJS.Platform;
}

export type FileScopeAdmission =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

/** Why a lane the adapter did not declare cannot carry a scope. */
const UNDECLARED_LANE_REASONS: Readonly<Record<ToolAuthorizationLane, string>> = {
  rpc: 'the ordinary lane of this runtime has no validated file-scope authority',
  prepared: 'the prepared lane of this runtime has no validated file-scope authority',
  durable: 'the durable lane of this runtime has no validated file-scope authority',
};

/** Whether the configured scope can be enforced for this offer, and why not when it cannot. */
export function fileScopeAdmission(facts: FileScopeAdmissionFacts): FileScopeAdmission {
  const platform = facts.platform ?? process.platform;
  if (facts.homeAccess === 'memory-reader') {
    return { supported: false, reason: 'memory-reader offers have no file-scope authority in this release' };
  }
  if (facts.descriptor.fileScope === undefined) {
    return { supported: false, reason: `runtime ${facts.descriptor.id} cannot enforce a file scope; only Pi supports one` };
  }
  if (!facts.descriptor.fileScope.lanes.includes(facts.lane)) {
    return { supported: false, reason: UNDECLARED_LANE_REASONS[facts.lane] };
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    return { supported: false, reason: `file-scope policies are not supported on ${platform}` };
  }
  return { supported: true };
}
