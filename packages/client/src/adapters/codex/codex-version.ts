/**
 * Codex CLI version policy, as in OAR: read the version, never gate on it. The
 * local Codex updates itself, so a version other than the one this SDK was
 * qualified against is an advisory. Native contracts the adapter depends on
 * are probed directly (app-server presence, MCP tool allowlist readback).
 */
export const QUALIFIED_CODEX_VERSION = '0.160.0';

/** Whether `codex --version` output names the qualified release exactly. */
export function isQualifiedCodexVersion(output: string): boolean {
  return output.trim() === `codex-cli ${QUALIFIED_CODEX_VERSION}`;
}
