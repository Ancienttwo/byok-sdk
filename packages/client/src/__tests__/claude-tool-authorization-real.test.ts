import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { createAutoToolAuthorizationGate, type ToolAuthorizationRules, type ToolAuthorizationVerdict, type ToolCall } from '../tool-authorization';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

const execFileAsync = promisify(execFile);
async function localPushFixture(root: string, workspace: string, env: NodeJS.ProcessEnv) {
  const remote = path.join(root, 'origin.git');
  const options = { cwd: workspace, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' } };
  await execFileAsync('git', ['init', '--bare', remote], options);
  await execFileAsync('git', ['init', '-b', 'main'], options);
  await fs.writeFile(path.join(workspace, 'tracked.txt'), 'local push fixture');
  await execFileAsync('git', ['add', 'tracked.txt'], options);
  await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], options);
  await execFileAsync('git', ['remote', 'add', 'origin', remote], options);
  const target = path.join(workspace, 'chain-target');
  await fs.mkdir(target);
  const marker = path.join(target, 'keep.txt');
  await fs.writeFile(marker, 'must survive the denied shell chain');
  return { target, marker, pushedRef: path.join(remote, 'refs', 'heads', 'main') };
}

/** Explicit local-runtime acceptance; all model traffic ends at the zero-cost loopback provider. */
describe.runIf(process.env.BYOK_REAL_CLAUDE_HOOK_TEST === '1')('real Claude auto gate with a loopback provider', () => {
  it.each(['denied', 'approved', 'workspace', 'all', 'subagent', 'native-all', 'native-approved', 'native-denied',
    'rules-ask', 'rules-allow', 'rules-floor', 'rules-resume', 'F1-shell-chain'] as const)('%s: enforced under bypassPermissions, allow rules and disableAllHooks', async mode => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-real-auth-')));
    const workspace = path.join(root, 'home');
    await fs.mkdir(workspace);
    // Outside the granted workspace is high-risk; inside it is ordinary work.
    const native = mode.startsWith('native-');
    const nativeRequests: unknown[] = [];
    const shellChain = mode === 'F1-shell-chain';
    const command = 'git push origin main && rm -rf chain-target';
    const target = mode === 'workspace' || mode === 'rules-ask' ? path.join(workspace, 'target.txt')
      : mode === 'rules-floor' ? path.join(root, '.ssh', 'fixture-key') : path.join(root, 'target.txt');
    if (mode === 'rules-floor') await fs.mkdir(path.dirname(target));
    const calls: ToolCall[] = [];
    const summaries: string[] = [];
    const verdicts: ToolAuthorizationVerdict[] = [];
    const results: unknown[] = [];
    let delegationOffered = false;
    let childWriteIssued = false;
    let resumedWriteIssued = false;
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
      const resumeWrite = mode === 'rules-resume' && !resumedWriteIssued
        && userTexts.some(text => text.includes('BYOK_RULE_RESUME_WRITE'));
      let content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'text'; text: string }>;
      if (shellChain && toolResults.length === 0 && tools.some(tool => tool.name === 'Bash')) {
        content = [{ type: 'tool_use', id: 'loopback-shell-chain', name: 'Bash', input: { command } }];
      } else if (mode === 'subagent' && !child && toolResults.length === 0 && delegation?.name) {
        delegationOffered = true;
        content = [{ type: 'tool_use', id: 'loopback-delegate', name: delegation.name, input: {
          description: 'Verify local child tool policy', prompt: childPrompt, subagent_type: 'general-purpose',
        } }];
      } else if (write && (toolResults.length === 0 || resumeWrite) && (mode !== 'subagent' || child)) {
        if (mode === 'subagent') childWriteIssued = true;
        if (resumeWrite) resumedWriteIssued = true;
        content = [{ type: 'tool_use', id: resumeWrite ? 'loopback-write-resumed' : 'loopback-write', name: 'Write', input: { file_path: target, content: 'native-write' } }];
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
      const local = shellChain ? await localPushFixture(root, workspace, env) : undefined;
      const adapter = new ClaudeAdapter({
        ...(process.env.BYOK_REAL_CLAUDE_BIN ? { resolveBin: () => ({ command: process.env.BYOK_REAL_CLAUDE_BIN!, source: 'env' as const }) } : {}),
        // The native relay must neither veto (`all`) nor ask a second time (`auto`).
        ...(native ? { nativeInteractions: { onRequest: (request: unknown) => { nativeRequests.push(request); } } } : {}),
      });
      const matchedWrite = { id: mode === 'rules-ask' ? 'ask-write' : 'allow-write',
        description: 'Host display text only', match: { toolName: 'Write', pathGlob: target } };
      const rules: ToolAuthorizationRules | undefined = shellChain
        ? { allowWithoutAsking: [{ id: 'allow-push', match: { toolName: 'Bash', commandGlob: 'git push origin *' } }] }
        : mode === 'rules-ask' ? { alwaysAsk: [matchedWrite] }
        : mode === 'rules-allow' || mode === 'rules-floor' || mode === 'rules-resume' ? { allowWithoutAsking: [matchedWrite] } : undefined;
      const inner = createAutoToolAuthorizationGate({ workspace, home: root, timeoutMs: 5_000, rules, requestAuthorization: async summary => {
        summaries.push(summary);
        return mode === 'approved' || mode === 'native-approved' ? { approved: true } : { approved: false, reason: '主人尚未授权' };
      } });
      const toolAuthorization = mode === 'all' || mode === 'native-all' ? undefined : { timeoutMs: inner.timeoutMs, authorize: async (call: ToolCall) => {
        calls.push(call);
        const verdict = await inner.authorize(call);
        verdicts.push(verdict);
        return verdict;
      } };
      session = await startPreparedOperation(adapter, { instruction: 'Perform the requested file operation, then finish.' }, {
        workspaceDir: workspace, agentHome: workspace, env, ...(toolAuthorization === undefined ? {} : { toolAuthorization }),
      });
      let ended = false;
      for await (const event of session.events) { if (event.type === 'turn_end') { ended = true; break; } }
      expect(ended).toBe(true);
      if (shellChain) {
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ toolName: 'Bash', input: { command } });
        expect(await fs.readFile(local!.marker, 'utf8')).toBe('must survive the denied shell chain');
        expect((await fs.stat(local!.target)).isDirectory()).toBe(true);
        await expect(fs.stat(local!.pushedRef)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toContain('recursive-delete');
        expect(summaries[0]).toContain('destructive-git');
        expect(verdicts).toEqual([{ decision: 'deny', code: 'tool_authorization_denied', reason: '主人尚未授权',
          authorization: { source: 'built-in', ruleIds: [] } }]);
        expect(JSON.stringify(results)).toContain('tool_authorization_denied: 主人尚未授权');
      } else if (mode === 'denied' || mode === 'subagent' || mode === 'native-denied' || mode === 'rules-ask' || mode === 'rules-floor') {
        await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(JSON.stringify(results)).toContain('tool_authorization_denied: 主人尚未授权');
        if (mode !== 'rules-ask') expect(summaries.some(summary => summary.includes('write-outside-workspace') && summary.includes(target))).toBe(true);
      } else {
        expect(await fs.readFile(target, 'utf8')).toBe('native-write');
      }
      if (mode === 'all' || mode === 'native-all') expect(calls).toEqual([]);
      if (native) expect(nativeRequests).toEqual([]);
      if (mode === 'native-approved') expect(summaries).toHaveLength(1);
      if (mode === 'workspace') expect(summaries).toEqual([]);
      if (mode === 'approved') expect(summaries).toHaveLength(1);
      if (mode === 'rules-ask' || mode === 'rules-floor') {
        expect(summaries).toHaveLength(1);
        expect(verdicts).toEqual([{ decision: 'deny', code: 'tool_authorization_denied', reason: '主人尚未授权',
          authorization: { source: mode === 'rules-floor' ? 'floor' : 'rule', ruleIds: mode === 'rules-floor' ? [] : ['ask-write'] } }]);
        if (mode === 'rules-floor') {
          expect(summaries[0]).toContain('sensitive-path');
          expect(summaries[0]).toMatch(/^Protected-path tool call/);
        }
      }
      if (mode === 'rules-allow' || mode === 'rules-resume') {
        expect(summaries).toEqual([]);
        expect(verdicts).toEqual([{ decision: 'allow', authorization: { source: 'rule', ruleIds: ['allow-write'] } }]);
      }
      if (mode === 'rules-resume') {
        const sessionRef = session.sessionRef;
        await session.close();
        await fs.rm(target);
        const resumedGate = createAutoToolAuthorizationGate({ workspace, home: root, timeoutMs: 5_000,
          rules: { alwaysAsk: [{ id: 'ask-resumed-write', match: { toolName: 'Write', pathGlob: target } }] },
          requestAuthorization: async summary => { summaries.push(summary); return { approved: false, reason: '主人尚未授权' }; },
        });
        session = await startPreparedOperation(adapter, { instruction: 'BYOK_RULE_RESUME_WRITE: perform the file operation again, then finish.', sessionRef }, {
          workspaceDir: workspace, agentHome: workspace, env, toolAuthorization: { timeoutMs: resumedGate.timeoutMs, authorize: async call => {
            const verdict = await resumedGate.authorize(call);
            verdicts.push(verdict);
            return verdict;
          } },
        });
        let resumedEnded = false;
        for await (const event of session.events) { if (event.type === 'turn_end') { resumedEnded = true; break; } }
        expect(resumedEnded).toBe(true);
        expect(session.sessionRef).toBe(sessionRef);
        expect(resumedWriteIssued).toBe(true);
        await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(summaries).toHaveLength(1);
        expect(verdicts[1]).toEqual({ decision: 'deny', code: 'tool_authorization_denied', reason: '主人尚未授权',
          authorization: { source: 'rule', ruleIds: ['ask-resumed-write'] } });
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(results)).toContain('tool_authorization_denied: 主人尚未授权');
      }
      if (mode === 'subagent') {
        expect(delegationOffered).toBe(true);
        expect(childWriteIssued).toBe(true);
        expect(calls.some(call => call.toolName === 'Agent' || call.toolName === 'Task')).toBe(true);
        expect(calls.some(call => call.toolName === 'Write' && typeof call.nativeAgentId === 'string' && call.nativeAgentId.length > 0)).toBe(true);
      }
    } finally {
      await session?.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
