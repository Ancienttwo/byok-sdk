import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { ClaudeToolAuthorizationBridge } from '../adapters/claude/tool-authorization';
import { createAutoToolAuthorizationGate, type ToolAuthorizationGate, type ToolCall } from '../tool-authorization';
import {
  AGENT_MEMORY_MCP_SERVER_NAME, AGENT_MEMORY_RECALL_TOOL_NAME, AGENT_MESSAGE_MCP_SERVER_NAME, AGENT_MESSAGE_TOOL_NAME,
  AGENT_RESULT_MCP_SERVER_NAME, AGENT_RESULT_TOOL_NAME, SDK_RESERVED_MCP_TOOL_NAMES,
} from '../sdk-reserved-mcp';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { McpStdioServerConfig, MessageDraftDelta, Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

const fixture = fileURLToPath(new URL('./fixtures/fake-claude-tool-authorization.mjs', import.meta.url));
const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-auth-')));
  roots.push(root);
  return root;
}
async function start(workspace: string, toolAuthorization?: ToolAuthorizationGate, env: NodeJS.ProcessEnv = process.env, mcpServers?: Record<string, McpStdioServerConfig>): Promise<Session> {
  const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: fixture, source: 'env' }) });
  const session = await startPreparedOperation(adapter, { instruction: 'write' }, {
    workspaceDir: workspace, agentHome: workspace, env, ...(toolAuthorization === undefined ? {} : { toolAuthorization }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });
  sessions.push(session);
  return session;
}
async function takeTurn(session: Session): Promise<Array<AgentEvent | MessageDraftDelta>> {
  const events: Array<AgentEvent | MessageDraftDelta> = [];
  for await (const event of session.events) { events.push(event); if (event.type === 'turn_end') break; }
  return events;
}
function recordingGate(approved: boolean, workspace: string) {
  const summaries: string[] = [];
  const calls: ToolCall[] = [];
  const inner = createAutoToolAuthorizationGate({ workspace, timeoutMs: 1_000, requestAuthorization: async summary => {
    summaries.push(summary);
    return approved ? { approved } : { approved, reason: 'owner said no' };
  } });
  const gate: ToolAuthorizationGate = { timeoutMs: inner.timeoutMs, authorize: call => { calls.push(call); return inner.authorize(call); } };
  return { gate, summaries, calls };
}

