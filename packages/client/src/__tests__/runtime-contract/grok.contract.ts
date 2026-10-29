import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { GrokAdapter, type GrokAdapterOptions } from '../../adapters/grok/grok-adapter';
import { QUALIFIED_GROK_VERSION } from '../../adapters/grok/grok-version';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeContract, detectWith, draftText, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, writeSubmitResultServer,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, startLoopbackProvider, type ProviderScript } from './loopback';

const target = contractTarget('grok', QUALIFIED_GROK_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const MODEL = 'contract-model';
const adapter = (options: GrokAdapterOptions = {}) => new GrokAdapter({ resolveBin, model: MODEL, ...options });
const PROJECT_MARKER = 'BYOK-CONTRACT-GROK-PROJECT-5d20';
const USER_MARKER = 'BYOK-CONTRACT-GROK-USER-e917';

/** Grok's own `--version` text: `grok 1.0.52 (0920c8169e27)`. */
const identifies = (version: string, expected: string) => /^grok (\S+)/.exec(version.trim())?.[1] === expected;

async function detectEnv(label: string, files: Record<string, string> = {}) {
  const box = await createSandbox(label);
  const grokHome = path.join(box.home, '.grok');
  await fs.mkdir(grokHome, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(grokHome, name), content, { mode: 0o600 });
  return { ...baseEnv(box.home), GROK_HOME: grokHome };
}

/**
 * Grok defers MCP tools: the model finds one with `search_tool`, then calls
 * the name the search returned through `use_tool`.
 */
const submitThroughSearchTool: ProviderScript = request => {
  const search = request.tools.find(tool => tool.name === 'search_tool');
  const use = request.tools.find(tool => tool.name === 'use_tool');
  if (search !== undefined && request.toolResults === 0) return { kind: 'tool', tool: search, args: { query: 'host submit_result' } };
  const found = /tool_name\\?"\s*:\s*\\?"([A-Za-z0-9_-]*submit_result)\\?"/.exec(request.text)?.[1];
  if (use !== undefined && request.toolResults === 1 && found !== undefined) {
    return { kind: 'tool', tool: use, args: { tool_name: found, tool_input: { summary: 'runtime contract' } } };
  }
  return { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS };
};

/**
 * One contract turn as an Agent task: a loopback chat-completions model in
 * GROK_HOME, a Host MCP server, the Agent home AGENTS.md, and user context in
 * Grok's Claude-compatible sources (`~/.claude/CLAUDE.md`, `~/.claude.json`),
 * which the two isolation options switch off.
 */
async function turn(mode: 'inherit' | 'excluded') {
  const box = await createSandbox(`grok-${mode}`);
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-chat', submitThroughSearchTool, MODEL);
  try {
    const grokHome = path.join(box.home, '.grok');
    await fs.mkdir(grokHome);
    await fs.mkdir(path.join(box.home, '.claude'));
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    const user = await writeSubmitResultServer(box.root, userReceipt, 'user_tool');
    await fs.writeFile(path.join(grokHome, 'config.toml'), [
      '[cli]', 'auto_update = false',
      '[model_providers.contract]', `base_url = "${provider.baseUrl}"`, 'api_backend = "chat_completions"',
      `[model."${MODEL}"]`, `model = "${MODEL}"`, 'model_provider = "contract"', `name = "${MODEL}"`,
      'context_window = 128000', 'max_completion_tokens = 1024', 'api_key = "runtime-contract-placeholder"', '',
    ].join('\n'), { mode: 0o600 });
    await fs.writeFile(path.join(box.home, '.claude', 'CLAUDE.md'), `# User\n\n${USER_MARKER}\n`);
    await fs.writeFile(path.join(box.home, '.claude.json'), JSON.stringify({ mcpServers: { usermcp: { type: 'stdio', command: user.command, args: user.args } } }));
    await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    const options: GrokAdapterOptions = mode === 'excluded' ? { compatInstructions: 'disabled', agentUserMcpServers: 'excluded' } : {};
    const events = await runTurn(adapter(options), 'Call the submit_result tool, then finish.', {
      workspaceDir: box.workspace, agentHome: box.workspace,
      env: { ...baseEnv(box.home), GROK_HOME: grokHome, ...recorder.env },
      mcpServers: { host },
    });
    return { events, provider, calls: await readReceipt(receipt), userSpawned: spawned(userReceipt) };
  } finally {
    await provider.close();
  }
}

const excluded = once(() => turn('excluded'));
const inherited = once(() => turn('inherit'));
const descriptor = adapter().descriptor;

defineRuntimeContract(`grok runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, {
  'detect.version': check(async () => {
    expectDetectedVersion(await detectWith(adapter(), await detectEnv('grok-version')), target, identifies, true);
  }),
  'detect.auth.absent': check(async () => {
    expectAuth(await detectWith(adapter(), await detectEnv('grok-auth-absent')), false);
  }),
  'detect.auth.apiKey': check(async () => {
    expectAuth(await detectWith(adapter(), { ...await detectEnv('grok-auth-key'), XAI_API_KEY: 'xai-runtime-contract-placeholder' }), true);
  }),
  'detect.auth.login': check(async () => {
    // The adapter checks that Grok's login file exists and never reads it.
    expectAuth(await detectWith(adapter(), await detectEnv('grok-auth-login', { 'auth.json': '{}' })), true);
  }),
  'mcp.submitResult': check(async () => {
    const { calls, events } = await excluded();
    expect(events.at(-1)?.type).toBe('turn_end');
    expect(calls).toEqual([expect.objectContaining({ name: 'submit_result', arguments: { summary: 'runtime contract' } })]);
  }),
  'instructions.project': check(async () => {
    expect((await excluded()).provider.saw(PROJECT_MARKER)).toBe(true);
  }),
  'isolation.userContext': check(async () => {
    expect((await inherited()).provider.saw(USER_MARKER), 'positive control: inherited ~/.claude/CLAUDE.md reaches the model').toBe(true);
    expect((await excluded()).provider.saw(USER_MARKER)).toBe(false);
  }),
  'isolation.userMcp': check(async () => {
    expect((await inherited()).userSpawned, 'positive control: inherited Claude-compatible MCP server starts').toBe(true);
    expect((await excluded()).userSpawned).toBe(false);
  }),
  'isolation.sessionPersistence': skip('the Grok adapter has no session persistence option; Grok keeps sessions under GROK_HOME'),
  drafts: check(async () => {
    expect(draftText((await excluded()).events, descriptor)).toContain('runtime contract reply');
  }),
  'gate.auto': notAdvertised(descriptor, 'toolAuthorizationAuto'),
  'egress.declaredHostsOnly': egressCheck(async () => { await excluded(); await inherited(); }, [
    { phase: 'turn', target: 'cli-chat-proxy.grok.com:443', reason: 'Grok syncs its workspace, bundle and experiments with xAI whatever the model provider (GROK_CLI_CHAT_PROXY_BASE_URL); follow-up to #1103' },
  ]),
});
