import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { CodexAdapter, type CodexAdapterOptions } from '../../adapters/codex/codex-adapter';
import { QUALIFIED_CODEX_VERSION } from '../../adapters/codex/codex-version';
import { CODEX_ABSENT_ISOLATION_SOURCES } from '../../adapters/codex/codex-capabilities';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeCases, defineRuntimeContract, detectWith, draftText, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, writeSubmitResultServer,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, callOnceThenReply, mcpTool, startLoopbackProvider } from './loopback';
import { testExecutionScratch } from '../fixtures/execution-scratch';
import { startPreparedOperation } from '../fixtures/prepared-operation';

const target = contractTarget('codex', QUALIFIED_CODEX_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const adapter = (options: CodexAdapterOptions = {}) => new CodexAdapter({ resolveBin, sandbox: 'inherit', operationTimeoutMs: 60_000, ...options });
const PROJECT_MARKER = 'BYOK-CONTRACT-CODEX-PROJECT-7c1e';
const USER_MARKER = 'BYOK-CONTRACT-CODEX-USER-5d02';
const MEMORY_MARKER = 'BYOK-CONTRACT-CODEX-MEMORY-0f47';
const FIRST_MARKER = 'BYOK-CONTRACT-CODEX-FIRST-TURN-93b8';
const placeholderKey = 'sk-runtime-contract-placeholder';

/** Codex's own `--version` text: `codex-cli 0.160.0`. */
const identifies = (version: string, expected: string) => /^codex-cli (\S+)$/.exec(version.trim())?.[1] === expected;

async function detectEnv(label: string, files: Record<string, string> = {}) {
  const box = await createSandbox(label);
  const codexHome = path.join(box.home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(codexHome, name), content, { mode: 0o600 });
  return { ...baseEnv(box.home), CODEX_HOME: codexHome };
}

/**
 * The user's `CODEX_HOME` of a contract turn: a placeholder file login, the
 * loopback provider, memories on, a user AGENTS.md and memory summary, and a
 * workspace AGENTS.md.
 */
async function writeUserHome(box: Awaited<ReturnType<typeof createSandbox>>, codexHome: string, baseUrl: string, egressEnv: Record<string, string>, extraConfig: readonly string[] = []) {
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: placeholderKey, tokens: null, last_refresh: null }), { mode: 0o600 });
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'cli_auth_credentials_store = "file"', 'model = "contract-model"', 'model_provider = "contract"',
    '[features]', 'plugins = false', 'memories = true',
    '[model_providers.contract]', 'name = "contract"', `base_url = "${baseUrl}"`, 'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"', 'supports_websockets = false', ...extraConfig, '',
  ].join('\n'), { mode: 0o600 });
  await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
  await fs.writeFile(path.join(codexHome, 'AGENTS.md'), `# User\n\n${USER_MARKER}\n`);
  await fs.mkdir(path.join(codexHome, 'memories'), { recursive: true });
  await fs.writeFile(path.join(codexHome, 'memories', 'memory_summary.md'), `${MEMORY_MARKER}\n`);
  return { ...baseEnv(box.home), CODEX_HOME: codexHome, OPENAI_API_KEY: placeholderKey, ...egressEnv };
}

/**
 * One contract turn: a loopback Responses provider, a Host MCP server that the
 * Host approved by exact tool name (#1072), a workspace AGENTS.md, and a user
 * MCP server in the user's config.toml.
 */
async function turn(mode: 'inherit' | 'excluded') {
  const box = await createSandbox(`codex-${mode}`);
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-responses', callOnceThenReply(mcpTool('host', 'submit_result'), { summary: 'runtime contract' }));
  try {
    const codexHome = path.join(box.home, '.codex');
    await fs.mkdir(codexHome);
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    const user = await writeSubmitResultServer(box.root, userReceipt, 'user_tool');
    const env = await writeUserHome(box, codexHome, provider.baseUrl, recorder.env, [
      '[mcp_servers.usermcp]', `command = ${JSON.stringify(user.command)}`, `args = ${JSON.stringify(user.args)}`,
    ]);
    const options: CodexAdapterOptions = mode === 'excluded' ? { agentUserMcpServers: 'excluded', agentUserContext: 'excluded' } : {};
    const events = await runTurn(adapter(options), 'Call the submit_result tool, then finish.', {
      workspaceDir: box.workspace, agentHome: box.workspace, env,
      mcpServers: { host }, mcpToolApprovals: { host: ['submit_result'] },
    });
    return { events, provider, calls: await readReceipt(receipt), userSpawned: spawned(userReceipt) };
  } finally {
    await provider.close();
  }
}

/**
 * Two Agent turns under `excluded`, each in its own execution and so its own
 * fresh SDK home: the second resumes the first's thread through the Agent's
 * own store in its home, with no Codex state database from the first. The user config
 * turns Codex memories on, and the second execution has a rollout to extract.
 */
