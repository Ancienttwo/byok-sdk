import { spawn } from 'node:child_process';
import type { McpStdioServerConfig } from '../types';

export const MCP_TOOLS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Hard cap on the bytes one probed server may write to stdout before its
 * `tools/list` answer is complete. The probe reads a fixed two-message
 * handshake, so a server still streaming past this is either broken or
 * hostile; either way it must not be able to grow the daemon's heap while an
 * offer waits on admission. Exceeding it is a probe failure, never a partial
 * observation.
 */
export const MCP_TOOLS_PROBE_MAX_STDOUT_BYTES = 1_048_576;

/**
 * The single admission budget for observing ALL of one task's projected
 * toolset servers, however many there are.
 *
 * `handleOffer` runs inside its connection's FIFO, so anything it awaits also
 * delays the `task.cancel` / `task.approve` / next-offer envelopes queued
 * behind it. Probing a toolset's servers one after another would multiply the
 * per-server timeout by the server count — a device configured to the current
 * ceiling (16 toolsets × 16 servers) could hold the control channel for
 * minutes on a single unresponsive command. The runner therefore starts every
 * probe at once and gives each one this same deadline, so total admission
 * latency is bounded by one timeout regardless of server count, and each probe
 * still kills its own child when the deadline expires.
 */
export const MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS = 10_000;

/**
 * Tool names an adapter is allowed to pre-grant must be OBSERVED, never
 * configured: the daemon's own `mcpToolsets` config carries `command`/`args`
 * only (see `toolset-registry.ts`), so the single authority for "which tools
 * does this server actually expose" is the server's own `tools/list` answer.
 *
 * A name that survives this filter is about to be interpolated into runtime
 * CLI authority — `--allowedTools mcp__<server>__<tool>` for claude, and
 * `mcp_servers.<server>.tools.<tool>.approval_mode` for codex. A comma, a
 * dot, a quote, or whitespace in a tool name would forge additional grants or
 * a different config key out of one legitimate one.
 *
 * A server that reports ANY name outside this shape fails the whole probe —
 * the observation is rejected, and the task is declined permanently rather
 * than partially granted. Granting the well-formed subset and silently
 * dropping the rest would hand the model a toolset it can only half call, and
 * would let one bad name ride along with good ones; only observed, validated
 * names are ever granted, and a list that cannot be validated in full yields
 * no grant at all. The shape is deliberately narrower than MCP's own
 * (unbounded) name rule: the two real servers this SDK ships and every toolset
 * server observed so far satisfy it, and a legitimate server that does not can
 * still be listed and called by a runtime that grants tools itself — it simply
 * cannot be pre-granted here, and this SDK will not admit a task for it.
 */
export const GRANTABLE_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/u;

/**
 * The same rule for the SERVER half of the identifier, enforced at grant
 * resolution (`../adapters/mcp-tool-grants.ts`). A projected server name is
 * interpolated into `mcp__<server>__<tool>` for claude and into the flat TOML
 * key `mcp_servers.<server>.tools.<tool>.approval_mode` for codex: a `.` would
 * split that key into a different table, and a quote, comma, or space would
 * forge a second grant out of one. `toolset-registry.ts` already validates
 * configured server names, so this is the second, local gate that keeps the
 * grant surface honest for a server that reached an adapter some other way.
 */
export const GRANTABLE_MCP_SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/u;

/**
 * A probe failure caused by the server's own ANSWER rather than by its
 * environment — an ungrantable tool name, a malformed tool entry, or an
 * oversized stream. Retrying cannot change it: the same configured command
 * reports the same names next time. Callers use this to decline the task
 * permanently instead of re-offering it forever (see `task-runner.ts`).
 */
export class McpToolsProbeAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolsProbeAuthorityError';
  }
}

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
 * Start the exact configured stdio MCP server, complete an
 * `initialize` + `tools/list` handshake, and return the reported tool names.
 * No `tools/call` is ever sent, so an authenticated task binding stays unused
 * until the real runtime invokes it.
 *
 * The child is always killed before this resolves — the probe proves the
 * server can start and enumerate its tools; the runtime spawns its own copy.
 */
