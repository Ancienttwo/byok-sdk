import { describe, expect, it } from 'vitest';
import { mapPiMessageToAgentEvent, ROUTINE_PI_EVENT_TYPES } from '../adapters/pi/events';
import type { PiRpcMessage } from '../adapters/pi/rpc-client';
import { RuntimeExecutionFailure } from '../runtime-failure';

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
    expect(mapPiMessageToAgentEvent(msg)).toEqual({ type: 'tool_use', tool: 'bash', input: { command: 'ls' }, toolCallId: 'call_1' });
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
      output: { result: { content: [{ type: 'text', text: 'ok' }] } },
      toolCallId: 'call_1',
      isError: false,
    });
  });

  it('maps a native error outcome', () => {
    expect(mapPiMessageToAgentEvent({ type: 'tool_execution_end', toolCallId: 'call_error', toolName: 'bash', result: 'nope', isError: true })).toEqual({
      type: 'tool_result', tool: 'bash', output: { result: 'nope' }, toolCallId: 'call_error', isError: true,
    });
  });

  it('keeps same-name concurrent calls distinct by their native IDs', () => {
    const first = mapPiMessageToAgentEvent({
      type: 'tool_execution_start', toolCallId: 'call_a', toolName: 'bash', args: { command: 'echo one' },
    });
    const second = mapPiMessageToAgentEvent({
      type: 'tool_execution_start', toolCallId: 'call_b', toolName: 'bash', args: { command: 'echo two' },
    });
    expect(first).toMatchObject({ type: 'tool_use', tool: 'bash', toolCallId: 'call_a' });
    expect(second).toMatchObject({ type: 'tool_use', tool: 'bash', toolCallId: 'call_b' });
  });

  it.each([
    { type: 'tool_execution_start', toolName: 'bash', args: {} },
    { type: 'tool_execution_end', toolCallId: '', toolName: 'bash', result: 'x' },
    { type: 'tool_execution_end', toolCallId: '  ', toolName: 'bash', result: 'x' },
  ] satisfies PiRpcMessage[])('fails closed when a bundled tool frame has no valid native ID: %j', (msg) => {
    try {
      mapPiMessageToAgentEvent(msg);
      throw new Error('expected RuntimeExecutionFailure');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeExecutionFailure);
      expect(error).toMatchObject({ phase: 'run', category: 'authority', retry: 'non-retryable' });
    }
  });

  it.each([
    { type: 'tool_execution_end', toolCallId: 'call_missing', toolName: 'bash', result: 'x' },
    { type: 'tool_execution_end', toolCallId: 'call_bad', toolName: 'bash', result: 'x', isError: 'false' },
  ] satisfies PiRpcMessage[])('fails closed when a bundled tool result has no valid native outcome: %j', (msg) => {
    try {
      mapPiMessageToAgentEvent(msg);
      throw new Error('expected RuntimeExecutionFailure');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeExecutionFailure);
      expect(error).toMatchObject({ phase: 'run', category: 'authority', retry: 'non-retryable' });
    }
  });

  it('maps only agent_settled to BYOK turn_end', () => {
    expect(mapPiMessageToAgentEvent({ type: 'agent_settled' })).toEqual({ type: 'turn_end' });
    expect(mapPiMessageToAgentEvent({ type: 'agent_end', messages: [], willRetry: true })).toBeUndefined();
    expect(mapPiMessageToAgentEvent({ type: 'turn_end', message: {}, toolResults: [] })).toBeUndefined();
  });

  it('treats agent_end and retry bookkeeping as routine but keeps agent_settled authoritative', () => {
    expect(ROUTINE_PI_EVENT_TYPES.has('agent_end')).toBe(true);
    expect(ROUTINE_PI_EVENT_TYPES.has('agent_start')).toBe(true);
    expect(ROUTINE_PI_EVENT_TYPES.has('turn_end')).toBe(true);
    expect(ROUTINE_PI_EVENT_TYPES.has('agent_settled')).toBe(false);
    expect(ROUTINE_PI_EVENT_TYPES.has('summarization_retry_scheduled')).toBe(true);
    expect(ROUTINE_PI_EVENT_TYPES.has('bash_execution_update')).toBe(true);
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
