import type { AgentEvent } from '@byok/protocol';
import type { PiRpcMessage } from './rpc-client';

/**
 * ROOT CAUSE of the 2026-07-16 live GLM run's "finding #2" hang (task stuck
 * `Running` forever after pi streamed its final answer; pi process alive,
 * idle, no sockets, only stdio pipes): this mapper used to listen for a pi
 * event type `agent_settled` to know a whole run had finished. That type
 * does not exist anywhere in the real, installed
 * `@earendil-works/pi-coding-agent@0.74.2` package — not in its bundled
 * `docs/rpc.md`, not in `dist/modes/rpc/rpc-types.d.ts`, not in
 * `pi-agent-core`'s own `AgentEvent` union (`dist/types.d.ts`), and not
 * observed even once across live probes against real GLM traffic (raw JSONL
 * frame capture). The real "whole run is done, pi is idle again" signal is
 * `agent_end` — confirmed both by `pi-agent-core`'s own doc comment ("
 * `agent_end` is the last event emitted for a run... The agent becomes idle
 * only after those listeners finish") and empirically: a live run's frame
 * sequence ended `...turn_end (tool call), ..., turn_end (final text),
 * agent_end` with nothing further arriving even after an 8s idle-grace
 * window. Because this switch had no `agent_end` case, it fell to
 * `default: return undefined` — silently dropped — so `task-runner.ts`'s
 * `pump()` loop never saw a `turn_end` `AgentEvent` and blocked forever on
 * the next one. This repo's own fixture (`fake-pi.mjs`) masked the bug for
 * the whole M0/M1 test suite by emitting a fictional `agent_settled` frame
 * of its own alongside the real `agent_end` one — fixed alongside this
 * change (see fake-pi.mjs's doc comment).
 *
 * `agent_end` (not pi's own per-LLM-turn `turn_end`) is what maps to our
 * `turn_end`: a single pi prompt can produce several internal turns (tool
 * round-trips, each ending its own real `turn_end`); only once the whole
 * run is settled (no auto-retry, compaction-retry, or queued continuation
 * left) is the task actually done. Forwarding pi's own `turn_end` 1:1 would
 * emit multiple confusing `turn_end`s for what the daemon must treat as one
 * task — empirically confirmed: a single-tool-call prompt produced two real
 * `turn_end` frames (one after the tool call, one after the final text) and
 * exactly one `agent_end`.
 *
 * Returns undefined for pi messages with no protocol equivalent (session/
 * compaction/retry bookkeeping — see `ROUTINE_PI_EVENT_TYPES` below —
 * extension UI dialogs, which never reach here at all in production since
 * `PiRpcClient` answers them itself before they'd ever be queued as an
 * event; see rpc-client.ts).
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

    case 'agent_end':
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
    case 'turn_start':
    case 'turn_end': // pi's own per-LLM-turn boundary, not ours — see `agent_end` above
    case 'message_start':
    case 'message_end':
    case 'tool_execution_update':
    case 'queue_update':
    case 'compaction_start':
    case 'compaction_end':
    case 'auto_retry_start':
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
 * regression like this file's root-cause bug (`agent_end` going unhandled)
 * self-diagnosing: a warning fires the first time the new/renamed settle
 * event shows up, instead of the daemon just quietly hanging. `default`-only
 * unknowns (a type not listed in the switch at all) are equally "not
 * routine" and get flagged the same way — this set exists so *routine*
 * traffic doesn't also trip that alarm on every single task.
 */
export const ROUTINE_PI_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent_start',
  'turn_start',
  'turn_end',
  'message_start',
  'message_end',
  'tool_execution_update',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'session_info_changed',
  'thinking_level_changed',
]);
