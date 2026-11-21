import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, expect } from 'vitest';
import { captureProcessIdentity, isProcessLive } from '../support/process-liveness';
import { DshAdapter, type DshAdapterOptions, type DshModelSelection } from '../../adapters/dsh/dsh-adapter';
import { OWNED_TREE_OBSERVE_MS } from '../../adapters/process-tree';
import { classifyToolCall } from '../../tool-authorization';
import { dshAgentsHome, dshEnvironment } from '../../adapters/dsh/dsh-profile';
import { QUALIFIED_DSH_VERSION } from '../../adapters/dsh/dsh-version';
import { DSH_ABSENT_ISOLATION_SOURCES } from '../../adapters/dsh/dsh-capabilities';
import { setLoginShellSnapshotSource } from '../../login-shell-environment';
import { TEST_LOGIN_SHELL_SNAPSHOT } from '../fixtures/runtime-env';
import { startPreparedOperation } from '../fixtures/prepared-operation';
import {
  baseEnv, absent, check, contractTarget, createSandbox, defineRuntimeCases, defineRuntimeContract, detectWith, egressCheck,
  credentialFiles, expectDetectedVersion, fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, withProcessEnv, writeSubmitResultServer,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, mcpTool, startLoopbackProvider, type ProviderScript } from './loopback';

import { defineMcpSearchProbes } from './mcp-search-probe';
import { searchMcpEnvironmentFor } from '../../daemon/search-runtime-qualification';
import type { DaemonConfig } from '../../daemon/create-daemon';
const target = contractTarget('dsh', QUALIFIED_DSH_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const MODEL = 'contract-model';
const DSH_TARGET = { lane: 'harness', harnessId: 'dsh', selection: { mode: 'byok', providerId: 'openai', modelId: `byok-custom/${MODEL}` } } as const;
const PROVIDER_KEY = 'byok-contract-dsh-provider-86ae';
const resolveKey = async () => PROVIDER_KEY;
const PROJECT_MARKER = 'BYOK-CONTRACT-DSH-PROJECT-4e19';
const USER_MARKER = 'BYOK-CONTRACT-DSH-USER-a7c2';
const PERSONA_MARKER = 'BYOK-CONTRACT-DSH-PERSONA-5a3e';
const SKILL_MARKER = 'BYOK-CONTRACT-DSH-SKILL-0b5d';
const SKILL = 'byok-contract-user-skill';
const STEER_MARKER = 'BYOK-CONTRACT-DSH-STEER-3c8e';
const ROOT_MARKER = 'BYOK-CONTRACT-DSH-ROOT-6d1f';
const CHILD_MARKER = 'BYOK-CONTRACT-DSH-CHILD-92ab';
const RESUME_MARKER = 'BYOK-CONTRACT-DSH-RESUME-e07c';
const AGENT_PERSONA_MARKER = 'BYOK-CONTRACT-DSH-AGENT-PERSONA-71d4';
const SKILL_FILE = `---\nname: ${SKILL}\ndescription: ${SKILL_MARKER}\n---\n\nRuntime contract user skill.\n`;

const loopbackModel = (baseUrl: string): DshModelSelection => ({ provider: 'custom', model: MODEL, baseUrl, providerId: 'openai' });

/** One SDK-owned dsh root for the file; detect() writes the acp profile into it before any turn. */
const rootBox = once(() => createSandbox('dsh-root'));
async function adapter(model: DshModelSelection, options: Partial<DshAdapterOptions> = {}): Promise<DshAdapter> {
  return new DshAdapter({ home: path.join((await rootBox()).root, 'dsh'), resolveBin, model, resolveKey, ...options });
}
const detectModel = loopbackModel('http://127.0.0.1:9/v1');

/** `dsh --version` prints the bare package version. */
const identifies = (version: string, expected: string) => version.trim().split('\n')[0]?.trim() === expected;

/**
 * detect() keeps a failed probe's output to itself, so a failed root init
 * reruns `dsh --version` in the adapter's own runtime environment to show why.
 */
async function directVersion(runtime: DshAdapter, home: string): Promise<string> {
  const base = await withProcessEnv(baseEnv(home), () => runtime.runtimeEnvironment());
  const env = dshEnvironment(base.env, path.join((await rootBox()).root, 'dsh'), 'danger-full-access');
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 30_000 });
    return { status: result.status, signal: result.signal, error: (result.error as NodeJS.ErrnoException | undefined)?.code, stdout: result.stdout?.slice(0, 500), stderr: result.stderr?.slice(0, 2000) };
  };
  return JSON.stringify({ PATH: env.PATH, node: run('sh', ['-c', 'command -v node && node --version']), version: run(target.bin, ['--version']) });
}

