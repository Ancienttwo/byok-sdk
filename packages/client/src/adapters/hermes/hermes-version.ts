/**
 * Hermes version policy, as for Codex: read the version, never gate on it.
 * Hermes updates itself, so another build is an advisory. This is the build
 * the gateway ownership, standalone profile and ACP contracts were checked
 * against (`docs/notes/2026-10-20-519-hermes-acp-s0.md`).
 */
export const QUALIFIED_HERMES_VERSION = '0.22.2+2364.g0b10b9f';

/** The first line of `hermes --version`, for example `Hermes Agent v0.22.2+2364.g0b10b9f (2026.9.24) · stable · …`. */
export function hermesVersionLine(output: string): string {
  return output.trim().split('\n')[0]?.trim() ?? '';
}

export function isQualifiedHermesVersion(line: string): boolean {
  return line === `Hermes Agent v${QUALIFIED_HERMES_VERSION}` || line.startsWith(`Hermes Agent v${QUALIFIED_HERMES_VERSION} `);
}
