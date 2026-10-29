/**
 * The Claude Code release that the runtime contract suite qualifies in PR CI
 * (#1103). Claude Code is the user's own install; the adapter reads its
 * version and does not gate on it, and has no unqualified-version advisory.
 * The nightly contract run checks the latest release against the same suite.
 */
export const QUALIFIED_CLAUDE_VERSION = '2.1.312';
