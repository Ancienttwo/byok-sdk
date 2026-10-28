import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { BeforeToolRequest } from '../tool-execution-hook';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

/** Explicit local-runtime acceptance; all model traffic ends at the zero-cost loopback provider. */
describe.runIf(process.env.BYOK_REAL_CLAUDE_HOOK_TEST === '1')('real Claude PreToolUse with a loopback provider', () => {
  it.each(['deny', 'throw', 'timeout', 'allow', 'disabled', 'subagent', 'stalled-host'] as const)('enforces %s under bypassPermissions and disableAllHooks', async mode => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-real-hook-')));
    const target = path.join(root, 'target.txt');
    const calls: BeforeToolRequest[] = [];
    const results: unknown[] = [];
    let delegationOffered = false;
    let childWriteIssued = false;
    const childPrompt = 'BYOK_SUBAGENT_LOOPBACK_CHILD: perform the requested write, then finish.';
    let session: Session | undefined;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      if (!request.url?.includes('/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const toolResults = (parsed.messages ?? []).flatMap((message: { content?: unknown }) => Array.isArray(message.content) ? message.content : [])
        .filter((block: { type?: string }) => block.type === 'tool_result');
      results.push(...toolResults);
      const tools: Array<{ name?: string }> = parsed.tools ?? [];
      const write = tools.some(tool => tool.name === 'Write');
      const delegation = tools.find(tool => tool.name === 'Agent' || tool.name === 'Task');
      const userTexts: string[] = (parsed.messages ?? []).filter((message: { role?: string }) => message.role === 'user')
        .flatMap((message: { content?: unknown }) => typeof message.content === 'string' ? [message.content]
          : Array.isArray(message.content) ? message.content.filter((block: { type?: string }) => block.type === 'text')
            .map((block: { text?: string }) => block.text ?? '') : []);
      const child = userTexts.some(text => text.includes('BYOK_SUBAGENT_LOOPBACK_CHILD'));
      let content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'text'; text: string }>;
      if (mode === 'subagent' && !child && toolResults.length === 0 && delegation?.name) {
        delegationOffered = true;
        content = [{ type: 'tool_use', id: 'loopback-delegate', name: delegation.name, input: {
          description: 'Verify local child tool policy', prompt: childPrompt, subagent_type: 'general-purpose',
        } }];
      } else if (write && toolResults.length === 0 && (mode !== 'subagent' || child)) {
        if (mode === 'subagent') childWriteIssued = true;
        content = [{ type: 'tool_use', id: 'loopback-write', name: 'Write', input: { file_path: target, content: 'native-write' } }];
      } else content = [{ type: 'text', text: 'Finished.' }];
      const message = { id: `msg-${Date.now()}`, type: 'message', role: 'assistant', model: parsed.model ?? 'claude-sonnet-4-6',
        content, stop_reason: content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 } };
      if (!parsed.stream) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const event = (type: string, value: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
      for (const [index, block] of content.entries()) {
        event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use'
          ? { ...block, input: {} } : { type: 'text', text: '' } });
        event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: JSON.stringify('input' in block ? block.input : {}) }
          : { type: 'text_delta', text: 'Finished.' } });
        event('content_block_stop', { type: 'content_block_stop', index });
      }
      event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
      event('message_stop', { type: 'message_stop' });
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback did not bind');
    try {
      const config = path.join(root, 'claude-config');
      await fs.mkdir(config);
      await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true,
        permissions: { allow: ['Write(*)', 'Bash(*)'] } }));
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: 'loopback-fixture',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6', ANTHROPIC_SMALL_FAST_MODEL: 'claude-sonnet-4-6',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      };
      const adapter = new ClaudeAdapter({
        ...(process.env.BYOK_REAL_CLAUDE_BIN ? { resolveBin: () => ({ command: process.env.BYOK_REAL_CLAUDE_BIN!, source: 'env' as const }) } : {}),
        ...(mode === 'disabled' ? {} : { beforeTool: { timeoutMs: 100, onRequest: (request: BeforeToolRequest) => {
          calls.push(request);
          if (mode === 'subagent' && (request.toolName === 'Agent' || request.toolName === 'Task')) return { decision: 'allow' as const };
          if (mode === 'stalled-host') {
            const deadline = Date.now() + 2500;
            while (Date.now() < deadline) { /* Exercise the CLI deadline while the embedding event loop cannot respond. */ }
          }
          if (mode === 'throw') throw new Error('fixture callback failed');
          if (mode === 'timeout') return new Promise<never>(() => {});
          return mode === 'allow' ? { decision: 'allow' as const } : { decision: 'deny' as const, reason: '本地规则拒绝' };
        } } }),
      });
      session = await startPreparedOperation(adapter, { instruction: 'Perform the requested file operation, then finish.' }, { workspaceDir: root, agentHome: root, env });
      let ended = false;
      for await (const event of session.events) { if (event.type === 'turn_end') { ended = true; break; } }
      expect(ended).toBe(true);
      if (mode === 'allow' || mode === 'disabled') {
        expect(await fs.readFile(target, 'utf8')).toBe('native-write');
      } else {
        await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(calls.some(call => call.toolName === 'Write' && call.taskId === 'adapter-unit-test'
          && call.agentRef?.agentId === 'adapter-unit-agent' && call.paths.includes(target))).toBe(true);
        const expected = mode === 'stalled-host' ? 'PreToolUse hook did not respond before its timeout' : mode === 'deny' || mode === 'subagent' ? 'tool_policy_denied: 本地规则拒绝' : mode === 'throw' ? 'tool_policy_error' : 'tool_policy_timeout';
        expect(JSON.stringify(results)).toContain(expected);
      }
      if (mode === 'disabled') expect(calls).toEqual([]);
      if (mode === 'subagent') {
        expect(delegationOffered).toBe(true);
        expect(childWriteIssued).toBe(true);
        expect(calls.some(call => (call.toolName === 'Agent' || call.toolName === 'Task')
          && call.taskId === 'adapter-unit-test' && call.agentRef?.agentId === 'adapter-unit-agent')).toBe(true);
        expect(calls.some(call => call.toolName === 'Write' && typeof call.nativeAgentId === 'string'
          && call.nativeAgentId.length > 0 && call.taskId === 'adapter-unit-test'
          && call.agentRef?.agentId === 'adapter-unit-agent' && call.paths.includes(target))).toBe(true);
      }
    } finally {
      await session?.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
