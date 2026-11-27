interface OarRuntimeIds {
  readonly runtime: string;
  readonly qualification: Readonly<Record<string, string>>;
}

// SDK adapter IDs map to OAR manifest IDs and the CLI pins used in qualification.
export const OAR_RUNTIME_IDS: ReadonlyMap<string, OarRuntimeIds> = new Map<string, OarRuntimeIds>([
  ['claude', { runtime: 'claude', qualification: { 'claude-aimock': 'claude' } }],
  ['codex', { runtime: 'codex', qualification: { 'codex-aimock': 'codex' } }],
  ['agy', { runtime: 'antigravity', qualification: { 'antigravity-aimock': 'agy' } }],
  ['grok', { runtime: 'grok', qualification: { 'grok-aimock': 'grok' } }],
  ['dsh', { runtime: 'dsh', qualification: { 'dsh-aimock': 'dsh' } }],
  ['pi', { runtime: 'pi', qualification: { 'pi-rpc-minimum': 'pi' } }],
  // One adapter, two independently qualified native lines.
  ['opencode', { runtime: 'opencode', qualification: { 'opencode-aimock': 'opencode1', 'opencode-cleanup': 'opencode2' } }],
]);
