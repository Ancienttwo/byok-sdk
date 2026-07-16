import { describe, expect, it } from 'vitest';
import { mapPiMessageToAgentEvent } from '../adapters/pi/events';
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

  it('maps agent_settled to turn_end (not pi\'s own per-turn turn_end)', () => {
    expect(mapPiMessageToAgentEvent({ type: 'agent_settled' })).toEqual({ type: 'turn_end' });
    expect(mapPiMessageToAgentEvent({ type: 'turn_end', message: {}, toolResults: [] })).toBeUndefined();
  });

  it('maps extension_error to an error event', () => {
    const msg: PiRpcMessage = { type: 'extension_error', extensionPath: '/x.ts', event: 'tool_call', error: 'boom' };
    expect(mapPiMessageToAgentEvent(msg)).toEqual({ type: 'error', message: 'boom' });
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
