/**
 * The verified scoped-tool source that a file-scoped native Pi subagent child
 * publishes from its scope extension to its gate extension (#1061 D11).
 *
 * The two extensions are separate modules and separate bundles, so they share
 * this one process-global marker by registered symbol. The scope extension sets
 * it only after it has matched all six registered tools to the exact tool
 * definitions it created (object identity of the parameter schema), and the
 * gate extension refuses any of the six whose registered source is not that
 * exact path. A shadowing non-builtin registration, a duplicate registration,
 * or a missing scope extension therefore never passes.
 */
export interface PiSubagentScopedToolSource {
  readonly sourcePath: string;
}

const MARKER = Symbol.for('byok.pi-subagent.file-scope.tool-source');

export function setPiSubagentScopedToolSource(sourcePath: string): void {
  (globalThis as unknown as Record<symbol, unknown>)[MARKER] = Object.freeze({ sourcePath });
}

export function piSubagentScopedToolSource(): PiSubagentScopedToolSource | undefined {
  const value = (globalThis as unknown as Record<symbol, unknown>)[MARKER];
  if (value === null || typeof value !== 'object') return undefined;
  const sourcePath = (value as { readonly sourcePath?: unknown }).sourcePath;
  return typeof sourcePath === 'string' && sourcePath.length > 0 ? Object.freeze({ sourcePath }) : undefined;
}
