export interface ResolvedBin {
  command: string;
  source: 'env' | 'path';
}

/**
 * Resolve the `claude` (Claude Code) CLI executable.
 *
 * Unlike pi (`../pi/resolve-bin.ts`), this package does NOT bundle a
 * matched `claude` build as an optionalDependency. Claude Code is the end
 * user's own globally-installed, individually-authenticated CLI (`claude
 * auth login`, tied to their Anthropic/claude.ai account) — there is
 * nothing useful to vendor: a bundled copy could never carry the user's own
 * login state, and the credential-isolation rule (see `../../types.ts`'s
 * `RuntimeAdapter` doc comment — this adapter must never read, proxy, or
 * forward `~/.claude`'s own auth storage) means this adapter has no
 * business managing a claude install at all, only spawning whatever `claude`
 * the user already has authenticated on their PATH.
 *
 * Resolution is therefore deliberately two-tier, not three like pi's:
 * `BYOK_CLAUDE_BIN` overrides everything when set (the injectable seam for
 * in-process tests — mirrors `BYOK_PI_BIN` and substitutes the
 * `fake-claude.mjs` fixture ahead of a real claude install, exactly as pi's
 * own override does), otherwise this falls back to the literal command name
 * `claude`, resolved via the child process's own PATH lookup — there is no
 * optionalDependency tier in between.
 */
export function resolveClaudeBin(): ResolvedBin {
  const override = process.env.BYOK_CLAUDE_BIN;
  if (override) {
    return { command: override, source: 'env' };
  }
  return { command: 'claude', source: 'path' };
}
