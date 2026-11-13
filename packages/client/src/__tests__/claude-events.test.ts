import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantMessageTracker,
  createToolUseCorrelation,
  mapClaudeMessageToAgentEvents,
  parseClaudeContextWindow,
  ROUTINE_CLAUDE_SYSTEM_SUBTYPES,
  type ClaudeStreamMessage,
} from '../adapters/claude/projection';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { ClaudeStreamSession } from '../adapters/claude/stream-session';
import { memoryClaude } from './fixtures/memory-claude';
import { foldStreamJsonStdout } from '../../vendor/oar/95c6547/shared/stream-json/projection';
import { claudeProjectionProfile, initialClaudeProjection } from '../../vendor/oar/95c6547/runtimes/claude/projection';

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-events-test-'));
}

describe('mapClaudeMessageToAgentEvents', () => {
  it('maps an assistant text block to a progress event', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello there' }] },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result).toEqual({ events: [{ type: 'progress', text: 'Hello there' }] });
  });

  it('ignores thinking and redacted_thinking blocks (never surfaced as progress)', () => {
    const correlation = createToolUseCorrelation();
    for (const type of ['thinking', 'redacted_thinking']) {
      const msg: ClaudeStreamMessage = {
        type: 'assistant',
        message: { content: [{ type, thinking: 'pondering deeply' }] },
      };
      const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
      expect(result.events).toEqual([]);
      expect(result.unmappedLabel).toBeUndefined();
    }
  });

  it('maps a tool_use block to tool_use and records the correlation for later tool_result lookup', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'tool_use', tool: 'Bash', input: { command: 'ls' }, toolCallId: 'toolu_1' }]);
    expect(correlation.toolNameByUseId.get('toolu_1')).toBe('Bash');
  });

  it('flags an unrecognized assistant content-block type as unmapped, once, without dropping other blocks in the same frame', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'before' },
          { type: 'some_future_block_type', payload: 'x' },
        ],
      },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'progress', text: 'before' }]);
    expect(result.unmappedLabel).toBe('assistant-block:some_future_block_type');
  });

  it('maps a tool_result block to tool_result, correlating the tool name from a prior tool_use', () => {
    const correlation = createToolUseCorrelation();
    correlation.toolNameByUseId.set('toolu_1', 'Bash');
    const msg: ClaudeStreamMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi\n', is_error: false }] },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'tool_result', tool: 'Bash', output: { content: 'hi\n' }, toolCallId: 'toolu_1', isError: false }]);
  });

  it('maps a denied tool_result (is_error:true) faithfully — the real headless auto-deny shape', () => {
    const correlation = createToolUseCorrelation();
    correlation.toolNameByUseId.set('toolu_1', 'Write');
    const msg: ClaudeStreamMessage = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: "Claude requested permissions to write to /x/out.txt, but you haven't granted it yet.",
            is_error: true,
          },
        ],
      },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([
      {
        type: 'tool_result',
        tool: 'Write',
        output: { content: "Claude requested permissions to write to /x/out.txt, but you haven't granted it yet." },
        toolCallId: 'toolu_1',
        isError: true,
      },
    ]);
  });

  it('keeps a valid but locally unpaired native ID without deriving a tool match', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_never_seen', content: 'x' }] },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'tool_result', tool: 'unknown', output: { content: 'x' }, toolCallId: 'toolu_never_seen' }]);
  });

  it('keeps same-name concurrent tool calls distinct by their native IDs', () => {
    const correlation = createToolUseCorrelation();
    const uses = mapClaudeMessageToAgentEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'one' } },
          { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'two' } },
        ],
      },
    }, correlation, { workspaceDir: '/tmp/ws' });
    expect(uses.events.map((event) => event.type === 'tool_use' ? event.toolCallId : undefined)).toEqual(['toolu_a', 'toolu_b']);

    const result = mapClaudeMessageToAgentEvents({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'two', is_error: false }] },
    }, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'tool_result', tool: 'Bash', output: { content: 'two' }, toolCallId: 'toolu_b', isError: false }]);
  });

  it.each([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: '', name: 'Bash' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: '  ', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 42, content: 'x' }] } },
  ] satisfies ClaudeStreamMessage[])('fails closed when a bundled tool frame has no valid native ID: %j', (msg) => {
    const result = mapClaudeMessageToAgentEvents(msg, createToolUseCorrelation(), { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([]);
    expect(result.terminalFailure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(result.terminalFailure).toMatchObject({ phase: 'run', retry: 'non-retryable' });
  });

  it('flags a non-tool_result user content block as unmapped', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'user',
      message: { content: [{ type: 'some_new_user_block' }] },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([]);
    expect(result.unmappedLabel).toBe('user-block:some_new_user_block');
  });

  it('maps a successful result to turn_end', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = { type: 'result', subtype: 'success', is_error: false, result: 'done' };
    expect(mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' })).toEqual({ events: [{ type: 'turn_end' }] });
  });

  it('maps a successful result carrying usage to a usage AgentEvent followed by turn_end', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      usage: { input_tokens: 2, cache_creation_input_tokens: 35649, cache_read_input_tokens: 7, output_tokens: 24 },
    };
    expect(mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' })).toEqual({
      events: [
        { type: 'usage', inputTokens: 2, cachedInputTokens: 7, outputTokens: 24 },
        { type: 'turn_end' },
      ],
    });
  });

  it('maps a successful result with an empty usage object to just turn_end (no content-free usage event)', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = { type: 'result', subtype: 'success', is_error: false, result: 'done', usage: {} };
    expect(mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' })).toEqual({ events: [{ type: 'turn_end' }] });
  });

  it('never maps cache_creation_input_tokens onto cachedInputTokens (a distinct, more-expensive-not-cheaper concept)', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      usage: { cache_creation_input_tokens: 35649 },
    };
    expect(mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' })).toEqual({ events: [{ type: 'turn_end' }] });
  });

  it('maps a failed result (is_error:true) to an error event, preferring the errors array', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['No conversation found with session ID: bogus'],
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'error', message: 'No conversation found with session ID: bogus' }]);
    expect(result.terminalFailure).toEqual(expect.objectContaining({
      phase: 'run', retry: 'non-retryable',
    }));
    expect(result.terminalFailure).toBeInstanceOf(RuntimeExecutionFailure);
  });

  it('maps a failed result that still carries partial usage to a usage AgentEvent followed by error', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['model overloaded'],
      usage: { input_tokens: 50, output_tokens: 0 },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([
        { type: 'usage', inputTokens: 50, outputTokens: 0 },
        { type: 'error', message: 'model overloaded' },
    ]);
    expect(result.terminalFailure).toMatchObject({ retry: 'non-retryable' });
  });

  it('falls back to a generic error message when a failed result has neither errors nor a result string', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = { type: 'result', is_error: true };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'error', message: 'claude reported an error result' }]);
    expect(result.terminalFailure).toMatchObject({ retry: 'non-retryable' });
  });

  it('cross-model review (Fix 3): a result with a MISSING is_error is never reported as success — fails closed rather than treating an absent flag as success', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = { type: 'result', subtype: 'success', result: 'done' }; // no is_error at all
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events.some((e) => e.type === 'turn_end')).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'error' });
    expect((result.events[0] as { message: string }).message).toMatch(/missing\/invalid is_error flag/);
  });

  it('cross-model review (Fix 3): a result with a NON-BOOLEAN is_error is never reported as success — fails closed rather than coercing truthiness', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = { type: 'result', subtype: 'success', result: 'done', is_error: 'false' };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events.some((e) => e.type === 'turn_end')).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'error' });
    expect((result.events[0] as { message: string }).message).toMatch(/missing\/invalid is_error flag/);
  });

  it('M4 Fix 1: a MISSING is_error with a usable errors array still fails closed, but no longer silently drops that diagnostic content', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['No conversation found with session ID: bogus'], // no is_error at all
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events.some((e) => e.type === 'turn_end')).toBe(false); // still fail-closed
    expect(result.events).toHaveLength(1);
    const event = result.events[0] as { type: string; message: string };
    expect(event.type).toBe('error');
    expect(event.message).toMatch(/missing\/invalid is_error flag/); // fail-closed verdict preserved
    expect(event.message).toContain('No conversation found with session ID: bogus');
  });

  it('M4 Fix 1: a non-boolean is_error with a usable result string still fails closed, but no longer silently drops that diagnostic content', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'result',
      subtype: 'success',
      is_error: 1, // malformed: neither `true` nor `false`
      result: 'partial output before the flag went missing',
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events.some((e) => e.type === 'turn_end')).toBe(false);
    expect(result.events).toHaveLength(1);
    const event = result.events[0] as { type: string; message: string };
    expect(event.type).toBe('error');
    expect(event.message).toMatch(/missing\/invalid is_error flag/);
    expect(event.message).toContain('partial output before the flag went missing');
  });

  it('M4 Fix 1: a MISSING is_error with NEITHER errors nor result leaves the generic fail-closed message exactly as before (nothing to append)', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = { type: 'result', subtype: 'success' }; // no is_error, no errors, no result
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([
      {
        type: 'error',
        message: 'claude result frame had a missing/invalid is_error flag (got undefined) — treating as failure, fail-closed',
      },
    ]);
  });

  it('M4 Fix 1: an oversized diagnostic payload on a malformed result frame is truncated to a sane bound rather than appended verbatim', () => {
    const correlation = createToolUseCorrelation();
    const hugeResult = 'x'.repeat(5000);
    const msg: ClaudeStreamMessage = { type: 'result', subtype: 'success', result: hugeResult }; // is_error missing
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    const event = result.events[0] as { type: string; message: string };
    expect(event.message.length).toBeLessThan(hugeResult.length);
    expect(event.message).toContain('[truncated]');
    expect(event.message).not.toContain(hugeResult); // the full untruncated string never appears
  });

  it('treats known-routine system subtypes as no-ops, never unmapped', () => {
    const correlation = createToolUseCorrelation();
    for (const subtype of ROUTINE_CLAUDE_SYSTEM_SUBTYPES) {
      const result = mapClaudeMessageToAgentEvents({ type: 'system', subtype }, correlation, { workspaceDir: '/tmp/ws' });
      expect(result).toEqual({ events: [] });
    }
  });

  it('flags an unrecognized system subtype as unmapped (finer-grained than treating all system frames as routine)', () => {
    const correlation = createToolUseCorrelation();
    const result = mapClaudeMessageToAgentEvents({ type: 'system', subtype: 'some_future_subtype' }, correlation, {
      workspaceDir: '/tmp/ws',
    });
    expect(result).toEqual({ events: [], unmappedLabel: 'system:some_future_subtype' });
  });

  it('treats rate_limit_event as routine', () => {
    const correlation = createToolUseCorrelation();
    expect(mapClaudeMessageToAgentEvents({ type: 'rate_limit_event' }, correlation, { workspaceDir: '/tmp/ws' })).toEqual({
      events: [],
    });
  });

  it('flags a genuinely unrecognized top-level frame type as unmapped', () => {
    const correlation = createToolUseCorrelation();
    const result = mapClaudeMessageToAgentEvents({ type: 'some_future_top_level_type' }, correlation, { workspaceDir: '/tmp/ws' });
    expect(result).toEqual({ events: [], unmappedLabel: 'top-level:some_future_top_level_type' });
  });

  describe('artifact detection from tool_use_result (M2-a: no native "artifact" message exists — this is derived)', () => {
    it('emits an artifact event for a successful Write inside the workspace, using a workspace-relative name', async () => {
      const workspaceDir = await tmpWorkspace();
      const correlation = createToolUseCorrelation();
      correlation.toolNameByUseId.set('toolu_1', 'Write');
      const filePath = path.join(workspaceDir, 'out.txt');
      const msg: ClaudeStreamMessage = {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `File created successfully at: ${filePath}`, is_error: false }] },
        tool_use_result: { type: 'create', filePath, content: 'hi', structuredPatch: [], originalFile: null, userModified: false },
      };
      const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir });
      expect(result.events).toEqual([
        { type: 'tool_result', tool: 'Write', output: { content: `File created successfully at: ${filePath}` }, toolCallId: 'toolu_1', isError: false },
        { type: 'artifact', name: 'out.txt', contentType: 'text/plain' },
      ]);
    });

    it('never emits an artifact event for a file written outside the workspace (e.g. plan mode\'s own ~/.claude/plans/*.md side effect)', async () => {
      const workspaceDir = await tmpWorkspace();
      const outsideDir = await tmpWorkspace(); // a sibling tmp dir, NOT inside workspaceDir
      const correlation = createToolUseCorrelation();
      correlation.toolNameByUseId.set('toolu_1', 'Write');
      const filePath = path.join(outsideDir, 'plan.md');
      const msg: ClaudeStreamMessage = {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `File created successfully at: ${filePath}`, is_error: false }] },
        tool_use_result: { type: 'create', filePath, content: 'plan', structuredPatch: [], originalFile: null, userModified: false },
      };
      const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir });
      expect(result.events).toEqual([
        { type: 'tool_result', tool: 'Write', output: { content: `File created successfully at: ${filePath}` }, toolCallId: 'toolu_1', isError: false },
      ]);
    });

    it('never emits an artifact event for a denied (is_error:true) Write', async () => {
      const workspaceDir = await tmpWorkspace();
      const correlation = createToolUseCorrelation();
      correlation.toolNameByUseId.set('toolu_1', 'Write');
      const filePath = path.join(workspaceDir, 'out.txt');
      const msg: ClaudeStreamMessage = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: `Claude requested permissions to write to ${filePath}, but you haven't granted it yet.`,
              is_error: true,
            },
          ],
        },
        // Real claude reports a plain string tool_use_result for a denial (no filePath) — confirmed live.
        tool_use_result: `Error: Claude requested permissions to write to ${filePath}, but you haven't granted it yet.`,
      };
      const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir });
      expect(result.events).toEqual([
        {
        type: 'tool_result',
        tool: 'Write',
        output: { content: `Claude requested permissions to write to ${filePath}, but you haven't granted it yet.` },
        toolCallId: 'toolu_1',
        isError: true,
        },
      ]);
    });

    it('guesses a content type from the file extension, defaulting to application/octet-stream', async () => {
      const workspaceDir = await tmpWorkspace();
      const correlation = createToolUseCorrelation();
      correlation.toolNameByUseId.set('toolu_1', 'Write');
      const filePath = path.join(workspaceDir, 'data.bin');
      const msg: ClaudeStreamMessage = {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] },
        tool_use_result: { type: 'create', filePath, content: '', structuredPatch: [], originalFile: null, userModified: false },
      };
      const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir });
      expect(result.events).toContainEqual({ type: 'artifact', name: 'data.bin', contentType: 'application/octet-stream' });
    });
  });
});

