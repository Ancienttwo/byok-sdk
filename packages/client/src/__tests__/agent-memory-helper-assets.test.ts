import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { copyAgentMemoryHelperAssets, resolveAgentMemoryFilesystemHelper, verifyAgentMemoryFilesystemHelper } from '../daemon/agent-memory-helper-release';
import { hasAgentMemoryHelperBuild } from './fixtures/agent-memory-helper-build';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
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
    execFileSync('bun', ['build', fixture, '--target=node', '--format=esm', `--outfile=${outfile}`]);
    const result = JSON.parse(execFileSync(process.execPath, [outfile, assetRoot, root], { cwd: root, env: { PATH: process.env.PATH! }, encoding: 'utf8' }));
    expect(result).toMatchObject({ path: 'MEMORY.md', content: 'relocated SDK helper' });
    await fs.unlink(path.join(assetRoot, 'manifest.json'));
    expect(() => execFileSync(process.execPath, [outfile, assetRoot, root], { cwd: root, encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});

it('does not admit relative or missing explicitly configured asset roots', () => {
  expect(() => resolveAgentMemoryFilesystemHelper('relative-assets')).toThrow();
  expect(() => resolveAgentMemoryFilesystemHelper('/missing-byok-memory-release')).toThrow();
});