beforeAll(async () => {
  // The suite setup installs the test snapshot before each test, after this hook. Without it, detect() would see the
  // machine's real login shell, whose PATH may lack the `node` that dsh's launcher needs (the GitHub ubuntu runner's does).
  setLoginShellSnapshotSource(async () => TEST_LOGIN_SHELL_SNAPSHOT);
  const box = await createSandbox('dsh-init');
  const runtime = await adapter(detectModel);
  const result = await detectWith(runtime, baseEnv(box.home));
  if (result.kind !== 'available') throw new Error(`dsh root init: ${JSON.stringify(result)}; direct: ${await directVersion(runtime, box.home).catch((error: unknown) => String(error))}`);
});



const PERSONA_ROW = { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: PERSONA_MARKER } };

/**
 * User context in the places dsh reads it by default: `~/.dsh/AGENTS.md`,
 * `~/.dsh/skills`, `~/.agents/skills`, and a user MCP server and a
 * `personaPrefix` in the home patch `~/.dsh/cordis.patch.yml`. The adapter runs dsh in its own `DSH_HOME` with
 * an empty `DSH_AGENTS_HOME`, so none of it may reach the turn.
 */
async function writeUserContext(home: string, userServer: { command: string; args?: readonly string[] }): Promise<void> {
  const dshHome = path.join(home, '.dsh');
  for (const skills of [path.join(dshHome, 'skills'), path.join(home, '.agents', 'skills')]) {
    await fs.mkdir(path.join(skills, SKILL), { recursive: true });
    await fs.writeFile(path.join(skills, SKILL, 'SKILL.md'), SKILL_FILE);
  }
  await fs.writeFile(path.join(dshHome, 'AGENTS.md'), `# User\n\n${USER_MARKER}\n`);
  await fs.writeFile(path.join(dshHome, 'cordis.patch.yml'), `${JSON.stringify([{
    id: 'mcp-usermcp', name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'usermcp', transport: 'stdio', command: userServer.command, args: [...(userServer.args ?? [])] },
  }, PERSONA_ROW], null, 2)}\n`);
}

/** One contract turn: a loopback `custom` model, a Host MCP server, a workspace AGENTS.md, and user context. */
async function turn() {
  const box = await createSandbox('dsh-turn');
  const recorder = await fileEgress();
  const shellEnv = path.join(box.workspace, 'shell.env');
  const submitResult = mcpTool('host', 'submit_result');
  const provider = await startLoopbackProvider('openai-chat', request => {
    if (request.toolResults === 0) {
      const bash = request.tools.find(tool => tool.name === 'bash');
      if (bash !== undefined) return { kind: 'tool', tool: bash, args: { command: `env > ${JSON.stringify(shellEnv)}`, description: 'Record the tool environment' } };
    }
    const tool = request.toolResults === 1 ? submitResult(request.tools) : undefined;
    return tool === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }
      : { kind: 'tool', tool, args: { summary: 'runtime contract' } };
  }, MODEL);
  try {
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    await writeUserContext(box.home, await writeSubmitResultServer(box.root, userReceipt, 'user_tool'));
    await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    const env = { ...baseEnv(box.home), ...recorder.env };
    const events = await runTurn(await adapter(loopbackModel(provider.baseUrl)), 'Call the submit_result tool, then finish.', { workspaceDir: box.workspace, env, mcpServers: { host } }, DSH_TARGET);
    return { events, provider, calls: await readReceipt(receipt), userSpawned: spawned(userReceipt),
      mcpEnv: await fs.readFile(`${receipt}.env`, 'utf8'), shellEnv: await fs.readFile(shellEnv, 'utf8'),
      credentialFiles: [...await credentialFiles(box.root, PROVIDER_KEY), ...await credentialFiles((await rootBox()).root, PROVIDER_KEY)],
    };
  } finally {
    await provider.close();
  }
}

