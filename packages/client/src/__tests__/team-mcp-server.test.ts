import { describe, expect, it, vi } from 'vitest';
import {
  handleTeamToolCall,
  TEAM_ACK_TOOL_NAME,
  TEAM_POST_TOOL_NAME,
  TEAM_READ_TOOL_NAME,
  TEAM_TOOLS,
} from '../bin/team-mcp-server';

/**
 * The JSON-RPC envelope, `initialize` and the framing are `../mcp-server`'s and
 * are asserted there and in `reserved-mcp-wire-regression.test.ts`. What is
 * asserted here is the half that stayed: the tool set and its input contract.
 */
const call = (name: string, args: Record<string, unknown> | undefined) => ({
  name,
  arguments: args,
  signal: new AbortController().signal,
});

describe('team MCP server', () => {
  it('exposes exactly three tools', () => {
    expect(TEAM_TOOLS.map((tool) => tool.name)).toEqual([TEAM_POST_TOOL_NAME, TEAM_READ_TOOL_NAME, TEAM_ACK_TOOL_NAME]);
  });

  it('never accepts sender or workspace identity from the model', async () => {
    const deps = { post: vi.fn(), read: vi.fn(), ack: vi.fn() };
    await expect(handleTeamToolCall(call(TEAM_POST_TOOL_NAME, { body: 'hi', sender: 'other' }), deps)).rejects.toMatchObject({
      code: -32602,
    });
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('routes bounded typed inputs to the daemon-owned dependency', async () => {
    const deps = { post: vi.fn().mockResolvedValue({ seq: 1 }), read: vi.fn().mockResolvedValue({ messages: [] }), ack: vi.fn().mockResolvedValue({ throughSeq: 1 }) };
    await handleTeamToolCall(call(TEAM_POST_TOOL_NAME, { body: 'hi' }), deps);
    await handleTeamToolCall(call(TEAM_READ_TOOL_NAME, { afterSeq: 0 }), deps);
    await handleTeamToolCall(call(TEAM_ACK_TOOL_NAME, { throughSeq: 1 }), deps);
    expect(deps.post).toHaveBeenCalledWith({ body: 'hi' }); expect(deps.read).toHaveBeenCalledWith({ afterSeq: 0 }); expect(deps.ack).toHaveBeenCalledWith({ throughSeq: 1 });
  });

  it('refuses arguments that are not an object, and rules on an undefined tool name itself', async () => {
    const deps = { post: vi.fn(), read: vi.fn(), ack: vi.fn() };
    await expect(handleTeamToolCall(call(TEAM_POST_TOOL_NAME, undefined), deps)).rejects.toMatchObject({
      code: -32602,
      message: 'team tool input must be an object',
    });
    await expect(handleTeamToolCall(call('not_a_team_tool', {}), deps)).rejects.toMatchObject({
      code: -32602,
      message: 'unknown team tool',
    });
  });

  it('maps a dependency failure to -32000, not to a protocol fault', async () => {
    const deps = {
      post: vi.fn().mockRejectedValue(new Error('daemon unreachable')),
      read: vi.fn(),
      ack: vi.fn(),
    };
    await expect(handleTeamToolCall(call(TEAM_POST_TOOL_NAME, { body: 'hi' }), deps)).rejects.toMatchObject({
      code: -32000,
      message: 'daemon unreachable',
    });
  });
});
