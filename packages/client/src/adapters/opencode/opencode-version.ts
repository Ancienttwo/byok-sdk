import type { RuntimeVersionPolicy } from '../../types';

/** Compatibility floors are independent of OS/line canary qualification. */
export function opencodeVersionToken(output: string): string | undefined {
  const match = /^(?:opencode v)?((1|2)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.exec(output.trim());
  if (!match) return undefined;
  const [, version, major, minor, patch] = match;
  if (major === '1' && (Number(minor) < 18 || (minor === '18' && Number(patch) < 35))) return undefined;
  if (major === '2' && minor === '0' && Number(patch) < 26) return undefined;
  return version;
}

/** The OpenCode release the native canary qualified (#1593). */
export const QUALIFIED_OPENCODE_VERSION = '2.2.6';

/** The adapter's default policy: an unqualified version is an advisory. A block is Host-only, so none is declared here. */
export const OPENCODE_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_OPENCODE_VERSION,
  unqualified: 'warn',
});
