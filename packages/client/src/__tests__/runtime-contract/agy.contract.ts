import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '@byok-sdk/protocol';
import { expect } from 'vitest';
import { AgyAdapter, type AgyAdapterOptions } from '../../adapters/antigravity/agy-adapter';
import { agyAdapterWithEndpoint } from '../../adapters/antigravity/agy-endpoint';
import { QUALIFIED_AGY_VERSION } from '../../adapters/antigravity/agy-version';
import { AGY_ABSENT_ISOLATION_SOURCES } from '../../adapters/antigravity/agy-capabilities';
import type { Session } from '../../types';
import { startPreparedOperation } from '../fixtures/prepared-operation';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeCases, defineRuntimeContract, detectWith, egressCheck, expectAuth, expectDetectedVersion,
  fileEgress, notAdvertised, once, readReceipt, runTurn, skip, spawned, writeSubmitResultServer,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, callOnceThenReply, mcpTool, startLoopbackProvider, type ProviderScript } from './loopback';

const target = contractTarget('agy', QUALIFIED_AGY_VERSION);
const resolveBin = () => ({ command: target.bin, source: 'env' as const });
const PROJECT_MARKER = 'BYOK-CONTRACT-AGY-PROJECT-3d71';
const USER_MARKER = 'BYOK-CONTRACT-AGY-USER-c92e';
const REAL_KEY = 'byok-contract-agy-real-key-5f08';

/** One SDK-owned home for the file, as a Host keeps one across executions. */
const ownedBox = once(() => createSandbox('agy-owned'));
const ownedHome = async () => path.join((await ownedBox()).root, 'agy');
const detectAdapter = async () => new AgyAdapter({ home: await ownedHome(), resolveBin, runtimeEnvironment: { base: 'allowlist', pass: ['GEMINI_API_KEY'] } });

const submitResult = callOnceThenReply(mcpTool('host', 'submit_result'), { summary: 'runtime contract', toolSummary: 'Submit the result' });

async function writeUserContext(home: string, userServer: { command: string; args?: readonly string[] }): Promise<void> {
  const gemini = path.join(home, '.gemini');
  await fs.mkdir(path.join(gemini, 'config'), { recursive: true });
  await fs.writeFile(path.join(gemini, 'GEMINI.md'), `# User\n\n${USER_MARKER}\n`);
  await fs.writeFile(path.join(gemini, 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { usermcp: { command: userServer.command, args: userServer.args ?? [] } } }));
}

/**
 * One contract turn with user context in `userContextHome`: the ambient user
 * home by default, which the adapter must hide, or the adapter's own home as
 * the positive control. `REAL_KEY` is the key in the task's runtime environment.
 */
async function turn(where: 'user' | 'owned', script: ProviderScript = submitResult) {
  const box = await createSandbox(`agy-${where}`);
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('gemini', script);
  try {
    const home = where === 'owned' ? path.join(box.root, 'agy') : await ownedHome();
    const receipt = path.join(box.root, 'host.jsonl');
    const userReceipt = path.join(box.root, 'user-mcp.jsonl');
    const host = await writeSubmitResultServer(box.root, receipt);
    await writeUserContext(where === 'owned' ? home : box.home, await writeSubmitResultServer(box.root, userReceipt, 'user_tool'));
    await fs.writeFile(path.join(box.workspace, 'AGENTS.md'), `# Project\n\n${PROJECT_MARKER}\n`);
    const runtime = agyAdapterWithEndpoint(new AgyAdapter({ home, resolveBin }), provider.origin);
    const env = { ...baseEnv(box.home), GEMINI_API_KEY: REAL_KEY, ...recorder.env };
    const events = await runTurn(runtime, 'Call the submit_result tool, then finish.', { workspaceDir: box.workspace, env, mcpServers: { host } });
    return { events, provider, box, calls: await readReceipt(receipt), userSpawned: spawned(userReceipt), mcpEnv: await fs.readFile(`${receipt}.env`, 'utf8') };
  } finally {
    await provider.close();
  }
}

