import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClaudeControlChannel,
  parseClaudeContextWindow,
} from '../adapters/claude/control-channel';
import {
  mapClaudeMessageToAgentEvents,
  createToolUseCorrelation,
} from '../adapters/claude/events';
afterEach(() => vi.useRealTimers());
describe('bounded Claude control plane', () => {
  it('correlates success ACK to exactly the original request id and shares concurrent interrupts', async () => {
    const channel = createClaudeControlChannel(1000);
    const write = vi.fn(async (_frame: Record<string, unknown>) => {});
    channel.bind(write);
    const promise = channel.interrupt();
    expect(channel.interrupt()).toBe(promise);
    const frame = write.mock.calls[0]![0] as unknown as { request_id: string };
    channel.receive({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'other' },
    });
    channel.receive({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id,
        response: { still_queued: [] },
      },
    });
    expect(await promise).toBe(true);
    expect(write).toHaveBeenCalledWith({
      type: 'control_request',
      request_id: frame.request_id,
      request: { subtype: 'interrupt' },
    });
  });
  it('expires pending control and ignores late ACK after timeout', async () => {
    vi.useFakeTimers();
    const channel = createClaudeControlChannel(30);
    const frames: Record<string, unknown>[] = [];
    channel.bind(async (frame) => {
      frames.push(frame);
    });
    const pending = channel.interrupt();
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toBe(false);
    channel.receive({
      type: 'control_response',
      response: { subtype: 'success', request_id: frames[0]!.request_id },
    });
    const next = channel.interrupt();
    channel.receive({
      type: 'control_response',
      response: { subtype: 'success', request_id: frames[0]!.request_id },
    });
    channel.receive({
      type: 'control_response',
      response: { subtype: 'success', request_id: frames[1]!.request_id },
    });
    expect(await next).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('settles promptly on write failure, error ACK and process close', async () => {
    const channel = createClaudeControlChannel(1000);
    channel.bind(async () => {
      throw new Error('write failed');
    });
    expect(await channel.interrupt()).toBe(false);
    channel.bind(async (frame) => {
      channel.receive({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: frame.request_id,
          error: 'refused',
        },
      });
    });
    expect(await channel.interrupt()).toBe(false);
    channel.bind(async () => {});
    const pending = channel.interrupt();
    channel.closed();
    expect(await pending).toBe(false);
    expect(await channel.interrupt()).toBe(false);
  });
});
describe('Claude context window reserved for S4', () => {
  it('uses the init model key, not an assistant API model or get_context_usage.maxTokens', () => {
    const channel = createClaudeControlChannel(1000);
    channel.receive({
      type: 'system',
      subtype: 'init',
      model: 'group/claude[1m]',
    });
    channel.receive({
      type: 'result',
      modelUsage: {
        'api-model': { contextWindow: 200000 },
        'group/claude[1m]': { contextWindow: 1000000 },
      },
      maxTokens: 500000,
    });
    expect(channel.contextWindow).toBe(1000000);
  });
  it('traverses values and leaves inconsistent or invalid windows unknown', () => {
    expect(
      parseClaudeContextWindow({ alias: { contextWindow: 1000000 } }),
    ).toBe(1000000);
    expect(
      parseClaudeContextWindow({
        a: { contextWindow: 10 },
        b: { contextWindow: 20 },
      }),
    ).toBeNull();
    for (const value of [
      undefined,
      null,
      [],
      { a: { contextWindow: 0 } },
      { a: { contextWindow: '1000' } },
      { a: { contextWindow: NaN } },
    ])
      expect(parseClaudeContextWindow(value)).toBeNull();
  });
  it('adds the authorized provider context window without changing cost counters', () => {
    const mapped = mapClaudeMessageToAgentEvents(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 2 },
        modelUsage: { init: { contextWindow: 1000000 } },
      },
      createToolUseCorrelation(),
      { workspaceDir: '/workspace' },
    );
    expect(mapped.events).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 2, contextWindow: 1000000, contextSource: 'provider' },
      { type: 'turn_end' },
    ]);
  });
  it('aborted_streaming is a runtime turn boundary without diagnostic or typed failure', () => {
    const mapped = mapClaudeMessageToAgentEvents(
      {
        type: 'result',
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_streaming',
        is_error: true,
        usage: {},
      },
      createToolUseCorrelation(),
      { workspaceDir: '/workspace' },
    );
    expect(mapped.events).toEqual([{ type: 'turn_end' }]);
    expect(mapped.terminalFailure).toBeUndefined();
  });
  it('aborted_tools (interrupt during tool phase) is a turn boundary and keeps contextWindow usage', () => {
    const mapped = mapClaudeMessageToAgentEvents(
      {
        type: 'result',
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_tools',
        is_error: true,
        modelUsage: { 'group/claude[1m]': { contextWindow: 1000000 } },
        usage: { input_tokens: 2, output_tokens: 88, cache_creation_input_tokens: 71603, cache_read_input_tokens: 0 },
        errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'],
      },
      createToolUseCorrelation(),
      { workspaceDir: '/workspace' },
    );
    expect(mapped.events.map((e) => e.type)).toEqual(['usage', 'turn_end']);
    expect(mapped.events[0]).toMatchObject({ type: 'usage', contextWindow: 1000000, contextSource: 'provider' });
    expect(mapped.terminalFailure).toBeUndefined();
  });
  it('unknown terminal_reason on error_during_execution stays a failure', () => {
    const mapped = mapClaudeMessageToAgentEvents(
      { type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_something_else', is_error: true },
      createToolUseCorrelation(),
      { workspaceDir: '/workspace' },
    );
    expect(mapped.terminalFailure).toBeDefined();
    expect(mapped.events.some((e) => e.type === 'error')).toBe(true);
  });
  it('other execution errors retain failure and malformed abort frames remain fail-closed', () => {
    for (const message of [
      { type: 'result', subtype: 'error_during_execution', is_error: true },
      {
        type: 'result',
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_streaming',
      },
    ])
      expect(
        mapClaudeMessageToAgentEvents(message, createToolUseCorrelation(), {
          workspaceDir: '/workspace',
        }).terminalFailure,
      ).toBeDefined();
  });
});
