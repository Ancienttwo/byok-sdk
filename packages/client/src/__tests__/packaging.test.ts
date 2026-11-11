import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copySdkPackagingAssets } from '../adapters/packaging';
import { resolveSdkHosting, SdkHostingAssetsMissingError } from '../sdk-hosting';
import { bundledSdkHelperHost } from '../sdk-reserved-helper-host';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'packaging-')); roots.push(dir); return dir; }
/** resolveSdkHosting as a Host on `platform`-`arch` runs it. */
function hostingOn(platform: string, arch: string, assetRoot: string) {
  const saved = { platform: process.platform, arch: process.arch };
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  try { return resolveSdkHosting({ assetRoot, helperHost: bundledSdkHelperHost() }); } finally {
    Object.defineProperty(process, 'platform', { value: saved.platform });
    Object.defineProperty(process, 'arch', { value: saved.arch });
  }
}
function missingOn(platform: string, arch: string, assetRoot: string): readonly string[] {
  try { hostingOn(platform, arch, assetRoot); } catch (error) {
    if (error instanceof SdkHostingAssetsMissingError && error.code === 'sdk_hosting_assets_missing') return error.missing;
    throw error;
  }
  throw new Error('resolveSdkHosting did not throw');
}

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

  const helperHost = bundledSdkHelperHost();
  expect(hostingOn('linux', 'arm64', outDir)).toEqual({ daemon: { sdkHelperHost: helperHost },
    adapters: { sdkHelperHost: helperHost, runtimes: { pi: { packageDir: path.join(outDir, 'pi') } } } });
  // Every native file the build writes is required: Windows x64 without native/, macOS without the memory helper.
  expect(missingOn('win32', 'x64', outDir)).toEqual(['native/KOFFI-LICENSE.txt', 'native/agent-memory-fs/manifest.json',
    'native/agent-memory-fs/win32-x64.exe', 'native/manifest.json', 'native/win32-x64/koffi.node']);
  expect(missingOn('darwin', 'arm64', outDir)).toEqual(['native/agent-memory-fs/darwin-arm64', 'native/agent-memory-fs/darwin-x64',
    'native/agent-memory-fs/manifest.json']);
  expect(() => hostingOn('win32', 'arm64', outDir)).toThrow('unsupported target win32-arm64');
  await fs.rm(path.join(outDir, 'pi/package.json'));
  expect(missingOn('linux', 'x64', outDir)).toEqual(['pi/package.json']);
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