// Sanity-check the fixture path used by claude-adapter.test.ts actually
// exists at the expected location, mirroring pi-events.test.ts's sibling
// test file layout (this file only tests the pure mapper; fixture/process
// integration lives in claude-adapter.test.ts).
describe('fixture path', () => {
  it('fake-claude.mjs exists', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
    await fs.access(fixturePath);
  });
});

describe('AssistantMessageTracker', () => {
  /** Maps each frame and returns, per frame, whether each of its `progress` events starts a message. */
  function starts(frames: ClaudeStreamMessage[]): boolean[][] {
    const correlation = createToolUseCorrelation();
    const tracker = new AssistantMessageTracker();
    return frames.map((frame) => {
      const { events } = mapClaudeMessageToAgentEvents(frame, correlation, { workspaceDir: '/tmp/ws' });
      tracker.observe(frame, events);
      return events.filter((event) => event.type === 'progress').map((event) => tracker.startsMessage(event));
    });
  }
  const assistant = (id: string | undefined, content: unknown[]): ClaudeStreamMessage => ({
    type: 'assistant', message: { ...(id === undefined ? {} : { id }), content },
  });
  const text = (value: string) => ({ type: 'text', text: value });

  it('continues a message across frames that share its id, through thinking and routine system frames', () => {
    expect(starts([
      assistant('msg_1', [text('Part one. ')]),
      { type: 'system', subtype: 'thinking_tokens' },
      assistant('msg_1', [{ type: 'thinking', thinking: '' }]),
      assistant('msg_1', [text('Part two.')]),
    ])).toEqual([[true], [], [], [false]]);
  });

  it('starts a message at each new id, so a repeated answer in a later model call starts again', () => {
    expect(starts([assistant('msg_1', [text('Answer.')]), assistant('msg_2', [text('Answer.')])])).toEqual([[true], [true]]);
  });

  it('starts a message after any non-system frame between frames of the same id', () => {
    expect(starts([assistant('msg_1', [text('A')]), { type: 'rate_limit_event' }, assistant('msg_1', [text('B')])])).toEqual([[true], [], [true]]);
  });

  it('continues within one frame but never across frames that carry no id', () => {
    expect(starts([assistant(undefined, [text('A'), text('B')]), assistant(undefined, [text('C')])])).toEqual([[true, false], [true]]);
  });

  it('lets a message start at its first non-blank text block', () => {
    expect(starts([assistant('msg_1', [text('\n')]), assistant('msg_1', [text('Answer.')])])).toEqual([[true], [true]]);
  });

  it('treats an event it never observed as a message start', () => {
    expect(new AssistantMessageTracker().startsMessage({ type: 'progress', text: 'x' })).toBe(true);
  });
});

