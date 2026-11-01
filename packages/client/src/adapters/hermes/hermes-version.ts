import type { RuntimeVersionPolicy } from '../../types';

/**
 * Hermes version policy, as for Codex: the version is read, never gated by
 * default. Hermes updates itself, so another build is an advisory. This is the
 * build the gateway ownership, standalone profile and ACP contracts were
 * checked against (`docs/researches/2026-10-20-519-hermes-acp-s0.md`).
 */
export const QUALIFIED_HERMES_VERSION = '0.22.2+2364.g0b10b9f';

/** The adapter's default policy (#1103). A block is Host-only, so none is declared here. */
export const HERMES_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_HERMES_VERSION,
  unqualified: 'warn',
});

/** The first line of `hermes --version`, for example `Hermes Agent v0.22.2+2364.g0b10b9f (2026.9.24) · stable · …`. */
export function hermesVersionLine(output: string): string {
  return output.trim().split('\n')[0]?.trim() ?? '';
}

/** The normalized token the policy matches: the first line without the command name and leading `v`. */
export function hermesVersionToken(line: string): string {
  return /^Hermes Agent v(\S+)/.exec(line.trim())?.[1] ?? line.trim();
}
