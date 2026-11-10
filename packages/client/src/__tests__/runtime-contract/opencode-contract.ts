import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { OpenCodeAdapter } from '../../adapters/opencode/opencode-adapter';
import { QUALIFIED_OPENCODE_VERSION } from '../../adapters/opencode/opencode-version';
import {
  baseEnv, check, contractTarget, createSandbox, detectWith, egressCheck, expectDetectedVersion,
  fileEgress, notAdvertised, once, runTurn, skip, type ContractPlan, type ContractRuntime, type DeclaredHost,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, startLoopbackProvider } from './loopback';

const MODEL = 'fake';
const PROJECT_MARKER = 'BYOK-CONTRACT-OPENCODE-PROJECT-3e91';

/**
 * One OpenCode release line under the shared contract plan. OpenCode reads its
 * provider table from `$XDG_CONFIG_HOME/opencode/opencode.json`, so the contract
 * points a custom OpenAI-compatible provider at the loopback model (#1593).
 */
export function openCodeContract(
  runtime: Extract<ContractRuntime, 'opencode1' | 'opencode2'>, line: string, qualifiedVersion: string, declaredHosts: readonly DeclaredHost[] = [],
) {
  const target = contractTarget(runtime, qualifiedVersion);
  const resolveBin = () => ({ command: target.bin, source: 'env' as const });
  const adapter = () => new OpenCodeAdapter({ resolveBin, models: [`loopback/${MODEL}`] });
  const identifies = (version: string, expected: string) => version === expected;

  async function openCodeEnv(label: string, baseURL: string) {
    const box = await createSandbox(label);
    const env = baseEnv(box.home);
    const config = {
      $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', model: `loopback/${MODEL}`, small_model: `loopback/${MODEL}`,
      provider: { loopback: { npm: '@ai-sdk/openai-compatible', name: 'Loopback', options: { baseURL, apiKey: 'runtime-contract-placeholder' }, models: { [MODEL]: { name: 'Contract', tool_call: true, limit: { context: 32_000, output: 4096 } } } } },
    };
    await fs.mkdir(path.join(env.XDG_CONFIG_HOME!, 'opencode'), { recursive: true });
    await fs.writeFile(path.join(env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), JSON.stringify(config));
    return { box, env: { ...env, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1' } };
  }

  /** One contract turn against the loopback model, with a project AGENTS.md in the workspace. */
  const turn = once(async () => {
    const recorder = await fileEgress();
    const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }), MODEL);
    try {
      const { box, env } = await openCodeEnv(`${runtime}-turn`, provider.baseUrl);
      await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
      const events = await runTurn(adapter(), 'Say hello.', { workspaceDir: box.workspace, agentHome: box.workspace, env: { ...env, ...recorder.env } });
      return { events, provider };
    } finally {
      await provider.close();
    }
  });

  const descriptor = adapter().descriptor;
  const plan: ContractPlan = {
    'detect.version': check(async () => {
      const { env } = await openCodeEnv(`${runtime}-version`, 'http://127.0.0.1:1/v1');
      expectDetectedVersion(await detectWith(adapter(), env), { expectedVersion: target.expectedVersion, qualifiedVersion: QUALIFIED_OPENCODE_VERSION }, identifies, true);
    }),
    'detect.auth.absent': skip('the OpenCode adapter does not report authPresent; credentials live in OpenCode\'s own store, which the SDK never reads'),
    'detect.auth.apiKey': skip('the OpenCode adapter does not report authPresent; credentials live in OpenCode\'s own store, which the SDK never reads'),
    'detect.auth.login': skip('the OpenCode adapter does not report authPresent; credentials live in OpenCode\'s own store, which the SDK never reads'),
    'mcp.submitResult': notAdvertised(descriptor, 'mcpToolsets'),
    'instructions.project': check(async () => {
      expect((await turn()).provider.saw(PROJECT_MARKER)).toBe(true);
    }),
    'isolation.userInstructions': notAdvertised(descriptor, 'isolation.userInstructions'),
    'isolation.userOutputStyle': notAdvertised(descriptor, 'isolation.userOutputStyle'),
    'isolation.userMemory': notAdvertised(descriptor, 'isolation.userMemory'),
    'isolation.userSkills': notAdvertised(descriptor, 'isolation.userSkills'),
    'isolation.userHookContext': notAdvertised(descriptor, 'isolation.userHookContext'),
    'isolation.userMcp': notAdvertised(descriptor, 'isolation.userMcpServers'),
    'isolation.sessionPersistence': notAdvertised(descriptor, 'isolation.sessionPersistence'),
    drafts: notAdvertised(descriptor, 'messageDraft'),
    'gate.auto': notAdvertised(descriptor, 'toolAuthorizationAuto'),
    'egress.declaredHostsOnly': egressCheck(async () => { await turn(); }, declaredHosts),
  };
  return { title: `${line} runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, plan };
}
