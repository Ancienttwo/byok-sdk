import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  evaluateBeforeToolRequest,
  formatToolExecutionDenial,
  type BeforeToolOptions,
  type ToolExecutionCall,
  type ToolExecutionVerdict,
} from '../../tool-execution-hook';
import type { RuntimeOperationManifest } from '../../types';
import type { ClaudeStreamMessage } from './events';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

/** Claude owns path expansion; preserve native arguments rather than interpreting shell commands. */
export function decodeClaudePreToolUse(value: unknown): ToolExecutionCall {
  if (!record(value) || value.hook_event_name !== 'PreToolUse' || !text(value.tool_name)
    || !text(value.tool_use_id) || !record(value.tool_input) || !text(value.cwd) || !isAbsolute(value.cwd)
    || (value.agent_id !== undefined && !text(value.agent_id))) {
    throw new Error('invalid Claude PreToolUse input');
  }
  const input = value.tool_input;
  const paths = ['file_path', 'notebook_path', 'path'].flatMap(key => typeof input[key] === 'string' ? [input[key] as string] : []);
  return {
    toolCallId: value.tool_use_id, toolName: value.tool_name, input, cwd: value.cwd, paths,
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    ...(value.agent_id === undefined ? {} : { nativeAgentId: value.agent_id }),
  };
}

export function encodeClaudePreToolUse(verdict: ToolExecutionVerdict): Record<string, unknown> {
  // An allow leaves normal runtime permission handling intact. It does not
  // supersede a user's deny rule or enable the runtime's approval UI.
  return verdict.decision === 'allow' ? {} : {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: formatToolExecutionDenial(verdict),
    },
  };
}

/** SDK callback hooks survive disableAllHooks; can_use_tool and settings hooks do not provide this boundary. */
export class ClaudeBeforeToolBridge {
  private readonly callbackId = randomUUID();
  private readonly lifetime = new AbortController();
  private write: ((frame: Record<string, unknown>) => Promise<void>) | undefined;
  private ended = false;
  readonly hooks: Readonly<Record<string, unknown>>;

  constructor(
    private readonly options: BeforeToolOptions,
    private readonly manifest: RuntimeOperationManifest,
    private readonly onFatal: (error: Error) => void,
  ) {
    // The SDK bounds the callback first, so the native timeout is a backstop
    // for a dead control transport and never wins over a classified refusal.
    this.hooks = { PreToolUse: [{ hookCallbackIds: [this.callbackId], timeout: ((options.timeoutMs ?? 5_000) + 1_000) / 1_000 }] };
  }

  bind(write: (frame: Record<string, unknown>) => Promise<void>): void { this.write = write; }
  close(): void { this.ended = true; this.lifetime.abort('closed'); }

  /** Returns true only for this bridge's control requests, keeping native approvals independent. */
  receive(message: ClaudeStreamMessage): boolean {
    if (message.type !== 'control_request' || !record(message.request) || message.request.subtype !== 'hook_callback') return false;
    if (this.ended) return true;
    if (!text(message.request_id) || message.request.callback_id !== this.callbackId || !this.write) {
      this.onFatal(new Error('Claude sent an unregistered tool policy callback'));
      return true;
    }
    const requestId = message.request_id;
    const payload = message.request.input;
    void this.respond(requestId, payload).catch(error => this.onFatal(error instanceof Error ? error : new Error('Claude tool policy response failed')));
    return true;
  }

  private async respond(requestId: string, payload: unknown): Promise<void> {
    let verdict: ToolExecutionVerdict;
    try {
      const call = decodeClaudePreToolUse(payload);
      verdict = await evaluateBeforeToolRequest(this.options, {
        ...call, taskId: this.manifest.taskId, runtimeId: 'claude',
        ...(this.manifest.agentRef === undefined ? {} : { agentRef: this.manifest.agentRef }),
      }, this.lifetime.signal);
    } catch {
      verdict = { decision: 'deny', code: 'tool_policy_error', reason: 'Invalid Claude tool policy request' };
    }
    if (this.ended) return;
    await this.write!({ type: 'control_response', response: {
      subtype: 'success', request_id: requestId, response: encodeClaudePreToolUse(verdict),
    } });
  }
}
