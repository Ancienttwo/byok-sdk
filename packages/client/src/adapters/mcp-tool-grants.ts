import type { McpStdioServerConfig, McpToolsetToolObservation } from '../types';
import { RESERVED_MCP_SERVER_NAMES } from '../sdk-reserved-mcp';

/** One projected toolset server and the exact tool names observed on it. */
export interface McpToolsetGrant {
  readonly server: string;
  readonly tools: readonly string[];
}

export type McpToolsetGrantResolution =
  | { ok: true; grants: readonly McpToolsetGrant[] }
  | { ok: false; reason: string };

/**
 * Pair every projected (non-reserved) MCP server with the tool names the
 * daemon actually observed on it, or fail closed.
 *
 * Both runtimes this SDK drives non-interactively refuse an MCP tool call
 * that was not pre-granted — claude auto-denies it under `--permission-mode
 * default` and under `acceptEdits`, codex rejects it under
 * `approval_policy=never` — so a projected toolset is only genuinely usable
 * if the adapter can name its tools in the runtime's own grant surface. That
 * makes an unobserved server an inexpressible policy, not a smaller one: the
 * task would claim, spawn a model, and then be told it may not call the very
 * tools it was offered for. Rejecting before spawn is the same fail-closed
 * posture the permission mappers already take for an inexpressible
 * `denyTools` or `network` constraint.
 *
 * Reserved SDK servers are deliberately absent from the result: each carries
 * a fixed, single-tool grant its own protocol defines, never an observed one.
 */
export function resolveMcpToolsetGrants(
  servers: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  observation: McpToolsetToolObservation | undefined,
): McpToolsetGrantResolution {
  const projected = Object.keys(servers ?? {}).filter((name) => !RESERVED_MCP_SERVER_NAMES.has(name)).sort();
  const observed = observation ?? {};
  const unexpected = Object.keys(observed).filter((name) => !projected.includes(name)).sort();
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: `observed MCP tool names for server(s) [${unexpected.join(', ')}] that are not projected for this task — refusing to grant tools for a server the task was never given`,
    };
  }
  const grants: McpToolsetGrant[] = [];
  for (const server of projected) {
    const tools = observed[server];
    if (tools === undefined || tools.length === 0) {
      return {
        ok: false,
        reason: `no tools/list observation for projected MCP toolset server "${server}" — refusing to start a task whose toolset tools cannot be granted`,
      };
    }
    grants.push({ server, tools: Object.freeze([...tools].sort()) });
  }
  return { ok: true, grants: Object.freeze(grants) };
}

/** Order-independent identity of one grant set, for adapters that must prove start() received the authority prepare() was admitted with. */
export function grantFingerprint(grants: readonly McpToolsetGrant[]): string {
  return grants
    .flatMap((grant) => grant.tools.map((tool) => `${grant.server} ${tool}`))
    .sort()
    .join('\n');
}
