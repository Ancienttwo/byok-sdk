import type { RuntimeVersionPolicy } from '../../types';

/**
 * Codex CLI version policy, as in OAR: the version is read, never gated by
 * default. The local Codex updates itself, so a version other than the one
 * this SDK was qualified against is an advisory. Native contracts the adapter
 * depends on are probed directly (app-server presence).
 */
export const QUALIFIED_CODEX_VERSION = '0.160.0';

/** The adapter's default policy (#1103). A block is Host-only, so none is declared here. */
export const CODEX_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_CODEX_VERSION,
  unqualified: 'warn',
});

/**
 * The normalized token the policy matches: `codex-cli 0.160.0` -> `0.160.0`.
 * `version` on the detect result stays the raw probe text.
 */
export function codexVersionToken(output: string): string {
  return /^codex-cli\s+(\S+)/.exec(output.trim())?.[1] ?? output.trim();
}

/** Whether `codex --version` output names the qualified release exactly (used by the warn-only team relay). */
export function isQualifiedCodexVersion(output: string): boolean {
  return codexVersionToken(output) === QUALIFIED_CODEX_VERSION;
}
