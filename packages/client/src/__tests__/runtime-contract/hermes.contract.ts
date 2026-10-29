import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, expect } from 'vitest';
import { HermesAdapter, type HermesModelSelection } from '../../adapters/hermes/hermes-adapter';
import { hermesVersionLine, QUALIFIED_HERMES_VERSION } from '../../adapters/hermes/hermes-version';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeContract, detectWith, draftText, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, withProcessEnv, writeSubmitResultServer,
} from './contract';
import { searchThenCall, startLoopbackProvider } from './loopback';

const target = contractTarget('hermes', QUALIFIED_HERMES_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
// The runtime environment drops BYOK_* names, so the key variable has its own prefix.
const KEY_ENV = 'RC_CONTRACT_MODEL_KEY';
const PROJECT_MARKER = 'BYOK-CONTRACT-HERMES-PROJECT-62ab';
const USER_MARKER = 'BYOK-CONTRACT-HERMES-USER-c3f0';

/** One SDK-owned Hermes root for the whole file; the build below fills it once. */
const rootBox = once(() => createSandbox('hermes-root'));
async function adapter(model?: HermesModelSelection): Promise<HermesAdapter> {
  return new HermesAdapter({ home: path.join((await rootBox()).root, 'hermes'), resolveBin, probeTimeoutMs: 900_000, gatewayReadyTimeoutMs: 180_000, ...(model === undefined ? {} : { model }) });
}

/**
 * Every Hermes run of the file shares one uv and XDG cache, so a run with a
 * fresh HOME reuses what the root build fetched instead of downloading again.
 */
async function hermesEnv(home: string): Promise<NodeJS.ProcessEnv> {
  const cache = path.join((await rootBox()).root, 'cache');
  return { ...baseEnv(home), XDG_CACHE_HOME: cache, UV_CACHE_DIR: path.join(cache, 'uv') };
}

/** Output of one Hermes command against the SDK root, for a failure message. */
function hermesDiagnostic(env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(target.bin, args, { encoding: 'utf8', env, timeout: 600_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(JSON.stringify({ args, error: error?.message, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) }));
    });
  });
}

/**
 * The first detect() on a new root builds Hermes's Python environment there
 * and downloads its dependencies. That build is installation, not runtime
 * behavior, so it runs once before any case and outside the egress recorder;
 * every recorded probe and turn after it reuses the built root.
 */
beforeAll(async () => {
  const box = await rootBox();
  const env = await hermesEnv(box.home);
  const result = await withProcessEnv(env, async () => (await adapter()).detect());
  if (result.kind !== 'available') {
    const rootEnv = { ...env, HERMES_HOME: path.join(box.root, 'hermes') };
    throw new Error(`Hermes root build: ${JSON.stringify(result)}; ${await hermesDiagnostic(rootEnv, ['--version'])} ${await hermesDiagnostic(rootEnv, ['acp', '--check'])}`);
  }
}, 900_000);

/**
 * The qualified version names a build (`0.22.2+2364.g0b10b9f`); a latest run
 * names the commit it installed, which the build suffix carries.
 */
const identifies = (version: string, expected: string) => {
  const build = /^Hermes Agent v(\S+)/.exec(hermesVersionLine(version))?.[1];
  return build !== undefined && (build === expected || (/^[0-9a-f]{7,40}$/.test(expected) && build.endsWith(`.g${expected.slice(0, 7)}`)));
};

/** Hermes defers MCP tools: `tool_search` finds one, `tool_call` calls the name the search returned. */
const submitThroughToolSearch = searchThenCall({
  search: 'tool_search', searchArgs: { queries: ['host submit result'] },
  call: 'tool_call', callArgs: name => ({ calls: [{ name, arguments: { summary: 'runtime contract' } }] }),
}, 'submit_result');

/**
 * One contract turn: a loopback `custom` model, a Host MCP server, a workspace
 * AGENTS.md, and a user Hermes home (`~/.hermes`) with a SOUL.md and an MCP
 * server. The adapter never reads the user home, so the isolation cases have
 * no inherit mode to compare against.
 */
