import { afterEach, expect, it, vi } from 'vitest';
import { lstat, rename } from 'node:fs/promises';
import { moveAll } from './stores.ts';

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), rename: vi.fn() }));
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

it('refuses an occupied destination before moving any source', async () => {
  vi.mocked(lstat).mockResolvedValue({} as Awaited<ReturnType<typeof lstat>>);
  await expect(moveAll(moves)).rejects.toThrow('/store.aside already exists');
  expect(rename).not.toHaveBeenCalled();
});

it('rolls back earlier moves if a rename fails after inspection', async () => {
  vi.mocked(lstat).mockImplementation(async file => {
    if (String(file).endsWith('.aside')) throw missing();
    return {} as Awaited<ReturnType<typeof lstat>>;
  });
  vi.mocked(rename).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('rename denied'));
  await expect(moveAll(moves)).rejects.toThrow('rename denied');
  expect(vi.mocked(rename).mock.calls).toEqual([
    ['/store', '/store.aside'], ['/host', '/host.aside'], ['/store.aside', '/store'],
  ]);
});
