import type { RuntimeVersionPolicy } from '../../types.js';
import { compareRuntimeSemver } from '../../runtime/compare-runtime-semver.js';

export function opencodeVersionToken(output: string): string | undefined {
  return /^(?:opencode v)?((?:1|2)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(output.trim())?.[1];
}

/** Each supported OpenCode major has its own compatibility floor. */
export function opencodeVersionUnsupported(version: string): { installedVersion: string; requiredVersion: string } | undefined {
  const requiredVersion = version.startsWith('1.') ? '1.18.35' : '2.0.26';
  return (compareRuntimeSemver(version, requiredVersion) ?? -1) < 0 ? { installedVersion: version, requiredVersion } : undefined;
}

/** The OpenCode release selected by the default version policy (#1593). */
export const QUALIFIED_OPENCODE_VERSION = '2.3.0';

/** The v1 release the runtime contract installs (#1593). */
export const CONTRACT_OPENCODE_V1_VERSION = '1.19.5';

/** The adapter's default policy: an unqualified version is an advisory. */
export const OPENCODE_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_OPENCODE_VERSION,
  unqualified: 'warn',
});