/** The environment agy gives the model's shell, read back from a real `run_command`. */
async function shellEnvironment() {
  const box = await createSandbox('agy-shell-env');
  const file = path.join(box.workspace, 'tool.env');
  const command = process.platform === 'win32'
    ? `Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" } | Out-File -Encoding utf8 ${JSON.stringify(file)}`
    : `env > ${JSON.stringify(file)}`;
  const script: ProviderScript = request => {
    const tool = request.toolResults === 0 ? request.tools.find(candidate => candidate.name === 'run_command') : undefined;
    return tool === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }
      : { kind: 'tool', tool, args: { CommandLine: command, toolSummary: 'Record the environment', WaitMsBeforeAsync: 10_000 } };
  };
  const provider = await startLoopbackProvider('gemini', script);
  try {
    const recorder = await fileEgress();
    const runtime = agyAdapterWithEndpoint(new AgyAdapter({ home: await ownedHome(), resolveBin }), provider.origin);
    const events = await runTurn(runtime, 'Run the command.', { workspaceDir: box.workspace, env: { ...baseEnv(box.home), GEMINI_API_KEY: REAL_KEY, ...recorder.env } });
    return { text: await fs.readFile(file, 'utf8'), events, command, provider };
  } finally {
    await provider.close();
  }
}

/** A command agy starts as a daemon, in its own process group, and the process id it recorded. */
async function daemonPid(): Promise<number> {
  const box = await createSandbox('agy-daemon');
  const file = path.join(box.root, 'daemon.pid');
  const command = process.platform === 'win32'
    ? `Set-Content -LiteralPath ${JSON.stringify(file)} -Value $PID; Start-Sleep -Seconds 300`
    : `echo $$ > ${JSON.stringify(file)}; exec sleep 300`;
  const provider = await startLoopbackProvider('gemini', (request) => {
    const tool = request.toolResults === 0 ? request.tools.find(candidate => candidate.name === 'run_command') : undefined;
    return tool === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }
      : { kind: 'tool', tool, args: { CommandLine: command, toolSummary: 'Start the daemon', WaitMsBeforeAsync: 5_000, IsDaemon: true } };
  });
  try {
    const recorder = await fileEgress();
    const runtime = agyAdapterWithEndpoint(new AgyAdapter({ home: await ownedHome(), resolveBin }), provider.origin);
    await runTurn(runtime, 'Start the daemon.', { workspaceDir: box.workspace, env: { ...baseEnv(box.home), GEMINI_API_KEY: REAL_KEY, ...recorder.env } });
    return Number(await fs.readFile(file, 'utf8'));
  } finally {
    await provider.close();
  }
}

/** A second execution on a saved conversation: agy lists it, and the SDK confirms its saved cwd before it resumes. */
async function resumed() {
  const box = await createSandbox('agy-resume');
  const recorder = await fileEgress();
  const provider = await startLoopbackProvider('gemini', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }));
  try {
    const runtime = agyAdapterWithEndpoint(new AgyAdapter({ home: await ownedHome(), resolveBin }), provider.origin);
    const resources = { workspaceDir: box.workspace, env: { ...baseEnv(box.home), GEMINI_API_KEY: REAL_KEY, ...recorder.env } };
    const opened: Session = await startPreparedOperation(runtime, { instruction: 'First.' }, resources);
    for await (const event of opened.events) if (event.type === 'turn_end') break;
    const sessionRef = opened.sessionRef;
    await opened.close();
    const again = await startPreparedOperation(runtime, { instruction: 'Second.', sessionRef }, resources);
    const events: AgentEvent[] = [];
    for await (const event of again.events) {
      events.push(event as AgentEvent);
      if (event.type === 'turn_end') break;
    }
    const resumedRef = again.sessionRef;
    await again.close();
    return { sessionRef, resumedRef, events };
  } finally {
    await provider.close();
  }
}

const userTurn = once(() => turn('user'));
const ownedTurn = once(() => turn('owned'));
const shellEnv = once(shellEnvironment);
const daemon = once(daemonPid);
const resume = once(resumed);
const descriptor = new AgyAdapter({ home: path.resolve('/agy-descriptor-only') }).descriptor;

