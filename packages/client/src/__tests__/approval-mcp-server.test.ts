import { describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_SUMMARY_MAX_CHARS,
  APPROVAL_TOOL_NAME,
  APPROVAL_TOOLS,
  handleApprovalToolCall,
  summarizeToolCall,
  type ApprovalMcpDeps,
} from '../bin/approval-mcp-server';

/**
 * M4 Phase 3: unit coverage for `byok-approval-mcp`'s testable core —
 * `handleApprovalToolCall`/`summarizeToolCall`. The wire shapes asserted here
 * (tools/call arguments `{tool_name, input, tool_use_id}`, the expected
 * `{behavior:'allow'|'deny', ...}` JSON-in-text-content response) were
 * empirically verified end-to-end against the real installed claude 2.1.216
 * binary during M4 Phase 3 STEP 0 — see `approval-mcp-server.ts`'s own
 * module doc comment and `../adapters/claude/permission-mapping.ts`'s
 * `confirm`-mode doc comment for the full writeup.
 *
 * The JSON-RPC envelope around all of this is `../mcp-server`'s since the
 * shared-core migration; `reserved-mcp-wire-regression.test.ts` asserts the
 * emitted bytes and `mcp-server-core.test.ts` asserts the protocol behaviour.
 */

function fakeDeps(requestApproval: ApprovalMcpDeps['requestApproval']): ApprovalMcpDeps {
  return { requestApproval };
}

function call(name: string, args: Record<string, unknown> | undefined): {
  name: string;
  arguments: Record<string, unknown> | undefined;
  signal: AbortSignal;
} {
  return { name, arguments: args, signal: new AbortController().signal };
}

function payloadOf(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  return JSON.parse(content[0]?.text ?? '') as Record<string, unknown>;
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

describe('the advertised approval tool', () => {
  it('is exactly one tool, named APPROVAL_TOOL_NAME, with the schema claude was verified against', () => {
    expect(APPROVAL_TOOLS).toHaveLength(1);
    expect(APPROVAL_TOOLS[0]?.name).toBe(APPROVAL_TOOL_NAME);
    expect(APPROVAL_TOOLS[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' } },
    });
  });
});

describe('handleApprovalToolCall', () => {
  it('forwards {taskId, summary} to requestApproval and returns behavior:allow with updatedInput echoing the original input on approval', async () => {
    const requestApproval = vi.fn(async (taskId: string, summary: string) => {
      expect(taskId).toBe('task-42');
      expect(summary).toBe('Bash: {"command":"echo hi"}');
      return { approved: true };
    });
    const result = await handleApprovalToolCall(
      call(APPROVAL_TOOL_NAME, { tool_name: 'Bash', input: { command: 'echo hi' }, tool_use_id: 'toolu_1' }),
      fakeDeps(requestApproval),
      'task-42',
    );
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(payloadOf(result)).toEqual({ behavior: 'allow', updatedInput: { command: 'echo hi' } });
  });

  it('returns behavior:deny with the reason on rejection', async () => {
    const result = await handleApprovalToolCall(
      call(APPROVAL_TOOL_NAME, { tool_name: 'Write', input: { file_path: '/x' } }),
      fakeDeps(async () => ({ approved: false, reason: 'operator said no' })),
      't1',
    );
    expect(payloadOf(result)).toEqual({ behavior: 'deny', message: 'operator said no' });
  });

  it('fails closed (deny) rather than throwing/hanging when requestApproval itself rejects (daemon unreachable, control request timed out, etc.)', async () => {
    const result = await handleApprovalToolCall(
      call(APPROVAL_TOOL_NAME, { tool_name: 'Bash', input: {} }),
      fakeDeps(async () => {
        throw new Error('control socket unreachable');
      }),
      't1',
    );
    // A RESULT, never an error: the core writes a normal return verbatim, so a
    // fail-closed deny cannot be turned into a protocol error on the way out.
    const payload = payloadOf(result) as { behavior: string; message: string };
    expect(payload.behavior).toBe('deny');
    expect(payload.message).toMatch(/could not reach the approving device/);
    expect(payload.message).toMatch(/control socket unreachable/);
  });

  it('a call naming a DIFFERENT tool than the approval tool is rejected with a protocol error, never silently approved', async () => {
    const requestApproval = vi.fn();
    await expect(
      handleApprovalToolCall(call('some_other_tool', {}), fakeDeps(requestApproval), 't1'),
    ).rejects.toMatchObject({ code: -32602, message: 'unknown tool "some_other_tool"' });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('missing/non-string tool_name falls back to "unknown tool" rather than throwing', async () => {
    const requestApproval = vi.fn(async (_taskId: string, summary: string) => {
      expect(summary).toMatch(/^unknown tool:/);
      return { approved: false };
    });
    await handleApprovalToolCall(call(APPROVAL_TOOL_NAME, {}), fakeDeps(requestApproval), 't1');
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('treats absent arguments the same as empty arguments rather than failing the call', async () => {
    const requestApproval = vi.fn(async () => ({ approved: false, reason: 'no' }));
    const result = await handleApprovalToolCall(call(APPROVAL_TOOL_NAME, undefined), fakeDeps(requestApproval), 't1');
    expect(payloadOf(result)).toEqual({ behavior: 'deny', message: 'no' });
  });
});
