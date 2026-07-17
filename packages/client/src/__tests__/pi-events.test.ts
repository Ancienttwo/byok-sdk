import { describe, expect, it } from 'vitest';
import { mapPiMessageToAgentEvent, ROUTINE_PI_EVENT_TYPES } from '../adapters/pi/events';
import type { PiRpcMessage } from '../adapters/pi/rpc-client';

describe('mapPiMessageToAgentEvent', () => {
  it('maps a text_delta message_update to a progress event', () => {
    const msg: PiRpcMessage = {
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
    };
    expect(mapPiMessageToAgentEvent(msg)).toEqual({ type: 'progress', text: 'Hello' });
  });

  it('ignores non-text_delta message_update sub-events (e.g. thinking, toolcall deltas)', () => {
    const msg: PiRpcMessage = {
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' },
    };
    expect(mapPiMessageToAgentEvent(msg)).toBeUndefined();
  });

  it('maps tool_execution_start to tool_use', () => {
    const msg: PiRpcMessage = {
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'ls' },
    };
    expect(mapPiMessageToAgentEvent(msg)).toEqual({ type: 'tool_use', tool: 'bash', input: { command: 'ls' } });
  });

  it('maps tool_execution_end to tool_result, carrying isError', () => {
    const msg: PiRpcMessage = {
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    };
    expect(mapPiMessageToAgentEvent(msg)).toEqual({
      type: 'tool_result',
      tool: 'bash',
      output: { result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
    });
  });

  it('maps agent_end to turn_end (not pi\'s own per-turn turn_end) — confirmed root cause of the 2026-07-16 hang', () => {
    // `agent_end` is pi's real "whole run settled" event (confirmed against
    // pi-agent-core's own AgentEvent doc comment and live GLM traffic — see
    // events.ts's doc comment). pi's own per-LLM-turn `turn_end` fires once
    // per internal turn (tool round-trip) and must stay unmapped, or a
    // multi-turn prompt would emit several confusing `turn_end`s for what
    // the daemon treats as one task.
    expect(mapPiMessageToAgentEvent({ type: 'agent_end', messages: [] })).toEqual({ type: 'turn_end' });
    expect(mapPiMessageToAgentEvent({ type: 'turn_end', message: {}, toolResults: [] })).toBeUndefined();
  });

  it('agent_settled is not a real pi event type and is no longer specially handled', () => {
    // This mapper used to listen for `agent_settled` instead of `agent_end`
    // — a type that does not exist anywhere in the real, installed
    // @earendil-works/pi-coding-agent@0.74.2 package (confirmed by grepping
    // its dist/ and docs/rpc.md). That mismatch is the confirmed root cause
    // of the live GLM run's "task stuck Running forever" finding: real pi
    // never emitted the frame this mapper was waiting for. Kept as an
    // explicit regression test — if `agent_settled` shows up again, it
    // must NOT silently start mapping to `turn_end` without a real,
    // verified pi event to justify it.
    expect(mapPiMessageToAgentEvent({ type: 'agent_settled' })).toBeUndefined();
  });

  it('ROUTINE_PI_EVENT_TYPES lists exactly the switch\'s other silently-ignored cases, and does not include agent_end', () => {
    expect(ROUTINE_PI_EVENT_TYPES.has('agent_end')).toBe(false);
    expect(ROUTINE_PI_EVENT_TYPES.has('agent_start')).toBe(true);
    expect(ROUTINE_PI_EVENT_TYPES.has('turn_end')).toBe(true);
    expect(ROUTINE_PI_EVENT_TYPES.has('agent_settled')).toBe(false);
  });

  it('maps extension_error to an error event', () => {
    const msg: PiRpcMessage = { type: 'extension_error', extensionPath: '/x.ts', event: 'tool_call', error: 'boom' };
    expect(mapPiMessageToAgentEvent(msg)).toEqual({ type: 'error', message: 'boom' });
  });

  it('maps a well-formed artifact message 1:1 (fixture-only convention — M1-4 blob-path e2e)', () => {
    expect(mapPiMessageToAgentEvent({ type: 'artifact', name: 'big.bin', contentType: 'application/octet-stream' })).toEqual({
      type: 'artifact',
      name: 'big.bin',
      contentType: 'application/octet-stream',
    });
  });

  it('drops a malformed artifact message missing name/contentType', () => {
    expect(mapPiMessageToAgentEvent({ type: 'artifact', name: 'big.bin' })).toBeUndefined();
    expect(mapPiMessageToAgentEvent({ type: 'artifact', contentType: 'text/plain' })).toBeUndefined();
  });

  it('maps a failed auto_retry_end to an error event, but a successful one to nothing', () => {
    expect(mapPiMessageToAgentEvent({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'still down' })).toEqual({
      type: 'error',
      message: 'still down',
    });
    expect(mapPiMessageToAgentEvent({ type: 'auto_retry_end', success: true, attempt: 2 })).toBeUndefined();
  });

  it('drops unrelated bookkeeping messages (compaction, queue_update, agent_start, etc.)', () => {
    expect(mapPiMessageToAgentEvent({ type: 'agent_start' })).toBeUndefined();
    expect(mapPiMessageToAgentEvent({ type: 'compaction_start', reason: 'manual' })).toBeUndefined();
    expect(mapPiMessageToAgentEvent({ type: 'queue_update', steering: [], followUp: [] })).toBeUndefined();
    expect(mapPiMessageToAgentEvent({ type: 'extension_ui_request', id: 'x', method: 'confirm' })).toBeUndefined();
  });
});
