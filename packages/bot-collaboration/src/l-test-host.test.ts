import * as fs from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { openLTestHost } from './l-test-host.test-support';

vi.mock('node:fs/promises', async original => ({
  ...await original<typeof fs>(),
  mkdtemp: vi.fn().mockRejectedValue(new Error('fixture setup reached')),
}));

it('rejects missing device credentials before fixture setup', async () => {
  // @ts-expect-error JavaScript callers can omit the required backend.
  await expect(openLTestHost({ consume: async () => {} })).rejects.toThrow(new TypeError('openLTestHost requires deviceCredentials'));
  expect(fs.mkdtemp).not.toHaveBeenCalled();
});
