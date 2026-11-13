import { afterEach, expect, it, vi } from 'vitest';
import { cp, lstat, readFile, rename } from 'node:fs/promises';
import { moveAll, restoreSnapshot } from './stores.ts';

vi.mock('node:fs/promises', () => ({ cp: vi.fn(), lstat: vi.fn(), readFile: vi.fn(), rename: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const moves = [{ from: '/store', to: '/store.aside' }, { from: '/host', to: '/host.aside' }];

it.each(['EACCES', 'EPERM', 'EIO', 'ENOTDIR'])('refuses %s at either source or destination before moving anything', async code => {
  for (const blocked of ['/host', '/host.aside']) {
    vi.mocked(lstat).mockImplementation(async file => {
      if (file === blocked) throw Object.assign(new Error(code), { code });
      if (String(file).endsWith('.aside')) throw missing();
      return {} as Awaited<ReturnType<typeof lstat>>;
    });
    await expect(moveAll(moves)).rejects.toThrow(`Cannot inspect ${blocked}: ${code}`);
    expect(rename).not.toHaveBeenCalled();
  }
});

it('skips only missing sources and moves present sources to missing destinations', async () => {
  vi.mocked(lstat).mockImplementation(async file => {
    if (file !== '/host') throw missing();
    return {} as Awaited<ReturnType<typeof lstat>>;
  });
  await expect(moveAll(moves)).resolves.toEqual([moves[1]]);
  expect(rename).toHaveBeenCalledExactlyOnceWith('/host', '/host.aside');
});

it('refuses an occupied second destination before moving any source', async () => {
  vi.mocked(lstat).mockImplementation(async file => {
    if (file === '/store.aside') throw missing();
    return {} as Awaited<ReturnType<typeof lstat>>;
  });
  await expect(moveAll(moves)).rejects.toThrow('/host.aside already exists');
  expect(rename).not.toHaveBeenCalled();
});

it('refuses an inaccessible restore staging directory before copying or moving stores', async () => {
  vi.mocked(readFile).mockResolvedValue('{"version":"2"}');
  vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(restoreSnapshot({ storeDir: '/store', scratchRoot: { path: '/tmp' }, hostStorageRoot: '/app' }, '2', 's'))
    .rejects.toThrow('Cannot inspect /store.restore-s: denied');
  expect(cp).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
});
