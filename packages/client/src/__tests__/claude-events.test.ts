import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createToolUseCorrelation,
  mapClaudeMessageToAgentEvents,
  ROUTINE_CLAUDE_SYSTEM_SUBTYPES,
  type ClaudeStreamMessage,
} from '../adapters/claude/events';

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
    expect(result.events).toEqual([{ type: 'tool_use', tool: 'Bash', input: { command: 'ls' } }]);
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
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi\n' }] },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'tool_result', tool: 'Bash', output: { content: 'hi\n', isError: false } }]);
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
        output: { content: "Claude requested permissions to write to /x/out.txt, but you haven't granted it yet.", isError: true },
      },
    ]);
  });

  it('falls back to "unknown" (never drops the event) when a tool_result has no matching tool_use correlation', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_never_seen', content: 'x' }] },
    };
    const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' });
    expect(result.events).toEqual([{ type: 'tool_result', tool: 'unknown', output: { content: 'x', isError: false } }]);
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
    expect(mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' })).toEqual({
      events: [{ type: 'error', message: 'No conversation found with session ID: bogus' }],
    });
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
    expect(mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' })).toEqual({
      events: [
        { type: 'usage', inputTokens: 50, outputTokens: 0 },
        { type: 'error', message: 'model overloaded' },
      ],
    });
  });

  it('falls back to a generic error message when a failed result has neither errors nor a result string', () => {
    const correlation = createToolUseCorrelation();
    const msg: ClaudeStreamMessage = { type: 'result', is_error: true };
    expect(mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir: '/tmp/ws' })).toEqual({
      events: [{ type: 'error', message: 'claude reported an error result' }],
    });
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
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `File created successfully at: ${filePath}` }] },
        tool_use_result: { type: 'create', filePath, content: 'hi', structuredPatch: [], originalFile: null, userModified: false },
      };
      const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir });
      expect(result.events).toEqual([
        { type: 'tool_result', tool: 'Write', output: { content: `File created successfully at: ${filePath}`, isError: false } },
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
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `File created successfully at: ${filePath}` }] },
        tool_use_result: { type: 'create', filePath, content: 'plan', structuredPatch: [], originalFile: null, userModified: false },
      };
      const result = mapClaudeMessageToAgentEvents(msg, correlation, { workspaceDir });
      expect(result.events).toEqual([
        { type: 'tool_result', tool: 'Write', output: { content: `File created successfully at: ${filePath}`, isError: false } },
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
          output: { content: `Claude requested permissions to write to ${filePath}, but you haven't granted it yet.`, isError: true },
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
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
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
    await expect(fs.access(fixturePath)).resolves.toBeUndefined();
  });
});
