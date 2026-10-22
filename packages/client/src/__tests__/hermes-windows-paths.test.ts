import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecutionScratch } from '../daemon/retention/scratch';
import type { HermesSessionDependencies } from '../adapters/hermes/hermes-session-runtime';

// The Windows process-table read runs PowerShell through `execFile`; these tests answer for it.
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile }));

const { mayStopForeignHermesGateway, ownsHermesGatewayPid } = await import('../adapters/hermes/gateway-ownership');
const { sweepStaleHermesProfiles } = await import('../adapters/hermes/hermes-home');
const { servesHermesHome } = await import('../adapters/hermes/gateway-identity');
const { createHermesSession } = await import('../adapters/hermes/hermes-session-runtime');
const { RuntimeExecutionFailure, isRuntimeExecutionFailure } = await import('../runtime-failure');

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const systemRoot = process.env.SystemRoot;
const dirs: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
  execFile.mockReset();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
/** Run the Windows branches on any host. */
function asWindows(): void {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env.SystemRoot = 'C:\\Windows';
}

it('ends the PowerShell read when the foreign-gateway deadline passes, and does not stop the gateway', async () => {
  asWindows();
  const aborted: boolean[] = [];
  execFile.mockImplementation((_command, _args, options: { signal?: AbortSignal }, callback) => {
    // Like execFile: an abort, also one before the call, kills the child and fails the call.
    const abort = () => { aborted.push(true); callback(new Error('aborted'), ''); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  });
  const started = Date.now();
  expect(await mayStopForeignHermesGateway({ pid: 300, state: 'ready', servedHomes: [] }, 'C:\\root\\profiles\\byok-a', 100, AbortSignal.timeout(50))).toBe(false);
  expect(aborted).toEqual([true]);
  expect(Date.now() - started).toBeLessThan(5_000);
});

it('keeps a stale profile when the Windows pipe client fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bhw-'));
  dirs.push(root);
  const home = path.join(root, 'profiles', 'byok-stale');
  await fs.mkdir(home, { recursive: true });
  asWindows();
  // A native asset root without the koffi asset: the pipe client cannot load.
  await sweepStaleHermesProfiles(root, new Set(), Date.now() + 60 * 60_000, path.join(root, 'no-native-assets'));
  expect((await fs.stat(home)).isDirectory()).toBe(true);
});

/** A PowerShell read that answers only an abort. Returns the signals it got. */
function hangingProcessTableRead(): AbortSignal[] {
  const signals: AbortSignal[] = [];
  execFile.mockImplementation((_command, _args, options: { signal?: AbortSignal }, callback) => {
    if (options.signal === undefined) return;
    signals.push(options.signal);
    options.signal.addEventListener('abort', () => callback(new Error('aborted'), ''), { once: true });
  });
  return signals;
}

/** A session whose gateway answers at once, under a pid that the ownership check has not judged yet. */
async function readyWait() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bhr-')));
  dirs.push(home);
  const session = createHermesSession({} as ExecutionScratch, home, new Set(), 1_000, {
    RuntimeExecutionFailure, isRuntimeExecutionFailure, servesHermesHome, ownsHermesGatewayPid,
    infrastructure: (phase, reason, retry = 'non-retryable') => new RuntimeExecutionFailure({ phase, category: 'infrastructure', retry, reason }),
    identifyHermesGateway: async () => ({ pid: 300, state: 'ready', servedHomes: [home] }),
  } as Partial<HermesSessionDependencies> as HermesSessionDependencies);
  return { home, session };
}

it('ends the ownership read when the gateway ready deadline passes', async () => {
  asWindows();
  const signals = hangingProcessTableRead();
  const { home, session } = await readyWait();
  await expect(session.awaitGatewayReady(home, 100, 200, undefined)).rejects.toThrow(/did not report ready in time/);
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  expect(signals[0]!.aborted).toBe(true);
});

it('ends the ownership read when the start is aborted', async () => {
  asWindows();
  const signals = hangingProcessTableRead();
  const { home, session } = await readyWait();
  const start = new AbortController();
  const waiting = session.awaitGatewayReady(home, 100, 60_000, start.signal);
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  expect(signals[0]!.aborted).toBe(false);
  start.abort();
  await expect(waiting).rejects.toThrow(/aborted/);
  expect(signals[0]!.aborted).toBe(true);
});
