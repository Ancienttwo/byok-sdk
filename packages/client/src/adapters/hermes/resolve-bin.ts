import type { ResolvedBin } from '../codex/resolve-bin';

/**
 * Resolve the Hermes Agent CLI. Hermes is a user install (git or package
 * installer), not an npm package. `BYOK_HERMES_BIN` overrides the PATH lookup,
 * as `BYOK_CODEX_BIN` does for Codex.
 */
export function resolveHermesBin(): ResolvedBin {
  const override = process.env.BYOK_HERMES_BIN;
  return override ? { command: override, source: 'env' } : { command: 'hermes', source: 'path' };
}
