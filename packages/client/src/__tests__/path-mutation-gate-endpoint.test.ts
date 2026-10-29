import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquirePathMutationGate, type PathMutationGate } from '../util/path-mutation-gate';
import { resolveBunBin } from './support/test-bun-bin';

/**
 * #1149 review: no path unlink may remove another holder's gate endpoint.
 * Each acquisition binds its own server, so two acquisitions in this process
 * contend exactly as two processes do. The barriers pause `fs.rm` of the
 * endpoint path, the only point where the gate unlinks by path.
 */
const posix = process.platform !== 'win32';

/** A pause the test opens: `wait()` marks it reached, then blocks until `open()`. */
function barrier() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const hit = new Promise<void>((resolve) => { reached = resolve; });
  return { open, hit, async wait() { reached(); await opened; } };
}

/** Pauses the next `count` `fs.rm` calls on `endpoint` at their own barrier, in call order. */
function pauseEndpointRm(endpoint: string, count: number): Array<ReturnType<typeof barrier>> {
  const barriers = Array.from({ length: count }, () => barrier());
  const rm = nodeFs.rm;
  let next = 0;
  vi.spyOn(nodeFs, 'rm').mockImplementation(async (file, options) => {
    if (String(file) === endpoint && next < barriers.length) await barriers[next++]!.wait();
    return rm(file, options);
  });
  return barriers;
}

async function settle(promise: Promise<PathMutationGate>): Promise<PathMutationGate | Error> {
  return promise.catch((error: unknown) => error as Error);
}

const held: PathMutationGate[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(held.splice(0).map((gate) => gate.release()));
  await Promise.all(dirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })));
});

async function target(): Promise<{ input: { scope: 'store'; targetPath: string }; endpoint: string }> {
  const dir = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'byok-gate-ep-'));
  dirs.push(dir);
  const input = { scope: 'store' as const, targetPath: dir };
  const probe = await acquirePathMutationGate(input);
  await probe.release();
  return { input, endpoint: path.join(`/tmp/byok-pm-${process.getuid!()}`, `${probe.identity}.sock`) };
}

function keep(result: PathMutationGate | Error): PathMutationGate | Error {
  if (!(result instanceof Error)) held.push(result);
  return result;
}

const BUN = resolveBunBin();
const GATE_MODULE = new URL('../util/path-mutation-gate.ts', import.meta.url).href;

/**
 * A separate process running the gate from source under Bun. It acquires the
 * gate for `targetPath`, prints `held` (or `busy`), and with `pauseRelease`
 * releases on its first stdin line with its endpoint rm paused until a second
 * line, printing `paused` there and `released` after.
 */
function gateProcess(targetPath: string, endpoint: string, pauseRelease: boolean): { child: ChildProcess; line: (text: string) => Promise<void>; send: () => void } {
  const source = `
    const fs = (await import('node:fs')).promises;
    const lines = [];
    let wake;
    process.stdin.on('data', (chunk) => { for (const _ of String(chunk).split('\\n').slice(0, -1)) lines.push(1); wake?.(); });
    const nextLine = async () => { while (lines.length === 0) await new Promise((resolve) => { wake = resolve; }); lines.shift(); };
    const rm = fs.rm;
    fs.rm = async (file, options) => {
      if (${pauseRelease} && String(file) === ${JSON.stringify(endpoint)}) { process.stdout.write('paused\\n'); await nextLine(); }
      return rm(file, options);
    };
    const { acquirePathMutationGate } = await import(${JSON.stringify(GATE_MODULE)});
    let gate;
    try { gate = await acquirePathMutationGate({ scope: 'store', targetPath: ${JSON.stringify(targetPath)} }); }
    catch (error) { process.stdout.write(error.name === 'PathMutationGateBusyError' ? 'busy\\n' : 'error ' + error.message + '\\n'); process.exit(0); }
    process.stdout.write('held\\n');
    await nextLine();
    await gate.release();
    process.stdout.write('released\\n');
    process.exit(0);
  `;
  const child = spawn(BUN!, ['-e', source], { stdio: ['pipe', 'pipe', 'inherit'] });
  let stdout = '';
  const waiters: Array<() => void> = [];
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); waiters.splice(0).forEach((check) => check()); });
  const line = (text: string) => new Promise<void>((resolve, reject) => {
    const check = () => { if (stdout.includes(`${text}\n`)) resolve(); else if (child.exitCode !== null) reject(new Error(`gate process exited before "${text}": ${stdout}`)); else waiters.push(check); };
    child.once('exit', () => check());
    check();
  });
  return { child, line, send: () => child.stdin!.write('next\n') };
}

describe.runIf(posix)('path-mutation gate endpoint ownership (#1149)', () => {
  it('a releaser paused before its endpoint rm cannot remove the next holder\'s endpoint', async () => {
    const { input, endpoint } = await target();
    const first = await acquirePathMutationGate(input);
    const [pause] = pauseEndpointRm(endpoint, 1);
    const releasing = first.release();
    await pause!.hit;
    const second = keep(await settle(acquirePathMutationGate(input)));
    expect(second).not.toBeInstanceOf(Error);
    pause!.open();
    await releasing;
    // `second` still holds the gate, so a third acquisition must be refused.
    const third = keep(await settle(acquirePathMutationGate(input)));
    expect(third).toBeInstanceOf(Error);
    expect((third as Error).name).toBe('PathMutationGateBusyError');
  });

  it.skipIf(BUN === undefined)('across three OS processes: a releaser paused before its endpoint rm cannot let a third process in beside the next holder', async () => {
    const { input, endpoint } = await target();
    const first = gateProcess(input.targetPath, endpoint, true);
    const children = [first.child];
    try {
      await first.line('held');
      first.send();
      await first.line('paused');
      const second = gateProcess(input.targetPath, endpoint, false);
      children.push(second.child);
      await second.line('held');
      first.send();
      await first.line('released');
      // The second process still holds the gate, so a third must be refused.
      const third = gateProcess(input.targetPath, endpoint, false);
      children.push(third.child);
      const outcome = await Promise.race([third.line('held').then(() => 'held'), third.line('busy').then(() => 'busy')]);
      expect(outcome).toBe('busy');
    } finally {
      for (const child of children) child.kill('SIGKILL');
    }
  });

  it('two acquirers that both proved a crashed holder\'s endpoint unbound: exactly one holds the gate', async () => {
    const { input, endpoint } = await target();
    // A crashed holder: a process that bound the endpoint and was killed, leaving the socket file.
    const crash = spawnSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(endpoint)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    expect(crash.signal).toBe('SIGKILL');
    expect((await nodeFs.lstat(endpoint)).isSocket()).toBe(true);
    const [firstRm, secondRm] = pauseEndpointRm(endpoint, 2);
    const acquirers = [settle(acquirePathMutationGate(input)), settle(acquirePathMutationGate(input))];
    await firstRm!.hit;
    await secondRm!.hit;
    // Both have proved the leftover unbound and wait at their rm; the first to reach it binds first.
    firstRm!.open();
    const winner = keep(await Promise.race(acquirers));
    expect(winner).not.toBeInstanceOf(Error);
    secondRm!.open();
    const [first, second] = await Promise.all(acquirers);
    const other = keep(first === winner ? second! : first!);
    expect(other).toBeInstanceOf(Error);
    expect((other as Error).name).toBe('PathMutationGateBusyError');
  });
});