export async function probeMcpServerTools(
  server: Readonly<McpStdioServerConfig>,
  options: McpToolsProbeOptions,
): Promise<readonly string[]> {
  const label = options.label ?? 'MCP server';
  const timeoutMs = options.timeoutMs ?? MCP_TOOLS_PROBE_TIMEOUT_MS;
  return new Promise<readonly string[]>((resolve, reject) => {
    let settled = false;
    /** Bytes received but not yet terminated by a newline. Never re-scanned. */
    let pending = '';
    let stdoutBytes = 0;
    let stderr = '';
    const child = spawn(server.command, [...(server.args ?? [])], {
      // `server.env` is layered on top exactly as the runtime path layers it:
      // claude/codex receive the per-server `env` inside the generated MCP
      // config and apply it over their own (already allowlisted) child
      // environment. Only SDK-reserved servers ever carry one — host toolset
      // configuration rejects the field outright (`toolset-registry.ts`).
      env: { ...options.env, ...(server.env ?? {}) },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (error?: Error, tools?: readonly string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(tools ?? []);
    };
    const requestTools = (): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    };
    /** Consume exactly one complete line of the server's stdout. */
    const inspectLine = (line: string): void => {
      if (!line.trim()) return;
      let response: unknown;
      try { response = JSON.parse(line); } catch { return; }
      if (response === null || typeof response !== 'object' || Array.isArray(response)) return;
      const record = response as { id?: unknown; result?: unknown; error?: unknown };
      if (record.id === 1) {
        if (record.error !== undefined || record.result === null || typeof record.result !== 'object' || Array.isArray(record.result)) {
          finish(new Error(`${label} initialize failed${record.error === undefined ? '' : `: ${JSON.stringify(record.error)}`}`));
          return;
        }
        requestTools();
        return;
      }
      const toolsResult = record.result as { tools?: unknown } | undefined;
      if (record.id !== 2 || !Array.isArray(toolsResult?.tools)) return;
      const names: string[] = [];
      for (const tool of toolsResult.tools) {
        if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
          finish(new McpToolsProbeAuthorityError(`${label} tools/list returned a malformed tool entry`));
          return;
        }
        const name = (tool as { name?: unknown }).name;
        if (typeof name !== 'string' || !GRANTABLE_TOOL_NAME.test(name)) {
          finish(new McpToolsProbeAuthorityError(
            `${label} tools/list reported an ungrantable tool name ${JSON.stringify(name)}`,
          ));
          return;
        }
        names.push(name);
      }
      finish(undefined, Object.freeze([...new Set(names)].sort()));
    };
    const timer = setTimeout(() => {
      finish(new Error(`${label} handshake timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ''}`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => finish(new Error(`${label} failed to start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(
        `${label} exited before handshake (code=${String(code)}, signal=${String(signal)})${stderr ? `: ${stderr.trim()}` : ''}`,
      ));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > MCP_TOOLS_PROBE_MAX_STDOUT_BYTES) {
        finish(new McpToolsProbeAuthorityError(
          `${label} wrote more than ${MCP_TOOLS_PROBE_MAX_STDOUT_BYTES} bytes of stdout before completing tools/list`,
        ));
        return;
      }
      // Incremental: every byte is scanned exactly once. Re-splitting the
      // whole accumulated buffer on each chunk would re-parse every earlier
      // line again — quadratic in a chatty server's output.
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf('\n', start);
        if (newline === -1) {
          pending += chunk.slice(start);
          return;
        }
        const line = pending + chunk.slice(start, newline);
        pending = '';
        start = newline + 1;
        inspectLine(line);
        if (settled) return;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (error) => finish(new Error(`${label} stdin failed: ${error.message}`)));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: '@byok-sdk/client-mcp-tools-probe', version: '0.0.0' },
      },
    })}\n`);
  });
}
