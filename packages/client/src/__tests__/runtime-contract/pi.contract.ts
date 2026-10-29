import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { PiAdapter, type PiAdapterOptions } from '../../adapters/pi/pi-adapter';
import { readClientPiRuntimePin } from '../../adapters/pi/client-manifest';
import { createAutoToolAuthorizationGate } from '../../tool-authorization';
import {
  baseEnv, check, contractMode, createSandbox, defineRuntimeContract, detectWith, draftText, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, observeServers, once, readReceipt, runTurn, skip, skipRuntimeContract, writeSubmitResultServer,
} from './contract';
import { callOnceThenReply, mcpTool, startLoopbackProvider, type ProviderScript, type ProviderTool } from './loopback';

/**
 * Pi is bundled: the client depends on one exact Pi release (`byok.piRuntimePin`)
 * and the adapter runs that package, so the qualified version is the pin and
 * the only installed one.
 */
const pin = readClientPiRuntimePin();
if (pin === undefined) throw new Error('packages/client/package.json has no byok.piRuntimePin');
const mode = contractMode();
// The ordinary RPC host the daemon launches; `bun run build` writes it.
const rpcHost = path.resolve(import.meta.dirname, '../../../dist/bin/byok-pi-rpc.js');
const turnAdapter = (options: PiAdapterOptions = {}) => new PiAdapter({ resolveBin: () => ({ command: rpcHost, source: 'package' }), ...options });
const PROJECT_MARKER = 'BYOK-CONTRACT-PI-PROJECT-91c4';
const USER_MARKER = 'BYOK-CONTRACT-PI-USER-0d6b';
const PROVIDER = 'contract-loopback';

/** Pi's own `--version` text is the bare release. */
const identifies = (version: string, expected: string) => version.trim() === expected;

async function detectEnv(label: string, files: Record<string, string> = {}) {
  const box = await createSandbox(label);
  const agentDir = path.join(box.home, '.pi', 'agent');
  await fs.mkdir(agentDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(agentDir, name), content, { mode: 0o600 });
  return { ...baseEnv(box.home), PI_CODING_AGENT_DIR: agentDir };
}

/** A Pi agent directory whose default model is the loopback provider. */
async function agentDirFor(home: string, baseUrl: string): Promise<string> {
  const agentDir = path.join(home, '.pi', 'agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { [PROVIDER]: {
    baseUrl, api: 'openai-completions', apiKey: 'runtime-contract-placeholder',
    models: [{ id: 'contract-model', name: 'contract-model', contextWindow: 32_768, maxTokens: 256, input: ['text'], reasoning: false }],
  } } }));
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: 'contract-model' }));
  return agentDir;
}

/**
 * One contract turn as an Agent task: a Host MCP server (observed, as the
 * daemon does before Pi registers its tools), the Agent home AGENTS.md, and a
 * user AGENTS.md in Pi's agent directory.
 */
async function turn(userContext: 'inherit' | 'excluded') {
  const box = await createSandbox(`pi-${userContext}`);
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-chat', callOnceThenReply(mcpTool('host', 'submit_result'), { summary: 'runtime contract' }));
  try {
    const agentDir = await agentDirFor(box.home, provider.baseUrl);
    await fs.writeFile(path.join(agentDir, 'AGENTS.md'), `# User\n\n${USER_MARKER}\n`);
    await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    const receipt = path.join(box.root, 'host.jsonl');
    const mcpServers = { host: await writeSubmitResultServer(box.root, receipt) };
    const env = { ...baseEnv(box.home), PI_CODING_AGENT_DIR: agentDir, ...recorder.env };
    const events = await runTurn(turnAdapter({ agentUserContext: userContext }), 'Call the submit_result tool, then finish.', {
      workspaceDir: box.workspace, agentHome: box.workspace, env, mcpServers, mcpToolsetTools: await observeServers(mcpServers, env),
    });
    return { events, provider, calls: await readReceipt(receipt) };
  } finally {
    await provider.close();
  }
}

