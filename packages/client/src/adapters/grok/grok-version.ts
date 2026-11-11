import type { RuntimeVersionPolicy } from '../../types.js';

/**
 * Grok version policy, as for Codex: the version is read, never gated by
 * default. Grok updates itself, so another version is an advisory. This is the
 * newest version that OAR's live evidence covers for the vendored profile (the
 * prompt-option probe in OAR docs/runtimes/grok.md, read at OAR c264f17).
 * The vendored ac7fde4 Grok runtime session differs upstream from c264f17
 * in the wording of its resume refusal (0.86), the manual compaction control
 * the SDK bridge does not expose (0.88) and the native task events the adapter
 * ignores (0.91); the 0.80-0.92 shared ACP stack adds connection opening, input
 * draining, refusal of foreign child attribution and the adapter-held queue
 * without changing the Grok launch profile. The 0.94 shared stack keeps full
 * tool inputs and admits a steer only at dispatch. 0.99 names each prompt
 * (`_meta.promptId`), adopts Grok's own turns, steers through
 * `_x.ai/interject` (the Grok bridge exposes no steer) and classes limit 429s
 * from Grok 1.0.77 evidence. Native
 * contracts the adapter depends on are probed directly (`agent stdio`).
 */
export const QUALIFIED_GROK_VERSION = '1.0.52';

/** The adapter's default policy (#1103). A block is Host-only, so none is declared here. */
export const GROK_VERSION_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: QUALIFIED_GROK_VERSION,
  unqualified: 'warn',
});

/** The normalized token the policy matches: `grok 1.0.62 (1474f9cbdd91)` -> `1.0.62`. */
export function grokVersionToken(output: string): string {
  return /^grok\s+(\S+)/.exec(output.trim())?.[1] ?? output.trim();
}
