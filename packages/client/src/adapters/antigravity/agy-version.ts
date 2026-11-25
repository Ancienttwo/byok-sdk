import type { RuntimeVersionPolicy } from '../../types.js';

/**
 * Antigravity CLI version policy, as for Grok: the CLI updates itself on a
 * user's machine, so another version is an advisory; a block is Host-only.
 * This is the release the runtime contract suite qualified.
 */
export const QUALIFIED_AGY_VERSION = '1.5.16';

/** The adapter's default policy (#1103). */
export const AGY_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_AGY_VERSION,
  unqualified: 'warn',
});

/** `agy --version` prints the bare release. */
export function agyVersionToken(output: string): string {
  return output.trim();
}