defineRuntimeContract(`agy runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, {
  'detect.version': check(async () => {
    const box = await createSandbox('agy-version');
    expectDetectedVersion(await detectWith(await detectAdapter(), baseEnv(box.home)), target, (version, expected) => version.trim() === expected, true);
  }),
  'detect.auth.absent': check(async () => {
    const box = await createSandbox('agy-auth-absent');
    expectAuth(await detectWith(await detectAdapter(), baseEnv(box.home)), false);
  }),
  'detect.auth.apiKey': check(async () => {
    const box = await createSandbox('agy-auth-key');
    expectAuth(await detectWith(await detectAdapter(), { ...baseEnv(box.home), GEMINI_API_KEY: REAL_KEY }), true);
  }),
  'detect.auth.login': skip('the SDK supports no Google account login: the vendor forbids third-party use of one'),
  'mcp.submitResult': check(async () => {
    const { calls, events, provider } = await userTurn();
    expect(events.at(-1)?.type).toBe('turn_end');
    const offered = provider.requests.filter(request => request.model).map(request => request.tools.map(tool => tool.name));
    expect(calls, `tools offered per model request: ${JSON.stringify(offered)}`).toEqual([expect.objectContaining({ name: 'submit_result', arguments: { summary: 'runtime contract' } })]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', tool: 'mcp_host_submit_result' }));
  }),
  'instructions.project': check(async () => {
    expect((await userTurn()).provider.saw(PROJECT_MARKER)).toBe(true);
  }),
  'isolation.userInstructions': check(async () => {
    expect((await ownedTurn()).provider.saw(USER_MARKER), 'positive control: GEMINI.md in the home agy reads reaches the model').toBe(true);
    expect((await userTurn()).provider.saw(USER_MARKER)).toBe(false);
  }),
  'isolation.userOutputStyle': skip('agy descriptor does not advertise isolation.userOutputStyle yet (#1575)'),
  'isolation.userMemory': skip('agy descriptor does not advertise isolation.userMemory yet (#1575)'),
  'isolation.userSkills': skip('agy descriptor does not advertise isolation.userSkills yet (#1575)'),
  'isolation.userHookContext': skip('agy descriptor does not advertise isolation.userHookContext yet (#1575)'),
  'isolation.userMcp': check(async () => {
    expect((await ownedTurn()).provider.saw('usermcp'), 'positive control: a server in the home agy reads is offered').toBe(true);
    const user = await userTurn();
    expect(user.userSpawned).toBe(false);
    expect(user.provider.saw('usermcp')).toBe(false);
  }),
  'isolation.sessionPersistence': skip('agy always keeps conversations below its home, which resume needs; it has no switch'),
  drafts: notAdvertised(descriptor, 'messageDraft'),
  'gate.auto': notAdvertised(descriptor, 'toolAuthorizationAuto'),
  'egress.declaredHostsOnly': egressCheck(async () => {
    const { provider } = await userTurn();
    await ownedTurn(); await shellEnv(); await resume(); await daemon();
    // agy holds only the session token, so a request carrying the key came through the local proxy.
    expect(new Set(provider.requests.map(request => request.apiKey))).toEqual(new Set([REAL_KEY]));
  }),
}, AGY_ABSENT_ISOLATION_SOURCES);

defineRuntimeCases(`agy runtime contract: agy cases (${target.mode} ${target.expectedVersion})`, {
  'agy.keyIsolation': ['the real key reaches the provider through the proxy, never the model\'s shell or a stdio MCP server', check(async () => {
    const { text, events, command, provider } = await shellEnv();
    expect(text).toMatch(/GEMINI_API_KEY=\S/);
    expect(text).not.toContain(REAL_KEY);
    expect(provider.requests.some(request => request.apiKey === REAL_KEY)).toBe(true);
    const { mcpEnv } = await userTurn();
    expect(mcpEnv).toContain('"GEMINI_API_KEY"');
    expect(mcpEnv).not.toContain(REAL_KEY);
    // The projection reads `rawInput` from the opening frame only; this proves real agy sends it there.
    expect(events.find(event => event.type === 'tool_use' && event.tool === 'run_command')).toMatchObject({ input: { command } });
  })],
  'agy.proxyEnv': ['agy reaches the local proxy past the proxy its environment names, with no NO_PROXY entry for it', check(async () => {
    const box = await createSandbox('agy-proxy-env');
    const provider = await startLoopbackProvider('gemini', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }));
    try {
      const dead = 'http://127.0.0.1:9';
      const env = { ...baseEnv(box.home), GEMINI_API_KEY: REAL_KEY, HTTP_PROXY: dead, HTTPS_PROXY: dead, NO_PROXY: new URL(provider.origin).host };
      const runtime = agyAdapterWithEndpoint(new AgyAdapter({ home: await ownedHome(), resolveBin }), provider.origin);
      const events = await runTurn(runtime, 'Reply.', { workspaceDir: box.workspace, env });
      expect(events.at(-1)?.type).toBe('turn_end');
      expect(provider.requests.some(request => request.model && request.apiKey === REAL_KEY)).toBe(true);
    } finally {
      await provider.close();
    }
  })],
  'agy.turnEnd': ['a daemon command does not outlive the turn', check(async () => {
    const pid = await daemon();
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  })],
  'agy.resume': ['a saved conversation resumes with its id on the same cwd', check(async () => {
    const { events, sessionRef, resumedRef } = await resume();
    expect(sessionRef).not.toBe('');
    expect(resumedRef).toBe(sessionRef);
    expect(events.at(-1)?.type).toBe('turn_end');
  })],
});
