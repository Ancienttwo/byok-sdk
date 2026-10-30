import { spawn, type ChildProcess } from 'node:child_process';
import { promises as nodeFs, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquirePathMutationGate, PathMutationGateBusyError, type PathMutationGate } from '../util/path-mutation-gate';
import { resolveBunBin } from './support/test-bun-bin';

/**
 * #1149: the gate is an OS lock owned by one open handle, so no process can
 * remove another holder's lock and a dead holder frees it at once. Each
 * acquisition takes its own handle, so two in this process contend exactly as
 * two processes do; the child-process cases run the bundled gate under Node
 * and under Bun.
 */
const supported = process.platform === 'darwin' || process.platform === 'linux';
const GATE_SOURCE = fileURLToPath(new URL('../util/path-mutation-gate.ts', import.meta.url));
const BUN = resolveBunBin();
const RUNTIMES: Array<[string, string | undefined]> = [['node', process.execPath], ['bun', BUN]];

let work = '';
let bundle = '';

const WORKERS = {
  // Loops `rounds` times: acquire, create the inside marker exclusively (EEXIST = overlap), leave it, release.
  'stress.mjs': `
    import { openSync, closeSync, unlinkSync } from 'node:fs';
    const [bundle, targetPath, marker, rounds] = process.argv.slice(2);
    const { acquirePathMutationGate } = await import(bundle);
    let overlaps = 0;
    for (let round = 0; round < Number(rounds); round += 1) {
      const gate = await acquirePathMutationGate({ scope: 'store', targetPath }, { waitMs: 30000 });
      try { closeSync(openSync(marker, 'wx')); } catch (error) { if (error.code === 'EEXIST') overlaps += 1; else throw error; }
      await new Promise((resolve) => setImmediate(resolve));
      unlinkSync(marker);
      await gate.release();
    }
    process.stdout.write(JSON.stringify({ rounds: Number(rounds), overlaps }) + '\\n');
  `,
  // Acquires once with waitMs 0; prints held or busy; a holder optionally starts a long-lived grandchild,
  // optionally blocks its event loop for blockMs, then releases on its first stdin line.
  'holder.mjs': `
    import { spawn } from 'node:child_process';
    const [bundle, targetPath, mode, blockMs] = process.argv.slice(2);
    const { acquirePathMutationGate } = await import(bundle);
    let gate;
    try { gate = await acquirePathMutationGate({ scope: 'store', targetPath }, { waitMs: 0 }); }
    catch (error) { process.stdout.write(error.name === 'PathMutationGateBusyError' ? 'busy\\n' : 'error ' + error.message + '\\n'); process.exit(0); }
    if (mode === 'grandchild') {
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      process.stdout.write('grandchild ' + grandchild.pid + '\\n');
    }
    process.stdout.write('held\\n');
    if (mode === 'block') {
      const until = Date.now() + Number(blockMs);
      while (Date.now() < until) {}
      process.stdout.write('unblocked\\n');
    }
    process.stdin.once('data', async () => { await gate.release(); process.stdout.write('released\\n'); process.exit(0); });
  `,
};

interface Child { child: ChildProcess; output: () => string; line: (text: string) => Promise<void>; send: () => void }
const children: ChildProcess[] = [];

function run(runtime: string, worker: keyof typeof WORKERS, args: string[]): Child {
  const child = spawn(runtime, [path.join(work, worker), bundle, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  let stdout = '';
  let closed = false;
  const waiters: Array<() => void> = [];
  const wake = () => waiters.splice(0).forEach((check) => check());
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); wake(); });
  // 'close' comes after the last stdout chunk; 'exit' can come before it.
  child.once('close', () => { closed = true; wake(); });
  const line = (text: string) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (stdout.split('\n').includes(text)) resolve();
      else if (closed) reject(new Error(`${worker} exited before "${text}": ${stdout}`));
      else waiters.push(check);
    };
    check();
  });
  return { child, output: () => stdout, line, send: () => child.stdin!.write('next\n') };
}

/** `held` or `busy`, whichever line a holder process prints first. */
function outcome(holder: Child): Promise<string> {
  return Promise.any([holder.line('held').then(() => 'held'), holder.line('busy').then(() => 'busy')]);
}

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve()));
}

const held: PathMutationGate[] = [];
const dirs: string[] = [];

async function target(): Promise<string> {
  const dir = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'byok-gate-'));
  dirs.push(dir);
  return dir;
}

async function settle(promise: Promise<PathMutationGate>): Promise<PathMutationGate | Error> {
  const result = await promise.catch((error: unknown) => error as Error);
  if (!(result instanceof Error)) held.push(result);
  return result;
}

