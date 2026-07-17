import { describe, expect, it } from 'vitest';
import { isRoutineCodexEvent, mapCodexEventToAgentEvents, ROUTINE_CODEX_EVENT_TYPES, unmappedFrameKey } from '../adapters/codex/events';
import type { CodexRawEvent } from '../adapters/codex/process-runner';

const WORKSPACE = '/workspace/task-1';

describe('mapCodexEventToAgentEvents', () => {
  it('maps turn.completed to turn_end (usage is real but has no AgentEvent wire slot — dropped)', () => {
    const evt: CodexRawEvent = {
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
    };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([{ type: 'turn_end' }]);
  });

  it('maps turn.failed to an error event, never to turn_end', () => {
    const evt: CodexRawEvent = { type: 'turn.failed', error: { message: 'boom' } };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('maps a top-level error to an error event', () => {
    const evt: CodexRawEvent = { type: 'error', message: 'top-level failure' };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([{ type: 'error', message: 'top-level failure' }]);
  });

  it('maps item.completed agent_message to progress', () => {
    const evt: CodexRawEvent = { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'hello' } };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([{ type: 'progress', text: 'hello' }]);
  });

  it('ignores an item.started agent_message (never observed on real codex — only .completed)', () => {
    const evt: CodexRawEvent = { type: 'item.started', item: { id: 'item_1', type: 'agent_message', text: 'hello' } };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([]);
  });

  it('maps item.started command_execution to tool_use', () => {
    const evt: CodexRawEvent = {
      type: 'item.started',
      item: { id: 'item_2', type: 'command_execution', command: 'echo hi', aggregated_output: '', exit_code: null, status: 'in_progress' },
    };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([
      { type: 'tool_use', tool: 'command_execution', input: { command: 'echo hi' } },
    ]);
  });

  it('maps item.completed command_execution to tool_result, carrying exit code and status', () => {
    const evt: CodexRawEvent = {
      type: 'item.completed',
      item: { id: 'item_2', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' },
    };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([
      {
        type: 'tool_result',
        tool: 'command_execution',
        output: { command: 'echo hi', aggregatedOutput: 'hi\n', exitCode: 0, status: 'completed' },
      },
    ]);
  });

  it('maps item.completed file_change to tool_result plus an artifact event for an add, using a workspace-relative name', () => {
    const evt: CodexRawEvent = {
      type: 'item.completed',
      item: {
        id: 'item_3',
        type: 'file_change',
        changes: [{ path: `${WORKSPACE}/output.txt`, kind: 'add' }],
        status: 'completed',
      },
    };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([
      {
        type: 'tool_result',
        tool: 'file_change',
        output: { changes: [{ path: `${WORKSPACE}/output.txt`, kind: 'add' }], status: 'completed' },
      },
      { type: 'artifact', name: 'output.txt', contentType: 'text/plain' },
    ]);
  });

  it('a file_change under a nested relative path preserves the subdirectory in the artifact name', () => {
    const evt: CodexRawEvent = {
      type: 'item.completed',
      item: { id: 'item_3', type: 'file_change', changes: [{ path: `${WORKSPACE}/sub/dir/data.json`, kind: 'update' }], status: 'completed' },
    };
    const mapped = mapCodexEventToAgentEvents(evt, WORKSPACE);
    expect(mapped[1]).toEqual({ type: 'artifact', name: 'sub/dir/data.json', contentType: 'application/json' });
  });

  it('an unrecognized extension falls back to application/octet-stream', () => {
    const evt: CodexRawEvent = {
      type: 'item.completed',
      item: { id: 'item_3', type: 'file_change', changes: [{ path: `${WORKSPACE}/binary.dat`, kind: 'add' }], status: 'completed' },
    };
    const mapped = mapCodexEventToAgentEvents(evt, WORKSPACE);
    expect(mapped[1]).toEqual({ type: 'artifact', name: 'binary.dat', contentType: 'application/octet-stream' });
  });

  it('drops a deleted file_change entry (nothing to upload) and emits only tool_result', () => {
    const evt: CodexRawEvent = {
      type: 'item.completed',
      item: { id: 'item_3', type: 'file_change', changes: [{ path: `${WORKSPACE}/gone.txt`, kind: 'delete' }], status: 'completed' },
    };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([
      { type: 'tool_result', tool: 'file_change', output: { changes: [{ path: `${WORKSPACE}/gone.txt`, kind: 'delete' }], status: 'completed' } },
    ]);
  });

  // task-runner.ts's `openArtifact` resolves an artifact `name` via
  // `path.resolve(realWorkspaceDir, name)`, which returns an absolute second
  // argument VERBATIM (unlike path.join) — so a file_change whose absolute
  // path lands genuinely outside the given workspaceDir must never be
  // forwarded as-is; this mapper fails closed (skips it) instead of handing
  // downstream code something that could defeat its own containment check.
  it('skips (never forwards) a file_change whose absolute path resolves outside the given workspaceDir', () => {
    const evt: CodexRawEvent = {
      type: 'item.completed',
      item: { id: 'item_3', type: 'file_change', changes: [{ path: '/etc/passwd', kind: 'add' }], status: 'completed' },
    };
    const mapped = mapCodexEventToAgentEvents(evt, WORKSPACE);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.type).toBe('tool_result');
    expect(mapped.some((e) => e.type === 'artifact')).toBe(false);
  });

  it('maps item.completed error to an error event (forwarded honestly — informational, not necessarily fatal)', () => {
    const evt: CodexRawEvent = {
      type: 'item.completed',
      item: { id: 'item_0', type: 'error', message: 'Exceeded skills context budget of 2%.' },
    };
    expect(mapCodexEventToAgentEvents(evt, WORKSPACE)).toEqual([{ type: 'error', message: 'Exceeded skills context budget of 2%.' }]);
  });

  it('drops thread.started/turn.started (routine — thread.started is consumed upstream in codex-adapter.ts)', () => {
    expect(mapCodexEventToAgentEvents({ type: 'thread.started', thread_id: 'x' }, WORKSPACE)).toEqual([]);
    expect(mapCodexEventToAgentEvents({ type: 'turn.started' }, WORKSPACE)).toEqual([]);
  });

  it('drops a genuinely unrecognized top-level or item type (falls to the safe default)', () => {
    expect(mapCodexEventToAgentEvents({ type: 'session.configured' }, WORKSPACE)).toEqual([]);
    expect(
      mapCodexEventToAgentEvents({ type: 'item.completed', item: { id: 'x', type: 'reasoning', text: 'thinking' } }, WORKSPACE),
    ).toEqual([]);
  });

  it('never produces a needs_approval AgentEvent for any known frame shape (codex exec has no wire-visible approval signal)', () => {
    const shapes: CodexRawEvent[] = [
      { type: 'thread.started', thread_id: 'x' },
      { type: 'turn.started' },
      { type: 'turn.completed', usage: {} },
      { type: 'turn.failed', error: { message: 'x' } },
      { type: 'item.completed', item: { id: 'x', type: 'error', message: 'x' } },
      { type: 'item.completed', item: { id: 'x', type: 'agent_message', text: 'x' } },
    ];
    for (const shape of shapes) {
      expect(mapCodexEventToAgentEvents(shape, WORKSPACE).some((e) => e.type === 'needs_approval')).toBe(false);
    }
  });
});

describe('isRoutineCodexEvent / unmappedFrameKey (unmapped-frame accounting)', () => {
  it('ROUTINE_CODEX_EVENT_TYPES contains exactly thread.started and turn.started', () => {
    expect(ROUTINE_CODEX_EVENT_TYPES.has('thread.started')).toBe(true);
    expect(ROUTINE_CODEX_EVENT_TYPES.has('turn.started')).toBe(true);
    expect(ROUTINE_CODEX_EVENT_TYPES.size).toBe(2);
  });

  it('isRoutineCodexEvent is true only for the routine set', () => {
    expect(isRoutineCodexEvent({ type: 'thread.started', thread_id: 'x' })).toBe(true);
    expect(isRoutineCodexEvent({ type: 'turn.started' })).toBe(true);
    expect(isRoutineCodexEvent({ type: 'turn.completed', usage: {} })).toBe(false);
    expect(isRoutineCodexEvent({ type: 'session.configured' })).toBe(false);
  });

  it('unmappedFrameKey folds in the nested item.type for item.* frames', () => {
    expect(unmappedFrameKey({ type: 'item.completed', item: { id: 'x', type: 'reasoning' } })).toBe('item.completed:reasoning');
    expect(unmappedFrameKey({ type: 'item.started', item: { id: 'x', type: 'mcp_tool_call' } })).toBe('item.started:mcp_tool_call');
  });

  it('unmappedFrameKey falls back to the bare top-level type for non-item frames or a malformed item', () => {
    expect(unmappedFrameKey({ type: 'session.configured' })).toBe('session.configured');
    expect(unmappedFrameKey({ type: 'item.completed' })).toBe('item.completed:unknown');
  });
});
