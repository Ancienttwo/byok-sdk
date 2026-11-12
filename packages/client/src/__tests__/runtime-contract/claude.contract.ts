import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { ClaudeAdapter, type ClaudeAdapterOptions } from '../../adapters/claude/claude-adapter';
import { QUALIFIED_CLAUDE_VERSION } from '../../adapters/claude/claude-version';
import { CLAUDE_ABSENT_ISOLATION_SOURCES } from '../../adapters/claude/claude-capabilities';
import { createAutoToolAuthorizationGate } from '../../tool-authorization';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeCases, defineRuntimeContract, detectWith, draftText, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, once, readReceipt, runTurn, skip, spawned, writeSubmitResultServer, type TurnEvent,
} from './contract';
import {
  CONTRACT_REPLY_CHUNKS, callOnceThenReply, mcpTool, startLoopbackProvider, type ProviderRequest, type ProviderScript, type ProviderStep, type ProviderTool,
} from './loopback';
import { startPreparedOperation } from '../fixtures/prepared-operation';

const target = contractTarget('claude', QUALIFIED_CLAUDE_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const adapter = (options: ClaudeAdapterOptions = {}) => new ClaudeAdapter({ resolveBin, ...options });
const PROJECT_MARKER = 'BYOK-CONTRACT-CLAUDE-PROJECT-3a9d';
const USER_MARKER = 'BYOK-CONTRACT-CLAUDE-USER-b42f';
const ANCESTOR_MARKER = 'BYOK-CONTRACT-CLAUDE-ANCESTOR-7c20';
const OUTPUT_STYLE_MARKER = 'BYOK-CONTRACT-CLAUDE-OUTPUT-STYLE-5e81';
const AGENT_STYLE_MARKER = 'BYOK-CONTRACT-CLAUDE-AGENT-STYLE-91c4';
const MEMORY_MARKER = 'BYOK-CONTRACT-CLAUDE-MEMORY-d3a6';
/** The system-prompt section Claude adds for any output style other than the default, as JSON in the raw body. */
const OUTPUT_STYLE_SECTION = JSON.stringify('according to your "Output Style"').slice(1, -1);

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
 * Agent home, a user CLAUDE.md, output style and MCP server in the Claude
 * config directory. `excluded` turns on both Agent isolation options.
 */
async function turn(mode: 'inherit' | 'excluded', agentStyle = false) {
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
    // The Agent home's own style replaces the user's, so the two never share a turn.
    const styleRoot = agentStyle ? path.join(box.workspace, '.claude') : config;
    const styleName = agentStyle ? 'agent' : 'contract';
    await fs.mkdir(path.join(styleRoot, 'output-styles'), { recursive: true });
    await fs.writeFile(path.join(styleRoot, 'output-styles', `${styleName}.md`), `---\nname: ${styleName}\ndescription: ${styleName}\n---\n${agentStyle ? AGENT_STYLE_MARKER : OUTPUT_STYLE_MARKER}\n`);
    await fs.writeFile(path.join(styleRoot, 'settings.json'), JSON.stringify({ outputStyle: styleName }));
    await fs.writeFile(path.join(config, '.claude.json'), JSON.stringify({ mcpServers: { usermcp: { type: 'stdio', command: user.command, args: user.args } } }));
    // Claude keys a project's memory directory by its path with every non-alphanumeric character replaced by `-`.
    const memory = path.join(config, 'projects', (await fs.realpath(box.workspace)).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    await fs.mkdir(memory, { recursive: true });
    await fs.writeFile(path.join(memory, 'MEMORY.md'), `- ${MEMORY_MARKER}\n`);
    await fs.writeFile(path.join(box.workspace, 'CLAUDE.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    await fs.writeFile(path.join(box.root, 'CLAUDE.md'), `# Ancestor\n\n${ANCESTOR_MARKER}\n`);
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
const agentStyled = once(() => turn('excluded', true));
const agentStyledInherited = once(() => turn('inherit', true));
const gated = once(gateTurn);
const descriptor = adapter({ agentUserContext: 'excluded', agentSessionPersistence: 'disabled' }).descriptor;

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
  'isolation.userInstructions': check(async () => {
    expect((await inherited()).provider.saw(USER_MARKER), 'positive control: inherited user CLAUDE.md reaches the model').toBe(true);
    expect((await excluded()).provider.saw(USER_MARKER)).toBe(false);
    // Under excluded only the Agent home's instruction file remains, as for Pi.
    expect((await excluded()).provider.saw(ANCESTOR_MARKER)).toBe(false);
  }),
  'isolation.userOutputStyle': check(async () => {
    expect((await inherited()).provider.saw(OUTPUT_STYLE_MARKER), 'positive control: inherited user output style reaches the model').toBe(true);
    expect((await inherited()).provider.saw(OUTPUT_STYLE_SECTION), 'positive control: inherited output style section').toBe(true);
    expect((await excluded()).provider.saw(OUTPUT_STYLE_MARKER)).toBe(false);
    expect((await excluded()).provider.saw(OUTPUT_STYLE_SECTION)).toBe(false);
    expect((await excluded()).provider.saw(PROJECT_MARKER), 'positive control: the Agent home is still read under excluded').toBe(true);
    expect((await agentStyledInherited()).provider.saw(AGENT_STYLE_MARKER), 'positive control: the Agent home style reaches the model when inherited').toBe(true);
    // The flag-layer `outputStyle: "default"` outranks the Agent home's own settings, so excluded drops its style too.
    expect((await agentStyled()).provider.saw(AGENT_STYLE_MARKER)).toBe(false);
    expect((await agentStyled()).provider.saw(PROJECT_MARKER), 'positive control: the Agent home is still read under excluded').toBe(true);
  }),
  'isolation.userMemory': check(async () => {
    expect((await inherited()).provider.saw(MEMORY_MARKER), 'positive control: inherited auto memory reaches the model').toBe(true);
    expect((await excluded()).provider.saw(MEMORY_MARKER)).toBe(false);
  }),
  'isolation.userSkills': skip('claude loads skills, commands and subagents from the config directory under excluded; the descriptor declares userSkills false (docs/researches/2026-10-24-871-873-claude-agent-user-context.md)'),
  'isolation.userHookContext': skip('claude runs user and plugin hooks under excluded; the descriptor declares userHookContext false (docs/researches/2026-10-24-871-873-claude-agent-user-context.md)'),
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
  'egress.declaredHostsOnly': egressCheck(async () => { await excluded(); await inherited(); await agentStyled(); await agentStyledInherited(); await gated(); }, [
    { phase: 'detect', target: 'api.anthropic.com:443', reason: '`claude auth status` checks an ANTHROPIC_API_KEY with Anthropic' },
  ]),
}, CLAUDE_ABSENT_ISOLATION_SOURCES);

const FOLLOW_UP = 'BYOK-CONTRACT-CLAUDE-FOLLOW-UP-6d18';
/** Claude's closing text arrives as progress; with partial messages, also as draft deltas. */
const said = (events: readonly TurnEvent[], text: string) =>
  events.some(event => (event.type === 'progress' || event.type === 'message_draft_delta') && event.text.includes(text));
const lastMessage = (request: ProviderRequest): { role?: string; toolResult: boolean; text: string } => {
  const message = (JSON.parse(request.text) as { messages?: Array<{ role?: string; content?: unknown }> }).messages?.at(-1);
  const blocks = Array.isArray(message?.content) ? message.content as Array<{ type?: unknown }> : [];
  return { role: message?.role, toolResult: blocks.some(block => block.type === 'tool_result'), text: JSON.stringify(message?.content ?? '') };
};

/**
 * Claude's own turn (#1899): the task turn starts a background command; when
 * it completes while the session is idle, Claude wakes itself with a root
 * `system/init` and runs a turn the SDK never prompted. That turn runs a
 * blocking command, and the follow-up the SDK sends while it runs must wait
 * for it (#1892: OAR refuses the prompt busy and holds it).
 */
async function ownTurn() {
  const box = await createSandbox('claude-own-turn');
  const recorder = await fileEgress();
  const bash = (command: string, background: boolean): ProviderStep =>
    ({ kind: 'tool', tool: { name: 'Bash' }, args: { command, description: 'runtime contract', ...(background ? { run_in_background: true } : {}) } });
  const provider = await startLoopbackProvider('anthropic-messages', request => {
    const last = lastMessage(request);
    const prompt = request.tools.some(tool => tool.name === 'Bash') && last.role === 'user' && !last.toolResult;
    if (prompt && request.toolResults === 0 && last.text.includes('Start the background command')) return bash('sleep 3', true);
    // The background command's completion: a user message the SDK never sent.
    if (prompt && request.toolResults === 1) return bash('sleep 4; echo own-turn-done', false);
    return { kind: 'text', chunks: [last.text.includes(FOLLOW_UP) ? 'follow-up reply' : last.text.includes('own-turn-done') ? 'own turn reply' : 'runtime contract reply'] };
  });
  try {
    const config = path.join(box.home, '.claude');
    await fs.mkdir(config);
    const session = await startPreparedOperation(adapter(), { instruction: 'Start the background command, then finish.' }, {
      workspaceDir: box.workspace, agentHome: box.workspace, env: runtimeEnv(box.home, config, provider.origin, recorder.env),
    });
    const events: TurnEvent[] = [];
    let followUp: Promise<void> | undefined;
    let followUpAt = -1;
    const deadline = setTimeout(() => void session.close(), 120_000);
    try {
      // Each read of `events` ends at a turn end; read turns until the follow-up's reply has ended one.
      for (let turnStart = 0; followUp === undefined || !said(events.slice(turnStart), 'follow-up reply');) {
        turnStart = events.length;
        for await (const event of session.events) {
          events.push(event);
          // Claude's own turn is running its blocking command: the task turn already ended.
          if (followUp === undefined && event.type === 'tool_use' && JSON.stringify(event.input).includes('own-turn-done')) {
            followUpAt = events.length;
            followUp = session.followUp({ instruction: `${FOLLOW_UP}: reply.` });
          }
        }
      }
      await followUp;
    } finally {
      clearTimeout(deadline);
      await session.close();
    }
    return { events, followUpAt, requests: provider.requests.filter(request => request.model).map(request => ({ ...lastMessage(request), body: request.text })) };
  } finally {
    await provider.close();
  }
}

defineRuntimeCases(`claude runtime contract: claude cases (${target.mode} ${target.expectedVersion})`, {
  ownTurn: ['a follow-up sent during a turn Claude runs on its own is held until that turn ends, and adds no turn end of its own', check(async () => {
    const { events, followUpAt, requests } = await ownTurn();
    const ends = events.flatMap((event, index) => event.type === 'turn_end' ? [index] : []);
    // One turn end per root result: the task turn, Claude's own turn and the follow-up turn.
    expect(ends).toHaveLength(3);
    expect(followUpAt).toBeGreaterThan(ends[0]!);
    expect(followUpAt).toBeLessThan(ends[1]!);
    expect(events.slice(ends[0], ends[1]).some(event => event.type === 'tool_result' && JSON.stringify(event.output).includes('own-turn-done'))).toBe(true);
    expect(said(events.slice(ends[1]), 'follow-up reply')).toBe(true);
    // Claude received the follow-up only after its own turn's command result, never inside that turn.
    const ownTurnClosed = requests.findIndex(request => request.toolResult && request.text.includes('own-turn-done'));
    const followUpSent = requests.findIndex(request => request.body.includes(FOLLOW_UP));
    expect(ownTurnClosed).toBeGreaterThan(-1);
    expect(followUpSent).toBeGreaterThan(ownTurnClosed);
  })],
});