/**
 * Positive control for the isolation cases: the same file in the SDK-owned
 * `DSH_HOME` (or the directory the adapter points `DSH_AGENTS_HOME` at)
 * reaches the model, so a marker's absence in the user-home turn is isolation,
 * not a source dsh never reads. It uses a root of its own so the file's shared
 * root stays empty.
 */
async function controlTurn(label: string, write: (root: string) => Promise<void>) {
  const box = await createSandbox(`dsh-${label}-control`);
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }), MODEL);
  try {
    const root = path.join(box.root, 'dsh');
    const runtime = new DshAdapter({ home: root, resolveBin, model: loopbackModel(provider.baseUrl), resolveKey });
    const init = await detectWith(runtime, baseEnv(box.home));
    if (init.kind !== 'available') throw new Error(`dsh control root init: ${JSON.stringify(init)}`);
    await write(root);
    const env = { ...baseEnv(box.home), ...recorder.env };
    await runTurn(runtime, 'Reply.', { workspaceDir: box.workspace, env }, DSH_TARGET);
    return provider;
  } finally {
    await provider.close();
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** `ps` rows of `pids`, for a failure message: which process group each survivor is in. */
function processRows(pids: readonly number[]): string {
  if (pids.length === 0) return 'none';
  try { return execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,command=', '-p', pids.join(',')], { encoding: 'utf8' }).trim(); } catch { return 'none'; }
}

/**
 * A turn whose shell tool holds a foreground and a background `sleep`, then
 * ends one of two ways: `close` is the SDK's own shutdown (the native
 * `dispose`, then the owned process tree); `sigkill` is the dsh root killed from outside,
 * after which dsh cannot cancel its own tools and the SDK alone must reap them.
 */
async function toolTreeTurn(stop: 'close' | 'sigkill') {
  const box = await createSandbox(`dsh-${stop}`);
  const recorder = await fileEgress();
  const pidFile = path.join(box.workspace, 'tool.pids');
  const script: ProviderScript = request => {
    const tool = request.toolResults === 0 ? request.tools.find(candidate => candidate.name === 'bash') : undefined;
    if (request.model && request.toolResults === 0 && tool === undefined) throw new Error(`no bash tool offered: ${JSON.stringify(request.tools.map(t => t.name))}`);
    return tool === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS } : { kind: 'tool', tool, args: {
      command: `sleep 307 & echo "$$ $!" > ${JSON.stringify(pidFile)}; sleep 308`, description: 'Hold two sleeps for the process tree case',
    } };
  };
  const provider = await startLoopbackProvider('openai-chat', script, MODEL);
  let child: ChildProcess | undefined;
  // The owned line process always passes argv and options; the cast keeps spawn's overloads out of the fixture.
  const spawnFn = ((command: string, args: readonly string[], options: SpawnOptions) => (child = spawn(command, [...args], options))) as typeof spawn;
  try {
    const runtime = await adapter(loopbackModel(provider.baseUrl), { spawnFn });
    const env = { ...baseEnv(box.home), ...recorder.env };
    const session = await startPreparedOperation(runtime, { target: DSH_TARGET, instruction: 'Run the shell command.' }, { workspaceDir: box.workspace, env });
    const tools = await waitFor(async () => {
      const found = (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim().split(/\s+/).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0);
      return found.length === 2 ? found : undefined;
    }, 120_000, 'the shell tool pids');
    const identities = tools.map(captureProcessIdentity);
    const before = `dsh root ${child?.pid}; ${processRows(tools)}`;
    if (stop === 'sigkill') {
      // The tools run in a group of their own: only an observation taken while the root ran leads to them.
      await new Promise(resolve => setTimeout(resolve, 2 * OWNED_TREE_OBSERVE_MS));
      child!.kill('SIGKILL');
      try { for await (const _event of session.events) { /* drain to the root's exit */ } } catch { /* the session fails with the root */ }
    }
    await session.close();
    const survivors = await waitFor(async () => identities.some(isProcessLive) ? undefined : [], 10_000, 'the tool processes to exit')
      .catch(() => identities.filter(isProcessLive).map(({ pid }) => pid));
    const after = processRows(survivors);
    for (const pid of survivors) process.kill(pid, 'SIGKILL');
    return { survivors, diagnostic: `before: ${before}; after: ${after}` };
  } finally {
    await provider.close();
  }
}

/**
 * Real steer: a shell tool holds the turn open, the SDK steers, and the model's
 * next request carries the steer text. The turn then ends normally.
 */
async function steerTurn() {
  const box = await createSandbox('dsh-steer');
  const recorder = await fileEgress();
  const started = path.join(box.workspace, 'tool.started');
  const script: ProviderScript = request => {
    const tool = request.toolResults === 0 ? request.tools.find(candidate => candidate.name === 'bash') : undefined;
    return tool === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS } : { kind: 'tool', tool, args: {
      command: `touch ${JSON.stringify(started)}; sleep 3`, description: 'Hold the turn for the steer case',
    } };
  };
  const provider = await startLoopbackProvider('openai-chat', script, MODEL);
  try {
    const runtime = await adapter(loopbackModel(provider.baseUrl));
    const env = { ...baseEnv(box.home), ...recorder.env };
    const session = await startPreparedOperation(runtime, { target: DSH_TARGET, instruction: 'Run the shell command.' }, { workspaceDir: box.workspace, env });
    try {
      await waitFor(async () => fs.access(started).then(() => true, () => undefined), 120_000, 'the shell tool');
      await session.steer(STEER_MARKER);
      const events = [];
      for await (const event of session.events) {
        events.push(event);
        if (event.type === 'turn_end') break;
      }
      return { events, saw: provider.saw(STEER_MARKER) };
    } finally {
      await session.close();
    }
  } finally {
    await provider.close();
  }
}

