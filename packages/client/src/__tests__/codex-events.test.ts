import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { CodexProjection } from '../adapters/codex/projection';
import { createSessionKernel } from '../../vendor/oar/98be973/shared/session-kernel';
import { RuntimeExecutionFailure } from '../runtime-failure';
function setup() {
  const kernel = createSessionKernel('root');
  const projection = new CodexProjection('/workspace', 'root');
  const output: AgentEvent[] = [];
  const feed = (
    type: string,
    native: unknown,
    origin = 'byok-native',
    sessionId = 'root',
  ) => {
    const body = { type, native, events: [], origin };
    const frame = kernel.frame(body, { sessionId });
    projection.consume(kernel, frame, (e) => output.push(e));
    return frame;
  };
  return { kernel, projection, output, feed };
}
describe('required Codex native projection', () => {
  it('maps structured command input and output without stringification', () => {
    const s = setup();
    s.feed('item/started', {
      item: { type: 'commandExecution', id: 'c', command: 'echo hello' },
    });
    s.feed('item/completed', {
      item: {
        type: 'commandExecution',
        id: 'c',
        command: 'echo hello',
        aggregatedOutput: 'hello',
        exitCode: 0,
        status: 'completed',
      },
    });
    expect(s.output).toEqual([
      {
        type: 'tool_use',
        tool: 'command_execution',
        toolCallId: 'c',
        input: { command: 'echo hello' },
      },
      {
        type: 'tool_result',
        tool: 'command_execution',
        toolCallId: 'c',
        output: {
          command: 'echo hello',
          aggregatedOutput: 'hello',
          exitCode: 0,
          status: 'completed',
        },
      },
    ]);
  });
  it('emits file result and every contained artifact, skipping external paths and deletions', () => {
    const s = setup();
    const changes = [
      { path: '/workspace/a.md', kind: 'add' },
      { path: '/workspace/b.json', kind: 'update' },
      { path: '/outside/c', kind: 'add' },
      { path: '/workspace/deleted', kind: 'delete' },
    ];
    s.feed('item/started', { item: { type: 'fileChange', id: 'f', changes } });
    s.feed('item/completed', {
      item: { type: 'fileChange', id: 'f', changes, status: 'completed' },
    });
    expect(s.output[0]).toMatchObject({ type: 'tool_use', input: { changes } });
    expect(s.output[1]).toMatchObject({
      type: 'tool_result',
      output: { changes, status: 'completed' },
    });
    expect(s.output.slice(2)).toEqual([
      { type: 'artifact', name: 'a.md', contentType: 'text/markdown' },
      { type: 'artifact', name: 'b.json', contentType: 'application/json' },
    ]);
  });
  it.each([undefined, '', '  '])(
    'missing authoritative tool id fails (%s)',
    (id) => {
      const s = setup();
      expect(() =>
        s.feed('item/started', {
          item: { type: 'commandExecution', id, command: 'x' },
        }),
      ).toThrow(RuntimeExecutionFailure);
    },
  );
  it('does not consume empty derived frames with the identical type and native payload', () => {
    const s = setup();
    const native = { item: { type: 'agentMessage', id: 'm', text: 'hello' } };
    s.feed('item/completed', native);
    s.feed('item/completed', native, 'derived');
    expect(s.output).toEqual([{ type: 'progress', text: 'hello' }]);
  });
  it('does not allow a child terminal to end the parent task or collide repeated local ids', () => {
    const s = setup();
    for (const threadId of ['root', 'child'])
      s.feed(
        'item/started',
        {
          threadId,
          item: { type: 'commandExecution', id: 'same', command: 'x' },
        },
        'byok-native',
        threadId,
      );
    s.feed(
      'turn/completed',
      { threadId: 'child', turn: { status: 'completed' } },
      'byok-native',
      'child',
    );
    expect(
      s.output.map((e) => ('toolCallId' in e ? e.toolCallId : null)),
    ).toEqual(['same', '["child",[],"same"]']);
    expect(s.output.some((e) => e.type === 'turn_end')).toBe(false);
  });
  it('replay identity includes the stream instance and each derived ordinal', () => {
    const s = setup();
    const row = s.kernel.frame({
      type: 'item/completed',
      native: {
        item: {
          type: 'fileChange',
          id: 'f',
          changes: [{ path: '/workspace/a.md', kind: 'add' }],
          status: 'completed',
        },
      },
      events: [],
      origin: 'byok-native',
    } as never);
    let ordinal = 0;
    const first: AgentEvent[] = [];
    expect(() =>
      s.projection.consume(s.kernel, row, (e) => {
        if (ordinal++ === 1) throw new Error('sink failed');
        first.push(e);
      }),
    ).toThrow('sink failed');
    s.projection.consume(s.kernel, row, (e) => first.push(e));
    s.projection.consume(s.kernel, row, (e) => first.push(e));
    expect(first.map((e) => e.type)).toEqual(['tool_result', 'artifact']);
    const other = {};
    s.projection.consume(other, row, (e) => first.push(e));
    expect(first).toHaveLength(4);
  });
  it('usage separates last context occupancy from cumulative provider cost', () => {
    const s = setup();
    s.feed('turn/started', { turn: { id: 't' } });
    s.feed('thread/tokenUsage/updated', {
      tokenUsage: {
        last: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: 12,
        },
        total: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
        modelContextWindow: 1000,
      },
    });
    s.feed('turn/completed', { turn: { status: 'completed' } });
    expect(s.output).toEqual([
      {
        type: 'usage',
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningTokens: 1,
        contextTokens: 12, contextWindow: 1000, contextSource: 'provider',
      },
      { type: 'turn_end' },
    ]);
  });
  it('context is last-observed; missing window and null occupancy never reuse prior values', () => {
    const s = setup();
    s.feed('turn/started', { turn: { id: 'one' } });
    s.feed('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 55 }, modelContextWindow: 1000 } });
    s.feed('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 0 } } });
    s.feed('turn/completed', { turn: { status: 'completed' } });
    expect(s.output).toEqual([{ type: 'usage', contextTokens: 0, contextSource: 'provider' }, { type: 'turn_end' }]);
    s.feed('turn/started', { turn: { id: 'two' } });
    s.feed('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: null }, modelContextWindow: 2000 } });
    s.feed('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: null } } });
    s.feed('turn/completed', { turn: { status: 'completed' } });
    expect(s.output.slice(2)).toEqual([{ type: 'usage', contextSource: 'provider' }, { type: 'turn_end' }]);
  });
  it('accounts for every model call in a turn and resets the boundary for the next turn', () => {
    const s = setup();
    s.feed('turn/started', { turn: { id: 'one' } });
    s.feed('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 10, outputTokens: 2 } },
    });
    s.feed('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 25, outputTokens: 7 } },
    });
    s.feed('turn/completed', { turn: { status: 'completed' } });
    s.feed('turn/started', { turn: { id: 'two' } });
    s.feed('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 30, outputTokens: 10 } },
    });
    s.feed('turn/completed', { turn: { status: 'completed' } });
    expect(s.output.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 25, outputTokens: 7 },
      { type: 'usage', inputTokens: 5, outputTokens: 3 },
    ]);
  });
  it('keeps resumed usage unknown until a reliable cumulative boundary exists', () => {
    const kernel = createSessionKernel('root');
    const projection = new CodexProjection('/workspace', 'root', false);
    const out: AgentEvent[] = [];
    const feed = (type: string, native: unknown) => {
      const body = { type, native, origin: 'byok-native', events: [] };
      projection.consume(kernel, kernel.frame(body), (e) => out.push(e));
    };
    feed('turn/started', { turn: { id: 'one' } });
    feed('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 100, outputTokens: 10 } },
    });
    feed('turn/completed', { turn: { status: 'completed' } });
    expect(out).toEqual([{ type: 'turn_end' }]);
    feed('turn/started', { turn: { id: 'two' } });
    feed('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 105, outputTokens: 12 } },
    });
    feed('turn/completed', { turn: { status: 'completed' } });
    expect(out.slice(1)).toEqual([
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'turn_end' },
    ]);
  });
  it('normalizes app-server object patch kinds and does not upload deleted files', () => {
    const s = setup();
    s.feed('item/completed', {
      item: {
        type: 'fileChange',
        id: 'f',
        changes: [
          { path: '/workspace/deleted.txt', kind: { type: 'delete' } },
          { path: '/workspace/new.md', kind: { type: 'add' } },
        ],
        status: 'completed',
      },
    });
    expect(s.output.filter((e) => e.type === 'artifact')).toEqual([
      { type: 'artifact', name: 'new.md', contentType: 'text/markdown' },
    ]);
  });

  it('failed turn yields diagnostics without successful terminal', () => {
    const s = setup();
    s.feed('turn/completed', {
      turn: { status: 'failed', error: { message: 'provider failure' } },
    });
    expect(s.output).toEqual([{ type: 'error', message: 'provider failure' }]);
  });
  it('interrupted items close explicitly without pretending runtime success', () => {
    const s = setup();
    s.feed('item/started', {
      item: { type: 'commandExecution', id: 'c', command: 'sleep' },
    });
    s.feed('turn/completed', { turn: { status: 'interrupted' } });
    expect(s.output[1]).toMatchObject({
      type: 'tool_result',
      output: { status: 'interrupted' },
    });
    expect(s.output[1]).not.toHaveProperty('output.exitCode');
    expect(s.output.at(-1)?.type).toBe('turn_end');
  });
  it('required projection failure escapes the kernel consumer; the native fact remains retained', () => {
    const projection = new CodexProjection('/workspace', 'root');
    const kernel = createSessionKernel('root', {
      onRecord: (r) => projection.consume(kernel, r, () => {}),
    });
    const body = {
      type: 'item/started',
      native: { item: { type: 'commandExecution' } },
      events: [],
      origin: 'byok-native',
    };
    expect(() => kernel.frame(body)).toThrow(RuntimeExecutionFailure);
    expect(kernel.records()).toHaveLength(1);
  });
});
