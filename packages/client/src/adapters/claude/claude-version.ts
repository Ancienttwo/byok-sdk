import type { RuntimeVersionPolicy } from '../../types';

/**
 * The Claude Code release that the runtime contract suite qualifies in PR CI
 * (#1103). Claude Code is the user's own install; the adapter reads its
 * version and does not gate on it, and has no unqualified-version advisory.
 * The nightly contract run checks the latest release against the same suite.
 */
export const QUALIFIED_CLAUDE_VERSION = '2.1.312';

/** The adapter's default policy (#1103): read the version, never warn or block by default. */
export const CLAUDE_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_CLAUDE_VERSION,
  unqualified: 'allow',
});

/** The normalized token the policy matches: `2.1.312 (Claude Code)` -> `2.1.312`. */
export function claudeVersionToken(output: string): string {
  return /^(\S+)/.exec(output.trim())?.[1] ?? output.trim();
}
