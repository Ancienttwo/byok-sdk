import type { ToolAuthorizationGate, ToolAuthorizationHomeAccess, ToolAuthorizationLane } from './tool-authorization';
import type { FileScopeGrant } from './file-scope-guard';
import type { ScopedFileDenial } from './file-scope-tools';

/**
 * The internal companion of one per-task auto gate. The daemon resolves the
 * file-scope grant before claim and binds it here; the adapter reads it to
 * write the digest-bound Pi launch config, and the gate IPC server reads the
 * audit sink. This is deliberately not part of the public
 * `ToolAuthorizationGate` type: the grant never becomes wire or package API.
 */
export interface FileScopeGateBinding {
  readonly grant: FileScopeGrant;
  readonly taskId: string;
  readonly lane: ToolAuthorizationLane;
  readonly homeAccess: ToolAuthorizationHomeAccess;
  /** Called once per denied scoped-tool call; allow is never reported. */
  readonly onDeny: (denial: ScopedFileDenial) => void;
}

const bindings = new WeakMap<ToolAuthorizationGate, FileScopeGateBinding>();

export function bindFileScopeGate(gate: ToolAuthorizationGate, binding: FileScopeGateBinding): void {
  bindings.set(gate, Object.freeze({ ...binding }));
}

export function fileScopeGateBinding(gate: ToolAuthorizationGate): FileScopeGateBinding | undefined {
  return bindings.get(gate);
}
