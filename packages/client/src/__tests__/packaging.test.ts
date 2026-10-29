import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copySdkPackagingAssets } from '../adapters/packaging';
import { bundledSdkHelperHost } from '../sdk-reserved-helper-host';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'packaging-')); roots.push(dir); return dir; }

it('ships only the Pi asset root for Linux, where memory needs no helper', async () => {
  const outDir = path.join(await root(), 'ship');
  const assets = await copySdkPackagingAssets({ outDir, platform: 'linux', arch: 'x64' });
  expect(assets.piPackageDir).toBe('pi');
  expect(assets.nativeAssetRoot).toBeUndefined();
  expect(assets.agentMemoryHelperAssetRoot).toBeUndefined();
  expect(assets.files.length).toBeGreaterThan(0);
  expect(assets.files.every(file => file.startsWith('pi/'))).toBe(true);
  expect(assets.files).toContain('pi/package.json');
  expect([...assets.files].sort()).toEqual(assets.files);
});

it('refuses a non-empty directory, a relative directory and an unsupported target', async () => {
  const dir = await root();
  await fs.writeFile(path.join(dir, 'product.js'), '');
  await expect(copySdkPackagingAssets({ outDir: dir, platform: 'linux', arch: 'x64' })).rejects.toThrow('new or empty output directory');
  await expect(copySdkPackagingAssets({ outDir: 'ship', platform: 'linux', arch: 'x64' })).rejects.toThrow('absolute output directory');
  await expect(copySdkPackagingAssets({ outDir: path.join(dir, 'w'), platform: 'win32', arch: 'arm64' })).rejects.toThrow('unsupported target');
});

it('re-enters Node with the running script outside a SEA', () => {
  expect(bundledSdkHelperHost()).toEqual({ mode: 'self-executable', executable: process.execPath, entry: process.argv[1] });
});