describe('stream_event draft deltas (--include-partial-messages)', () => {
  /** Frame order captured from claude 2.1.302: a block's deltas, its `assistant` frame, then its stop. */
  const stream = (id: string, event: Record<string, unknown>): ClaudeStreamMessage => ({
    type: 'stream_event', event, session_id: 's', parent_tool_use_id: null, api_message_id: id,
  });
  const textDelta = (id: string, text: string) => stream(id, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  const assistant = (id: string, content: unknown[]): ClaudeStreamMessage => ({ type: 'assistant', message: { id, content } });
  const block = (id: string, parts: string[]) => [
    stream(id, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...parts.map(part => textDelta(id, part)),
    assistant(id, [{ type: 'text', text: parts.join('') }]),
    stream(id, { type: 'content_block_stop', index: 0 }),
  ];

  /** Per frame: the mapped events, with each progress event's boundary decision. */
  function run(frames: ClaudeStreamMessage[]) {
    const correlation = createToolUseCorrelation();
    const tracker = new AssistantMessageTracker();
    return frames.flatMap((frame) => {
      const { events, unmappedLabel } = mapClaudeMessageToAgentEvents(frame, correlation, { workspaceDir: '/tmp/ws' });
      expect(unmappedLabel).toBeUndefined();
      tracker.observe(frame, events);
      return events.map(event => event.type === 'progress' ? { ...event, startsMessage: tracker.startsMessage(event) } : event);
    });
  }

  it('maps only text deltas, and maps every other stream frame to nothing without a warning', () => {
    expect(run([
      stream('msg_1', { type: 'message_start', message: { id: 'msg_1', content: [] } }),
      stream('msg_1', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      stream('msg_1', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      stream('msg_1', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c2ln' } }),
      stream('msg_1', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command"' } }),
      stream('msg_1', { type: 'content_block_stop', index: 0 }),
      stream('msg_1', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      stream('msg_1', { type: 'message_stop' }),
      textDelta('msg_1', 'Hi'),
    ])).toEqual([{ type: 'message_draft_delta', text: 'Hi', startsMessage: true }]);
  });

  it('keeps every block of one message in one message and starts the draft once per message id', () => {
    expect(run([
      stream('msg_2', { type: 'message_start', message: { id: 'msg_2', content: [] } }),
      ...block('msg_2', ['Part ', 'one.']),
      ...block('msg_2', [' Part ', 'two.']),
      ...block('msg_3', ['Again.']),
    ])).toEqual([
      { type: 'message_draft_delta', text: 'Part ', startsMessage: true },
      { type: 'message_draft_delta', text: 'one.', startsMessage: false },
      { type: 'progress', text: 'Part one.', startsMessage: true },
      { type: 'message_draft_delta', text: ' Part ', startsMessage: false },
      { type: 'message_draft_delta', text: 'two.', startsMessage: false },
      { type: 'progress', text: ' Part two.', startsMessage: false },
      { type: 'message_draft_delta', text: 'Again.', startsMessage: true },
      { type: 'progress', text: 'Again.', startsMessage: true },
    ]);
  });

  it('starts the draft at the first non-blank delta of a message', () => {
    expect(run([textDelta('msg_4', '\n'), textDelta('msg_4', 'Answer.')]).map(event => event.type === 'message_draft_delta' && event.startsMessage))
      .toEqual([false, true]);
  });
});

describe('Claude context window reserved for S4', () => {
  it('uses the init model key, not an assistant API model or get_context_usage.maxTokens', () => {
    expect(parseClaudeContextWindow({
      'api-model': { contextWindow: 200000 },
      'group/claude[1m]': { contextWindow: 1000000 },
    }, 'group/claude[1m]')).toBe(1000000);
  });
  it('the session reads the window of the root init model, not a subagent init model', async () => {
    const claude = memoryClaude();
    const stream = new ClaudeStreamSession(claude.child as never);
    await stream.open({ env: {}, maxRetainedBytes: 16 * 1024 * 1024, mcpServers: {}, onFrame: () => {}, onExit: () => {}, onAppRequest: () => {} });
    expect((await stream.raw.prompt('go')).response.body.kind).toBe('accepted');
    claude.send({ type: 'system', subtype: 'init', model: 'root-model', session_id: 'session-1' });
    claude.send({ type: 'system', subtype: 'init', model: 'child-model', session_id: 'session-1', parent_tool_use_id: 'toolu_task' });
    claude.send({ type: 'result', subtype: 'success', is_error: false, usage: {},
      modelUsage: { 'child-model': { contextWindow: 200000 }, 'root-model': { contextWindow: 1000000 } } });
    expect(stream.contextWindow).toBe(1000000);
    expect(await stream.sessionRef).toBe('session-1');
  });
  it('elides old frame payloads past the retention budget while the session runs and every frame is read whole', async () => {
    const claude = memoryClaude();
    const stream = new ClaudeStreamSession(claude.child as never);
    const read: number[] = [];
    await stream.open({ env: {}, maxRetainedBytes: 16 * 1024 * 1024, mcpServers: {}, onFrame: frame => { read.push(JSON.stringify(frame).length); }, onExit: () => {}, onAppRequest: () => {} });
    expect((await stream.raw.prompt('go')).response.body.kind).toBe('accepted');
    const text = 'x'.repeat(7 * 1024 * 1024);
    for (const id of ['a', 'b', 'c']) claude.send({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
    const frames = stream.raw.records().filter(record => record.kind === 'frame') as unknown as Array<{ body: { native: unknown; elided?: true } }>;
    expect(frames[0]!.body).toMatchObject({ native: null, elided: true });
    expect(frames.at(-1)!.body.native).not.toBeNull();
    expect(read.every(length => length > text.length)).toBe(true);
    expect((await stream.raw.prompt('busy')).response.body).toMatchObject({ kind: 'rejected', code: 'busy' });
  });
  it('remembers only tool uses inside an agent, with unchanged attribution (#1940)', () => {
    let state = initialClaudeProjection;
    const fold = (message: Record<string, unknown>) => {
      const folded = foldStreamJsonStdout(claudeProjectionProfile, state, message);
      state = folded.state;
      return folded.commands.find(command => command.kind === 'frame')?.agentPath;
    };
    const toolUse = (id: string, parent: string | null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Task', input: {} }] } });
    for (let i = 0; i < 100; i++) fold(toolUse(`root-${i}`, null));
    expect(state.agents.size).toBe(0);
    expect(fold(toolUse('nested', 'root-7'))).toEqual(['root-7']);
    expect([...state.agents]).toEqual([['nested', ['root-7']]]);
    expect(fold({ type: 'assistant', parent_tool_use_id: 'nested', message: { id: 'm-x', role: 'assistant', content: [{ type: 'text', text: 'deep' }] } })).toEqual(['root-7', 'nested']);
    // A root tool use that reuses the id drops the old ancestors.
    fold(toolUse('nested', null));
    expect(state.agents.size).toBe(0);
    expect(fold({ type: 'assistant', parent_tool_use_id: 'nested', message: { id: 'm-y', role: 'assistant', content: [{ type: 'text', text: 'again' }] } })).toEqual(['nested']);
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

describe('a refused or unwritten interrupt leaves the turn as it was (#2037)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const outcome = (stream: ClaudeStreamSession) => (stream.raw.records() as unknown as Array<{ kind: string; body?: { events?: Array<{ kind: string; outcome?: { kind: string } }> } }>)
    .flatMap(record => record.kind === 'frame' ? record.body?.events ?? [] : []).find(event => event.kind === 'turn_ended')?.outcome?.kind;
  async function opened(...args: Parameters<typeof memoryClaude>) {
    vi.useFakeTimers();
    const claude = memoryClaude(...args);
    const stream = new ClaudeStreamSession(claude.child as never);
    await stream.open({ env: {}, maxRetainedBytes: 16 * 1024 * 1024, mcpServers: {}, onFrame: () => {}, onExit: () => {}, onAppRequest: () => {} });
    expect((await stream.raw.prompt('go')).response.body.kind).toBe('accepted');
    return { claude, stream };
  }
  const answer = (claude: ReturnType<typeof memoryClaude>, n: number, subtype: 'success' | 'error') => {
    claude.send({ type: 'control_response', response: { subtype, request_id: `interrupt-${n}`, ...(subtype === 'error' ? { error: 'interrupt refused' } : { response: {} }) } });
  };
  const success = { type: 'result', subtype: 'success', is_error: false, usage: {} };
  it.each([
    ['an interrupt write that throws', ['interrupt', 'throw'], () => {}],
    ['an interrupt write that rejects later', ['interrupt', 'reject'], () => {}],
    ['an interrupt Claude refuses after its result', [], (claude: ReturnType<typeof memoryClaude>) => { answer(claude, 1, 'error'); }],
  ] as const)('%s: the abort is rejected, no fallback kill, and the result that arrived meanwhile completes', async (_label, args, settle) => {
    const { claude, stream } = await opened(...args);
    const abort = stream.raw.abort();
    claude.send(success);
    expect(outcome(stream)).toBeUndefined();
    settle(claude);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await abort).response.body.kind).toBe('rejected');
    expect(claude.kills()).toBe(0);
    expect(outcome(stream)).toBe('completed');
  });
  it('an interrupt never answered after its result is accepted at the fallback and the turn ends aborted (#2094)', async () => {
    const { claude, stream } = await opened();
    const abort = stream.raw.abort();
    claude.send(success);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await abort).response.body.kind).toBe('accepted');
    expect(claude.kills()).toBe(1);
    claude.exit(null);
    expect(outcome(stream)).toBe('aborted');
  });
  it('a fallback kill with queued input does not dispatch the next turn to the killed process', async () => {
    const { claude, stream } = await opened();
    expect((await stream.raw.queue('next', { inputId: 'next' })).response.body.kind).toBe('accepted');
    const abort = stream.raw.abort();
    claude.send(success);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await abort).response.body.kind).toBe('accepted');
    expect(claude.kills()).toBe(1);
    claude.exit(null);
    expect(outcome(stream)).toBe('aborted');
    expect(claude.written.filter(frame => (frame as { type?: string }).type === 'user')).toHaveLength(1);
  });
  it.each([
    ['unanswered', () => {}],
    ['answered before its acknowledgement', (claude: ReturnType<typeof memoryClaude>) => { answer(claude, 1, 'success'); }],
  ] as const)('an interrupt write never acknowledged and %s counts as written: the abort is accepted and the fallback kills', async (_label, settle) => {
    const { claude, stream } = await opened('interrupt', 'hang');
    const abort = stream.raw.abort();
    settle(claude);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await abort).response.body.kind).toBe('accepted');
    expect(claude.kills()).toBe(1);
  });
  it('a refused second interrupt keeps the mark of an accepted first one', async () => {
    const { claude, stream } = await opened();
    const first = stream.raw.abort();
    answer(claude, 1, 'success');
    expect((await first).response.body.kind).toBe('accepted');
    const second = stream.raw.abort();
    answer(claude, 2, 'error');
    expect((await second).response.body.kind).toBe('rejected');
    claude.send({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_streaming', is_error: true, usage: {} });
    expect(outcome(stream)).toBe('aborted');
  });
});
