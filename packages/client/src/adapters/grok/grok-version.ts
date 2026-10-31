import type { RuntimeVersionPolicy } from '../../types';

/**
 * Grok version policy, as for Codex: the version is read, never gated by
 * default. Grok updates itself, so another version is an advisory. This is the
 * newest version that OAR's live evidence covers for the vendored profile (the
 * prompt-option probe in OAR docs/runtimes/grok.md, read at OAR c264f17).
 * The vendored 044633e Grok runtime session is byte-identical upstream to
 * c264f17; the 0.80 shared ACP stack adds connection opening and input
 * draining without changing the Grok launch profile. Native contracts the
 * adapter depends on are probed directly (`agent stdio`).
 */
export const QUALIFIED_GROK_VERSION = '1.0.52';

/** The adapter's default policy (#1103). A block is Host-only, so none is declared here. */
export const GROK_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_GROK_VERSION,
  unqualified: 'warn',
});

/** The normalized token the policy matches: `grok 1.0.62 (1474f9cbdd91)` -> `1.0.62`. */
export function grokVersionToken(output: string): string {
  return /^grok\s+(\S+)/.exec(output.trim())?.[1] ?? output.trim();
}
