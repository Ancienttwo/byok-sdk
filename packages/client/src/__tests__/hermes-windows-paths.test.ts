import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// The Windows process-table read runs PowerShell through `execFile`; these tests answer for it.
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile }));

const { mayStopForeignHermesGateway } = await import('../adapters/hermes/gateway-ownership');
const { sweepStaleHermesProfiles } = await import('../adapters/hermes/hermes-home');

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
    // Like execFile: an abort kills the child and fails the call.
    options.signal?.addEventListener('abort', () => { aborted.push(true); callback(new Error('aborted'), ''); }, { once: true });
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