const resumeTurns = once(async () => {
  const box = await createSandbox('codex-resume');
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-responses', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }));
  try {
    const codexHome = path.join(box.home, '.codex');
    await fs.mkdir(codexHome);
    const env = await writeUserHome(box, codexHome, provider.baseUrl, recorder.env);
    const runtime = adapter({ agentUserContext: 'excluded' });
    const homes: string[][] = [];
    const run = async (offer: { instruction: string; sessionRef?: string }) => {
      // The SDK home's entries just before the scratch is removed.
      const scratch = await testExecutionScratch();
      const release = async () => { homes.push(await fs.readdir(path.join(scratch.sdkDir, 'codex-home'))); await scratch.release(); };
      const session = await startPreparedOperation(runtime, offer, { workspaceDir: box.workspace, agentHome: box.workspace, env, scratch: { ...scratch, release } });
      for await (const event of session.events) if (event.type === 'turn_end') break;
      const ref = session.sessionRef;
      await session.close();
      return ref;
    };
    const sessionRef = await run({ instruction: `Remember ${FIRST_MARKER}.` });
    const before = provider.requests.length;
    const resumedRef = await run({ instruction: 'Continue.', sessionRef });
    const agentStore = (await fs.readdir(path.join(box.workspace, '.byok', 'codex', 'sessions'), { recursive: true })).filter(name => name.endsWith('.jsonl'));
    return { sessionRef, resumedRef, resumed: provider.requests.slice(before), all: provider.requests, homes, agentStore, userEntries: await fs.readdir(codexHome) };
  } finally {
    await provider.close();
  }
});

const excluded = once(() => turn('excluded'));
const inherited = once(() => turn('inherit'));
const descriptor = adapter().descriptor;

defineRuntimeContract(`codex runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, {
  'detect.version': check(async () => {
    expectDetectedVersion(await detectWith(adapter(), await detectEnv('codex-version')), target, identifies, true);
  }),
  'detect.auth.absent': check(async () => {
    expectAuth(await detectWith(adapter(), await detectEnv('codex-auth-absent')), false);
  }),
  'detect.auth.apiKey': skip('Codex `login status` reads only its stored login; an OPENAI_API_KEY in the environment is a provider env_key, not a Codex login'),
  'detect.auth.login': check(async () => {
    // The file `codex login --with-api-key` writes.
    const env = await detectEnv('codex-auth-login', { 'auth.json': JSON.stringify({ OPENAI_API_KEY: placeholderKey, tokens: null, last_refresh: null }), 'config.toml': 'cli_auth_credentials_store = "file"\n' });
    expectAuth(await detectWith(adapter(), env), true);
  }),
  'mcp.submitResult': check(async () => {
    const { calls, events } = await excluded();
    expect(events.at(-1)?.type).toBe('turn_end');
    expect(calls).toEqual([expect.objectContaining({ name: 'submit_result', arguments: { summary: 'runtime contract' } })]);
  }),
  'instructions.project': check(async () => {
    const { provider } = await excluded();
    expect(provider.saw(PROJECT_MARKER)).toBe(true);
  }),
  'isolation.userInstructions': check(async () => {
    expect((await inherited()).provider.saw(USER_MARKER), 'positive control: inherited user AGENTS.md reaches the model').toBe(true);
    expect((await excluded()).provider.saw(USER_MARKER)).toBe(false);
    expect((await excluded()).provider.saw(PROJECT_MARKER), 'positive control: the Agent home is still read under excluded').toBe(true);
  }),
  'isolation.userOutputStyle': notAdvertised(descriptor, 'isolation.userOutputStyle'),
  'isolation.userMemory': check(async () => {
    expect((await inherited()).provider.saw(MEMORY_MARKER), 'positive control: inherited memory summary reaches the model').toBe(true);
    expect((await excluded()).provider.saw(MEMORY_MARKER)).toBe(false);
  }),
  'isolation.userSkills': skip('codex also loads user skills from $HOME/.agents/skills, outside CODEX_HOME; the descriptor declares userSkills false (docs/adapter-capabilities.md)'),
  'isolation.userHookContext': notAdvertised(descriptor, 'isolation.userHookContext'),
  'isolation.userMcp': check(async () => {
    expect((await inherited()).userSpawned, 'positive control: inherited user MCP server starts').toBe(true);
    expect((await excluded()).userSpawned).toBe(false);
  }),
  'isolation.sessionPersistence': skip('the Codex adapter has no session persistence option; Codex keeps its thread store under CODEX_HOME'),
  drafts: check(async () => {
    expect(draftText((await excluded()).events, descriptor)).toContain('runtime contract reply');
  }),
  'gate.auto': notAdvertised(descriptor, 'toolAuthorizationAuto'),
  'egress.declaredHostsOnly': egressCheck(async () => { await excluded(); await inherited(); }),
}, CODEX_ABSENT_ISOLATION_SOURCES);

defineRuntimeCases(`codex runtime cases (${target.mode} ${target.expectedVersion})`, {
  'codex.resume.excluded': ['under agentUserContext excluded, a second execution resumes the first execution\'s thread from the Agent home store, and the user CODEX_HOME gets no sessions/', check(async () => {
    const { sessionRef, resumedRef, resumed, agentStore, userEntries } = await resumeTurns();
    expect(agentStore.some(name => name.includes(sessionRef)), 'the rollout is in the Agent home store').toBe(true);
    expect(userEntries).not.toContain('sessions');
    expect(sessionRef).not.toBe('');
    expect(resumedRef).toBe(sessionRef);
    // Codex's own background memory agent runs on another thread; only the resumed thread's requests count.
    const thread = resumed.filter(request => request.text.includes(sessionRef));
    expect(thread.length).toBeGreaterThan(0);
    expect(thread.every(request => request.text.includes(FIRST_MARKER)), 'the resumed thread carries the first turn').toBe(true);
    expect(resumed.some(request => request.text.includes(USER_MARKER))).toBe(false);
  })],
  'codex.memoryPipeline.excluded': ['under agentUserContext excluded, the user config\'s memories feature runs no memory agent and writes no memories in the SDK home', check(async () => {
    const { all, homes } = await resumeTurns();
    expect(all.some(request => request.text.includes('Memory Writing Agent'))).toBe(false);
    expect(homes).toHaveLength(2);
    for (const entries of homes) expect(entries).not.toContain('memories');
  })],
});
