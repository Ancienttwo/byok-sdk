import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, expect } from 'vitest';
import { DshAdapter, type DshAdapterOptions, type DshModelSelection } from '../../adapters/dsh/dsh-adapter';
import { OWNED_TREE_OBSERVE_MS } from '../../adapters/process-tree';
import { classifyToolCall } from '../../tool-authorization';
import { dshEnvironment } from '../../adapters/dsh/dsh-profile';
import { QUALIFIED_DSH_VERSION } from '../../adapters/dsh/dsh-version';
import { DSH_ABSENT_ISOLATION_SOURCES } from '../../adapters/dsh/dsh-capabilities';
import { setLoginShellSnapshotSource } from '../../login-shell-environment';
import { TEST_LOGIN_SHELL_SNAPSHOT } from '../fixtures/runtime-env';
import { startPreparedOperation } from '../fixtures/prepared-operation';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeCases, defineRuntimeContract, detectWith, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, withProcessEnv, writeSubmitResultServer,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, callOnceThenReply, mcpTool, startLoopbackProvider, type ProviderScript } from './loopback';

const target = contractTarget('dsh', QUALIFIED_DSH_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const MODEL = 'contract-model';
// dsh keeps a name with KEY in it out of tool processes; BYOK_* names never reach the runtime.
const KEY_ENV = 'RC_CONTRACT_MODEL_KEY';
const PROJECT_MARKER = 'BYOK-CONTRACT-DSH-PROJECT-4e19';
const USER_MARKER = 'BYOK-CONTRACT-DSH-USER-a7c2';
const SKILL_MARKER = 'BYOK-CONTRACT-DSH-SKILL-0b5d';
const SKILL = 'byok-contract-user-skill';
const STEER_MARKER = 'BYOK-CONTRACT-DSH-STEER-3c8e';
const ROOT_MARKER = 'BYOK-CONTRACT-DSH-ROOT-6d1f';
const CHILD_MARKER = 'BYOK-CONTRACT-DSH-CHILD-92ab';
const RESUME_MARKER = 'BYOK-CONTRACT-DSH-RESUME-e07c';
const SKILL_FILE = `---\nname: ${SKILL}\ndescription: ${SKILL_MARKER}\n---\n\nRuntime contract user skill.\n`;

const loopbackModel = (baseUrl: string): DshModelSelection => ({ provider: 'custom', model: MODEL, baseUrl, keyEnv: KEY_ENV });

/** One SDK-owned dsh root for the file; detect() writes the acp profile into it before any turn. */
const rootBox = once(() => createSandbox('dsh-root'));
async function adapter(model: DshModelSelection, options: Partial<DshAdapterOptions> = {}): Promise<DshAdapter> {
  return new DshAdapter({ home: path.join((await rootBox()).root, 'dsh'), resolveBin, model, ...options });
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

const submitResult = callOnceThenReply(mcpTool('host', 'submit_result'), { summary: 'runtime contract' });

/**
 * User context in the places dsh reads it by default: `~/.dsh/AGENTS.md`,
 * `~/.dsh/skills`, `~/.agents/skills`, and a user MCP server in the home patch
 * `~/.dsh/cordis.patch.yml`. The adapter runs dsh in its own `DSH_HOME` with
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
  }], null, 2)}\n`);
}

/** One contract turn: a loopback `custom` model, a Host MCP server, a workspace AGENTS.md, and user context. */
async function turn() {
  const box = await createSandbox('dsh-turn');
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-chat', submitResult, MODEL);
  try {
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    await writeUserContext(box.home, await writeSubmitResultServer(box.root, userReceipt, 'user_tool'));
    await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    const env = { ...baseEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder', ...recorder.env };
    const events = await runTurn(await adapter(loopbackModel(provider.baseUrl)), 'Call the submit_result tool, then finish.', { workspaceDir: box.workspace, env, mcpServers: { host } });
    return { events, provider, calls: await readReceipt(receipt), userSpawned: spawned(userReceipt) };
  } finally {
    await provider.close();
  }
}

/**
 * Positive control for the user-skill case: the same skill file in the
 * directory the adapter points `DSH_AGENTS_HOME` at reaches the model, so the
 * marker's absence above is isolation, not a skill dsh never lists. It uses a
 * root of its own so the file's shared root stays empty.
 */
async function skillControlTurn() {
  const box = await createSandbox('dsh-skill-control');
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }), MODEL);
  try {
    const runtime = new DshAdapter({ home: path.join(box.root, 'dsh'), resolveBin, model: loopbackModel(provider.baseUrl) });
    const skills = path.join(box.root, 'dsh', 'byok-agents-home', 'skills', SKILL);
    await fs.mkdir(skills, { recursive: true });
    await fs.writeFile(path.join(skills, 'SKILL.md'), SKILL_FILE);
    const init = await detectWith(runtime, baseEnv(box.home));
    if (init.kind !== 'available') throw new Error(`dsh control root init: ${JSON.stringify(init)}`);
    const env = { ...baseEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder', ...recorder.env };
    await runTurn(runtime, 'Reply.', { workspaceDir: box.workspace, env });
    return provider;
  } finally {
    await provider.close();
  }
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

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
    const env = { ...baseEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder', ...recorder.env };
    const session = await startPreparedOperation(runtime, { instruction: 'Run the shell command.' }, { workspaceDir: box.workspace, env });
    const tools = await waitFor(async () => {
      const found = (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim().split(/\s+/).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0);
      return found.length === 2 ? found : undefined;
    }, 120_000, 'the shell tool pids');
    const before = `dsh root ${child?.pid}; ${processRows(tools)}`;
    if (stop === 'sigkill') {
      // The tools run in a group of their own: only an observation taken while the root ran leads to them.
      await new Promise(resolve => setTimeout(resolve, 2 * OWNED_TREE_OBSERVE_MS));
      child!.kill('SIGKILL');
      try { for await (const _event of session.events) { /* drain to the root's exit */ } } catch { /* the session fails with the root */ }
    }
    await session.close();
    const survivors = await waitFor(async () => tools.some(isAlive) ? undefined : [], 10_000, 'the tool processes to exit').catch(() => tools.filter(isAlive));
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
    const env = { ...baseEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder', ...recorder.env };
    const session = await startPreparedOperation(runtime, { instruction: 'Run the shell command.' }, { workspaceDir: box.workspace, env });
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
    const resources = { workspaceDir: box.workspace, env: { ...baseEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder', ...recorder.env } };
    const opened = await startPreparedOperation(runtime, { instruction: `Start the work. ${ROOT_MARKER}` }, resources);
    const usage = [];
    for await (const event of opened.events) {
      if (event.type === 'usage') usage.push(event);
      if (event.type === 'turn_end') break;
    }
    // turn_end follows the disposal, so the tree is already gone here.
    const pids = await Promise.all([childPid, jobPid].map(async file => Number(await fs.readFile(file, 'utf8'))));
    const survivors = pids.filter(isAlive);
    const diagnostic = processRows(survivors);
    for (const pid of survivors) process.kill(pid, 'SIGKILL');
    const sessionRef = opened.sessionRef;
    await opened.close();
    const requests = provider.requests.length;
    const modelRequests = provider.requests.filter(request => request.model);
    const again = await startPreparedOperation(runtime, { instruction: `Continue. ${RESUME_MARKER}`, sessionRef }, resources);
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
    const env = { ...baseEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder', ...recorder.env };
    const events = await runTurn(await adapter(loopbackModel(provider.baseUrl)), 'Run the tools.', { workspaceDir: box.workspace, env });
    const uses = events.filter(event => event.type === 'tool_use');
    return { calls, uses, risks: uses.map(use => classifyToolCall({ toolName: use.tool, input: use.input as Record<string, unknown>, cwd: box.workspace }, box.workspace, box.home).level) };
  } finally {
    await provider.close();
  }
}

const contractTurn = once(turn);
const steered = once(steerTurn);
const background = once(backgroundTurn);
const toolInput = once(toolInputTurn);
const skillControl = once(skillControlTurn);
const closed = once(() => toolTreeTurn('close'));
const sigkilled = once(() => toolTreeTurn('sigkill'));
const descriptor = new DshAdapter({ home: path.resolve('/dsh-descriptor-only'), model: detectModel }).descriptor;

defineRuntimeContract(`dsh runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, {
  'detect.version': check(async () => {
    const box = await createSandbox('dsh-version');
    expectDetectedVersion(await detectWith(await adapter(detectModel), baseEnv(box.home)), target, identifies, true);
  }),
  'detect.auth.absent': check(async () => {
    const box = await createSandbox('dsh-auth-absent');
    expectAuth(await detectWith(await adapter(detectModel), baseEnv(box.home)), false);
  }),
  'detect.auth.apiKey': check(async () => {
    const box = await createSandbox('dsh-auth-key');
    expectAuth(await detectWith(await adapter(detectModel), { ...baseEnv(box.home), [KEY_ENV]: 'runtime-contract-placeholder' }), true);
  }),
  'detect.auth.login': skip('dsh runs in an SDK-owned DSH_HOME and the adapter never reads a user dsh login; the key comes from the model selection keyEnv'),
  'mcp.submitResult': check(async () => {
    const { calls, events, provider } = await contractTurn();
    expect(events.at(-1)?.type).toBe('turn_end');
    const offered = provider.requests.filter(request => request.model).map(request => request.tools.map(tool => tool.name));
    expect(calls, `tools offered per model request: ${JSON.stringify(offered)}; events: ${JSON.stringify(events.map(event => event.type))}`).toEqual([expect.objectContaining({ name: 'submit_result', arguments: { summary: 'runtime contract' } })]);
  }),
  'instructions.project': check(async () => {
    expect((await contractTurn()).provider.saw(PROJECT_MARKER)).toBe(true);
  }),
  'isolation.userInstructions': check(async () => {
    const { provider } = await contractTurn();
    expect(provider.saw(USER_MARKER), '~/.dsh/AGENTS.md').toBe(false);
    expect(provider.saw(SKILL_MARKER), '~/.dsh/skills and ~/.agents/skills').toBe(false);
  }),
  'isolation.userOutputStyle': skip('dsh descriptor does not advertise isolation.userOutputStyle yet (#1574)'),
  'isolation.userMemory': skip('dsh descriptor does not advertise isolation.userMemory yet (#1574)'),
  'isolation.userSkills': skip('dsh descriptor does not advertise isolation.userSkills yet (#1574)'),
  'isolation.userHookContext': skip('dsh descriptor does not advertise isolation.userHookContext yet (#1574)'),
  'isolation.userMcp': check(async () => {
    expect((await contractTurn()).userSpawned).toBe(false);
  }),
  'isolation.sessionPersistence': skip('the dsh adapter has no session persistence option; dsh keeps sessions under the SDK-owned DSH_HOME, which resume needs'),
  drafts: notAdvertised(descriptor, 'messageDraft'),
  'gate.auto': notAdvertised(descriptor, 'toolAuthorizationAuto'),
  'egress.declaredHostsOnly': egressCheck(async () => { await contractTurn(); await skillControl(); await closed(); await sigkilled(); await background(); await steered(); await toolInput(); }),
}, DSH_ABSENT_ISOLATION_SOURCES);

defineRuntimeCases(`dsh runtime contract: dsh cases (${target.mode} ${target.expectedVersion})`, {
  'dsh.turnEnd': ['a background subagent and a background job do not outlive the turn', check(async () => {
    const { survivors, diagnostic, usage, modelRequests } = await background();
    expect(survivors, diagnostic).toEqual([]);
    expect(modelRequests.some(request => !request.text.includes(ROOT_MARKER))).toBe(true);
    // The loopback provider bills one input and one output token per request, including the child's.
    expect(usage).toEqual([expect.objectContaining({ inputTokens: modelRequests.length, outputTokens: modelRequests.length })]);
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
  'dsh.userSkills': ['the skill marker reaches the model from the adapter\'s DSH_AGENTS_HOME (positive control)', check(async () => {
    expect((await skillControl()).saw(SKILL_MARKER)).toBe(true);
  })],
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