async function turn() {
  const box = await createSandbox('hermes-turn');
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-chat', submitThroughToolSearch);
  try {
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    const user = await writeSubmitResultServer(box.root, userReceipt, 'user_tool');
    const userHome = path.join(box.home, '.hermes');
    await fs.mkdir(userHome, { recursive: true });
    await fs.writeFile(path.join(userHome, 'SOUL.md'), `# User\n\n${USER_MARKER}\n`);
    await fs.writeFile(path.join(userHome, 'config.yaml'), `mcp_servers:\n  usermcp:\n    command: ${JSON.stringify(user.command)}\n    args: ${JSON.stringify(user.args)}\n`);
    await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    const runtime = await adapter({ provider: 'custom', model: 'contract-model', baseUrl: provider.baseUrl, keyEnv: KEY_ENV });
    const env = { ...await hermesEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder', ...recorder.env };
    const events = await runTurn(runtime, 'Call the submit_result tool, then finish.', { workspaceDir: box.workspace, env, mcpServers: { host } }, 600_000);
    return { events, provider, calls: await readReceipt(receipt), userSpawned: spawned(userReceipt) };
  } finally {
    await provider.close();
  }
}

const contractTurn = once(turn);
const descriptor = new HermesAdapter({ home: path.resolve('/hermes-descriptor-only') }).descriptor;
// The first detect() builds the Hermes environment in the new root.
const FIRST_DETECT_MS = 900_000;

defineRuntimeContract(`hermes runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, {
  'detect.version': check(async () => {
    const box = await createSandbox('hermes-version');
    expectDetectedVersion(await detectWith(await adapter(), await hermesEnv(box.home)), target, identifies, true);
  }, FIRST_DETECT_MS),
  'detect.auth.absent': check(async () => {
    const box = await createSandbox('hermes-auth-absent');
    expectAuth(await detectWith(await adapter(), await hermesEnv(box.home)), false);
  }, FIRST_DETECT_MS),
  'detect.auth.apiKey': check(async () => {
    const box = await createSandbox('hermes-auth-key');
    const runtime = await adapter({ provider: 'custom', model: 'contract-model', baseUrl: 'http://127.0.0.1:9/v1', keyEnv: KEY_ENV });
    expectAuth(await detectWith(runtime, { ...await hermesEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder' }), true);
  }, FIRST_DETECT_MS),
  'detect.auth.login': skip('Hermes runs in an SDK-owned home and the adapter never reads a user Hermes login; credentials come from the model selection or custody launcher'),
  'mcp.submitResult': check(async () => {
    const { calls, events, provider } = await contractTurn();
    expect(events.at(-1)?.type).toBe('turn_end');
    const offered = provider.requests.filter(request => request.model).map(request => request.tools.map(tool => tool.name));
    expect(calls, `tools offered per model request: ${JSON.stringify(offered)}; events: ${JSON.stringify(events.map(event => event.type))}`).toEqual([expect.objectContaining({ name: 'submit_result', arguments: { summary: 'runtime contract' } })]);
  }, FIRST_DETECT_MS),
  'instructions.project': check(async () => {
    expect((await contractTurn()).provider.saw(PROJECT_MARKER)).toBe(true);
  }, FIRST_DETECT_MS),
  'isolation.userContext': check(async () => {
    expect((await contractTurn()).provider.saw(USER_MARKER)).toBe(false);
  }, FIRST_DETECT_MS),
  'isolation.userMcp': check(async () => {
    expect((await contractTurn()).userSpawned).toBe(false);
  }, FIRST_DETECT_MS),
  'isolation.sessionPersistence': skip('each Hermes execution runs in a fresh profile home that the adapter deletes when it ends; there is no option'),
  drafts: check(async () => {
    expect(draftText((await contractTurn()).events, descriptor)).toContain('runtime contract reply');
  }, FIRST_DETECT_MS),
  'gate.auto': notAdvertised(descriptor, 'toolAuthorizationAuto'),
  'egress.declaredHostsOnly': egressCheck(contractTurn, [
    // Model metadata, fetched whatever the model provider. The adapter carries
    // the models.dev cache between executions, so a root's first turn fetches
    // it; the model catalog is not carried, so every turn refetches it.
    { phase: 'turn', target: 'models.dev:443', reason: 'Hermes model metadata (agent/models_dev.py); carried after the first turn of a root; follow-up to #1103' },
    { phase: 'turn', target: 'hermes-agent.nousresearch.com:443', reason: 'Hermes model catalog (hermes_cli/model_catalog.py DEFAULT_CATALOG_URL), refetched every turn; follow-up to #1103' },
    { phase: 'turn', target: 'raw.githubusercontent.com:443', reason: 'Hermes model catalog fallback (DEFAULT_CATALOG_FALLBACK_URLS) after the primary is refused; follow-up to #1103' },
  ]),
});
