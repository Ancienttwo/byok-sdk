import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureHermesRoot } from '../adapters/hermes/hermes-home';

it('initializes the same Hermes root concurrently within one clock tick', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-root-'));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  try {
    const results = await Promise.allSettled(Array.from({ length: 16 }, () => ensureHermesRoot(root)));
    expect(results.filter(result => result.status === 'rejected')).toEqual([]);
    expect(await fs.readFile(path.join(root, 'config.yaml'), 'utf8')).toContain('updates:\n  check: false\n');
    expect(await fs.readdir(root)).toEqual(['config.yaml']);
  } finally {
    clock.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
