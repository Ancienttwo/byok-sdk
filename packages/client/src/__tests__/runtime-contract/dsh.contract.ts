import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DshAdapter, type DshAdapterOptions, type DshModelSelection } from '../../adapters/dsh/dsh-adapter';
import { QUALIFIED_DSH_VERSION } from '../../adapters/dsh/dsh-version';
import { isRuntimeExecutionFailure } from '../../runtime-failure';
import { startPreparedOperation } from '../fixtures/prepared-operation';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeContract, detectWith, egressCheck, expectAuth,
  expectDetectedVersion, fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, writeSubmitResultServer,
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

beforeAll(async () => {
  const box = await createSandbox('dsh-init');
  const result = await detectWith(await adapter(detectModel), baseEnv(box.home));
  if (result.kind !== 'available') throw new Error(`dsh root init: ${JSON.stringify(result)}`);
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
  try { return execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,command=', '-p', pids.join(',')], { encoding: 'utf8' }).trim(); } catch { return 'none'; }
}

/**
 * A turn whose shell tool holds a foreground and a background `sleep`, then
 * ends one of two ways: `close` is the SDK's own shutdown (`session/close`,
 * then the owned process tree); `sigkill` is the dsh root killed from outside,
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
    let failure: unknown;
    if (stop === 'sigkill') {
      child!.kill('SIGKILL');
      try { for await (const _event of session.events) { /* drain to the failure */ } } catch (error) { failure = error; }
    }
    await session.close();
    const survivors = await waitFor(async () => tools.some(isAlive) ? undefined : [], 10_000, 'the tool processes to exit').catch(() => tools.filter(isAlive));
    const after = processRows(survivors);
    for (const pid of survivors) process.kill(pid, 'SIGKILL');
    return { failure, survivors, diagnostic: `before: ${before}; after: ${after}` };
  } finally {
    await provider.close();
  }
}

const contractTurn = once(turn);
const skillControl = once(skillControlTurn);
const closed = once(() => toolTreeTurn('close'));
const sigkill = once(() => toolTreeTurn('sigkill'));
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
  'isolation.userContext': check(async () => {
    const { provider } = await contractTurn();
    expect(provider.saw(USER_MARKER), '~/.dsh/AGENTS.md').toBe(false);
    expect(provider.saw(SKILL_MARKER), '~/.dsh/skills and ~/.agents/skills').toBe(false);
  }),
  'isolation.userMcp': check(async () => {
    expect((await contractTurn()).userSpawned).toBe(false);
  }),
  'isolation.sessionPersistence': skip('the dsh adapter has no session persistence option; dsh keeps sessions under the SDK-owned DSH_HOME, which resume needs'),
  drafts: notAdvertised(descriptor, 'messageDraft'),
  'gate.auto': notAdvertised(descriptor, 'toolAuthorizationAuto'),
  'egress.declaredHostsOnly': egressCheck(async () => { await contractTurn(); await skillControl(); await closed(); await sigkill(); }),
});

describe(`dsh runtime contract: dsh cases (${target.mode} ${target.expectedVersion})`, () => {
  it('dsh.patch: every model request reaches the patch route and names the patch model', async () => {
    const { provider } = await contractTurn();
    const models = provider.requests.filter(request => request.model);
    expect(models.length).toBeGreaterThan(0);
    for (const request of models) expect(JSON.parse(request.text).model).toBe(MODEL);
  }, 180_000);
  it('dsh.userSkills: the skill marker reaches the model from the adapter\'s DSH_AGENTS_HOME (positive control)', async () => {
    expect((await skillControl()).saw(SKILL_MARKER)).toBe(true);
  }, 180_000);
  it('dsh.close: closing a session while its shell tool runs reaps the tool processes', async () => {
    const { survivors, diagnostic } = await closed();
    expect(survivors, diagnostic).toEqual([]);
  }, 240_000);
  it('dsh.sigkill: after the dsh root is SIGKILLed, the session fails as runtime_exited and close() reaps its tool processes', async () => {
    const { failure, survivors, diagnostic } = await sigkill();
    expect(isRuntimeExecutionFailure(failure) ? failure.failure.class : failure).toBe('runtime_exited');
    expect(survivors, diagnostic).toEqual([]);
  }, 240_000);
});
