import { describe, expect, it, vi } from 'vitest';
import { handleTeamMcpRequest, TEAM_ACK_TOOL_NAME, TEAM_POST_TOOL_NAME, TEAM_READ_TOOL_NAME } from '../bin/team-mcp-server';

describe('team MCP server', () => {
  it('completes MCP initialization and exposes exactly three tools', async () => {
    const deps = { post: vi.fn(), read: vi.fn(), ack: vi.fn() };
    expect((await handleTeamMcpRequest({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, deps))?.result).toBeDefined();
    expect(await handleTeamMcpRequest({ method: 'notifications/initialized' }, deps)).toBeUndefined();
    const response = await handleTeamMcpRequest({ id: 2, method: 'tools/list' }, deps) as { result: { tools: Array<{ name: string }> } };
    expect(response.result.tools.map((tool) => tool.name)).toEqual([TEAM_POST_TOOL_NAME, TEAM_READ_TOOL_NAME, TEAM_ACK_TOOL_NAME]);
  });

  it('never accepts sender or workspace identity from the model', async () => {
    const deps = { post: vi.fn(), read: vi.fn(), ack: vi.fn() };
    const response = await handleTeamMcpRequest({ id: 3, method: 'tools/call', params: { name: TEAM_POST_TOOL_NAME, arguments: { body: 'hi', sender: 'other' } } }, deps);
    expect(response).toMatchObject({ error: { code: -32602 } });
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('routes bounded typed inputs to the daemon-owned dependency', async () => {
    const deps = { post: vi.fn().mockResolvedValue({ seq: 1 }), read: vi.fn().mockResolvedValue({ messages: [] }), ack: vi.fn().mockResolvedValue({ throughSeq: 1 }) };
    await handleTeamMcpRequest({ id: 3, method: 'tools/call', params: { name: TEAM_POST_TOOL_NAME, arguments: { body: 'hi' } } }, deps);
    await handleTeamMcpRequest({ id: 4, method: 'tools/call', params: { name: TEAM_READ_TOOL_NAME, arguments: { afterSeq: 0 } } }, deps);
    await handleTeamMcpRequest({ id: 5, method: 'tools/call', params: { name: TEAM_ACK_TOOL_NAME, arguments: { throughSeq: 1 } } }, deps);
    expect(deps.post).toHaveBeenCalledWith({ body: 'hi' }); expect(deps.read).toHaveBeenCalledWith({ afterSeq: 0 }); expect(deps.ack).toHaveBeenCalledWith({ throughSeq: 1 });
  });
});
