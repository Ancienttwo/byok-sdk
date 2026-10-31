import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyAgentMemoryHelperAssets, resolveAgentMemoryFilesystemHelper, verifyAgentMemoryFilesystemHelper } from '../util/agent-memory-helper-release';
import { agentMemoryHelperDigest } from '../util/agent-memory-helper-digest';
import { hasAgentMemoryHelperBuild } from './fixtures/agent-memory-helper-build';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function copied() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-relocated-memory-')); roots.push(root);
  const assetRoot = path.join(root, 'assets');
  const files = await copyAgentMemoryHelperAssets({ outDir: assetRoot });
  return { root, assetRoot, files };
}

describe.skipIf(!hasAgentMemoryHelperBuild())('SDK memory helper product assets', () => {
  it('copies the verified SDK release into an empty destination and never overwrites it', async () => {
    const { assetRoot, files } = await copied();
    expect(files).toEqual(['darwin-arm64', 'darwin-x64', 'manifest.json']);
    expect((await fs.readdir(assetRoot)).sort()).toEqual(files);
    const manifest = await fs.readFile(path.join(assetRoot, 'manifest.json'), 'utf8');
    await expect(copyAgentMemoryHelperAssets({ outDir: assetRoot })).rejects.toThrow('new or empty');
    expect(await fs.readFile(path.join(assetRoot, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('copies only the Windows x64 target for platform win32', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-relocated-memory-win32-')); roots.push(root);
    const outDir = path.join(root, 'assets');
    const files = await copyAgentMemoryHelperAssets({ outDir, platform: 'win32' });
    expect(files).toEqual(['manifest.json', 'win32-x64.exe']);
    expect((await fs.readdir(outDir)).sort()).toEqual(files);
    await expect(copyAgentMemoryHelperAssets({ outDir: path.join(root, 'other'), platform: 'linux' as 'win32' })).rejects.toThrow('unsupported platform');
    await expect(fs.stat(path.join(root, 'other'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('cleans a failed copy and allows retry (existing directory: %s)', async existing => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-copy-failure-')); roots.push(root);
    const outDir = path.join(root, 'assets');
    if (existing) await fs.mkdir(outDir);
    const copy = nodeFs.copyFileSync;
    let calls = 0;
    const fault = vi.spyOn(nodeFs, 'copyFileSync').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('injected copy I/O failure');
      return copy(...args);
    });
    await expect(copyAgentMemoryHelperAssets({ outDir })).rejects.toThrow('injected copy I/O failure');
    fault.mockRestore();
    if (existing) expect(await fs.readdir(outDir)).toEqual([]);
    else await expect(fs.stat(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(copyAgentMemoryHelperAssets({ outDir })).resolves.toHaveLength(3);
  });

  it.skipIf(process.platform !== 'darwin')('rejects changed code even with a self-consistent caller manifest', async () => {
    const { assetRoot } = await copied();
    const bin = resolveAgentMemoryFilesystemHelper(assetRoot);
    const bytes = await fs.readFile(bin); bytes[16384] = bytes[16384]! ^ 1;
    await fs.writeFile(bin, bytes);
    const manifestPath = path.join(assetRoot, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.entries[`darwin-${process.arch}`].digest = agentMemoryHelperDigest(bytes, process.arch);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    expect(() => resolveAgentMemoryFilesystemHelper(assetRoot)).toThrow('target mismatch');
  });

  it.skipIf(process.platform !== 'darwin')('rejects assets declaring another source build', async () => {
    const { assetRoot } = await copied();
    const file = path.join(assetRoot, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    manifest.sourceDigest = 'a'.repeat(64);
    await fs.writeFile(file, JSON.stringify(manifest));
    expect(() => resolveAgentMemoryFilesystemHelper(assetRoot)).toThrow('manifest mismatch');
  });

  it.skipIf(process.platform !== 'darwin')('revalidates relocated bytes and targets on every open resolution', async () => {
    const { assetRoot } = await copied();
    const bin = resolveAgentMemoryFilesystemHelper(assetRoot);
    expect(verifyAgentMemoryFilesystemHelper(bin, assetRoot)).toBe(bin);
    expect(() => verifyAgentMemoryFilesystemHelper('/bin/sh', assetRoot)).toThrow('SDK release artifact');
    const manifestPath = path.join(assetRoot, 'manifest.json');
    const originalManifest = await fs.readFile(manifestPath, 'utf8');
    await fs.writeFile(manifestPath, '{');
    expect(() => resolveAgentMemoryFilesystemHelper(assetRoot)).toThrow();
    await fs.writeFile(manifestPath, originalManifest);
    const manifest = JSON.parse(originalManifest);
    const key = `darwin-${process.arch}`;
    manifest.entries[key].file = '../other';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    expect(() => resolveAgentMemoryFilesystemHelper(assetRoot)).toThrow('target mismatch');
    manifest.entries[key].file = key;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const bytes = await fs.readFile(bin); bytes[16384] = bytes[16384]! ^ 1;
    await fs.writeFile(bin, bytes);
    expect(() => verifyAgentMemoryFilesystemHelper(bin, assetRoot)).toThrow('digest mismatch');
  });

  it.skipIf(process.platform !== 'darwin')('runs recall/save from an isolated single-file bundle after product re-signing', async () => {
    const { root, assetRoot } = await copied();
    const bin = resolveAgentMemoryFilesystemHelper(assetRoot);
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'test.byok.relocated', '--options', 'runtime', bin]);
    execFileSync('codesign', ['--verify', '--strict', bin]);
    expect(resolveAgentMemoryFilesystemHelper(assetRoot)).toBe(bin);
    const outfile = path.join(root, 'product.mjs');
    const fixture = fileURLToPath(new URL('./fixtures/agent-memory-relocated-bundle.ts', import.meta.url));
    buildSync({ entryPoints: [fixture], outfile, bundle: true, platform: 'node', format: 'esm' });
    const result = JSON.parse(execFileSync(process.execPath, [outfile, assetRoot, root], { cwd: root, env: { PATH: process.env.PATH! }, encoding: 'utf8' }));
    expect(result).toMatchObject({ path: 'MEMORY.md', content: 'relocated SDK helper' });
    const changed = await fs.readFile(bin); changed[16384] = changed[16384]! ^ 1;
    await fs.writeFile(bin, changed);
    expect(() => execFileSync(process.execPath, [outfile, assetRoot, root], { cwd: root, encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});

it('does not admit relative or missing explicitly configured asset roots', () => {
  expect(() => resolveAgentMemoryFilesystemHelper('relative-assets')).toThrow();
  expect(() => resolveAgentMemoryFilesystemHelper('/missing-byok-memory-release')).toThrow();
});
