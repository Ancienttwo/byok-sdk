/**
 * Grok version policy, as for Codex: read the version, never gate on it. Grok
 * updates itself, so another version is an advisory. This is the newest
 * version that OAR's live evidence covers for the vendored profile (the
 * prompt-option probe in OAR docs/runtimes/grok.md, read at OAR c264f17).
 * The vendored 51b83c9 Grok runtime is byte-identical upstream to c264f17;
 * shared/acp/profile.ts only adds an optional session-start timeout that Grok
 * does not set. Native contracts the adapter depends on are probed directly
 * (`agent stdio`).
 */
export const QUALIFIED_GROK_VERSION = '1.0.52';

/** Whether `grok --version` output (`grok 1.0.62 (1474f9cbdd91)`) names the qualified release exactly. */
export function isQualifiedGrokVersion(output: string): boolean {
  return /^grok (\S+)/.exec(output.trim())?.[1] === QUALIFIED_GROK_VERSION;
}
