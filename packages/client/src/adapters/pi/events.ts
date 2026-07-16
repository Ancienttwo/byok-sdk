import type { AgentEvent } from '@byok/protocol';
import type { PiRpcMessage } from './rpc-client';

/**
 * Translate one pi RPC-mode message (docs/rpc.md, empirically verified
 * against pi 0.74.2 and 0.80.7) into zero-or-one normalized `AgentEvent`s.
 *
 * `agent_settled` (not pi's own per-LLM-turn `turn_end`) is what maps to our
 * `turn_end`: a single pi prompt can produce several internal turns (tool
 * round-trips); only once the whole run is settled (no auto-retry,
 * compaction-retry, or queued continuation left) is the task actually done.
 * Forwarding pi's own `turn_end` 1:1 would emit multiple confusing
 * `turn_end`s for what the daemon must treat as one task.
 *
 * Returns undefined for pi messages with no protocol equivalent (session/
 * compaction/retry bookkeeping, extension UI dialogs — the latter dropped
 * because M0's pi adapter never loads an extension that raises one).
 */
export function mapPiMessageToAgentEvent(msg: PiRpcMessage): AgentEvent | undefined {
  switch (msg.type) {
    case 'message_update': {
      const delta = msg.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
        return { type: 'progress', text: delta.delta };
      }
      return undefined;
    }

    case 'tool_execution_start': {
      if (typeof msg.toolName !== 'string') return undefined;
      return { type: 'tool_use', tool: msg.toolName, input: msg.args };
    }

    case 'tool_execution_end': {
      if (typeof msg.toolName !== 'string') return undefined;
      return {
        type: 'tool_result',
        tool: msg.toolName,
        output: { result: msg.result, isError: msg.isError === true },
      };
    }

    case 'agent_settled':
      return { type: 'turn_end' };

    case 'extension_error':
      return { type: 'error', message: typeof msg.error === 'string' ? msg.error : 'pi extension error' };

    case 'auto_retry_end':
      if (msg.success === false) {
        return {
          type: 'error',
          message: typeof msg.finalError === 'string' ? msg.finalError : 'pi auto-retry exhausted',
        };
      }
      return undefined;

    default:
      return undefined;
  }
}
