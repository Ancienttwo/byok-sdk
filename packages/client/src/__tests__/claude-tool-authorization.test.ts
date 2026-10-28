import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { ClaudeToolAuthorizationBridge } from '../adapters/claude/tool-authorization';
import { createAutoToolAuthorizationGate, type ToolAuthorizationGate, type ToolCall } from '../tool-authorization';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { MessageDraftDelta, Session } from '../types';
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
async function start(workspace: string, toolAuthorization?: ToolAuthorizationGate, env: NodeJS.ProcessEnv = process.env): Promise<Session> {
  const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: fixture, source: 'env' }) });
  const session = await startPreparedOperation(adapter, { instruction: 'write' }, {
    workspaceDir: workspace, agentHome: workspace, env, ...(toolAuthorization === undefined ? {} : { toolAuthorization }),
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
