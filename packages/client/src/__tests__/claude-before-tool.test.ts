import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { decodeClaudePreToolUse } from '../adapters/claude/before-tool';
import type { BeforeToolOptions, BeforeToolRequest } from '../tool-execution-hook';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { MessageDraftDelta, Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

const fixture = fileURLToPath(new URL('./fixtures/fake-claude-before-tool.mjs', import.meta.url));
const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-hook-')));
  roots.push(root);
  return root;
}
async function start(root: string, beforeTool?: BeforeToolOptions, env: NodeJS.ProcessEnv = process.env): Promise<Session> {
  const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: fixture, source: 'env' }), beforeTool });
  const session = await startPreparedOperation(adapter, { instruction: 'write' }, { workspaceDir: root, agentHome: root, env });
  sessions.push(session);
  return session;
}
async function takeTurn(session: Session): Promise<Array<AgentEvent | MessageDraftDelta>> {
  const events: Array<AgentEvent | MessageDraftDelta> = [];
  for await (const event of session.events) { events.push(event); if (event.type === 'turn_end') break; }
  return events;
}

describe('Claude native PreToolUse control bridge (synthetic protocol)', () => {
  it('denies actual fixture writes, preserves reason, and binds native child calls to the parent identity', async () => {
    const root = await workspace();
    const calls: BeforeToolRequest[] = [];
    const session = await start(root, { onRequest: request => { calls.push(request); return { decision: 'deny', reason: '主人尚未授权' }; } },
      { ...process.env, FAKE_HOOK_NATIVE_AGENT_ID: 'native-child' });
    const events = await takeTurn(session);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: 'adapter-unit-test', runtimeId: 'claude', toolName: 'Write',
      agentRef: { agentId: 'adapter-unit-agent', profileRevision: 'r1' }, cwd: root,
      paths: [path.join(root, 'tool-1.txt')], nativeAgentId: 'native-child' });
    expect(events.some(event => event.type === 'turn_end')).toBe(true);
    expect(JSON.stringify(events)).toContain('tool_policy_denied: 主人尚未授权');
    await expect(fs.stat(path.join(root, 'tool-1.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['throw', 'timeout'] as const)('fails closed on callback %s and finishes the turn', async kind => {
    const root = await workspace();
    const session = await start(root, { timeoutMs: 20, onRequest: () => {
      if (kind === 'throw') throw new Error('Host unavailable');
      return new Promise(() => {});
    } });
    const events = await takeTurn(session);
    expect(JSON.stringify(events)).toContain(kind === 'throw' ? 'tool_policy_error' : 'tool_policy_timeout');
    expect(events.some(event => event.type === 'turn_end')).toBe(true);
    await expect(fs.stat(path.join(root, 'tool-1.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows actual writes and keeps the callback on subsequent turns', async () => {
    const root = await workspace();
    const calls: string[] = [];
    const session = await start(root, { onRequest: request => { calls.push(request.toolCallId); return { decision: 'allow' }; } });
    await takeTurn(session);
    await session.followUp({ instruction: 'write again' });
    await takeTurn(session);
    expect(calls).toEqual(['write-1', 'write-2']);
    expect(await fs.readFile(path.join(root, 'tool-2.txt'), 'utf8')).toBe('actual fixture write');
  });

  it('leaves the bypass execution path unchanged without a callback', async () => {
    const root = await workspace();
    await takeTurn(await start(root));
    expect(await fs.readFile(path.join(root, 'tool-1.txt'), 'utf8')).toBe('actual fixture write');
  });

  it.each(['missing', 'false'])('rejects unconfirmed registration (%s) before a user turn', async mode => {
    const root = await workspace();
    await expect(start(root, { onRequest: () => ({ decision: 'allow' }) }, { ...process.env, FAKE_HOOK_REGISTRATION: mode }))
      .rejects.toMatchObject({ code: 'tool_execution_hook_unsupported', runtimeId: 'claude' });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('projects command and native file inputs without interpreting command text', () => {
    expect(decodeClaudePreToolUse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1',
      tool_input: { command: 'echo $HOME > output' }, cwd: '/workspace' })).toMatchObject({ command: 'echo $HOME > output', paths: [] });
  });
});
