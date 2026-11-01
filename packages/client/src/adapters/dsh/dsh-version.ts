import type { RuntimeVersionPolicy } from '../../types';

/**
 * DeepSeek Harness version policy (#1258 O5). dsh is a developer preview that
 * ships only prereleases and warns of breaking changes, so the qualified
 * build is one exact version: the npm `latest` release the ACP launch, patch
 * overlay, sandbox switch and session contracts were checked against
 * (`docs/researches/2026-11-01-dsh-adapter.md` §2). Another version is an
 * advisory, as for the other runtimes; a block is Host-only.
 */
export const QUALIFIED_DSH_VERSION = '0.2.1-rc.5';

/** The adapter's default policy (#1103). */
export const DSH_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_DSH_VERSION,
  unqualified: 'warn',
});

/** `dsh --version` prints the bare version, for example `0.2.1-rc.5`: the token is its first line. */
export function dshVersionToken(output: string): string {
  return output.trim().split('\n')[0]?.trim() ?? '';
}
