import type { ToolAuthorizationGate, ToolAuthorizationHomeAccess, ToolAuthorizationLane } from './tool-authorization';
import type { FileScopeGrant } from './file-scope-guard';
import type { ScopedFileDenial } from './file-scope-tools';
import { SCOPED_FILE_TOOL_NAMES } from './file-scope-types';

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

/**
 * The private brand the gate's own module reads. It lives on the `authorize`
 * function because the gate object is frozen when it is returned; the function
 * is not, and it is the exact object whose decisions the brand scopes. Both
 * sides use the same registered symbol, so no module import is required.
 */
const FILE_SCOPE_GATE_MARKER = Symbol.for('byok.tool-authorization.file-scope-tools');

export function bindFileScopeGate(gate: ToolAuthorizationGate, binding: FileScopeGateBinding): void {
  bindings.set(gate, Object.freeze({ ...binding }));
  const authorize = gate.authorize as unknown as Record<symbol, unknown>;
  if (authorize[FILE_SCOPE_GATE_MARKER] === undefined) {
    Object.defineProperty(gate.authorize, FILE_SCOPE_GATE_MARKER, {
      value: SCOPED_FILE_TOOL_NAMES, enumerable: false, configurable: false, writable: false,
    });
  }
}

export function fileScopeGateBinding(gate: ToolAuthorizationGate): FileScopeGateBinding | undefined {
  return bindings.get(gate);
}