/**
 * A root turn that ends with a background subagent and a background job
 * running, then a second Turn of the same session through resume. The root
 * waits for both to record their pids, so each is live when the turn ends.
 */
async function backgroundTurn() {
  const box = await createSandbox('dsh-background');
  const recorder = await fileEgress();
  const childPid = path.join(box.workspace, 'child.pid');
  const jobPid = path.join(box.workspace, 'job.pid');
  const hold = (file: string, seconds: number) => `echo $$ > ${JSON.stringify(file)}; exec sleep ${seconds}`;
  const script: ProviderScript = request => {
    const bash = request.tools.find(tool => tool.name === 'bash')!;
    if (!request.text.includes(ROOT_MARKER)) {
      return request.toolResults === 0 ? { kind: 'tool', tool: bash, args: { command: hold(childPid, 311), description: 'Hold the child' } } : { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS };
    }
    switch (request.toolResults) {
      case 0: return { kind: 'tool', tool: request.tools.find(tool => tool.name === 'subagent')!, args: { description: 'Hold a shell', prompt: CHILD_MARKER } };
      case 1: return { kind: 'tool', tool: bash, args: { command: hold(jobPid, 313), description: 'Hold a job', run_in_background: true } };
      case 2: return { kind: 'tool', tool: bash, args: { command: `until [ -s ${JSON.stringify(childPid)} ] && [ -s ${JSON.stringify(jobPid)} ]; do sleep 0.1; done`, description: 'Wait for both' } };
      default: return { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS };
    }
  };
  const provider = await startLoopbackProvider('openai-chat', script, MODEL);
  try {
    const runtime = await adapter(loopbackModel(provider.baseUrl));
    const resources = { workspaceDir: box.workspace, env: { ...baseEnv(box.home), ...recorder.env } };
    const opened = await startPreparedOperation(runtime, { target: DSH_TARGET, instruction: `Start the work. ${ROOT_MARKER}` }, resources);
    const usage = [];
    for await (const event of opened.events) {
      if (event.type === 'usage') usage.push(event);
      if (event.type === 'turn_end') break;
    }
    // turn_end follows the disposal, so the tree is already gone here.
    const pids = await Promise.all([childPid, jobPid].map(async file => Number(await fs.readFile(file, 'utf8'))));
    const survivors = pids.filter(isProcessLive);
    const diagnostic = processRows(survivors);
    for (const pid of survivors) process.kill(pid, 'SIGKILL');
    const sessionRef = opened.sessionRef;
    await opened.close();
    const requests = provider.requests.length;
    const modelRequests = provider.requests.filter(request => request.model);
    const again = await startPreparedOperation(runtime, { target: DSH_TARGET, instruction: `Continue. ${RESUME_MARKER}`, sessionRef }, resources);
    const events = [];
    for await (const event of again.events) {
      events.push(event);
      if (event.type === 'turn_end') break;
    }
    const resumedRef = again.sessionRef;
    await again.close();
    return { survivors, diagnostic, sessionRef, resumedRef, events, usage, modelRequests, resumed: provider.requests.slice(requests).filter(request => request.model) };
  } finally {
    await provider.close();
  }
}

