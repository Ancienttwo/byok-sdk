import type { ResolvedBin } from '../codex/resolve-bin';

/**
 * Resolve the Grok Build CLI. Like Codex, it is a standalone user install
 * (xAI's install script; `~/.grok/bin` linked onto PATH), not an npm package
 * this SDK could depend on. `BYOK_GROK_BIN` overrides the PATH lookup, for
 * tests and for an out-of-process substitution.
 */
export function resolveGrokBin(): ResolvedBin {
  const override = process.env.BYOK_GROK_BIN;
  if (override) return { command: override, source: 'env' };
  return { command: 'grok', source: 'path' };
}
