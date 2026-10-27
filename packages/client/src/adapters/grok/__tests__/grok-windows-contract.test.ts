/**
 * The Grok fixture contract through the shared owned-process-tree path. It
 * runs on every platform; on the `adapter-lifecycle-smoke` Windows leg it is
 * the only Grok evidence for Windows (#609). Windows detection stays refused
 * (`platform_unsupported`), so a daemon never dispatches Grok there: these
 * cases drive the adapter directly against the fake ACP agent. They are not a
 * live Grok run.
 */
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { RuntimeTaskInput } from '../../../types';
import { GrokAdapter } from '../grok-adapter';
import { observeRuntimeDetection } from '../../../runtime-detection';
import type { Session } from '../../../types';
import { startPreparedOperation, type PreparedOperationResources } from '../../../__tests__/fixtures/prepared-operation';
import { resolveBunBin } from '../../../__tests__/support/test-bun-bin';

const FAKE_AGENT = fileURLToPath(new URL('../../../__tests__/fixtures/fake-acp-agent.mjs', import.meta.url));
const usage = { type: 'usage', inputTokens: 100, cachedInputTokens: 64, outputTokens: 7, contextTokens: 1001, contextSource: 'provider' } as const;
// Windows process start and job assignment are slower than vi.waitFor's 1 s default.
const WAIT = { timeout: 10_000 } as const;
const sessions: Session[] = [];
const dirs: string[] = [];
let launcherDir: string;
let command: string;

/**
 * POSIX runs the fixture through its shebang. Windows runs no script without
 * a shell, and `prepare()` probes the command with execFile, so on Windows the
 * fixture runs behind a compiled `grok.exe` that starts Node as its child.
 */
function fakeGrokCommand(outDir: string): string {
  if (process.platform !== 'win32') return FAKE_AGENT;
  const source = path.join(outDir, 'grok-launcher.mjs');
  writeFileSync(source, `import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(FAKE_AGENT)}, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
child.on('error', () => process.exit(127));
child.on('exit', (code) => process.exit(code ?? 1));
`);
  const executable = path.join(outDir, 'grok.exe');
  // The candidate list names POSIX paths; on Windows the CI jobs put bun.exe on PATH.
  execFileSync(resolveBunBin() ?? 'bun', ['build', source, '--compile', '--outfile', executable], { stdio: 'pipe' });
  return executable;
}

function adapter(options: ConstructorParameters<typeof GrokAdapter>[0] = {}): GrokAdapter {
  return new GrokAdapter({ resolveBin: () => ({ command, source: 'path' }), ...options });
}
async function ctx(): Promise<PreparedOperationResources & { log: string }> {
  // Realpath: Windows can name the temp root by its 8.3 short path.
  const workspaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-grok-')));
  dirs.push(workspaceDir);
  const log = path.join(workspaceDir, '.agent.log');
  // Node on Windows needs SystemRoot; the daemon's environment keeps it from the Host.
  const platform = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
  return { workspaceDir, log, env: { PATH: process.env.PATH, HOME: os.homedir(), FAKE_ACP_LOG: log, ...platform } };
}
function facts(log: string): Array<Record<string, any>> {
  return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
async function open(a: GrokAdapter, offer: RuntimeTaskInput, resources: PreparedOperationResources): Promise<Session> {
  const session = await startPreparedOperation(a, offer, resources);
  sessions.push(session);
  return session;
}
async function turn(s: Session): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of s.events) {
    if (e.type === 'message_draft_delta') continue; // Display-only; the draft lane has its own tests.
    out.push(e);
    if (e.type === 'turn_end') break;
  }
  return out;
}
/** Signal 0 tests existence on every platform. On Windows the fixture is a grandchild, so no handle of this process keeps it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

beforeAll(async () => {
  launcherDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-grok-bin-')));
  command = fakeGrokCommand(launcherDir);
}, 120_000);
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(s => s.close()));
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
afterAll(async () => {
  await fs.rm(launcherDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('GrokAdapter fixture contract on the host platform', { timeout: 30_000 }, () => {
  it.runIf(process.platform === 'win32')('keeps Windows detection refused before any probe', async () => {
    expect(await observeRuntimeDetection(adapter())).toEqual({ kind: 'refused', reason: 'platform_unsupported' });
  });

  it('runs a turn in an owned agent tree and ends the tree on close', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'hello' }, resources);
    expect(s.sessionRef).toBe('fake-grok-session');
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'echo:hello' }, usage, { type: 'turn_end' }]);
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    expect(started!.argv).toEqual(['agent', '--always-approve', '--no-leader', 'stdio']);
    expect(await fs.realpath(started!.cwd)).toBe(resources.workspaceDir);
    await s.close();
    await vi.waitFor(() => expect(alive(started!.pid)).toBe(false), WAIT);
  });

  it('runs a hosted terminal command with the task environment', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'terminal' }, resources);
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'terminal:terminal-ok' }, usage, { type: 'turn_end' }]);
  });

  it('interrupts through session/cancel', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'hold' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true), WAIT);
    await s.interrupt();
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(true);
    expect(await turn(s)).toEqual([usage, { type: 'turn_end' }]);
  });

  it('ends a hung terminal tree and the agent tree when the session closes mid-turn', async () => {
    const terminals: ChildProcess[] = [];
    const spawnFn = ((file: string, args: readonly string[], options: SpawnOptions) => {
      const child = spawn(file, [...args], options);
      if (options.shell) terminals.push(child);
      return child;
    }) as typeof spawn;
    const resources = await ctx();
    const s = await open(adapter({ spawnFn }), { instruction: 'terminal-hang' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'terminal')).toBe(true), WAIT);
    await s.close();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.exitCode ?? terminals[0]!.signalCode).not.toBeNull();
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    await vi.waitFor(() => expect(alive(started!.pid)).toBe(false), WAIT);
  });
});
