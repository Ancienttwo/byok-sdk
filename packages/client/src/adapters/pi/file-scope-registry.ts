/**
 * Post-creation loadout assertion for a scoped Pi session (#1061 D14/F2/R2).
 *
 * Pi 1.4.0 lets a registered extension/custom tool shadow a same-named
 * built-in, but that precedence is upstream behaviour. A scoped session is
 * only valid when the three SDK tools really are the registered definitions
 * (not `builtin:read` etc.), and when the native tools this slice does not
 * replace are absent. Failure is a pre-prompt refusal, never a degraded run.
 */
export interface PiToolSourceInfo {
  readonly path?: string;
}

export interface PiToolRegistryView {
  getAllTools(): readonly { readonly name: string; readonly sourceInfo?: PiToolSourceInfo }[];
  getActiveToolNames(): readonly string[];
}

export interface PiFileScopeRegistryExpectation {
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
}

export function assertPiFileScopeRegistry(
  session: PiToolRegistryView,
  expectation: PiFileScopeRegistryExpectation,
): void {
  const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool] as const));
  const active = new Set(session.getActiveToolNames());
  for (const name of expectation.required) {
    const tool = registered.get(name);
    if (tool === undefined) {
      throw new Error('file_scope_registry_drift: the scoped ' + name + ' tool was not registered');
    }
    if (!active.has(name)) {
      throw new Error('file_scope_registry_drift: the scoped ' + name + ' tool is not active');
    }
    if (tool.sourceInfo?.path === 'builtin:' + name) {
      throw new Error('file_scope_registry_drift: ' + name + ' is still the Pi built-in tool');
    }
  }
  for (const name of expectation.forbidden) {
    if (registered.has(name)) {
      throw new Error('file_scope_registry_drift: native ' + name + ' must not be registered in a scoped session');
    }
    if (active.has(name)) {
      throw new Error('file_scope_registry_drift: native ' + name + ' must not be active in a scoped session');
    }
  }
}
