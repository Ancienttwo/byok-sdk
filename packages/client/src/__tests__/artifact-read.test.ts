import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readArtifactBytes } from '../daemon/artifact-read';

describe('legacy artifact fd budget', () => {
  it('rejects sparse over-budget files before opening a read stream', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-artifact-budget-'));
    const handle = await fs.open(path.join(root, 'artifact'), 'w+');
    try {
      await handle.truncate(1024 * 1024 * 1024);
      const stream = vi.spyOn(handle, 'createReadStream');
      await expect(readArtifactBytes(handle, 1024, new AbortController().signal, () => {})).rejects.toThrow('budget');
      expect(stream).not.toHaveBeenCalled();
    } finally { await handle.close(); await fs.rm(root, { recursive: true }); }
  });

  it('counts actual bytes after stat and cancels without reopening the pathname', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-artifact-growth-'));
    const handle = await fs.open(path.join(root, 'artifact'), 'w+');
    try {
      await handle.writeFile(Buffer.alloc(256 * 1024));
      const actual = await handle.stat();
      vi.spyOn(handle, 'stat').mockResolvedValue({ ...actual, size: 1 } as never);
      await expect(readArtifactBytes(handle, 1024, new AbortController().signal, () => {})).rejects.toThrow('budget');
      const abort = new AbortController();
      await expect(readArtifactBytes(handle, 1024 * 1024, abort.signal, () => abort.abort())).rejects.toThrow();
    } finally { await handle.close(); await fs.rm(root, { recursive: true }); }
  });
});
