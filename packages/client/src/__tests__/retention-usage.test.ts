import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SweepBudget } from '../daemon/retention/registry';
import { measureTree, removeOwnedPath } from '../daemon/retention/usage';
import { testScratchRoot } from './fixtures/execution-scratch';

afterEach(() => vi.restoreAllMocks());
const now = new Date('2026-10-16T00:00:00.000Z');
const release = '2026-10-14T00:00:00.000Z';
function pass(max: number, inspections = Infinity) {
  const report = { deleted: 0, bytesReclaimed: 0, truncated: false };
  const budget: SweepBudget = {
    now, trigger: 'periodic',
    available: () => {
      if (report.deleted < max && inspections-- > 0) return true;
      report.truncated = true; return false;
    },
    remaining: () => max - report.deleted,
    removed: bytes => { report.deleted++; report.bytesReclaimed += bytes; },
    truncate: () => { report.truncated = true; },
  };
  return { report, budget };
}
async function fixture() {
  const root = testScratchRoot(), token = path.join(root, 'a'.repeat(12)), runtime = path.join(token, 'runtime');
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(token, 'released'), release);
  return { root, token, runtime };
}
const exists = (file: string) => fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

it('bounded deletion preserves the marker, resumes without cursor state and accounts actual bytes through completion', async () => {
  const { root, token, runtime } = await fixture();
  const nested = path.join(runtime, 'nested'); await fs.mkdir(nested);
  await fs.writeFile(path.join(runtime, 'output'), '12345');
  await fs.writeFile(path.join(nested, 'output'), '1234567');
  await fs.mkdir(path.join(nested, 'empty'));
  const initial = await measureTree(token, now);
  let bytes = 0, deleted = 0;
  for (let index = 0; index < 8 && await exists(token); index++) {
    const before = await measureTree(token, now), { report, budget } = pass(2);
    expect(await removeOwnedPath(root, token, now, budget)).toBe(report.bytesReclaimed);
    const after = await measureTree(token, now);
    expect(report.bytesReclaimed).toBe(before.bytes - after.bytes);
    expect(report.deleted).toBeGreaterThan(0); expect(report.deleted).toBeLessThanOrEqual(2);
    if (await exists(token)) expect(await fs.readFile(path.join(token, 'released'), 'utf8')).toBe(release);
    bytes += report.bytesReclaimed; deleted += report.deleted;
  }
  expect(await exists(token)).toBe(false);
  expect(bytes).toBe(initial.bytes); expect(deleted).toBe(6); // Two files, three directories, marker-only token.
});

it('exhausted deletion or inspection budgets preserve eligibility without deleting payload', async () => {
  const { root, token, runtime } = await fixture();
  const file = path.join(runtime, 'output'); await fs.writeFile(file, 'payload');
  for (const { report, budget } of [pass(0), pass(256, 1)]) {
    expect(await removeOwnedPath(root, token, now, budget)).toBe(0);
    expect(report).toEqual({ deleted: 0, bytesReclaimed: 0, truncated: true });
    expect(await fs.readFile(file, 'utf8')).toBe('payload');
    expect(await fs.readFile(path.join(token, 'released'), 'utf8')).toBe(release);
  }
});

it('a later unlink failure retains prior byte accounting and the release marker for retry', async () => {
  const { root, token, runtime } = await fixture();
  for (const name of ['one', 'two', 'three']) await fs.writeFile(path.join(runtime, name), '12345');
  const original = fs.unlink; let calls = 0;
  const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
    if (++calls === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return original(file);
  });
  const { report, budget } = pass(256);
  await expect(removeOwnedPath(root, token, now, budget)).rejects.toThrow('busy');
  expect(report).toMatchObject({ deleted: 1, bytesReclaimed: 5 });
  expect(await fs.readdir(runtime)).toHaveLength(2);
  expect(await fs.readFile(path.join(token, 'released'), 'utf8')).toBe(release);
  unlink.mockRestore();
  const retry = pass(256); await removeOwnedPath(root, token, now, retry.budget);
  expect(report.bytesReclaimed + retry.report.bytesReclaimed).toBe(15 + Buffer.byteLength(release));
  expect(await exists(token)).toBe(false);
});

it('refuses whole-token deletion if payload appears after the bounded leaf walk', async () => {
  const { root, token, runtime } = await fixture();
  await fs.writeFile(path.join(runtime, 'output'), '12345');
  const original = fs.rmdir, late = path.join(token, 'late');
  const rmdir = vi.spyOn(fs, 'rmdir').mockImplementation(async directory => {
    await original(directory);
    if (directory === runtime) await fs.writeFile(late, 'new payload');
  });
  const rm = vi.spyOn(fs, 'rm'), { report, budget } = pass(256);
  await expect(removeOwnedPath(root, token, now, budget)).rejects.toThrow('retention_usage_scan_limit');
  expect(rm).not.toHaveBeenCalled(); expect(report).toMatchObject({ deleted: 2, bytesReclaimed: 5 });
  expect(await fs.readFile(late, 'utf8')).toBe('new payload');
  expect(await fs.readFile(path.join(token, 'released'), 'utf8')).toBe(release);
  rmdir.mockRestore();
  const retry = pass(256); await removeOwnedPath(root, token, now, retry.budget);
  expect(retry.report.bytesReclaimed).toBe(Buffer.byteLength('new payload') + Buffer.byteLength(release));
});

it.skipIf(process.platform === 'win32')('unlinks nested symlinks without touching their targets and rejects aliased roots and ancestors', async () => {
  const { root, token, runtime } = await fixture();
  const outside = testScratchRoot(), data = path.join(outside, 'keep'); await fs.writeFile(data, 'protected');
  const link = path.join(runtime, 'link'); await fs.symlink(outside, link);
  const linkBytes = (await fs.lstat(link)).size;
  const alias = path.join(testScratchRoot(), 'alias'); await fs.symlink(root, alias);
  await expect(removeOwnedPath(alias, path.join(alias, path.basename(token)), now, pass(256).budget)).rejects.toThrow('retention_root_identity_invalid');
  const ancestor = path.join(root, 'alias'); await fs.symlink(outside, ancestor);
  await expect(removeOwnedPath(root, path.join(ancestor, 'keep'), now, pass(256).budget)).rejects.toThrow('retention_root_identity_invalid');
  await expect(removeOwnedPath(root, outside, now, pass(256).budget)).rejects.toThrow('retention_path_outside_root');
  await expect(removeOwnedPath(root, root, now, pass(256).budget)).rejects.toThrow('retention_path_outside_root');
  const { report, budget } = pass(256); await removeOwnedPath(root, token, now, budget);
  expect(report.bytesReclaimed).toBe(linkBytes + Buffer.byteLength(release));
  expect(await fs.readFile(data, 'utf8')).toBe('protected');
});
