import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { ClaudeAdapter, type ClaudeAdapterOptions } from '../../adapters/claude/claude-adapter';
import { QUALIFIED_CLAUDE_VERSION } from '../../adapters/claude/claude-version';
import { createAutoToolAuthorizationGate } from '../../tool-authorization';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeContract, detectWith, draftText, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, once, readReceipt, runTurn, spawned, writeSubmitResultServer,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, callOnceThenReply, mcpTool, startLoopbackProvider, type ProviderScript, type ProviderTool } from './loopback';

const target = contractTarget('claude', QUALIFIED_CLAUDE_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const adapter = (options: ClaudeAdapterOptions = {}) => new ClaudeAdapter({ resolveBin, ...options });
const PROJECT_MARKER = 'BYOK-CONTRACT-CLAUDE-PROJECT-3a9d';
const USER_MARKER = 'BYOK-CONTRACT-CLAUDE-USER-b42f';

/** Claude Code's own `--version` text: `2.1.312 (Claude Code)`. */
const identifies = (version: string, expected: string) => /^(\S+) \(Claude Code\)$/.exec(version.trim())?.[1] === expected;

async function detectEnv(label: string, files: Record<string, string> = {}) {
  const box = await createSandbox(label);
  const config = path.join(box.home, '.claude');
  await fs.mkdir(config, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(config, name), content, { mode: 0o600 });
  return { ...baseEnv(box.home), CLAUDE_CONFIG_DIR: config };
}

/** The Host's runtime environment for Claude: the loopback provider, no nonessential traffic. */
function runtimeEnv(home: string, config: string, origin: string, egress: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...baseEnv(home), CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: origin, ANTHROPIC_API_KEY: 'sk-ant-runtime-contract-placeholder',
    ANTHROPIC_MODEL: 'claude-sonnet-4-6', ANTHROPIC_SMALL_FAST_MODEL: 'claude-sonnet-4-6',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ...egress,
  };
}

const submitResult = mcpTool('host', 'submit_result');
/**
 * Claude defers MCP tools behind its native ToolSearch: the model sees the
 * deferred name, searches for it, and only then may call it.
 */
const submitThroughToolSearch: ProviderScript = request => {
  const direct = submitResult(request.tools);
  if (direct !== undefined && !request.text.includes('runtime contract result accepted')) return { kind: 'tool', tool: direct, args: { summary: 'runtime contract' } };
  const search = request.tools.find(tool => tool.name === 'ToolSearch');
  if (search !== undefined && request.toolResults === 0 && request.text.includes('mcp__host__submit_result')) {
    return { kind: 'tool', tool: search, args: { query: 'select:mcp__host__submit_result', max_results: 1 } };
  }
  return { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS };
};

/**
 * One contract turn as an Agent task: a Host MCP server, a CLAUDE.md in the
 * Agent home, a user CLAUDE.md and a user MCP server in the Claude config
 * directory. `excluded` turns on both Agent isolation options.
 */
