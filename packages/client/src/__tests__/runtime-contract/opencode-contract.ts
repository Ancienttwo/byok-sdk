import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { startPreparedOperation } from '../fixtures/prepared-operation';
import { OpenCodeAdapter } from '../../adapters/opencode/opencode-adapter';
import { QUALIFIED_OPENCODE_VERSION } from '../../adapters/opencode/opencode-version';
import {
  baseEnv, check, contractTarget, createSandbox, defineRuntimeCases, detectWith, egressCheck, expectDetectedVersion,
  fileEgress, notAdvertised, once, runTurn, skip, type ContractPlan, type ContractRuntime, type DeclaredHost,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, startLoopbackProvider, type ProviderScript } from './loopback';

const MODEL = 'fake';
/** The shell tool is `bash` on the 1.x line and `shell` on 2.x. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'shell']);
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

  async function openCodeEnv(label: string, baseURL: string, bash: 'allow' | 'ask' = 'allow') {
    const box = await createSandbox(label);
    const env = baseEnv(box.home);
    const config = {
      $schema: 'https://opencode.ai/config.json', autoupdate: false, permission: { bash, edit: bash }, share: 'disabled', model: `loopback/${MODEL}`, small_model: `loopback/${MODEL}`,
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
  return { title: `${line} runtime contract (${target.mode} ${target.expectedVersion})`, descriptor, plan, lifecycle: openCodeLifecycle(runtime, target, openCodeEnv) };
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

async function waitFor<T>(read: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Files under `root` (relative, with sizes), at most `limit`; a missing root is empty. */
async function listFiles(root: string, limit = 60): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(`${path.relative(root, full).replace(/\\/g, '/')} (${(await fs.stat(full).catch(() => ({ size: -1 }))).size}B)`);
    }
  };
  await walk(root);
  return out;
}

/** What a timed-out cancel case leaves to read (#1696): the holder script and pid, every event with its time, and OpenCode's own logs. */
async function cancelDiagnostics(workspace: string, home: string, log: readonly string[]): Promise<string> {
  const exists = (file: string) => fs.stat(path.join(workspace, file)).then(stat => `${file}=${stat.size}B`, () => `${file}=missing`);
  const logs = (await listFiles(home)).filter(row => /\.log\b/.test(row)).slice(-4);
  const tails: string[] = [];
  for (const row of logs) {
    const name = row.replace(/ \(\d+B\)$/, '');
    tails.push(`--- ${name}\n${(await fs.readFile(path.join(home, name), 'utf8').catch(() => '')).split(/\r?\n/).slice(-40).join('\n')}`);
  }
  // The shell tool's recorded state (shell, exit, time) lives in OpenCode's database as JSON text; OpenCode logs none of it.
  const stored: string[] = [];
  for (const file of ['opencode.db-wal', 'opencode.db']) {
    const text = (await fs.readFile(path.join(home, '.local', 'share', 'opencode', file)).catch(() => Buffer.alloc(0))).toString('latin1');
    for (const match of text.matchAll(/[\x20-\x7e]{0,400}hold\.mjs[\x20-\x7e]{0,900}/g)) if (stored.length < 4) stored.push(`${file}: ${match[0]}`);
  }
  return `\nworkspace: ${[await exists('hold.mjs'), await exists('hold.pid')].join(' ')}; node=${process.execPath}\nevents:\n${log.join('\n')}\nhome files: ${(await listFiles(home)).join(', ')}\n${tails.join('\n')}\nstored shell records:\n${stored.join('\n')}`;
}

/** The pid of a `pid command` row; `ps` right-aligns its pid column, so leading spaces are not a field. */
const pidOf = (row: string): string => row.trim().split(/\s+/)[0] ?? '';

/** The OpenCode runtime processes (`acp`, `serve --service`) alive now, as `pid command` rows. */
function openCodeProcesses(): string[] {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^opencode' } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"], { encoding: 'utf8' });
    return out.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  }
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .map(row => row.trim()).filter(line => /opencode/.test(line) && /(?:\bacp\b|serve --service)/.test(line));
}

/**
 * Records the ACP frames of the OpenCode processes an adapter starts: the
 * permission requests OpenCode sends and the replies the adapter writes back.
 */
function acpSpy() {
  const requests: Array<{ id: unknown; params: unknown }> = [];
  const replies: Array<{ id: unknown; result: unknown }> = [];
  const spawnFn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child: ChildProcess = spawn(command, [...args], options);
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown };
          if (frame.method === 'session/request_permission') requests.push({ id: frame.id, params: frame.params });
        } catch { /* not a JSON frame */ }
      }
    });
    const write = child.stdin?.write.bind(child.stdin);
    if (child.stdin && write) {
      child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
        try {
          const frame = JSON.parse(chunk.toString()) as { id?: unknown; method?: string; result?: unknown };
          if (frame.id !== undefined && frame.method === undefined && frame.result !== undefined) replies.push({ id: frame.id, result: frame.result });
        } catch { /* not a JSON frame */ }
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof child.stdin.write;
    }
    return child;
  }) as typeof spawn;
  return { spawnFn, requests, replies };
}

