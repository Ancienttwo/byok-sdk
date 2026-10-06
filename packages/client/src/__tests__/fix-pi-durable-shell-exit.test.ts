import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { durableShell } from '../adapters/pi-durable/shell';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fix-pi-durable-shell-exit-')));
  const env = new NodeExecutionEnv({ cwd: root, shellEnv: { PATH: '/usr/bin:/bin' } });
  const owned: number[] = [], released: number[] = [];
  const shell = durableShell(env, { PATH: '/usr/bin:/bin' }, async pid => { owned.push(pid); }, pid => { released.push(pid); });
  cleanups.push(async () => { await shell.cleanup(); await env.cleanup(BACKGROUND_CONTEXT); await rm(root, { recursive: true, force: true }); });
  return { root, env, shell, owned, released };
}
function liveGroup(group: number): number[] {
  return execFileSync('ps', ['-eo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.trim().split(/\s+/u)).filter(([, pgid, stat]) => Number(pgid) === group && !stat!.startsWith('Z')).map(([pid]) => Number(pid));
}
async function assertReleased(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.owned).toHaveLength(1);
  expect(f.released).toEqual(f.owned);
  expect(liveGroup(f.owned[0]!)).toEqual([]);
  const background = Number(await readFile(path.join(f.root, 'background.pid'), 'utf8'));
  expect(background).toBeGreaterThan(1);
  // A zombie is dead; group disposal must additionally have confirmed its own
  // stricter process-group receipt before this single ownership release.
  const rows = execFileSync('ps', ['-eo', 'pid=,stat='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/u));
  expect(rows.some(([pid, stat]) => Number(pid) === background && !stat!.startsWith('Z'))).toBe(false);
}

// Only local POSIX shell/Node fixtures. No Pi, provider, credentials or network.
describe.skipIf(process.platform === 'win32')('F16-2 foreground exit releases background stdio', () => {
  it.each([false, true])('completes successfully before timeout (background redirected: %s)', async redirected => {
    const f = await fixture();
    let output = '';
    const result = await f.shell.exec(`sleep 60 ${redirected ? '>/dev/null 2>&1' : ''} & echo $! > background.pid; printf foreground-complete`,
      { timeout: 0.5, onOutput: text => { output += text; } }, BACKGROUND_CONTEXT);
    expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
    expect(output).toBe('foreground-complete');
    await assertReleased(f);
  });

  it('does not require a command timeout to dispose inherited background pipes', async () => {
    const f = await fixture();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = f.shell.exec('sleep 60 & echo $! > background.pid; printf foreground-complete', undefined, BACKGROUND_CONTEXT);
    const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), 1_500); });
    const first = await Promise.race([running, deadline]);
    if (timer) clearTimeout(timer);
    if (first === 'deadline') await f.shell.cleanup(); // bounded regression teardown even on old code
    const result = await running;
    expect(first).not.toBe('deadline');
    expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
    await assertReleased(f);
  });

  it('preserves foreground failure status and fully drains large output and UTF-8 tails', async () => {
    const f = await fixture();
    const text = '汉'.repeat(70_000);
    let stdout = '', stderr = '';
    const writer = `const fs=require("node:fs");fs.writeSync(1,Buffer.concat([Buffer.from("汉".repeat(70000)),Buffer.from([0xe6,0xb1])]));fs.writeSync(2,"stderr-tail");`;
    const result = await f.shell.exec(`sleep 60 & echo $! > background.pid; ${JSON.stringify(process.execPath)} -e ${JSON.stringify(writer)}; exit 7`, {
      timeout: 0.8,
      spill: { afterBytes: 4096, afterLines: 100 },
      onOutput: (chunk, _context, meta) => { if (meta?.stream === 'stderr') stderr += chunk; else stdout += chunk; },
    }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.exitCode).toBe(7);
    expect(stdout).toBe(`${text}\ufffd`);
    expect(stderr).toBe('stderr-tail');
    expect(result.value.spillPath).toBeDefined();
    const spill = await readFile(result.value.spillPath!);
    expect(spill.length).toBe(Buffer.byteLength(text) + 2 + Buffer.byteLength('stderr-tail'));
    expect(spill.subarray(0, Buffer.byteLength(text))).toEqual(Buffer.from(text));
    expect(spill.includes(Buffer.from('stderr-tail'))).toBe(true);
    expect(spill.subarray(-2)).toEqual(Buffer.from([0xe6, 0xb1]));
    await assertReleased(f);
  });

  it('stops the command timer while disposing a TERM-ignoring background group', async () => {
    const f = await fixture();
    const background = `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("background-ready","");setInterval(()=>{},1000);`;
    const result = await f.shell.exec(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(background)} & echo $! > background.pid; while [ ! -f background-ready ]; do sleep 0.01; done; printf foreground-complete`,
      { timeout: 0.4 }, BACKGROUND_CONTEXT);
    expect(result).toEqual({ ok: true, value: { exitCode: 0 } });
    await assertReleased(f);
  });

  it('retains the timeout classification when the foreground is still running', async () => {
    const f = await fixture();
    const result = await f.shell.exec('sleep 60 & echo $! > background.pid; wait', { timeout: 0.2 }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timeout');
    await assertReleased(f);
  });

  it('retains cancellation while the foreground and its background child are running', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const context = { abortSignal: controller.signal } as Context;
    const result = await f.shell.exec('sleep 60 & echo $! > background.pid; printf ready; wait',
      { onOutput: () => { controller.abort(); } }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('aborted');
    await assertReleased(f);
  });

  it('retains output callback failures while releasing the whole group once', async () => {
    const f = await fixture();
    const result = await f.shell.exec('sleep 60 & echo $! > background.pid; printf ready; wait',
      { onOutput: () => { throw new Error('inert consumer closed'); } }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('callback_error');
    await assertReleased(f);
  });

  it('retains spawn-error classification when the working directory disappears', async () => {
    const f = await fixture();
    const cwd = path.join(f.root, 'removed');
    await mkdir(cwd); await rm(cwd, { recursive: true });
    const result = await f.shell.exec('printf forbidden', { cwd, timeout: 0.2 }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('spawn_error');
    expect(f.owned).toEqual([]);
    expect(f.released).toEqual([]);
  });
});