async function turn(mode: 'inherit' | 'excluded') {
  const box = await createSandbox(`claude-${mode}`);
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('anthropic-messages', submitThroughToolSearch);
  try {
    const config = path.join(box.home, '.claude');
    await fs.mkdir(config);
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    const user = await writeSubmitResultServer(box.root, userReceipt, 'user_tool');
    await fs.writeFile(path.join(config, 'CLAUDE.md'), `# User\n\n${USER_MARKER}\n`);
    await fs.writeFile(path.join(config, '.claude.json'), JSON.stringify({ mcpServers: { usermcp: { type: 'stdio', command: user.command, args: user.args } } }));
    await fs.writeFile(path.join(box.workspace, 'CLAUDE.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    const options: ClaudeAdapterOptions = mode === 'excluded' ? { agentUserContext: 'excluded', agentSessionPersistence: 'disabled' } : {};
    const events = await runTurn(adapter(options), 'Call the submit_result tool, then finish.', {
      workspaceDir: box.workspace, agentHome: box.workspace, env: runtimeEnv(box.home, config, provider.origin, recorder.env),
      mcpServers: { host },
    });
    const transcripts = existsSync(path.join(config, 'projects'))
      ? (await fs.readdir(path.join(config, 'projects'), { recursive: true })).filter(name => String(name).endsWith('.jsonl'))
      : [];
    return { events, provider, calls: await readReceipt(receipt), userSpawned: spawned(userReceipt), transcripts };
  } finally {
    await provider.close();
  }
}

/** The auto gate: the model writes outside the Agent home and the owner declines. */
async function gateTurn() {
  const box = await createSandbox('claude-gate');
  const recorder = await fileEgress();
  const outside = path.join(box.root, 'outside.txt');
  const summaries: string[] = [];
  const write = (tools: readonly ProviderTool[]) => tools.find(tool => tool.name === 'Write');
  const provider = await startLoopbackProvider('anthropic-messages', callOnceThenReply(write, { file_path: outside, content: 'runtime contract' }));
  try {
    const config = path.join(box.home, '.claude');
    await fs.mkdir(config);
    const toolAuthorization = createAutoToolAuthorizationGate({ workspace: box.workspace, timeoutMs: 10_000, requestAuthorization: async summary => {
      summaries.push(summary);
      return { approved: false, reason: 'runtime contract declines' };
    } });
    const events = await runTurn(adapter(), 'Write the requested file, then finish.', {
      workspaceDir: box.workspace, agentHome: box.workspace, env: runtimeEnv(box.home, config, provider.origin, recorder.env), toolAuthorization,
    });
    return { events, summaries, written: existsSync(outside), outside, provider };
  } finally {
    await provider.close();
  }
}

const excluded = once(() => turn('excluded'));
const inherited = once(() => turn('inherit'));
const gated = once(gateTurn);
const descriptor = adapter().descriptor;

defineRuntimeContract(`claude runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, {
  'detect.version': check(async () => {
    expectDetectedVersion(await detectWith(adapter(), await detectEnv('claude-version')), target, identifies, false);
  }),
  'detect.auth.absent': check(async () => {
    expectAuth(await detectWith(adapter(), await detectEnv('claude-auth-absent')), false);
  }),
  'detect.auth.apiKey': check(async () => {
    expectAuth(await detectWith(adapter(), { ...await detectEnv('claude-auth-key'), ANTHROPIC_API_KEY: 'sk-ant-runtime-contract-placeholder' }), true);
  }),
  'detect.auth.login': check(async () => {
    // The file form of a claude.ai login (`claude auth login` on Linux, or any platform with CLAUDE_CONFIG_DIR).
    const credentials = { claudeAiOauth: { accessToken: 'sk-ant-oat01-contract', refreshToken: 'sk-ant-ort01-contract', expiresAt: 4_102_444_800_000, scopes: ['user:inference'], subscriptionType: 'pro' } };
    expectAuth(await detectWith(adapter(), await detectEnv('claude-auth-login', { '.credentials.json': JSON.stringify(credentials) })), true);
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
    expect((await inherited()).provider.saw(USER_MARKER), 'positive control: inherited user CLAUDE.md reaches the model').toBe(true);
    expect((await excluded()).provider.saw(USER_MARKER)).toBe(false);
  }),
  'isolation.userMcp': check(async () => {
    expect((await inherited()).userSpawned, 'positive control: inherited user MCP server starts').toBe(true);
    expect((await excluded()).userSpawned).toBe(false);
  }),
  'isolation.sessionPersistence': check(async () => {
    expect((await inherited()).transcripts.length, 'positive control: a persisted session writes a transcript').toBeGreaterThan(0);
    expect((await excluded()).transcripts).toEqual([]);
  }),
  drafts: check(async () => {
    expect(draftText((await excluded()).events, descriptor)).toContain('runtime contract reply');
  }),
  'gate.auto': check(async () => {
    const { written, summaries, outside, provider } = await gated();
    expect(provider.requests.some(request => request.tools.some(tool => tool.name === 'Write')), 'the model was offered Write').toBe(true);
    expect(summaries.some(summary => summary.includes(outside))).toBe(true);
    expect(written).toBe(false);
  }),
  'egress.declaredHostsOnly': egressCheck(async () => { await excluded(); await inherited(); await gated(); }, [
    { phase: 'detect', target: 'api.anthropic.com:443', reason: '`claude auth status` checks an ANTHROPIC_API_KEY with Anthropic' },
  ]),
});
