import { classifyToolCall } from '../tool-authorization';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { MessageDraftDelta } from '../types';
import { CodexProjection } from '../adapters/codex/projection';
import { createSessionKernel } from '../../vendor/oar/51b83c9/shared/session-kernel';
import { RuntimeExecutionFailure } from '../runtime-failure';
function setup() {
  const kernel = createSessionKernel('root');
  const projection = new CodexProjection('/workspace', 'root');
  const output: Array<AgentEvent | MessageDraftDelta> = [];
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
    const first: Array<AgentEvent | MessageDraftDelta> = [];
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
    const out: Array<AgentEvent | MessageDraftDelta> = [];
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
  it('a projection failure stays inside the kernel observer; the native fact remains retained', () => {
    // The kernel swallows observer errors, so the adapter's record consumer fails the session itself.
    const projection = new CodexProjection('/workspace', 'root');
    const kernel = createSessionKernel('root');
    const failures: unknown[] = [];
    kernel.rawEvents((r) => {
      try { projection.consume(kernel, r, () => {}); } catch (error) { failures.push(error); throw error; }
    });
    const body = {
      type: 'item/started',
      native: { item: { type: 'commandExecution' } },
      events: [],
      origin: 'byok-native',
    };
    expect(() => kernel.frame(body)).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(RuntimeExecutionFailure);
    expect(kernel.records()).toHaveLength(1);
  });
});

it('retains native MCP identity on start, completion and interrupted closure without inferring builtins', () => {
  const s = setup();
  const item = { type: 'mcpToolCall', id: 'mcp1', server: 'market__feed', tool: 'get__quote', arguments: {} };
  s.feed('item/started', { item });
  s.feed('item/completed', { item: { ...item, result: {}, status: 'completed' } });
  s.feed('item/started', { item: { ...item, id: 'mcp2' } });
  s.feed('turn/completed', { turn: { status: 'interrupted' } });
  const tools = s.output.filter(e => e.type === 'tool_use' || e.type === 'tool_result');
  expect(tools).toHaveLength(4);
  for (const event of tools) expect(event).toHaveProperty('mcp', { server: 'market__feed', tool: 'get__quote' });
  const native = setup();
  native.feed('item/started', { item: { type: 'commandExecution', id: 'shell', command: 'mcp__market__feed__get__quote' } });
  expect(native.output[0]).not.toHaveProperty('mcp');
});

it('uses native MCP completion metadata even without a matching start', () => {
  const s = setup();
  s.feed('item/completed', { item: { type: 'mcpToolCall', id: 'only-result', server: 'quotes', tool: 'get', result: {}, status: 'completed' } });
  expect(s.output).toMatchObject([{ type: 'tool_result', mcp: { server: 'quotes', tool: 'get' } }]);
  const unknown = setup();
  unknown.feed('item/started', { item: { type: 'mcpToolCall', id: 'missing', arguments: { server: 'untrusted', tool: 'guess' } } });
  expect(unknown.output[0]).not.toHaveProperty('mcp');
});
describe('Codex agentMessage draft deltas', () => {
  const delta = (itemId: string, text: string, turnId = 'turn-1') => ({ threadId: 'root', turnId, itemId, delta: text });

  it('maps deltas of the active turn and starts a draft at the first non-blank delta of each item', () => {
    const s = setup();
    s.feed('turn/started', { threadId: 'root', turn: { id: 'turn-1' } });
    for (const [itemId, text] of [['m1', ' '], ['m1', 'Hi'], ['m1', ' there'], ['m2', 'Next']])
      s.feed('item/agentMessage/delta', delta(itemId!, text!));
    s.feed('item/completed', { threadId: 'root', turnId: 'turn-1', item: { id: 'm2', type: 'agentMessage', text: 'Next' } });
    expect(s.output).toEqual([
      { type: 'message_draft_delta', text: ' ', startsMessage: false },
      { type: 'message_draft_delta', text: 'Hi', startsMessage: true },
      { type: 'message_draft_delta', text: ' there', startsMessage: false },
      { type: 'message_draft_delta', text: 'Next', startsMessage: true },
      { type: 'progress', text: 'Next' },
    ]);
  });

  it('drops a delta of a stale turn and a delta without string text', () => {
    const s = setup();
    s.feed('turn/started', { threadId: 'root', turn: { id: 'turn-2' } });
    s.feed('item/agentMessage/delta', delta('old', 'STALE', 'turn-1'));
    s.feed('item/agentMessage/delta', { threadId: 'root', turnId: 'turn-2', itemId: 'm1', delta: 7 });
    expect(s.output).toEqual([]);
  });
});


describe('Codex projected file-change risk classification', () => {
  it.each([
    { changes: [{ path: '/workspace/local', kind: { type: 'add' } }], reasons: [] },
    ...['add', 'update', 'delete'].map(kind => ({ changes: [{ path: '/outside/file', kind: { type: kind } }], reasons: ['write-outside-workspace'] })),
    { changes: [{ path: '/outside/file', kind: { type: 'read' } }], reasons: [] },
    { changes: [{ path: '/workspace/local', kind: { type: 'add' } }, { path: '/Users/agent/.ssh/id_ed25519', kind: { type: 'update' } }], reasons: ['sensitive-path', 'write-outside-workspace'] },
    { changes: [{ path: '/workspace/local', kind: { type: 'update', movePath: '/outside/moved' } }], reasons: ['write-outside-workspace'] },
  ])('classifies native changes $changes through the real projection', ({ changes, reasons }) => {
    const s = setup();
    s.feed('item/started', { item: { type: 'fileChange', id: 'risk', changes } });
    const event = s.output[0];
    if (event?.type !== 'tool_use') throw new Error('missing projected tool_use');
    expect(event.tool).toBe('file_change');
    const risk = classifyToolCall({ toolName: event.tool, input: event.input as Record<string, unknown>, cwd: '/workspace' }, '/workspace', '/Users/agent');
    expect(risk.level === 'high' ? [...risk.reasons].sort() : []).toEqual(reasons);
  });
});