describe('Claude auto gate over the SDK PreToolUse callback (synthetic protocol)', () => {
  it('applies MCP Always Ask before event iteration using one trusted runtime observation', async () => {
    const workspace = await tempRoot();
    const receipt = path.join(workspace, 'status-receipt');
    const requestAuthorization = vi.fn(async (_summary: string) => ({ approved: false }));
    const decisions: string[] = [];
    const gate = createAutoToolAuthorizationGate({ workspace, timeoutMs: 2_000,
      rules: { alwaysAsk: [{ id: 'delete-ticket', match: { mcpServer: 'market.feed', mcpTool: 'delete.ticket' } }] },
      requestAuthorization, onDecision: ({ verdict }) => { decisions.push(verdict.decision); },
    });
    const session = await start(workspace, gate, { ...process.env,
      FAKE_TOOL_NAME: 'mcp__market_feed__delete_ticket', FAKE_MCP_STATUS_RECEIPT: receipt,
    }, { 'market.feed': { command: process.execPath, args: ['synthetic-mcp-server'] } });
    await vi.waitFor(() => expect(decisions).toEqual(['deny']));
    expect(requestAuthorization).toHaveBeenCalledOnce();
    expect(requestAuthorization.mock.calls[0]?.[0]).toContain('custom-rule');
    const events = await takeTurn(session);
    expect(events.find(event => event.type === 'tool_use')).toMatchObject({ mcp: { server: 'market.feed', tool: 'delete.ticket' } });
    expect((await fs.readFile(receipt, 'utf8')).trim().split('\n')).toEqual(['lookup']);
    await expect(fs.access(path.join(workspace, 'tool-1.txt'))).rejects.toThrow();
  });

  it.each(['malformed', 'wrong-command', 'collision', 'timeout'])('denies an MCP call when its runtime identity is %s', async scenario => {
    const workspace = await tempRoot();
    const requestAuthorization = vi.fn(async () => ({ approved: true }));
    const gate = createAutoToolAuthorizationGate({ workspace, timeoutMs: 300,
      rules: { alwaysAsk: [{ id: 'ask', match: { mcpServer: 'market.feed' } }],
        allowWithoutAsking: [{ id: 'allow', match: { toolName: 'mcp__market_feed__delete_ticket' } }] },
      requestAuthorization,
    });
    const status = scenario === 'malformed' ? null : { mcpServers: [{ name: 'market.feed',
      config: { command: scenario === 'wrong-command' ? 'other-command' : process.execPath, args: ['synthetic-mcp-server'] },
      tools: [{ name: 'delete.ticket' }, ...(scenario === 'collision' ? [{ name: 'delete_ticket' }] : [])],
    }] };
    const session = await start(workspace, gate, { ...process.env, FAKE_TOOL_NAME: 'mcp__market_feed__delete_ticket',
      ...(scenario === 'timeout' ? { FAKE_MCP_STATUS_NO_ACK: '1' } : { FAKE_MCP_STATUS: JSON.stringify(status) }),
    }, { 'market.feed': { command: process.execPath, args: ['synthetic-mcp-server'] } });
    const events = await takeTurn(session);
    expect(JSON.stringify(events)).toContain('tool_authorization_unavailable');
    expect(requestAuthorization).not.toHaveBeenCalled();
    await expect(fs.access(path.join(workspace, 'tool-1.txt'))).rejects.toThrow();
  });

  // #1091 F1: a user MCP selector must not lock out the SDK helpers the daemon injects.
  const helperServers = {
    salesko: { command: process.execPath, args: ['salesko-mcp-server'] },
    [AGENT_RESULT_MCP_SERVER_NAME]: { command: process.execPath, args: ['agent-result-helper'] },
    [AGENT_MESSAGE_MCP_SERVER_NAME]: { command: process.execPath, args: ['agent-message-helper'] },
    [AGENT_MEMORY_MCP_SERVER_NAME]: { command: process.execPath, args: ['agent-memory-helper'] },
  };
  const helperTools = JSON.stringify({
    salesko: ['find_leads'], ...SDK_RESERVED_MCP_TOOL_NAMES,
  });
  async function runWithSaleskoAsk(toolName: string, approved: boolean) {
    const workspace = await tempRoot();
    const requestAuthorization = vi.fn(async (_summary: string) => ({ approved }));
    const verdicts: string[] = [];
    const gate = createAutoToolAuthorizationGate({ workspace, timeoutMs: 2_000,
      rules: { alwaysAsk: [{ id: 'crm', match: { mcpServer: 'salesko' } }] },
      requestAuthorization, onDecision: ({ verdict }) => { verdicts.push(verdict.decision === 'deny' ? verdict.code : 'allow'); },
    });
    const session = await start(workspace, gate, { ...process.env, FAKE_TOOL_NAME: toolName, FAKE_MCP_TOOLS: helperTools }, helperServers);
    const events = await takeTurn(session);
    return { workspace, events, verdicts, requestAuthorization };
  }

  it.each([
    `mcp__${AGENT_RESULT_MCP_SERVER_NAME}__${AGENT_RESULT_TOOL_NAME}`,
    `mcp__${AGENT_MESSAGE_MCP_SERVER_NAME}__${AGENT_MESSAGE_TOOL_NAME}`,
    `mcp__${AGENT_MEMORY_MCP_SERVER_NAME}__${AGENT_MEMORY_RECALL_TOOL_NAME}`,
  ])('runs SDK helper %s without asking under a user MCP server rule', async toolName => {
    const { workspace, events, verdicts, requestAuthorization } = await runWithSaleskoAsk(toolName, false);
    expect(verdicts).toEqual(['allow']);
    expect(requestAuthorization).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(workspace, 'tool-1.txt'), 'utf8')).toBe('actual fixture write');
    // Helper identity authorizes the call; tool events still carry none (#633).
    for (const event of events.filter(event => event.type === 'tool_use' || event.type === 'tool_result')) {
      expect(event).not.toHaveProperty('mcp');
    }
  });

  it('still asks for the user server the rule names when helpers are present', async () => {
    const { workspace, verdicts, requestAuthorization } = await runWithSaleskoAsk('mcp__salesko__find_leads', false);
    expect(verdicts).toEqual(['tool_authorization_denied']);
    expect(requestAuthorization).toHaveBeenCalledOnce();
    expect(requestAuthorization.mock.calls[0]?.[0]).toContain('Tool authorization rule (crm)');
    await expect(fs.access(path.join(workspace, 'tool-1.txt'))).rejects.toThrow();
  });

  it('never asks for mcp_status without an MCP selector, so a silent Claude cannot deny a helper', async () => {
    const workspace = await tempRoot();
    const receipt = path.join(workspace, 'status-receipt');
    const requestAuthorization = vi.fn(async () => ({ approved: false }));
    const verdicts: string[] = [];
    const gate = createAutoToolAuthorizationGate({ workspace, timeoutMs: 300,
      rules: { alwaysAsk: [{ id: 'merges', match: { commandGlob: 'gh pr merge **' } }] }, requestAuthorization,
      onDecision: ({ verdict }) => { verdicts.push(verdict.decision === 'deny' ? verdict.code : 'allow'); },
    });
    const { salesko: _salesko, ...helpersOnly } = helperServers;
    const session = await start(workspace, gate, { ...process.env, FAKE_MCP_STATUS_NO_ACK: '1', FAKE_MCP_STATUS_RECEIPT: receipt,
      FAKE_TOOL_NAME: `mcp__${AGENT_RESULT_MCP_SERVER_NAME}__${AGENT_RESULT_TOOL_NAME}` }, helpersOnly);
    await takeTurn(session);
    expect(verdicts).toEqual(['allow']);
    expect(requestAuthorization).not.toHaveBeenCalled();
    await expect(fs.access(receipt)).rejects.toThrow();
    expect(await fs.readFile(path.join(workspace, 'tool-1.txt'), 'utf8')).toBe('actual fixture write');
  });

  it('gives no identity to a helper name Claude reports with another command', async () => {
    const workspace = await tempRoot();
    const requestAuthorization = vi.fn(async () => ({ approved: true }));
    const gate = createAutoToolAuthorizationGate({ workspace, timeoutMs: 2_000,
      rules: { alwaysAsk: [{ id: 'crm', match: { mcpServer: 'salesko' } }] }, requestAuthorization,
    });
    const status = { mcpServers: [{ name: AGENT_RESULT_MCP_SERVER_NAME,
      config: { command: 'user-command', args: ['agent-result-helper'] }, tools: [{ name: AGENT_RESULT_TOOL_NAME }] }] };
    const session = await start(workspace, gate, { ...process.env, FAKE_MCP_STATUS: JSON.stringify(status),
      FAKE_TOOL_NAME: `mcp__${AGENT_RESULT_MCP_SERVER_NAME}__${AGENT_RESULT_TOOL_NAME}` }, helperServers);
    expect(JSON.stringify(await takeTurn(session))).toContain('tool_authorization_unavailable');
    expect(requestAuthorization).not.toHaveBeenCalled();
    await expect(fs.access(path.join(workspace, 'tool-1.txt'))).rejects.toThrow();
  });

  it('denies a high-risk write outside the workspace before it happens, with the classified reason', async () => {
    const root = await tempRoot();
    const workspace = path.join(root, 'home');
    await fs.mkdir(workspace);
    const outside = path.join(root, 'outside.txt');
    const { gate, summaries, calls } = recordingGate(false, workspace);
    const session = await start(workspace, gate, { ...process.env, FAKE_TOOL_FILE: outside, FAKE_HOOK_NATIVE_AGENT_ID: 'native-child' });
    const events = await takeTurn(session);
    expect(calls[0]).toMatchObject({ toolName: 'Write', cwd: workspace, nativeAgentId: 'native-child', input: { file_path: outside } });
    expect(summaries).toEqual([`High-risk tool call (write-outside-workspace): Write ${outside}`]);
    expect(JSON.stringify(events)).toContain('tool_authorization_denied: owner said no');
    await expect(fs.stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs ordinary workspace writes without asking, on every turn', async () => {
    const workspace = await tempRoot();
    const { gate, summaries, calls } = recordingGate(false, workspace);
    const session = await start(workspace, gate);
    await takeTurn(session);
    await session.followUp({ instruction: 'write again' });
    await takeTurn(session);
    expect(calls.map(call => call.toolCallId)).toEqual(['write-1', 'write-2']);
    expect(summaries).toEqual([]);
    expect(await fs.readFile(path.join(workspace, 'tool-2.txt'), 'utf8')).toBe('actual fixture write');
  });

  it('all mode sends no gate: the bypass execution path is unchanged', async () => {
    const workspace = await tempRoot();
    await takeTurn(await start(workspace));
    expect(await fs.readFile(path.join(workspace, 'tool-1.txt'), 'utf8')).toBe('actual fixture write');
  });

  it.each(['missing', 'false'])('refuses to start when the runtime does not confirm the hook (%s)', async mode => {
    const workspace = await tempRoot();
    const { gate } = recordingGate(true, workspace);
    await expect(start(workspace, gate, { ...process.env, FAKE_HOOK_REGISTRATION: mode }))
      .rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', message: expect.stringContaining('tool_authorization_unsupported') });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
});

describe('Claude PreToolUse delivery deadline', () => {
  const callback = (bridge: ClaudeToolAuthorizationBridge, requestId: string) => {
    const hook = (bridge.hooks.PreToolUse as Array<{ hookCallbackIds: string[]; timeout: number }>)[0]!;
    bridge.receive({ type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: hook.hookCallbackIds[0], input: {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: requestId, tool_input: { command: 'sudo rm -rf /var/db' }, cwd: '/tmp',
    } } });
    return hook.timeout * 1_000;
  };

  it('denies two concurrent unanswered high-risk calls before the native hook timeout', async () => {
    vi.useFakeTimers();
    try {
      const writes: Array<Record<string, any>> = [];
      const onFatal = vi.fn();
      const gate = createAutoToolAuthorizationGate({ workspace: '/tmp', timeoutMs: 1_000, requestAuthorization: () => new Promise(() => {}) });
      const bridge = new ClaudeToolAuthorizationBridge(gate, onFatal);
      bridge.bind(async frame => { writes.push(frame); });
      const nativeTimeoutMs = callback(bridge, 'hook-1');
      await vi.advanceTimersByTimeAsync(300);
      callback(bridge, 'hook-2');
      await vi.advanceTimersByTimeAsync(1_300);
      expect(1_300).toBeLessThan(nativeTimeoutMs);
      expect(writes.map(frame => [frame.response.request_id, frame.response.response.hookSpecificOutput.permissionDecision])).toEqual([['hook-1', 'deny'], ['hook-2', 'deny']]);
      expect(writes[0]!.response.response.hookSpecificOutput.permissionDecisionReason).toMatch(/^tool_authorization_unavailable: /);
      await vi.advanceTimersByTimeAsync(nativeTimeoutMs);
      expect(onFatal).not.toHaveBeenCalled();
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes the process before the native timeout when a verdict cannot be delivered', async () => {
    vi.useFakeTimers();
    try {
      const onFatal = vi.fn();
      const gate: ToolAuthorizationGate = { timeoutMs: 1_000, authorize: () => new Promise(() => {}) };
      const bridge = new ClaudeToolAuthorizationBridge(gate, onFatal);
      bridge.bind(async () => {});
      const nativeTimeoutMs = callback(bridge, 'hook-1');
      await vi.advanceTimersByTimeAsync(nativeTimeoutMs - 1);
      expect(onFatal).toHaveBeenCalledTimes(1);
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