/**
 * A memory-reader Agent Turn and its resume. The reader runs in its run
 * directory under an Agent home with no `.git`, so dsh's own project chain
 * stops there and the home's AGENTS.md reaches the model only as the appended
 * persona: once in each request, on open and again on resume.
 */
async function agentPersonaTurn() {
  const box = await createSandbox('dsh-agent-persona');
  const recorder = await fileEgress();
  const home = path.join(box.root, 'agent');
  const run = path.join(home, '.byok', 'runs', 'adapter-unit-test');
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(home, 'AGENTS.md'), `# Agent\n\n${AGENT_PERSONA_MARKER}\n`);
  const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }), MODEL);
  try {
    const runtime = await adapter(loopbackModel(provider.baseUrl));
    const resources = { workspaceDir: run, reader: { canonicalHome: home }, env: { ...baseEnv(box.home), ...recorder.env } };
    const turnOf = async (offer: Parameters<typeof startPreparedOperation>[1]) => {
      const before = provider.requests.length;
      const session = await startPreparedOperation(runtime, offer, resources);
      try {
        for await (const event of session.events) if (event.type === 'turn_end') break;
      } finally {
        await session.close();
      }
      return { sessionRef: session.sessionRef, counts: provider.requests.slice(before).filter(request => request.model).map(request => request.text.split(AGENT_PERSONA_MARKER).length - 1) };
    };
    const opened = await turnOf({ target: DSH_TARGET, instruction: 'Reply.' });
    const resumed = await turnOf({ target: DSH_TARGET, instruction: 'Reply again.', sessionRef: opened.sessionRef });
    return { opened, resumed };
  } finally {
    await provider.close();
  }
}

/** Each real tool's native input reaches `tool_use` whole, so tool authorization classifies it. */
async function toolInputTurn() {
  const box = await createSandbox('dsh-tool-input');
  const recorder = await fileEgress();
  const outside = path.join(box.root, 'outside.txt');
  const calls = [
    { tool: 'bash', args: { command: `echo ${'a'.repeat(12_000)} > /dev/null; git push origin main`, description: 'Long command' } },
    { tool: 'write', args: { file_path: outside, content: 'probe\n' } },
    { tool: 'read', args: { file_path: path.join(box.home, '.ssh', 'id_probe') } },
    { tool: 'edit', args: { file_path: outside, old_string: 'probe', new_string: 'edited' } },
  ];
  const script: ProviderScript = request => {
    const call = calls[request.toolResults];
    const tool = call === undefined ? undefined : request.tools.find(candidate => candidate.name === call.tool);
    return tool === undefined || call === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS } : { kind: 'tool', tool, args: call.args };
  };
  const provider = await startLoopbackProvider('openai-chat', script, MODEL);
  try {
    const env = { ...baseEnv(box.home), ...recorder.env };
    const events = await runTurn(await adapter(loopbackModel(provider.baseUrl)), 'Run the tools.', { workspaceDir: box.workspace, env }, DSH_TARGET);
    const uses = events.filter(event => event.type === 'tool_use');
    return { calls, uses, risks: uses.map(use => classifyToolCall({ toolName: use.tool, input: use.input as Record<string, unknown>, cwd: box.workspace }, box.workspace, box.home).level) };
  } finally {
    await provider.close();
  }
}

defineMcpSearchProbes({
  target: DSH_TARGET,
  runtime: 'dsh', variant: 'sandbox=danger-full-access', wire: 'openai-chat', model: MODEL,
  async configure(box, provider, spawnFn) {
    const model = loopbackModel(provider.baseUrl);
    const home = path.join(box.root, 'dsh');
    return { adapter: new DshAdapter({ home, model, spawnFn, resolveKey }),
      env: { ...baseEnv(box.home), BYOK_DSH_BIN: target.bin } };
  },
  projectEnvironment: (env, box) => searchMcpEnvironmentFor({ runtimes: {
    dsh: { home: path.join(box.root, 'dsh'), model: detectModel, resolveKey },
  } } as DaemonConfig)('dsh', env),
});

