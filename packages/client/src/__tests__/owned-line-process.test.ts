import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type SpawnOptions } from 'node:child_process';
import { createOwnedLineProcessSpawn, spawnOwnedLineProcess } from '../runtime/owned-line-process';
import { __hostExitBackstopForTests } from '../adapters/process-tree';
import { createOwnedTerminalSpawn } from '../runtime/owned-terminal-process';
import { PiRpcClient } from '../adapters/pi/rpc-client';
import { McpStdioClient } from '../mcp/client';
import type { LineProcess, SpawnLineProcess } from '../../vendor/oar/95c6547/runtimes/codex/app-server-client';

/** Walks message, stack, cause and every nested own property, not only their string forms. */
const carriesSecret = (value: unknown, depth = 0): boolean => typeof value === 'string' ? value.includes('fake-key')
  : depth < 5 && typeof value === 'object' && value !== null && Object.getOwnPropertyNames(value).some(key => carriesSecret((value as Record<string, unknown>)[key], depth + 1));
const checkedSpawn: SpawnLineProcess = spawnOwnedLineProcess;
const live: LineProcess[] = [];
afterEach(async () => { for (const child of live.splice(0)) { child.kill(); await child.exited.catch(() => {}); } vi.unstubAllEnvs(); });
function firstLine(child: LineProcess): Promise<string> {
  return new Promise(resolve => child.onLine(resolve));
}

describe('BYOK owned line process', () => {
  it('passes exactly the filtered env through spawn and into a real child', async () => {
    vi.stubEnv('BYOK_S2A_UNRELATED_SECRET', 'must not inherit');
    const spawnFn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => spawn(command, args, options));
    const env = { BYOK_S2A_ALLOWED: 'yes' };
    const child = createOwnedLineProcessSpawn({ spawnFn })(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env }); live.push(child);
    const line = firstLine(child); await child.spawned;
    expect(spawnFn.mock.calls[0]![2]?.env).toBe(env);
    const observed = JSON.parse(await line);
    // Node's macOS spawn implementation adds this platform baseline independently of caller env.
    if (process.platform === 'darwin') delete observed.__CF_USER_TEXT_ENCODING;
    expect(observed).toEqual(env);
    expect(observed).not.toHaveProperty('BYOK_S2A_UNRELATED_SECRET');
    expect(await child.exited).toBe(0);
  });

  it('kills and reaps through existing owned-tree authority, with one exit callback and late readback', async () => {
    let pid = 0;
    const spawnFn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => { const child = spawn(command, args, options); pid = child.pid ?? 0; return child; });
    const child = createOwnedLineProcessSpawn({ spawnFn })(process.execPath, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'], { env: {} }); live.push(child);
    const line = firstLine(child); const onExit = vi.fn(); child.onExit(onExit);
    await child.spawned; await line;
    expect(__hostExitBackstopForTests.registeredPids()).toContain(pid);
    child.kill(); child.kill(); await child.exited;
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(__hostExitBackstopForTests.registeredPids()).not.toContain(pid);
    if (process.platform !== 'win32') expect(() => process.kill(-pid, 0)).toThrow();
    const late = vi.fn(); child.onExit(late); await Promise.resolve(); expect(late).toHaveBeenCalledTimes(1);
    expect(() => child.write('after close')).toThrow('not writable');
  });

  it('preserves split UTF-8 lines and reports actual exit status', async () => {
    const child = checkedSpawn(process.execPath, ['-e', 'const b=Buffer.from("你好\\n");process.stdout.write(b.subarray(0,2));setTimeout(()=>{process.stdout.write(b.subarray(2));process.exitCode=7},10)'], { env: {} }); live.push(child);
    const line = firstLine(child); const exited = vi.fn(); child.onExit(exited);
    await child.spawned; expect(await line).toBe('你好'); expect(await child.exited).toBe(7); expect(exited).toHaveBeenCalledWith(7);
  });

  it('rejects a NUL-bearing env value by name on every owned spawn', () => {
    const env = { BYOK_TEST_KEY: 'fake-key\0tail' };
    for (const start of [() => createOwnedLineProcessSpawn()(process.execPath, [], { env }),
      () => createOwnedTerminalSpawn()(process.execPath, [], { cwd: '.', env, shell: false }),
      () => new PiRpcClient({ command: process.execPath, args: [], cwd: '.', env })]) expect.soft(start).toThrow(/^spawn env variable BYOK_TEST_KEY contains a NUL byte$/);
  });

  it('rejects spawn failure with only its code on every client spawn and still settles its exit receipt', async () => {
    const command = '/nonexistent/byok-s2a-binary', args = ['--token=fake-key-2065'];
    const child = checkedSpawn(command, args, { env: {} }); live.push(child);
    const exited = child.exited.catch(error => error); const onExit = vi.fn(); child.onExit(onExit);
    const pi = new PiRpcClient({ command, args, cwd: '.', env: {} });
    const errors = [await child.spawned.catch(error => error), await exited, await createOwnedTerminalSpawn()(command, args, { cwd: '.', env: {}, shell: false }).spawned.catch(error => error),
      await pi.waitClosed().then(() => pi.terminalError), await new McpStdioClient({ command, args }, { env: {} }).connect().catch(error => error)];
    // Node's own error carries the arguments in `spawnargs`; nothing nested may.
    expect(errors.filter(error => carriesSecret(error))).toEqual([]);
    expect(errors.slice(0, 4)).toEqual(Array(4).fill(expect.objectContaining({ message: 'spawn failed: ENOENT', code: 'ENOENT' })));
    expect(errors[4]).toMatchObject({ message: 'MCP server failed to start: spawn failed: ENOENT' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
