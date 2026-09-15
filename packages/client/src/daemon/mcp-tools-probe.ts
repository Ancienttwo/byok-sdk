import type { McpStdioServerConfig } from '../types';
import { McpAuthorityError } from '../mcp/client';
import { observeMcpServer, type McpServerObservation } from '../mcp/observation';

/**
 * The daemon's admission-time use of the shared MCP core (`../mcp/`).
 *
 * This file owns the admission POLICY — the deadlines an offer may wait on and
 * what the runner does with a failure — and nothing else. The connection, the
 * byte bounds, the name rules and the descriptor shape all belong to the core,
 * so the observation the daemon admits on and the one the Pi extension
 * projects its tools from are the same code reading the same server.
 */

export const MCP_TOOLS_PROBE_TIMEOUT_MS = 10_000;

/**
 * The single admission budget for observing ALL of one task's projected
 * toolset servers, however many there are.
 *
 * `handleOffer` runs inside its connection's FIFO, so anything it awaits also
 * delays the `task.cancel` / `task.approve` / next-offer envelopes queued
 * behind it. Observing a toolset's servers one after another would multiply
 * the per-server timeout by the server count — a device configured to the
 * current ceiling (16 toolsets × 16 servers) could hold the control channel
 * for minutes on a single unresponsive command. The runner therefore starts
 * every observation at once and gives each one this same deadline, so total
 * admission latency is bounded by one timeout regardless of server count, and
 * each one still kills its own child when the deadline expires.
 */
export const MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS = 10_000;

export interface McpToolsProbeOptions {
  /** Prefix used in every error message, so a failure names the thing that failed. */
  label?: string;
  timeoutMs?: number;
  /**
   * The exact base environment the RUNTIME child of this task receives
   * (`buildRuntimeEnv`, `./environment.ts`) — never `process.env`. The probe
   * spawns a host-configured command, so it must not become the one place the
   * daemon's own ambient credentials (an `AWS_SECRET_ACCESS_KEY` or
   * `DATABASE_URL` set for the daemon's own deployment, this SDK's own
   * `BYOK_*` control-plane variables) reach a server the real runtime path
   * would have filtered out. Required, deliberately: a caller that forgets it
   * fails to compile rather than silently reinstating the blanket passthrough.
   */
  env: Readonly<Record<string, string>>;
  /**
   * Working directory for the probed child — the same directory the runtime
   * CLI is spawned in, so a server resolving relative paths sees what it will
   * see for real. Omitted only when no such directory is resolved before
   * admission.
   */
  cwd?: string;
}

/**
 * Observe one projected toolset server: start it, complete `initialize` +
 * `tools/list`, and return everything it reported about itself.
 *
 * No `tools/call` is ever sent, so an authenticated task binding stays unused
 * until the real runtime invokes it. The child is always killed before this
 * resolves — the observation proves the server can start and enumerate its
 * tools; the runtime spawns its own copy.
 */
export async function probeMcpServer(
  serverName: string,
  server: Readonly<McpStdioServerConfig>,
  options: McpToolsProbeOptions,
): Promise<McpServerObservation> {
  return observeMcpServer(serverName, server, {
    ...(options.label === undefined ? {} : { label: options.label }),
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeoutMs: options.timeoutMs ?? MCP_TOOLS_PROBE_TIMEOUT_MS,
  });
}

/**
 * The names-only form, for the one caller that proves a helper can START
 * rather than deciding what a model may call: the Agent message helper
 * preflight (`./agent-message-mcp-preflight.ts`).
 */
export async function probeMcpServerTools(
  server: Readonly<McpStdioServerConfig>,
  options: McpToolsProbeOptions,
): Promise<readonly string[]> {
  const observation = await probeMcpServer(options.label ?? 'server', server, options);
  return Object.freeze(observation.tools.map((tool) => tool.name));
}

/**
 * A probe failure caused by the server's own ANSWER rather than by its
 * environment — an ungrantable tool name, a malformed tool entry, an oversized
 * stream. Retrying cannot change it: the same configured command reports the
 * same thing next time. Callers use this to decline the task permanently
 * instead of re-offering it forever (see `task-runner.ts`).
 *
 * The classification is the core's; the retry decision it drives is the
 * daemon's.
 */
export { McpAuthorityError };
