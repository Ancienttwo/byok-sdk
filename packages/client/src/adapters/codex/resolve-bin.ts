export interface ResolvedBin {
  command: string;
  source: 'env' | 'path';
}

/**
 * Resolve the codex CLI executable.
 *
 * Unlike pi (bundled as an npm optionalDependency — see
 * `../pi/resolve-bin.ts`), the real OpenAI Codex CLI (empirically `codex-cli
 * 0.144.5` on the machine this adapter was built/verified against, installed
 * at a plain PATH location — not inside this repo's `node_modules`) is not
 * published as an npm package this SDK could sensibly depend on: it's a
 * standalone global install (native installer / `npm i -g @openai/codex` /
 * homebrew, depending on platform and version). There is no package-relative
 * resolution to attempt, so this is simpler than pi's version: an explicit
 * override for tests, else a bare PATH lookup.
 *
 * `BYOK_CODEX_BIN` overrides PATH lookup — substituting the fake-codex test
 * fixture, exactly like `BYOK_PI_BIN` does for pi. The `byok-agent` CLI bin
 * only ever constructs `new CodexAdapter()` with no options (mirroring
 * `createDaemon`'s pi wiring), so an out-of-process substitution (e.g. a
 * future e2e harness swapping in a fake binary ahead of a real codex install)
 * has no other seam to use.
 */
export function resolveCodexBin(): ResolvedBin {
  const override = process.env.BYOK_CODEX_BIN;
  if (override) {
    return { command: override, source: 'env' };
  }
  return { command: 'codex', source: 'path' };
}
