import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { GrokAdapter, type GrokAdapterOptions } from '../../adapters/grok/grok-adapter';
import { QUALIFIED_GROK_VERSION } from '../../adapters/grok/grok-version';
import { GROK_ABSENT_ISOLATION_SOURCES } from '../../adapters/grok/grok-capabilities';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeCases, defineRuntimeContract, detectWith, draftText, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, writeSubmitResultServer, type TurnEvent,
} from './contract';
import { searchThenCall, startLoopbackProvider, type ProviderRequest, type ProviderStep } from './loopback';
import { startPreparedOperation } from '../fixtures/prepared-operation';

const target = contractTarget('grok', QUALIFIED_GROK_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const MODEL = 'contract-model';
const adapter = (options: GrokAdapterOptions = {}) => new GrokAdapter({ resolveBin, model: MODEL, ...options });
const PROJECT_MARKER = 'BYOK-CONTRACT-GROK-PROJECT-5d20';

/** Grok's own `--version` text: `grok 1.0.77 (50ca579fa996)`. */
const identifies = (version: string, expected: string) => /^grok (\S+)/.exec(version.trim())?.[1] === expected;

async function detectEnv(label: string, files: Record<string, string> = {}) {
  const box = await createSandbox(label);
  const grokHome = path.join(box.home, '.grok');
  await fs.mkdir(grokHome, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(grokHome, name), content, { mode: 0o600 });
  return { ...baseEnv(box.home), GROK_HOME: grokHome };
}

/** Grok defers MCP tools: `search_tool` finds one, `use_tool` calls the name the search returned. */
const submitThroughSearchTool = searchThenCall({
  search: 'search_tool', searchArgs: { query: 'host submit result' },
  call: 'use_tool', callArgs: name => ({ tool_name: name, tool_input: { summary: 'runtime contract' } }),
}, 'submit_result');

/** GROK_HOME whose only model is the loopback provider at `baseUrl`. */
async function loopbackGrokHome(home: string, baseUrl: string): Promise<string> {
  const grokHome = path.join(home, '.grok');
  await fs.mkdir(grokHome);
  await fs.writeFile(path.join(grokHome, 'config.toml'), [
    '[cli]', 'auto_update = false',
    '[model_providers.contract]', `base_url = "${baseUrl}"`, 'api_backend = "chat_completions"',
    `[model."${MODEL}"]`, `model = "${MODEL}"`, 'model_provider = "contract"', `name = "${MODEL}"`,
    'context_window = 128000', 'max_completion_tokens = 1024', 'api_key = "runtime-contract-placeholder"', '',
  ].join('\n'), { mode: 0o600 });
  return grokHome;
}

/**
 * One contract turn as an Agent task: a loopback chat-completions model in
 * GROK_HOME, a Host MCP server, the Agent home AGENTS.md, and a user MCP server
 * in Grok's Claude-compatible `~/.claude.json`, which `agentUserMcpServers`
 * switches off.
 */
async function turn(mode: 'inherit' | 'excluded') {
  const box = await createSandbox(`grok-${mode}`);
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-chat', submitThroughSearchTool, MODEL);
  try {
    const grokHome = await loopbackGrokHome(box.home, provider.baseUrl);
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    const user = await writeSubmitResultServer(box.root, userReceipt, 'user_tool');
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
const descriptor = adapter({ agentUserMcpServers: 'excluded' }).descriptor;

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
  'isolation.userInstructions': skip('Grok has no per-process switch for $GROK_HOME/AGENTS.md, $GROK_HOME/rules/ or [paths] extra_rule_dirs; compatInstructions turns off only the Claude and Cursor sources (docs/adapter-capabilities.md)'),
  'isolation.userOutputStyle': notAdvertised(descriptor, 'isolation.userOutputStyle'),
  'isolation.userMemory': notAdvertised(descriptor, 'isolation.userMemory'),
  'isolation.userSkills': notAdvertised(descriptor, 'isolation.userSkills'),
  'isolation.userHookContext': notAdvertised(descriptor, 'isolation.userHookContext'),
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
}, GROK_ABSENT_ISOLATION_SOURCES);

const FOLLOW_UP = 'BYOK-CONTRACT-GROK-FOLLOW-UP-3e71';
const lastMessage = (request: ProviderRequest): { role?: string; text: string } => {
  const message = (JSON.parse(request.text) as { messages?: Array<{ role?: string; content?: unknown }> }).messages?.at(-1);
  return { role: message?.role, text: JSON.stringify(message?.content ?? '') };
};
/** Grok's title and summary requests quote the conversation back; they are not turns and Grok bills them to none. */
const auxiliary = (text: string) => text.includes('<agent_reply>') || text.includes('Generate a session title');

/**
 * Grok's own turn (OAR 0.99 native turns, Grok 1.0.70 and later): the task
 * turn starts a background command; when it completes Grok wakes itself with a
 * reminder and runs a turn the SDK never prompted. That turn runs a blocking
 * command, and the follow-up the SDK sends while it runs must wait for it.
 */
async function ownTurn() {
  const box = await createSandbox('grok-own-turn');
  const terminal = (command: string, blockUntilMs: number): ProviderStep =>
    ({ kind: 'tool', tool: { name: 'run_terminal_command' }, args: { command, block_until_ms: blockUntilMs, description: 'runtime contract' } });
  const provider = await startLoopbackProvider('openai-chat', request => {
    const { role, text } = lastMessage(request);
    if (auxiliary(text)) return { kind: 'text', chunks: ['runtime contract title'] };
    if (role === 'user' && text.includes('Start the background command')) return terminal('sleep 2', 0);
    if (role === 'user' && text.includes('completed (exit code')) return terminal('sleep 4; echo own-turn-done', 20_000);
    return { kind: 'text', chunks: [text.includes(FOLLOW_UP) ? 'follow-up reply' : 'runtime contract reply'] };
  }, MODEL);
  try {
    const grokHome = await loopbackGrokHome(box.home, provider.baseUrl);
    const session = await startPreparedOperation(adapter(), { instruction: 'Start the background command, then finish.' }, {
      workspaceDir: box.workspace, agentHome: box.workspace, env: { ...baseEnv(box.home), GROK_HOME: grokHome },
    });
    const events: TurnEvent[] = [];
    let followUp: Promise<void> | undefined;
    const deadline = setTimeout(() => void session.close(), 120_000);
    try {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === 'turn_end' && followUp !== undefined) break;
        // Grok's own turn is running its blocking command: the task turn already ended.
        if (event.type === 'tool_use' && JSON.stringify(event.input).includes('own-turn-done')) followUp = session.followUp({ instruction: `${FOLLOW_UP}: reply.` });
      }
      await followUp;
    } finally {
      clearTimeout(deadline);
      await session.close();
    }
    return { events, requests: provider.requests.filter(request => request.model).map(lastMessage).filter(message => !auxiliary(message.text)) };
  } finally {
    await provider.close();
  }
}

defineRuntimeCases(`grok runtime contract: grok cases (${target.mode} ${target.expectedVersion})`, {
  ownTurn: ['a turn Grok runs on its own ends no task turn, holds a follow-up until it closes, and its usage is counted once', check(async () => {
    const { events, requests } = await ownTurn();
    const ends = events.flatMap((event, index) => event.type === 'turn_end' ? [index] : []);
    expect(ends).toHaveLength(2);
    // The own turn's command ran between the task turn and the follow-up turn, with no turn end of its own.
    expect(events.slice(ends[0], ends[1]).some(event => event.type === 'tool_result' && JSON.stringify(event.output).includes('own-turn-done'))).toBe(true);
    const ownTurnClosed = requests.findIndex(message => message.role === 'tool' && message.text.includes('own-turn-done'));
    const followUpSent = requests.findIndex(message => message.text.includes(FOLLOW_UP));
    expect(ownTurnClosed).toBeGreaterThan(-1);
    expect(followUpSent).toBeGreaterThan(ownTurnClosed);
    // The loopback bills one output token per turn request: every request counted, none twice.
    const usage = events.filter(event => event.type === 'usage');
    expect(usage).toHaveLength(2);
    expect(usage.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0)).toBe(requests.length);
  })],
});