/** The auto gate: the model writes outside the Agent home and the owner declines. */
async function gateTurn() {
  const box = await createSandbox('pi-gate');
  const recorder = await fileEgress();
  const outside = path.join(box.root, 'outside.txt');
  const summaries: string[] = [];
  const write = (tools: readonly ProviderTool[]) => tools.find(tool => tool.name === 'write');
  const script: ProviderScript = callOnceThenReply(write, { path: outside, content: 'runtime contract' });
  const provider = await startLoopbackProvider('openai-chat', script);
  try {
    const agentDir = await agentDirFor(box.home, provider.baseUrl);
    const toolAuthorization = createAutoToolAuthorizationGate({ workspace: box.workspace, timeoutMs: 10_000, requestAuthorization: async summary => {
      summaries.push(summary);
      return { approved: false, reason: 'runtime contract declines' };
    } });
    const events = await runTurn(turnAdapter(), 'Write the requested file, then finish.', {
      workspaceDir: box.workspace, agentHome: box.workspace, env: { ...baseEnv(box.home), PI_CODING_AGENT_DIR: agentDir, ...recorder.env }, toolAuthorization,
    });
    return { events, summaries, written: existsSync(outside), outside, provider };
  } finally {
    await provider.close();
  }
}

const descriptor = new PiAdapter().descriptor;

if (mode === 'latest') {
  skipRuntimeContract(`pi runtime contract (latest)`, 'Pi is bundled at byok.piRuntimePin and the SDK runs only that release; a newer Pi is qualified by a pin bump PR, which runs this suite in qualified mode');
} else {
  const excluded = once(() => turn('excluded'));
  const inherited = once(() => turn('inherit'));
  const gated = once(gateTurn);
  defineRuntimeContract(`pi runtime contract (qualified ${pin})`, descriptor, {
    'detect.version': check(async () => {
      expectDetectedVersion(await detectWith(new PiAdapter(), await detectEnv('pi-version')), { expectedVersion: pin, qualifiedVersion: pin }, identifies, false);
    }),
    'detect.auth.absent': check(async () => {
      expectAuth(await detectWith(new PiAdapter(), await detectEnv('pi-auth-absent')), false);
    }),
    'detect.auth.apiKey': check(async () => {
      expectAuth(await detectWith(new PiAdapter(), { ...await detectEnv('pi-auth-key'), ANTHROPIC_API_KEY: 'sk-ant-runtime-contract-placeholder' }), true);
    }),
    'detect.auth.login': check(async () => {
      // The record `pi /login` stores for an API-key provider.
      const env = await detectEnv('pi-auth-login', { 'auth.json': JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-runtime-contract-placeholder' } }) });
      expectAuth(await detectWith(new PiAdapter(), env), true);
    }),
    'mcp.submitResult': check(async () => {
      const { calls, events } = await excluded();
      expect(events.at(-1)?.type).toBe('turn_end');
      expect(calls).toEqual([expect.objectContaining({ name: 'submit_result', arguments: { summary: 'runtime contract' } })]);
    }),
    // Excluded user context drops every Pi context file, the Agent-home
    // AGENTS.md too (docs/adapter-capabilities.md); the Host supplies the persona.
    'instructions.project': check(async () => {
      expect((await inherited()).provider.saw(PROJECT_MARKER)).toBe(true);
    }),
    'isolation.userContext': check(async () => {
      expect((await inherited()).provider.saw(USER_MARKER), 'positive control: the inherited agent-directory AGENTS.md reaches the model').toBe(true);
      expect((await excluded()).provider.saw(USER_MARKER)).toBe(false);
    }),
    'isolation.userMcp': skip('Pi has no user MCP configuration; it registers only the task servers the daemon observed'),
    'isolation.sessionPersistence': skip('the Pi adapter has no session persistence option; resume relies on the Agent home session store'),
    drafts: check(async () => {
      expect(draftText((await excluded()).events, descriptor)).toContain('runtime contract reply');
    }),
    'gate.auto': check(async () => {
      const { written, summaries, outside, provider } = await gated();
      expect(provider.requests.some(request => request.tools.some(tool => tool.name === 'write')), 'the model was offered write').toBe(true);
      expect(summaries.some(summary => summary.includes(outside))).toBe(true);
      expect(written).toBe(false);
    }),
    'egress.declaredHostsOnly': egressCheck(async () => { await excluded(); await inherited(); await gated(); }),
  });
}
