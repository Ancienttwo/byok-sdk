import type { ResolvedBin } from '../codex/resolve-bin';

/**
 * Resolve the DeepSeek Harness CLI (`npm install -g @deepseek-ai/dsh`). It is
 * a user install, not a dependency of this SDK. `BYOK_DSH_BIN` overrides the
 * PATH lookup, as `BYOK_CODEX_BIN` does for Codex.
 */
export function resolveDshBin(): ResolvedBin {
  const override = process.env.BYOK_DSH_BIN;
  return override ? { command: override, source: 'env' } : { command: 'dsh', source: 'path' };
}
