import type { AgentEvent } from '@byok-sdk/protocol';
import { RuntimeExecutionFailure } from '../../runtime-failure';
import type { PiRpcMessage } from './rpc-client';

function requireToolCallId(msg: PiRpcMessage): string {
  if (typeof msg.toolCallId === 'string' && msg.toolCallId.trim().length > 0) return msg.toolCallId;
  throw new RuntimeExecutionFailure({
    phase: 'run',
    category: 'authority',
    retry: 'non-retryable',
    reason: `pi ${msg.type} frame had no authoritative tool call id`,
  });
}

function requireToolResultOutcome(msg: PiRpcMessage): boolean {
  if (typeof msg.isError === 'boolean') return msg.isError;
  throw new RuntimeExecutionFailure({
    phase: 'run',
    category: 'authority',
    retry: 'non-retryable',
    reason: 'pi tool_execution_end frame had no authoritative isError outcome',
  });
}

/**
 * Map pi 0.84.2 RPC frames into BYOK's runtime-neutral event contract.
 *
 * `agent_settled` is the only whole-task completion authority. `agent_end`
 * ends one low-level agent run, but pi may still perform retry/compaction or
 * consume queued work before it emits `agent_settled`. Pi's own `turn_end`
 * is even narrower: a tool-using prompt can emit several of them. Mapping
 * either earlier boundary to BYOK `turn_end` would acknowledge the task
 * before the runtime is actually idle.
 *
 * `message_update` is delta-only in this contract. The mapper forwards text
 * deltas and never reads the removed cumulative `message`/`partial` fields.
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
      const toolCallId = requireToolCallId(msg);
      if (typeof msg.toolName !== 'string') return undefined;
      return { type: 'tool_use', tool: msg.toolName, input: msg.args, toolCallId };
    }

    case 'tool_execution_end': {
      const toolCallId = requireToolCallId(msg);
      const isError = requireToolResultOutcome(msg);
      if (typeof msg.toolName !== 'string') return undefined;
      const event: Extract<AgentEvent, { type: 'tool_result' }> = {
        type: 'tool_result',
        tool: msg.toolName,
        output: { result: msg.result },
        toolCallId,
        isError,
      };
      return event;
    }

    case 'agent_settled':
      return { type: 'turn_end' };

    /**
     * `artifact` is NOT a real pi RPC message — pi's own `write` tool only
     * ever surfaces as `tool_execution_start`/`tool_execution_end` (see
     * `docs/tools/write.js` in the installed package), and neither carries
     * enough on its own at the `_end` message (no `path`) for this stateless,
     * one-message-at-a-time mapper to correlate back to a written file
     * without introducing per-toolCallId state. This case exists purely so
     * the `fake-pi.mjs` test/e2e fixture (M1-4 blob-path acceptance run) has
     * a way to simulate "the runtime wrote a file and is reporting it as an
     * artifact" — real pi emits nothing today that reaches this branch, so
     * production traffic through this adapter never takes it. Revisit if a
     * future pi release adds a native artifact-producing message, or if this
     * needs correlating to a real `write` tool call.
     */
    case 'artifact': {
      if (typeof msg.name !== 'string' || typeof msg.contentType !== 'string') return undefined;
      return { type: 'artifact', name: msg.name, contentType: msg.contentType };
    }

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

    // Routine pi session/turn/streaming bookkeeping with no `AgentEvent`
    // equivalent — see `ROUTINE_PI_EVENT_TYPES` below, which mirrors this
    // list so `PiSession`'s unmapped-frame accounting (rpc-client.ts's
    // `recordUnmappedFrame`) can tell "known, expected, silently ignored"
    // apart from "genuinely never seen before" (falls to `default` below).
    case 'agent_start':
    case 'agent_end': // one low-level run; `agent_settled` is BYOK completion
    case 'turn_start':
    case 'turn_end': // pi's own per-LLM-turn boundary, not ours
    case 'message_start':
    case 'message_end':
    case 'bash_execution_update':
    case 'tool_execution_update':
    case 'queue_update':
    case 'compaction_start':
    case 'compaction_end':
    case 'auto_retry_start':
    case 'summarization_retry_scheduled':
    case 'summarization_retry_attempt_start':
    case 'summarization_retry_finished':
    case 'session_info_changed':
    case 'thinking_level_changed':
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Pi RPC message types that are routine, expected, and deliberately have no
 * `AgentEvent` equivalent (kept in sync with the switch cases above sharing
 * this comment). Used only for observability: `PiSession`'s event iterator
 * (pi-adapter.ts) calls `PiRpcClient.recordUnmappedFrame` for any message
 * type that maps to `undefined` AND isn't in this set — i.e. traffic nobody
 * has ever told this adapter to expect. That distinction is what makes a
 * regression like a changed completion event
 * self-diagnosing: a warning fires the first time the new/renamed settle
 * event shows up, instead of the daemon just quietly hanging. `default`-only
 * unknowns (a type not listed in the switch at all) are equally "not
 * routine" and get flagged the same way — this set exists so *routine*
 * traffic doesn't also trip that alarm on every single task.
 */
export const ROUTINE_PI_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_end',
  'bash_execution_update',
  'tool_execution_update',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'session_info_changed',
  'thinking_level_changed',
]);
