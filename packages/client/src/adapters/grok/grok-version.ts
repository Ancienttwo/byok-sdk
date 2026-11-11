import type { RuntimeVersionPolicy } from '../../types.js';

/**
 * Grok version policy, as for Codex: the version is read, never gated by
 * default. Grok updates itself, so another version is an advisory. 1.0.77 is
 * the newest stable release at qualification (npm `latest`), at or above the
 * 1.0.70 that gates Grok's own turns, and the version of OAR 0.99's
 * native-turn wire evidence. The runtime contract runs on it, its own-turn
 * case included (docs/adapter-capabilities.md, Grok).
 */
export const QUALIFIED_GROK_VERSION = '1.0.77';

/** The adapter's default policy (#1103). A block is Host-only, so none is declared here. */
export const GROK_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_GROK_VERSION,
  unqualified: 'warn',
});

/** The normalized token the policy matches: `grok 1.0.62 (1474f9cbdd91)` -> `1.0.62`. */
export function grokVersionToken(output: string): string {
  return /^grok\s+(\S+)/.exec(output.trim())?.[1] ?? output.trim();
}
