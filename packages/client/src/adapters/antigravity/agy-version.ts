import type { RuntimeVersionPolicy } from '../../types';

/**
 * Antigravity CLI version policy, as for Grok: the CLI updates itself on a
 * user's machine, so another version is an advisory; a block is Host-only.
 * This is the release the runtime contract suite qualified.
 */
export const QUALIFIED_AGY_VERSION = '1.5.1';

/** The adapter's default policy (#1103). */
export const AGY_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_AGY_VERSION,
  unqualified: 'warn',
});

/** `agy --version` prints the bare release. */
export function agyVersionToken(output: string): string {
  return output.trim();
}

/**
 * Whether a version token is a stable CLI with native ACP. Older CLIs answer
 * an unknown `acp` subcommand with help and exit 0, so the version is the only gate.
 */
export function agyHasNativeAcp(token: string): boolean {
  const release = /^(\d+)\.(\d+)\.\d+$/.exec(token);
  if (release === null) return false;
  const [major, minor] = [Number(release[1]), Number(release[2])];
  return major > 1 || (major === 1 && minor >= 5);
}
