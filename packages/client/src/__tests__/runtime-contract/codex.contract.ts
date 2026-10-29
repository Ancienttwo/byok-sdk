import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { CodexAdapter, type CodexAdapterOptions } from '../../adapters/codex/codex-adapter';
import { QUALIFIED_CODEX_VERSION } from '../../adapters/codex/codex-version';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeContract, detectWith, draftText, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, writeSubmitResultServer,
} from './contract';
import { callOnceThenReply, mcpTool, startLoopbackProvider } from './loopback';

const target = contractTarget('codex', QUALIFIED_CODEX_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const adapter = (options: CodexAdapterOptions = {}) => new CodexAdapter({ resolveBin, sandbox: 'inherit', operationTimeoutMs: 60_000, ...options });
const PROJECT_MARKER = 'BYOK-CONTRACT-CODEX-PROJECT-7c1e';
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
 * One contract turn: a loopback Responses provider, a Host MCP server that the
 * Host approved by exact tool name (#1072), a workspace AGENTS.md, and a user
 * MCP server in the user's config.toml.
 */
async function turn(userMcp: 'inherit' | 'excluded') {
  const box = await createSandbox(`codex-${userMcp}`);
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-responses', callOnceThenReply(mcpTool('host', 'submit_result'), { summary: 'runtime contract' }));
  try {
    const codexHome = path.join(box.home, '.codex');
    await fs.mkdir(codexHome);
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    const user = await writeSubmitResultServer(box.root, userReceipt, 'user_tool');
    await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: placeholderKey, tokens: null, last_refresh: null }), { mode: 0o600 });
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'cli_auth_credentials_store = "file"', 'model = "contract-model"', 'model_provider = "contract"',
      '[features]', 'plugins = false',
      '[model_providers.contract]', 'name = "contract"', `base_url = "${provider.baseUrl}"`, 'wire_api = "responses"',
      'env_key = "OPENAI_API_KEY"', 'supports_websockets = false',
      '[mcp_servers.usermcp]', `command = ${JSON.stringify(user.command)}`, `args = ${JSON.stringify(user.args)}`, '',
    ].join('\n'), { mode: 0o600 });
    await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    const env = { ...baseEnv(box.home), CODEX_HOME: codexHome, OPENAI_API_KEY: placeholderKey, ...recorder.env };
    const events = await runTurn(adapter({ agentUserMcpServers: userMcp }), 'Call the submit_result tool, then finish.', {
      workspaceDir: box.workspace, agentHome: box.workspace, env,
      mcpServers: { host }, mcpToolApprovals: { host: ['submit_result'] },
    });
    return { events, provider, calls: await readReceipt(receipt), userSpawned: spawned(userReceipt) };
  } finally {
    await provider.close();
  }
}

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
  'isolation.userContext': skip('Codex has no per-process switch for the user AGENTS.md; the adapter documents that it applies (docs/adapter-capabilities.md)'),
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
});
