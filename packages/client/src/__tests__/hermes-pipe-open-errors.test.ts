import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// A kernel32 stand-in: every pipe open fails with the error the test sets.
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_PIPE_BUSY = 231;
const kernel = vi.hoisted(() => ({ lastError: 0, opens: 0 }));
vi.mock('koffi', () => ({
  default: {
    load: () => ({
      func: (_convention: string, name: string) => (): number => {
        if (name === 'CreateFileW') { kernel.opens += 1; return -1; }
        if (name === 'GetLastError') return kernel.lastError;
        throw new Error(`unexpected kernel32 call ${name}`);
      },
    }),
    out: (type: unknown) => type,
    pointer: (type: unknown) => type,
  },
}));

const { exchangeHermesPipe } = await import('../adapters/hermes/gateway-pipe-win32');
const { sweepStaleHermesProfiles } = await import('../adapters/hermes/hermes-home');
const koffi = (await import('koffi')).default;

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const dirs: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  kernel.opens = 0;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function staleProfile(): Promise<{ root: string; home: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bhp-'));
  dirs.push(root);
  const home = path.join(root, 'profiles', 'byok-stale');
  await fs.mkdir(home, { recursive: true });
  return { root, home };
}

it('reports no gateway only when no pipe has the name', async () => {
  kernel.lastError = ERROR_FILE_NOT_FOUND;
  await expect(exchangeHermesPipe('\\\\.\\pipe\\hermes-gateway-0', 'x\n', () => true, Date.now() + 1_000, koffi)).resolves.toBeUndefined();
  for (const error of [ERROR_PIPE_BUSY, ERROR_ACCESS_DENIED]) {
    kernel.lastError = error;
    await expect(exchangeHermesPipe('\\\\.\\pipe\\hermes-gateway-0', 'x\n', () => true, Date.now() + 1_000, koffi)).rejects.toThrow(/could not be opened/);
  }
});

it.each([['busy', ERROR_PIPE_BUSY], ['access-denied', ERROR_ACCESS_DENIED]])('keeps a stale profile whose gateway pipe is %s', async (_name, error) => {
  const { root, home } = await staleProfile();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  kernel.lastError = error;
  await sweepStaleHermesProfiles(root, new Set(), Date.now() + 60 * 60_000);
  expect(kernel.opens).toBe(1);
  expect((await fs.stat(home)).isDirectory()).toBe(true);
});

it('deletes a stale profile whose gateway pipe does not exist', async () => {
  const { root, home } = await staleProfile();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  kernel.lastError = ERROR_FILE_NOT_FOUND;
  await sweepStaleHermesProfiles(root, new Set(), Date.now() + 60 * 60_000);
  expect(kernel.opens).toBe(1);
  await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
});
