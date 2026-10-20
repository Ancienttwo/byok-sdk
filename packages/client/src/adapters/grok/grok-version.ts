/**
 * Grok version policy, as for Codex: read the version, never gate on it. Grok
 * updates itself, so another version is an advisory. This is the newest
 * version with OAR 60ad09b live evidence for the vendored profile (the
 * prompt-option probe, docs/runtimes/grok.md). Native contracts the adapter
 * depends on are probed directly (`agent stdio`).
 */
export const QUALIFIED_GROK_VERSION = '1.0.52';

/** Whether `grok --version` output (`grok 1.0.62 (1474f9cbdd91)`) names the qualified release exactly. */
export function isQualifiedGrokVersion(output: string): boolean {
  return /^grok (\S+)/.exec(output.trim())?.[1] === QUALIFIED_GROK_VERSION;
}