beforeAll(async () => {
  work = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'byok-gate-work-'));
  bundle = path.join(work, 'gate.mjs');
  await build({ entryPoints: [GATE_SOURCE], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  for (const [name, source] of Object.entries(WORKERS)) await nodeFs.writeFile(path.join(work, name), source);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.allSettled(held.splice(0).map((gate) => gate.release()));
  await Promise.all(dirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  await nodeFs.rm(work, { recursive: true, force: true });
});

describe.runIf(supported)('path-mutation gate: one OS lock per handle (#1149)', () => {
  it('a second acquisition in the same process is busy, and the gate is free again after release', async () => {
    const targetPath = await target();
    const first = await settle(acquirePathMutationGate({ scope: 'store', targetPath }));
    expect(first).not.toBeInstanceOf(Error);
    expect(await settle(acquirePathMutationGate({ scope: 'store', targetPath }))).toBeInstanceOf(PathMutationGateBusyError);
    await (first as PathMutationGate).release();
    expect(await settle(acquirePathMutationGate({ scope: 'store', targetPath }))).not.toBeInstanceOf(Error);
  });

  it('replays the release ABA: after a release and a new holder, a third acquisition is busy, and no gate operation removes a path', async () => {
    const targetPath = await target();
    const rm = vi.spyOn(nodeFs, 'rm');
    const first = await acquirePathMutationGate({ scope: 'store', targetPath });
    await first.release();
    const second = await settle(acquirePathMutationGate({ scope: 'store', targetPath }));
    expect(second).not.toBeInstanceOf(Error);
    expect(await settle(acquirePathMutationGate({ scope: 'store', targetPath }))).toBeInstanceOf(PathMutationGateBusyError);
    expect(rm).not.toHaveBeenCalled();
  });

  it('waitMs 0: a held gate gives a typed busy error at once', async () => {
    const targetPath = await target();
    await settle(acquirePathMutationGate({ scope: 'store', targetPath }));
    const started = performance.now();
    const result = await settle(acquirePathMutationGate({ scope: 'store', targetPath }, { waitMs: 0 }));
    expect(performance.now() - started).toBeLessThan(50);
    expect(result).toBeInstanceOf(PathMutationGateBusyError);
    expect(result).toMatchObject({ scope: 'store', targetPath: await nodeFs.realpath(targetPath) });
  });

  it.runIf(process.platform === 'darwin')('darwin: the lock file keeps its inode over 100 acquire/release cycles', async () => {
    const targetPath = await target();
    const inodes = new Set<number>();
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const gate = await acquirePathMutationGate({ scope: 'store', targetPath });
      inodes.add(statSync(path.join(`/tmp/byok-pm-${process.getuid!()}`, `${gate.identity}.lock`)).ino);
      await gate.release();
    }
    expect(inodes.size).toBe(1);
  });

  it('the module never removes a path', () => {
    const source = readFileSync(GATE_SOURCE, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
    expect(source).not.toMatch(/\b(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/u);
  });

  describe.each(RUNTIMES)('child processes under %s', (_name, runtime) => {
    it.skipIf(runtime === undefined)('16 workers x 200 rounds: no two are ever inside at once', async () => {
      const targetPath = await target();
      const marker = path.join(targetPath, 'inside');
      const workers = Array.from({ length: 16 }, () => run(runtime!, 'stress.mjs', [targetPath, marker, '200']));
      await Promise.all(workers.map(({ child }) => exited(child)));
      const results = workers.map(({ child, output }) => {
        expect(child.exitCode, output()).toBe(0);
        return JSON.parse(output()) as { rounds: number; overlaps: number };
      });
      expect(results.reduce((sum, result) => sum + result.rounds, 0)).toBe(3200);
      expect(results.reduce((sum, result) => sum + result.overlaps, 0)).toBe(0);
    }, 180_000);

    it.skipIf(runtime === undefined)('a SIGKILLed holder with a live grandchild frees the gate at once; then 8 racers: exactly one holds', async () => {
      const targetPath = await target();
      const holder = run(runtime!, 'holder.mjs', [targetPath, 'grandchild', '0']);
      await holder.line('held');
      const grandchild = Number(/grandchild (\d+)/u.exec(holder.output())![1]);
      try {
        holder.child.kill('SIGKILL');
        await exited(holder.child);
        expect(() => process.kill(grandchild, 0)).not.toThrow();
        const next = await settle(acquirePathMutationGate({ scope: 'store', targetPath }, { waitMs: 0 }));
        expect(next).not.toBeInstanceOf(Error);
        await (next as PathMutationGate).release();

        const killed = run(runtime!, 'holder.mjs', [targetPath, 'hold', '0']);
        await killed.line('held');
        killed.child.kill('SIGKILL');
        await exited(killed.child);
        const racers = Array.from({ length: 8 }, () => run(runtime!, 'holder.mjs', [targetPath, 'hold', '0']));
        const outcomes = await Promise.all(racers.map((racer) => outcome(racer)));
        expect(outcomes.filter((outcome) => outcome === 'held')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === 'busy')).toHaveLength(7);
      } finally {
        process.kill(grandchild, 'SIGKILL');
      }
    }, 60_000);

    it.skipIf(runtime === undefined)('a holder whose event loop is blocked for 2 s: 200 contenders are all busy', async () => {
      const targetPath = await target();
      const holder = run(runtime!, 'holder.mjs', [targetPath, 'block', '2000']);
      await holder.line('held');
      const contenders = await Promise.all(Array.from({ length: 200 }, () => settle(acquirePathMutationGate({ scope: 'store', targetPath }, { waitMs: 0 }))));
      expect(holder.output()).not.toContain('unblocked');
      expect(contenders.every((result) => result instanceof PathMutationGateBusyError)).toBe(true);
      await holder.line('unblocked');
      holder.send();
      await holder.line('released');
    }, 60_000);
  });
});

describe.runIf(!supported && process.platform !== 'win32')('path-mutation gate on an unsupported platform', () => {
  it('refuses with a non-busy error', async () => {
    const result = await settle(acquirePathMutationGate({ scope: 'store', targetPath: await target() }));
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(PathMutationGateBusyError);
  });
});