const contractTurn = once(turn);
const steered = once(steerTurn);
const background = once(backgroundTurn);
const toolInput = once(toolInputTurn);
const readerPersona = once(agentPersonaTurn);
const skillControl = once(() => controlTurn('skill', async root => {
  const skills = path.join(dshAgentsHome(root), 'skills', SKILL);
  await fs.mkdir(skills, { recursive: true });
  await fs.writeFile(path.join(skills, 'SKILL.md'), SKILL_FILE);
}));
const instructionsControl = once(() => controlTurn('instructions', root => fs.writeFile(path.join(root, 'AGENTS.md'), `# User\n\n${USER_MARKER}\n`)));
const personaControl = once(() => controlTurn('persona', root => fs.writeFile(path.join(root, 'cordis.patch.yml'), `${JSON.stringify([PERSONA_ROW], null, 2)}\n`)));
const closed = once(() => toolTreeTurn('close'));
const sigkilled = once(() => toolTreeTurn('sigkill'));
const descriptor = new DshAdapter({ home: path.resolve('/dsh-descriptor-only'), model: detectModel, resolveKey }).descriptor;

defineRuntimeContract(`dsh runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, {
  'detect.version': check(async () => {
    const box = await createSandbox('dsh-version');
    expectDetectedVersion(await detectWith(await adapter(detectModel), baseEnv(box.home)), target, identifies, true);
  }),
  'detect.auth.absent': check(async () => {
    const box = await createSandbox('dsh-auth-absent');
    expect(await detectWith(await adapter(detectModel), baseEnv(box.home))).not.toHaveProperty('authPresent');
  }),
  'detect.auth.apiKey': check(async () => {
    const box = await createSandbox('dsh-auth-key');
    const refusedResolver = async () => { throw new Error('detection must not resolve a key'); };
    const result = await detectWith(await adapter(detectModel, { resolveKey: refusedResolver }), baseEnv(box.home));
    expect(result.kind).toBe('available');
    expect(result).not.toHaveProperty('authPresent');
  }),
  'detect.auth.login': skip('dsh uses an SDK-owned DSH_HOME and gets the API key from the Host resolver'),
  'mcp.submitResult': check(async () => {
    const { calls, events, provider, mcpEnv, shellEnv, credentialFiles: persisted } = await contractTurn();
    expect(new Set(provider.requests.filter(request => request.model).map(request => request.authorization))).toEqual(new Set([`Bearer ${PROVIDER_KEY}`]));
    for (const env of [mcpEnv, shellEnv]) {
      expect(env).not.toContain(PROVIDER_KEY);
      expect(env).not.toContain('BYOK_DSH_PROVIDER_API_KEY');
    }
    expect(JSON.stringify(events)).not.toContain(PROVIDER_KEY);
    expect(persisted).toEqual([]);
    expect(events.at(-1)?.type).toBe('turn_end');
    const offered = provider.requests.filter(request => request.model).map(request => request.tools.map(tool => tool.name));
    expect(calls, `tools offered per model request: ${JSON.stringify(offered)}; events: ${JSON.stringify(events.map(event => event.type))}`).toEqual([expect.objectContaining({ name: 'submit_result', arguments: { summary: 'runtime contract' } })]);
  }),
  'instructions.project': check(async () => {
    expect((await contractTurn()).provider.saw(PROJECT_MARKER)).toBe(true);
  }),
  'isolation.userInstructions': check(async () => {
    expect((await instructionsControl()).saw(USER_MARKER), 'positive control: AGENTS.md in the SDK-owned DSH_HOME reaches the model').toBe(true);
    expect((await contractTurn()).provider.saw(USER_MARKER), '~/.dsh/AGENTS.md').toBe(false);
  }),
  // dsh has no output style; the user-authored answer persona is its equivalent source.
  'isolation.userOutputStyle': check(async () => {
    expect((await personaControl()).saw(PERSONA_MARKER), 'positive control: personaPrefix in the SDK-owned DSH_HOME patch reaches the model').toBe(true);
    expect((await contractTurn()).provider.saw(PERSONA_MARKER), 'personaPrefix in ~/.dsh/cordis.patch.yml').toBe(false);
  }),
  'isolation.userMemory': absent(DSH_ABSENT_ISOLATION_SOURCES.userMemory),
  'isolation.userSkills': check(async () => {
    expect((await skillControl()).saw(SKILL_MARKER), 'positive control: a skill in the adapter\'s DSH_AGENTS_HOME reaches the model').toBe(true);
    expect((await contractTurn()).provider.saw(SKILL_MARKER), '~/.dsh/skills and ~/.agents/skills').toBe(false);
  }),
  'isolation.userHookContext': skip('the dsh hook bridge is a separate package that neither the npm install nor the acp profile includes, so no user hook source exists to isolate; the descriptor declares userHookContext false'),
  'isolation.userMcp': check(async () => {
    expect((await contractTurn()).userSpawned).toBe(false);
  }),
  'isolation.sessionPersistence': skip('the dsh adapter has no session persistence option; dsh keeps sessions under the SDK-owned DSH_HOME, which resume needs'),
  drafts: notAdvertised(descriptor, 'messageDraft'),
  'gate.auto': notAdvertised(descriptor, 'toolAuthorizationAuto'),
  'egress.declaredHostsOnly': egressCheck(async () => { await contractTurn(); await skillControl(); await instructionsControl(); await personaControl(); await closed(); await sigkilled(); await background(); await steered(); await toolInput(); await readerPersona(); }),
}, DSH_ABSENT_ISOLATION_SOURCES);

defineRuntimeCases(`dsh runtime contract: dsh cases (${target.mode} ${target.expectedVersion})`, {
  'dsh.turnEnd': ['a background subagent and a background job do not outlive the turn', check(async () => {
    const { survivors, diagnostic, usage, modelRequests } = await background();
    expect(survivors, diagnostic).toEqual([]);
    expect(modelRequests.some(request => !request.text.includes(ROOT_MARKER))).toBe(true);
    // Child usage is attributed for display; only the root observation is terminal metering.
    expect(usage).toHaveLength(2);
    expect(usage[0]!.agentPath).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(usage[1]!.agentPath).toBeUndefined();
    // The loopback provider bills one input and one output token per request, including the child's.
    expect(usage.filter(event => event.agentPath === undefined)).toEqual([
      expect.objectContaining({ inputTokens: modelRequests.length, outputTokens: modelRequests.length }),
    ]);
  }, 240_000)],
  'dsh.resume': ['a second Turn of the same session runs through resume after the kill', check(async () => {
    const { events, sessionRef, resumedRef, resumed } = await background();
    expect(sessionRef).not.toBe('');
    expect(resumedRef).toBe(sessionRef);
    expect(events.at(-1)?.type).toBe('turn_end');
    expect(resumed.length).toBeGreaterThan(0);
    for (const request of resumed) {
      expect(request.text).toContain(ROOT_MARKER);
      expect(request.text).toContain(RESUME_MARKER);
    }
  }, 240_000)],
  'dsh.steer': ['steer text reaches the next model request of the running turn', check(async () => {
    const { events, saw } = await steered();
    expect(events.at(-1)?.type).toBe('turn_end');
    expect(saw).toBe(true);
  }, 240_000)],
  'dsh.toolInput': ['each tool_use carries the whole native input as an object, and tool authorization sees it', check(async () => {
    const { calls, uses, risks } = await toolInput();
    expect(uses.map(use => ({ tool: use.tool, args: use.input }))).toEqual(calls);
    expect(risks).not.toContain('normal');
  }, 240_000)],
  'dsh.patch': ['every model request reaches the patch route and names the selected model', check(async () => {
    const { provider } = await contractTurn();
    const models = provider.requests.filter(request => request.model);
    expect(models.length).toBeGreaterThan(0);
    for (const request of models) expect(JSON.parse(request.text).model).toBe(MODEL);
  })],
  'dsh.agentPersona': ['a memory reader gets its Agent home AGENTS.md once in every request, on open and on resume', check(async () => {
    const { opened, resumed } = await readerPersona();
    expect(resumed.sessionRef).toBe(opened.sessionRef);
    for (const { counts } of [opened, resumed]) {
      expect(counts.length).toBeGreaterThan(0);
      expect(counts.every(count => count === 1), JSON.stringify(counts)).toBe(true);
    }
  }, 240_000)],
  'dsh.close': ['closing a session while its shell tool runs reaps the tool processes', check(async () => {
    const { survivors, diagnostic } = await closed();
    expect(survivors, diagnostic).toEqual([]);
  }, 240_000)],
  'dsh.sigkill': ['after the dsh root is SIGKILLed from outside, close() reaps its tool processes',
    check(async () => {
      const { survivors, diagnostic } = await sigkilled();
      expect(survivors, diagnostic).toEqual([]);
    }, 240_000)],
});
