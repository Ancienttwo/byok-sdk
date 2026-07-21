import { createInterface } from 'node:readline';

/**
 * M4 Phase 3: the testable core of `byok-approval-mcp` (`byok-approval-mcp.ts`
 * is the thin stdio-wiring entry point — mirrors this repo's existing
 * `bin/commands/*.ts` split: real logic lives in a plain module, the bin
 * script itself is glue no test ever imports directly).
 *
 * `byok-approval-mcp` is the MCP stdio server `claude`'s own
 * `--permission-prompt-tool` spawns AS ITS OWN CHILD PROCESS when the claude
 * adapter runs a task under `PermissionPolicy.mode: 'confirm'` (see
 * `../adapters/claude/permission-mapping.ts`'s `confirm`-mode doc comment).
 * It implements just enough of the MCP stdio transport (JSON-RPC 2.0,
 * newline-delimited, per the spec) to expose ONE tool — empirically
 * confirmed end-to-end against the real installed claude 2.1.216 binary
 * (M4 Phase 3 STEP 0): `initialize` -> `notifications/initialized` ->
 * `tools/list` -> `tools/call`, with the tool's arguments shaped exactly
 * `{tool_name, input, tool_use_id}` (claude's own real wire shape,
 * live-captured) and its expected response shaped
 * `{content:[{type:'text', text: JSON.stringify({behavior:'allow',
 * updatedInput} | {behavior:'deny', message})}]}` — the SAME shape the
 * Claude Agent SDK's in-process `canUseTool` callback returns (see
 * platform.claude.com/docs/en/agent-sdk/user-input), just crossing a
 * process boundary via MCP instead of an in-process function call.
 */

export const APPROVAL_TOOL_NAME = 'approval_prompt';

/** Bound on how much of a tool call's `input` gets folded into the wire `task.await_approval.summary` — mirrors `events.ts`'s `RESULT_DIAGNOSTIC_MAX_CHARS`/`truncateResultDiagnostic` convention: a human-facing summary, not a full audit record. */
export const APPROVAL_SUMMARY_MAX_CHARS = 500;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `${toolName}: ${input}`, bounded — the human-readable description carried into `task.await_approval.summary` and (via the daemon/CLI's own rendering) whatever a real approver actually reads before deciding. */
export function summarizeToolCall(toolName: string, input: unknown): string {
  let inputStr: string;
  try {
    inputStr = JSON.stringify(input);
  } catch (err) {
    inputStr = `<unserializable input: ${errorMessage(err)}>`;
  }
  const bounded =
    inputStr.length > APPROVAL_SUMMARY_MAX_CHARS ? `${inputStr.slice(0, APPROVAL_SUMMARY_MAX_CHARS)}… [truncated]` : inputStr;
  return `${toolName}: ${bounded}`;
}

export interface ApprovalOutcome {
  approved: boolean;
  reason?: string;
}

/** What `byok-approval-mcp.ts` (the real entry point) injects — the one real dependency this module has on the outside world. */
export interface ApprovalMcpDeps {
  /** Requests a decision from the daemon this task is running on. Any rejection/throw here is treated as fail-closed (deny) by `handleMcpRequest` — never surfaced to claude as a raw protocol error. */
  requestApproval(taskId: string, summary: string): Promise<ApprovalOutcome>;
}

interface JsonRpcRequestLike {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/**
 * Handles exactly one already-parsed JSON-RPC request object and returns the
 * exact response object to write back (`undefined` for a notification that
 * expects no reply, e.g. `notifications/initialized`) — no stdio/process
 * concerns at all, so tests call this directly with a stub {@link
 * ApprovalMcpDeps} instead of spawning a real process or a real control
 * socket. `serveApprovalMcpOverStdio` below is the only caller in production.
 */
export async function handleMcpRequest(
  req: JsonRpcRequestLike,
  deps: ApprovalMcpDeps,
  taskId: string,
): Promise<Record<string, unknown> | undefined> {
  const id = req.id;

  if (req.method === 'initialize') {
    const params = (req.params ?? {}) as { protocolVersion?: unknown };
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'byok-approval-mcp', version: '0.0.1' },
      },
    };
  }

  if (req.method === 'notifications/initialized') {
    return undefined; // notification — no response
  }

  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: APPROVAL_TOOL_NAME,
            description:
              'Requests operator approval for a pending tool call. Blocks until a human (or this device\'s daemon) decides, or the configured timeout elapses (fail-closed deny on timeout).',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
              },
            },
          },
        ],
      },
    };
  }

  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (params.name !== APPROVAL_TOOL_NAME) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool "${String(params.name)}"` } };
    }
    const args = (params.arguments ?? {}) as { tool_name?: unknown; input?: unknown };
    const toolName = typeof args.tool_name === 'string' ? args.tool_name : 'unknown tool';
    const input = args.input ?? {};
    const summary = summarizeToolCall(toolName, input);

    let outcome: ApprovalOutcome;
    try {
      outcome = await deps.requestApproval(taskId, summary);
    } catch (err) {
      // Fail-closed (task's own mandate): a daemon that's unreachable, a
      // control request that times out, or any other failure reaching the
      // approving device must never leave claude's own MCP call unanswered
      // — that risks claude abandoning the whole turn on its own (M4 Phase 3
      // STEP 0 found claude gives up on a permission-prompt-tool call that
      // never answers at all, ~1.5s in) rather than cleanly denying just
      // this one tool call and letting the conversation continue.
      outcome = { approved: false, reason: `could not reach the approving device: ${errorMessage(err)}` };
    }

    const payload = outcome.approved
      ? { behavior: 'allow' as const, updatedInput: input }
      : { behavior: 'deny' as const, message: outcome.reason ?? 'denied' };
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
  }

  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${String(req.method)}` } };
  }
  return undefined;
}

export interface ServeApprovalMcpOptions {
  taskId: string;
  deps: ApprovalMcpDeps;
  /** Defaults to `process.stdin`/`process.stdout` — overridable so tests can drive this over in-memory streams. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Wires {@link handleMcpRequest} to real NDJSON stdio (the MCP stdio
 * transport: one JSON-RPC message per line, both directions) — the only
 * genuinely process-shaped piece of this module. Each line is handled
 * independently and asynchronously (never serialized against the others),
 * since claude's own parallel-tool-use can legitimately fire more than one
 * concurrent `tools/call` over the same connection.
 */
export function serveApprovalMcpOverStdio(opts: ServeApprovalMcpOptions): void {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // a stray non-JSON line is not this server's concern
    }
    void handleMcpRequest(parsed as JsonRpcRequestLike, opts.deps, opts.taskId).then((response) => {
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    });
  });
}
