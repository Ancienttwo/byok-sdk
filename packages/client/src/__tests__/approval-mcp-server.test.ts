import { describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_SUMMARY_MAX_CHARS,
  APPROVAL_TOOL_NAME,
  handleMcpRequest,
  summarizeToolCall,
  type ApprovalMcpDeps,
} from '../bin/approval-mcp-server';

/**
 * M4 Phase 3: unit coverage for `byok-approval-mcp`'s testable core —
 * `handleMcpRequest`/`summarizeToolCall`. The wire shapes asserted here
 * (tools/call arguments `{tool_name, input, tool_use_id}`, the expected
 * `{behavior:'allow'|'deny', ...}` JSON-in-text-content response) were
 * empirically verified end-to-end against the real installed claude 2.1.216
 * binary during M4 Phase 3 STEP 0 — see `approval-mcp-server.ts`'s own
 * module doc comment and `../adapters/claude/permission-mapping.ts`'s
 * `confirm`-mode doc comment for the full writeup.
 */

function fakeDeps(requestApproval: ApprovalMcpDeps['requestApproval']): ApprovalMcpDeps {
  return { requestApproval };
}

describe('summarizeToolCall', () => {
  it('formats as "toolName: <json input>"', () => {
    expect(summarizeToolCall('Bash', { command: 'echo hi' })).toBe('Bash: {"command":"echo hi"}');
  });

  it('truncates an oversized input rather than growing task.await_approval.summary unbounded', () => {
    const bigInput = { command: 'x'.repeat(APPROVAL_SUMMARY_MAX_CHARS * 2) };
    const summary = summarizeToolCall('Bash', bigInput);
    expect(summary.length).toBeLessThan(JSON.stringify(bigInput).length);
    expect(summary).toMatch(/… \[truncated\]$/);
  });

  it('falls back to a diagnostic string rather than throwing on unserializable input (e.g. a circular reference)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => summarizeToolCall('Bash', circular)).not.toThrow();
    expect(summarizeToolCall('Bash', circular)).toMatch(/^Bash: <unserializable input/);
  });
});

describe('handleMcpRequest', () => {
  it('initialize echoes the requested protocolVersion (or a default) and advertises tools capability', async () => {
    const deps = fakeDeps(async () => ({ approved: true }));
    const response = await handleMcpRequest({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, deps, 't1');
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'byok-approval-mcp', version: '0.0.1' },
      },
    });
  });

  it('initialize defaults protocolVersion to 2024-11-05 when the request omits it', async () => {
    const deps = fakeDeps(async () => ({ approved: true }));
    const response = await handleMcpRequest({ id: 0, method: 'initialize' }, deps, 't1');
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
  });

  it('notifications/initialized returns undefined (no response — it is a notification, not a request)', async () => {
    const deps = fakeDeps(async () => ({ approved: true }));
    const response = await handleMcpRequest({ method: 'notifications/initialized' }, deps, 't1');
    expect(response).toBeUndefined();
  });

  it('tools/list advertises exactly one tool, named APPROVAL_TOOL_NAME', async () => {
    const deps = fakeDeps(async () => ({ approved: true }));
    const response = await handleMcpRequest({ id: 1, method: 'tools/list' }, deps, 't1');
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(APPROVAL_TOOL_NAME);
  });

  it('tools/call for the approval tool forwards {taskId, summary} to requestApproval and returns behavior:allow with updatedInput echoing the original input on approval', async () => {
    const requestApproval = vi.fn(async (taskId: string, summary: string) => {
      expect(taskId).toBe('task-42');
      expect(summary).toBe('Bash: {"command":"echo hi"}');
      return { approved: true };
    });
    const deps = fakeDeps(requestApproval);
    const response = await handleMcpRequest(
      {
        id: 2,
        method: 'tools/call',
        params: { name: APPROVAL_TOOL_NAME, arguments: { tool_name: 'Bash', input: { command: 'echo hi' }, tool_use_id: 'toolu_1' } },
      },
      deps,
      'task-42',
    );
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const content = (response?.result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0]?.text ?? '')).toEqual({ behavior: 'allow', updatedInput: { command: 'echo hi' } });
  });

  it('tools/call returns behavior:deny with the reason on rejection', async () => {
    const deps = fakeDeps(async () => ({ approved: false, reason: 'operator said no' }));
    const response = await handleMcpRequest(
      { id: 3, method: 'tools/call', params: { name: APPROVAL_TOOL_NAME, arguments: { tool_name: 'Write', input: { file_path: '/x' } } } },
      deps,
      't1',
    );
    const content = (response?.result as { content: Array<{ type: string; text: string }> }).content;
    expect(JSON.parse(content[0]?.text ?? '')).toEqual({ behavior: 'deny', message: 'operator said no' });
  });

  it('fails closed (deny) rather than throwing/hanging when requestApproval itself rejects (daemon unreachable, control request timed out, etc.)', async () => {
    const deps = fakeDeps(async () => {
      throw new Error('control socket unreachable');
    });
    const response = await handleMcpRequest(
      { id: 4, method: 'tools/call', params: { name: APPROVAL_TOOL_NAME, arguments: { tool_name: 'Bash', input: {} } } },
      deps,
      't1',
    );
    const content = (response?.result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]?.text ?? '') as { behavior: string; message: string };
    expect(payload.behavior).toBe('deny');
    expect(payload.message).toMatch(/could not reach the approving device/);
    expect(payload.message).toMatch(/control socket unreachable/);
  });

  it('a tools/call naming a DIFFERENT tool than the approval tool is rejected with a protocol error, never silently approved', async () => {
    const requestApproval = vi.fn();
    const deps = fakeDeps(requestApproval);
    const response = await handleMcpRequest({ id: 5, method: 'tools/call', params: { name: 'some_other_tool', arguments: {} } }, deps, 't1');
    expect(requestApproval).not.toHaveBeenCalled();
    expect(response?.error).toBeDefined();
  });

  it('an unknown method with an id gets a JSON-RPC method-not-found error; without an id (a notification) it is silently ignored', async () => {
    const deps = fakeDeps(async () => ({ approved: true }));
    const withId = await handleMcpRequest({ id: 6, method: 'totally/unknown' }, deps, 't1');
    expect(withId?.error).toBeDefined();
    const withoutId = await handleMcpRequest({ method: 'totally/unknown' }, deps, 't1');
    expect(withoutId).toBeUndefined();
  });

  it('missing/non-string tool_name falls back to "unknown tool" rather than throwing', async () => {
    const requestApproval = vi.fn(async (_taskId: string, summary: string) => {
      expect(summary).toMatch(/^unknown tool:/);
      return { approved: false };
    });
    const deps = fakeDeps(requestApproval);
    await handleMcpRequest({ id: 7, method: 'tools/call', params: { name: APPROVAL_TOOL_NAME, arguments: {} } }, deps, 't1');
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});
