import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { startPreparedOperation } from '../fixtures/prepared-operation';
import { OpenCodeAdapter } from '../../adapters/opencode/opencode-adapter';
import { QUALIFIED_OPENCODE_VERSION } from '../../adapters/opencode/opencode-version';
import {
  baseEnv, check, contractTarget, createSandbox, detectWith, egressCheck, expectDetectedVersion,
  fileEgress, notAdvertised, once, readReceipt, runTurn, skip, writeSubmitResultServer, type ContractPlan, type ContractRuntime, type DeclaredHost,
} from './contract';
import { CONTRACT_REPLY_CHUNKS, mcpTool, startLoopbackProvider, type ProviderScript } from './loopback';

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
    // PowerShell, which OpenCode 2.x runs shell tools in on Windows, exits 0 without running the command when PATHEXT is unset (#1696); the
    // runtime environment the SDK builds for win32 always carries it (runtime/environment.ts), so the contract's environment does too.
    const env: NodeJS.ProcessEnv = { ...baseEnv(box.home), ...(process.platform === 'win32' && process.env.PATHEXT !== undefined ? { PATHEXT: process.env.PATHEXT } : {}) };
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

  const mcp = once(async () => {
    const recorder = await fileEgress();
    const marker = 'runtime contract result accepted';
    const provider = await startLoopbackProvider('openai-chat', request => {
      const tool = request.toolResults === 0 ? mcpTool('host', 'submit_result')(request.tools) : undefined;
      const execute = (request.toolResults === 0 || (request.toolResults === 1 && request.text.includes('PROBE_RESUME_ACCESS'))) && request.text.includes('tools.host.submit_result(')
        ? request.tools.find(tool => tool.name === 'execute') : undefined;
      return tool ? { kind: 'tool', tool, args: { summary: 'contract' } }
        : execute ? { kind: 'tool', tool: execute, args: { code: 'return await tools.host.submit_result({summary: "contract"})' } }
        : { kind: 'text', chunks: [request.text.includes(marker) ? marker : 'no host tool'] };
    }, MODEL);
    try {
      const { box, env } = await openCodeEnv(`${runtime}-mcp`, provider.baseUrl);
      const config = path.join(box.home, '.config', 'opencode', 'opencode.json');
      const before = await fs.readFile(config, 'utf8');
      const receipt = path.join(box.root, 'host-receipt');
      const server = await writeSubmitResultServer(box.root, receipt);
      const resources = { workspaceDir: box.workspace, env: { ...env, ...recorder.env } };
      const first = await startPreparedOperation(adapter(), { instruction: 'Call the Host tool and return its result.' }, { ...resources, mcpServers: { host: server } });
      const events = [];
      try { for await (const event of first.events) events.push(event); } finally { await first.close(); }
      expect(events, JSON.stringify(provider.requests.filter(request => request.model).map(request => ({ tools: request.tools, toolResults: request.toolResults })))).toContainEqual({ type: 'progress', text: marker });
      expect(await readReceipt(receipt)).toMatchObject([{ name: 'submit_result', arguments: { summary: 'contract' } }]);
      const firstEnd = provider.requests.length;
      await runTurn(adapter(), 'Say hello without tools.', resources);
      const secondEnd = provider.requests.length;
      const resumed = await startPreparedOperation(adapter(), { instruction: 'PROBE_RESUME_ACCESS', sessionRef: first.sessionRef }, resources);
      try { for await (const _event of resumed.events) { /* drain the turn */ } } finally { await resumed.close(); }
      expect(await readReceipt(receipt), 'resumed tool call receipt').toHaveLength(1);
      for (const request of provider.requests.slice(firstEnd, secondEnd).filter(item => item.model)) {
        expect(mcpTool('host', 'submit_result')(request.tools)).toBeUndefined();
        const messages = JSON.parse(request.text).messages as Array<{ role: string; content: unknown }>;
        expect(JSON.stringify(messages.filter(message => message.role === 'system')).includes('tools.host.submit_result(')).toBe(false);
      }
      const resumeRequests = provider.requests.slice(secondEnd).filter(item => item.model);
      for (const request of resumeRequests) expect(mcpTool('host', 'submit_result')(request.tools)).toBeUndefined();
      if (runtime === 'opencode2') {
        expect(resumeRequests.some(request => request.text.includes('The following tool namespaces are no longer available and must not be used: `host`.'))).toBe(true);
        expect(resumeRequests.some(request => request.text.includes("Unknown tool 'host.submit_result'"))).toBe(true);
      }
      expect(provider.requests.slice(firstEnd, secondEnd).some(item => item.model)).toBe(true);
      expect(provider.requests.slice(secondEnd).some(item => item.model)).toBe(true);
      expect(await readReceipt(receipt)).toHaveLength(1);
      expect(await fs.readFile(config, 'utf8')).toBe(before);
    } finally { await provider.close(); }
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
    'mcp.submitResult': check(mcp),
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
      const drained = (async () => { for await (const event of session.events) { events.push(event.type); log.push(JSON.stringify(event).slice(0, 300)); if (event.type === 'turn_end') break; } })();
      const tool = Number(await waitFor(async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim() || undefined, 60_000, 'the shell tool pid')
        .catch((error: Error) => { throw new Error(`${error.message}; events: ${log.slice(-8).join(' | ')}`); }));
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
        expect(refusal, 'resume from another workspace must fail').toMatchObject({ phase: 'start', retry: 'non-retryable', message: expect.stringContaining('resumes it only there') });
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
