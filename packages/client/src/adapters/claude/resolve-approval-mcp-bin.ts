import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface ResolvedApprovalMcpBin {
  command: string;
  args: string[];
  source: 'env' | 'dist';
}

/**
 * Resolve `byok-approval-mcp` — the small stdio MCP server
 * (`bin/byok-approval-mcp.ts`) `claude`'s own `--permission-prompt-tool`
 * spawns as ITS child process (see that file's doc comment, and
 * `permission-mapping.ts`'s `confirm`-mode doc comment, for the full design).
 *
 * Unlike `resolveClaudeBin` (the end user's own separately-installed,
 * separately-authenticated CLI, resolved via bare-name PATH lookup),
 * `byok-approval-mcp` is a script THIS SAME `@byok/client` package ships —
 * bare-name PATH lookup is NOT safe for it: `@byok/client` is typically a
 * project-local dependency, so its `node_modules/.bin/byok-approval-mcp`
 * symlink is only on PATH for processes that inherit THAT project's own
 * shell/PATH, not reliably for a background OS service (launchd/systemd
 * often run with a stripped-down PATH that omits project-local
 * `node_modules/.bin` entirely — see `templates/service/**`). Resolving an
 * ABSOLUTE path to this package's own compiled bin avoids depending on PATH
 * at all.
 *
 * `BYOK_APPROVAL_MCP_BIN` overrides everything when set — the injectable
 * seam for tests (mirrors `BYOK_CLAUDE_BIN`/`BYOK_PI_BIN`), letting a test
 * substitute a fixture script instead of computing any real path. The
 * override is a single command string with no separate args (tests don't
 * need to invoke it any differently than `node <script>`); the real default
 * below is `node <absolute-path-to-the-built-bin>`.
 *
 * The default computation is deliberately anchored to THIS module's own
 * `import.meta.url`, resolved once at the real production entry point: when
 * `@byok/client` is built (`tsup.config.ts`), this file's code ends up
 * bundled into `dist/index.js` at the package root, with `dist/bin/
 * byok-approval-mcp.js` as its direct sibling (same layout `byok-agent.js`
 * already uses) — `path.join(path.dirname(fileURLToPath(import.meta.url)),
 * 'bin', 'byok-approval-mcp.js')` is therefore correct for that one real
 * shape. It is NOT correct for this file's own unbundled TypeScript source
 * location (`src/adapters/claude/` is two directories deeper than `src/`),
 * but nothing in this codebase ever reaches this fallback unbundled — every
 * test that exercises `confirm` mode sets `BYOK_APPROVAL_MCP_BIN` explicitly
 * (see `claude-adapter.test.ts`), exactly like `BYOK_CLAUDE_BIN` already
 * does for the real `claude` binary.
 */
export function resolveApprovalMcpBin(): ResolvedApprovalMcpBin {
  const override = process.env.BYOK_APPROVAL_MCP_BIN;
  if (override) {
    return { command: override, args: [], source: 'env' };
  }
  const distBin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'byok-approval-mcp.js');
  return { command: process.execPath, args: [distBin], source: 'dist' };
}
