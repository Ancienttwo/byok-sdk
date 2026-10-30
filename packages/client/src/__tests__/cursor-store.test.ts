import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorStore, CursorUnreadableError } from '../daemon/cursor-store';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * `CursorStore.save` now goes through `atomicWriteFile` (see
 * `util/atomic-write.ts`) instead of a plain `fs.writeFile`, so a `load()`
 * racing an in-flight `save()` never observes a torn/partial file. These
 * tests exercise `CursorStore`'s own public API — the atomic-write
 * mechanics themselves are covered directly in `atomic-write.test.ts`.
 */
describe('CursorStore (atomic write path)', () => {
  let storeDir: string;

  afterEach(async () => {
    if (storeDir) await fs.rm(storeDir, { recursive: true, force: true });
  });

  it('round-trips a cursor value through save()/load()', async () => {
    storeDir = await tmpDir('byok-cursor-store-');
    const store = new CursorStore(storeDir);

    expect(await store.load('https://example.test', 'device-1')).toBeUndefined();

    await store.save('https://example.test', 'device-1', 42);
    expect(await store.load('https://example.test', 'device-1')).toBe(42);

    // A later save() overwrites (through the same atomic path) rather than
    // merging or appending.
    await store.save('https://example.test', 'device-1', 43);
    expect(await store.load('https://example.test', 'device-1')).toBe(43);
  });

  it('keeps distinct (serverUrl, deviceId) pairs independent, each round-tripping its own cursor', async () => {
    storeDir = await tmpDir('byok-cursor-store-');
    const store = new CursorStore(storeDir);

    await store.save('https://a.test', 'device-a', 1);
    await store.save('https://b.test', 'device-b', 2);

    expect(await store.load('https://a.test', 'device-a')).toBe(1);
    expect(await store.load('https://b.test', 'device-b')).toBe(2);
  });

  it('leaves no leftover atomic-write temp file behind after save()', async () => {
    storeDir = await tmpDir('byok-cursor-store-');
    const store = new CursorStore(storeDir);

    await store.save('https://example.test', 'device-1', 7);

    const entries = await fs.readdir(storeDir);
    expect(entries.every((name) => !name.endsWith('.tmp'))).toBe(true);
  });

  it('clear() removes the persisted cursor so a subsequent load() sees undefined again', async () => {
    storeDir = await tmpDir('byok-cursor-store-');
    const store = new CursorStore(storeDir);

    await store.save('https://example.test', 'device-1', 5);
    expect(await store.load('https://example.test', 'device-1')).toBe(5);

    await store.clear('https://example.test', 'device-1');
    expect(await store.load('https://example.test', 'device-1')).toBeUndefined();
  });
});

/** #1121: a damaged cursor file is never read as "no cursor". */
describe('CursorStore refuses an unreadable cursor file', () => {
  let storeDir: string;

  afterEach(async () => {
    if (storeDir) await fs.rm(storeDir, { recursive: true, force: true });
  });

  async function corrupt(contents: string): Promise<CursorStore> {
    storeDir = await tmpDir('byok-cursor-corrupt-');
    const store = new CursorStore(storeDir);
    await store.save('https://example.test', 'device-1', 9);
    const [file] = await fs.readdir(storeDir);
    await fs.writeFile(path.join(storeDir, file!), contents);
    return store;
  }

  it.each([
    ['torn JSON', '{"cursor":'],
    ['empty file', ''],
    ['negative cursor', '{"cursor":-1}'],
    ['fractional cursor', '{"cursor":1.5}'],
    ['string cursor', '{"cursor":"9"}'],
    ['missing cursor', '{}'],
    ['non-object', '9'],
  ])('throws CursorUnreadableError for %s', async (_label, contents) => {
    const store = await corrupt(contents);
    await expect(store.load('https://example.test', 'device-1')).rejects.toBeInstanceOf(CursorUnreadableError);
  });

  it('throws CursorUnreadableError when the cursor path cannot be read as a file', async () => {
    storeDir = await tmpDir('byok-cursor-corrupt-');
    const store = new CursorStore(storeDir);
    await store.save('https://example.test', 'device-1', 9);
    const [file] = await fs.readdir(storeDir);
    await fs.rm(path.join(storeDir, file!));
    await fs.mkdir(path.join(storeDir, file!));
    await expect(store.load('https://example.test', 'device-1')).rejects.toBeInstanceOf(CursorUnreadableError);
  });
});
