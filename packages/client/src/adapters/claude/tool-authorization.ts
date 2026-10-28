import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { formatToolAuthorizationDenial, type ToolAuthorizationGate, type ToolAuthorizationVerdict, type ToolCall } from '../../tool-authorization';
import type { ClaudeStreamMessage } from './events';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

export function decodeClaudePreToolUse(value: unknown): ToolCall {
  if (!record(value) || value.hook_event_name !== 'PreToolUse' || !text(value.tool_name)
    || !text(value.tool_use_id) || !record(value.tool_input) || !text(value.cwd) || !isAbsolute(value.cwd)
    || (value.agent_id !== undefined && !text(value.agent_id))) {
    throw new Error('invalid Claude PreToolUse input');
  }
  return {
    toolCallId: value.tool_use_id, toolName: value.tool_name, input: value.tool_input, cwd: value.cwd,
    ...(value.agent_id === undefined ? {} : { nativeAgentId: value.agent_id }),
  };
}

export function encodeClaudePreToolUse(verdict: ToolAuthorizationVerdict): Record<string, unknown> {
  // An allow leaves the runtime's own permission handling unchanged.
  return verdict.decision === 'allow' ? {} : {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: formatToolAuthorizationDenial(verdict),
    },
  };
}

/**
 * An SDK callback hook registered at `initialize`. Unlike `can_use_tool` it
 * is not skipped by allow rules or bypass permissions, and `disableAllHooks`
 * does not remove it; it covers native subagents and MCP tools too.
 */
export class ClaudeToolAuthorizationBridge {
  private readonly callbackId = randomUUID();
  private write: ((frame: Record<string, unknown>) => Promise<void>) | undefined;
  private ended = false;
  readonly hooks: Readonly<Record<string, unknown>>;

  constructor(private readonly gate: ToolAuthorizationGate, private readonly onFatal: (error: Error) => void) {
    // The gate settles first (user authorization has its own deadline); the
    // native timeout only backstops a dead control transport.
    this.hooks = { PreToolUse: [{ hookCallbackIds: [this.callbackId], timeout: Math.ceil(gate.timeoutMs / 1_000) + 5 }] };
  }

  bind(write: (frame: Record<string, unknown>) => Promise<void>): void { this.write = write; }
  close(): void { this.ended = true; }

  /** True only for this bridge's hook callbacks; native question relay receives the rest. */
  receive(message: ClaudeStreamMessage): boolean {
    if (message.type !== 'control_request' || !record(message.request) || message.request.subtype !== 'hook_callback') return false;
    if (this.ended) return true;
    if (!text(message.request_id) || message.request.callback_id !== this.callbackId || !this.write) {
      this.onFatal(new Error('Claude sent an unregistered tool authorization callback'));
      return true;
    }
    const requestId = message.request_id;
    void this.respond(requestId, message.request.input)
      .catch(error => this.onFatal(error instanceof Error ? error : new Error('Claude tool authorization response failed')));
    return true;
  }

  private async respond(requestId: string, payload: unknown): Promise<void> {
    let verdict: ToolAuthorizationVerdict;
    try {
      verdict = await this.gate.authorize(decodeClaudePreToolUse(payload));
    } catch {
      verdict = { decision: 'deny', code: 'tool_authorization_unavailable', reason: 'invalid Claude tool authorization request' };
    }
    if (this.ended) return;
    await this.write!({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: encodeClaudePreToolUse(verdict) } });
  }
}