/**
 * The lifecycle cases the qualification rule requires on every advertised OS and
 * line (docs/adapter-capabilities.md): resume with cwd refusal, permission
 * refusal, cancellation and disposal. Each is an OpenCode case of its own, in the
 * way `dsh.close` is dsh's.
 */
export function openCodeLifecycle(runtime: Extract<ContractRuntime, 'opencode1' | 'opencode2'>, target: { bin: string; mode: string; expectedVersion: string }, openCodeEnv: (label: string, baseURL: string, bash?: 'allow' | 'ask') => Promise<{ box: { root: string; workspace: string }; env: NodeJS.ProcessEnv }>) {
  const resolveBin = () => ({ command: target.bin, source: 'env' as const });
  const adapter = (spawnFn?: typeof spawn) => new OpenCodeAdapter({ resolveBin, models: [`loopback/${MODEL}`], ...(spawnFn === undefined ? {} : { spawnFn }) });
  const HELD = 'BYOK-CONTRACT-OPENCODE-RESUME-1d7c';

  /** Turn 1, a resumed turn 2 in the same workspace, and a resume from another workspace. */
  const resumed = once(async () => {
    const recorder = await fileEgress();
    const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }), MODEL);
    try {
      const { box, env } = await openCodeEnv(`${runtime}-resume`, provider.baseUrl);
      const other = await createSandbox(`${runtime}-resume-other`);
      const resources = { workspaceDir: box.workspace, agentHome: box.workspace, env: { ...env, ...recorder.env } };
      const first = await startPreparedOperation(adapter(), { instruction: `Remember ${HELD}.` }, resources);
      for await (const event of first.events) if (event.type === 'turn_end') break;
      const sessionRef = first.sessionRef;
      await first.close();
      const before = provider.requests.length;
      const second = await startPreparedOperation(adapter(), { instruction: 'Continue.', sessionRef }, resources);
      const events: string[] = [];
      for await (const event of second.events) { events.push(event.type); if (event.type === 'turn_end') break; }
      const resumedRef = second.sessionRef;
      await second.close();
      const history = provider.requests.slice(before).filter(request => request.model).some(request => request.text.includes(HELD));
      let refusal: unknown;
      try {
        const third = await startPreparedOperation(adapter(), { instruction: 'Continue.', sessionRef },
          { workspaceDir: other.workspace, agentHome: other.workspace, env: { ...env, ...recorder.env } });
        try { for await (const event of third.events) if (event.type === 'turn_end') break; } finally { await third.close(); }
      } catch (error) { refusal = error; }
      return { sessionRef, resumedRef, events, history, refusal };
    } finally { await provider.close(); }
  });

  /** A shell tool call under `permission.bash: ask`: the adapter refuses the request and the command never runs. */
  const refused = once(async () => {
    const recorder = await fileEgress();
    let issued = false;
    const script: ProviderScript = request => {
      const tool = request.toolResults === 0 ? request.tools.find(candidate => SHELL_TOOLS.has(candidate.name)) : undefined;
      if (request.toolResults === 0 && request.tools.length > 0 && tool === undefined) throw new Error(`no shell tool offered: ${JSON.stringify(request.tools.map(t => t.name))}`);
      issued ||= tool !== undefined;
      return tool === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS } : { kind: 'tool', tool, args: { command: 'echo refused > refused.txt', description: 'Write a file' } };
    };
    const provider = await startLoopbackProvider('openai-chat', script, MODEL);
    try {
      const { box, env } = await openCodeEnv(`${runtime}-permission`, provider.baseUrl, 'ask');
      const spy = acpSpy();
      const events = await runTurn(adapter(spy.spawnFn), 'Run the shell command.', { workspaceDir: box.workspace, agentHome: box.workspace, env: { ...env, ...recorder.env } });
      const written = await fs.access(path.join(box.workspace, 'refused.txt')).then(() => true, () => false);
      return { events, written, issued, requests: spy.requests, replies: spy.replies };
    } finally { await provider.close(); }
  });

  /** A running shell tool, interrupted, then closed: the turn stops and nothing of the run survives. */
  const cancelled = once(async () => {
    const recorder = await fileEgress();
    const before = new Set(openCodeProcesses().map(pidOf));
    const box = await createSandbox(`${runtime}-cancel`);
    const pidFile = path.join(box.workspace, 'hold.pid').replace(/\\/g, '/');
    if (/\s/.test(process.execPath)) throw new Error(`the Node path must not contain whitespace: ${process.execPath}`);
    const holder = path.join(box.workspace, 'hold.mjs');
    await fs.writeFile(holder, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
    const script: ProviderScript = request => {
      const tool = request.toolResults === 0 ? request.tools.find(candidate => SHELL_TOOLS.has(candidate.name)) : undefined;
      if (request.toolResults === 0 && request.tools.length > 0 && tool === undefined) throw new Error(`no shell tool offered: ${JSON.stringify(request.tools.map(t => t.name))}`);
      return tool === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS } : { kind: 'tool', tool, args: {
        // A bare absolute path with forward slashes runs in bash, cmd and PowerShell, and needs no PATH; the tool's cwd is the workspace.
        command: `${process.execPath.replace(/\\/g, '/')} hold.mjs`, description: 'Hold the shell tool',
      } };
    };
    const provider = await startLoopbackProvider('openai-chat', script, MODEL);
    try {
      const { env } = await openCodeEnv(`${runtime}-cancel-env`, provider.baseUrl);
      const session = await startPreparedOperation(adapter(), { instruction: 'Run the shell command.' }, { workspaceDir: box.workspace, agentHome: box.workspace, env: { ...env, ...recorder.env } });
      const events: string[] = [];
      const log: string[] = [];
      const started = Date.now();
      const drained = (async () => { for await (const event of session.events) { events.push(event.type); log.push(`+${Date.now() - started}ms ${JSON.stringify(event).slice(0, 600)}`); if (event.type === 'turn_end') break; } })();
      const tool = Number(await waitFor(async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim() || undefined, 60_000, 'the shell tool pid')
        .catch(async (error: Error) => { throw new Error(`${error.message}; ${await cancelDiagnostics(box.workspace, env.HOME!, log)}`); }));
      await session.interrupt();
      await drained;
      // Before close(): a close would reap the process and hide a cancel that left it running.
      const exitedBeforeClose = await waitFor(async () => isAlive(tool) ? undefined : true, 10_000, 'the shell tool to exit after the interrupt').catch(() => false);
      await session.close();
      const toolGone = exitedBeforeClose || await waitFor(async () => isAlive(tool) ? undefined : true, 10_000, 'the shell tool to exit').catch(() => false);
      if (!toolGone) try { process.kill(tool, 'SIGKILL'); } catch { /* already gone */ }
      const leaked = await waitFor(async () => { const rows = openCodeProcesses().filter(row => !before.has(pidOf(row))); return rows.length === 0 ? [] : undefined; }, 10_000, 'the OpenCode processes to exit').catch(() => openCodeProcesses().filter(row => !before.has(pidOf(row))));
      return { events, toolGone, exitedBeforeClose, leaked };
    } finally { await provider.close(); }
  });

  /** A normal completed turn: after close() nothing of the run survives either. */
  const completed = once(async () => {
    const recorder = await fileEgress();
    const before = new Set(openCodeProcesses().map(pidOf));
    const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }), MODEL);
    try {
      const { box, env } = await openCodeEnv(`${runtime}-complete`, provider.baseUrl);
      const events = await runTurn(adapter(), 'Say hello.', { workspaceDir: box.workspace, agentHome: box.workspace, env: { ...env, ...recorder.env } });
      const leaked = await waitFor(async () => { const rows = openCodeProcesses().filter(row => !before.has(pidOf(row))); return rows.length === 0 ? [] : undefined; }, 10_000, 'the OpenCode processes to exit').catch(() => openCodeProcesses().filter(row => !before.has(pidOf(row))));
      return { events, leaked };
    } finally { await provider.close(); }
  });

  return {
    title: `${runtime} runtime contract: OpenCode lifecycle cases (${target.mode} ${target.expectedVersion})`,
    cases: {
      'opencode.resume': ['a second turn resumes the same native session with its history, and a different workspace is refused', check(async () => {
        const { sessionRef, resumedRef, events, history, refusal } = await resumed();
        expect(sessionRef).not.toBe('');
        expect(resumedRef).toBe(sessionRef);
        expect(events.at(-1)).toBe('turn_end');
        expect(history).toBe(true);
        expect(refusal, 'resume from another workspace must fail').toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable', message: expect.stringContaining('resumes it only there') });
      }, 240_000)],
      'opencode.permission': ['a permission request is refused: the shell command does not run and the turn still ends', check(async () => {
        const { events, written, issued, requests, replies } = await refused();
        expect(events.at(-1)?.type).toBe('turn_end');
        expect(written).toBe(false);
        expect(issued, 'the model asked for the shell tool').toBe(true);
        // OpenCode asked for the command, and the adapter's reply was a refusal of that very request.
        expect(requests).toEqual([expect.objectContaining({ params: expect.objectContaining({ toolCall: expect.objectContaining({ kind: 'execute', title: 'echo refused > refused.txt' }) }) })]);
        expect(replies).toEqual([{ id: requests[0]!.id, result: { outcome: { outcome: 'cancelled' } } }]);
      }, 240_000)],
      'opencode.cancel': ['interrupting a running shell tool ends the turn and the tool process', check(async () => {
        const { events, exitedBeforeClose } = await cancelled();
        expect(events.at(-1)).toBe('turn_end');
        expect(exitedBeforeClose, 'the shell tool exited after the interrupt, before close()').toBe(true);
      }, 240_000)],
      'opencode.dispose': ['after close, following a completed turn and following an interrupt, no OpenCode acp or serve --service process survives', check(async () => {
        expect((await completed()).leaked).toEqual([]);
        expect((await cancelled()).leaked).toEqual([]);
      }, 240_000)],
    } as const,
  };
}
