import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { serveAgentResultMcpOverStdio, type AgentResultMcpDeps } from '../bin/agent-result-mcp-server';
import { AGENT_RESULT_MCP_SERVER_NAME, AGENT_RESULT_TOOL_NAME, isReservedMcpServerName } from '../sdk-reserved-mcp';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string', minLength: 1 }, cites: { type: 'array', items: { type: 'string' } } },
};

/** One NDJSON MCP session over in-memory pipes. */
async function session(deps: AgentResultMcpDeps) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  let buffer = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      buffer = buffer.slice(newline + 1);
    }
  });
  // An early initialize waits in the pipe until describe answered and the server attached.
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
  const served = serveAgentResultMcpOverStdio({ deps, stdin, stdout });
  const request = async (id: number, method: string, params?: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    await vi.waitFor(() => expect(frames.some((frame) => frame.id === id)).toBe(true));
    return frames.find((frame) => frame.id === id)!;
  };
  return { served, request, frames };
}

describe('byok-agent-result-mcp', () => {
  it('is an SDK-reserved server name', () => {
    expect(AGENT_RESULT_MCP_SERVER_NAME).toBe('byokagentresult');
    expect(AGENT_RESULT_TOOL_NAME).toBe('submit_result');
    expect(isReservedMcpServerName(AGENT_RESULT_MCP_SERVER_NAME)).toBe(true);
  });

  it('advertises submit_result with the daemon-described schema verbatim and forwards raw arguments', async () => {
    const submit = vi.fn<AgentResultMcpDeps['submit']>(async () => ({ state: 'staged', receiptId: 'receipt-1' }));
    const describe = vi.fn<AgentResultMcpDeps['describe']>(async () => ({ name: 'submit_result', description: 'Submit it.', inputSchema: SCHEMA }));
    const { served, request, frames } = await session({ describe, submit });
    await served;
    await vi.waitFor(() => expect(frames.some((frame) => frame.id === 1)).toBe(true));
    expect(describe).toHaveBeenCalledOnce();
    const listed = await request(2, 'tools/list');
    expect(listed.result).toEqual({ tools: [{ name: 'submit_result', description: 'Submit it.', inputSchema: SCHEMA }] });
    // No local validation: even an outcome outside the schema reaches the daemon unchanged.
    const raw = { answer: '', unexpected: { nested: [1, 2] } };
    const called = await request(3, 'tools/call', { name: 'submit_result', arguments: raw });
    expect(submit).toHaveBeenCalledWith(raw);
    expect(called.result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ receiptId: 'receipt-1', state: 'staged' }) }] });
  });

  it('maps a daemon rejection to an isError tool result carrying the issues, and a refusal to a JSON-RPC error', async () => {
    const issues = [{ pointer: '/answer', keyword: 'minLength', message: 'String is too short (0 < 1).' }];
    const submit = vi.fn<AgentResultMcpDeps['submit']>()
      .mockResolvedValueOnce({ state: 'rejected', reason: 'schema-mismatch', issues, truncated: false })
      .mockRejectedValueOnce(new Error('this task already staged a different result; a staged result is immutable'));
    const { served, request } = await session({
      describe: async () => ({ name: 'submit_result', description: 'Submit it.', inputSchema: SCHEMA }),
      submit,
    });
    await served;
    const rejected = await request(2, 'tools/call', { name: 'submit_result', arguments: { answer: '' } });
    expect(rejected.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ error: 'result_rejected', reason: 'schema-mismatch', issues, truncated: false }) }],
      isError: true,
    });
    const refused = await request(3, 'tools/call', { name: 'submit_result', arguments: { answer: 'other' } });
    expect(refused.error).toMatchObject({ code: -32000, message: expect.stringContaining('already staged a different result') });
    const noArguments = await request(4, 'tools/call', { name: 'submit_result' });
    expect(noArguments.error).toMatchObject({ code: -32602 });
    const unknown = await request(5, 'tools/call', { name: 'other_tool', arguments: {} });
    expect(unknown.error).toMatchObject({ code: -32602 });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('refuses to serve when the daemon describe answer is not the submit_result tool', async () => {
    await expect(serveAgentResultMcpOverStdio({
      deps: { describe: async () => ({ name: 'other', description: '', inputSchema: SCHEMA }), submit: async () => ({ state: 'staged', receiptId: 'x' }) },
      stdin: new PassThrough(), stdout: new PassThrough(),
    })).rejects.toThrow(/invalid tool description/);
    await expect(serveAgentResultMcpOverStdio({
      deps: { describe: async () => { throw new Error('invalid or expired Agent result task context'); }, submit: async () => ({ state: 'staged', receiptId: 'x' }) },
      stdin: new PassThrough(), stdout: new PassThrough(),
    })).rejects.toThrow(/invalid or expired/);
  });
});
