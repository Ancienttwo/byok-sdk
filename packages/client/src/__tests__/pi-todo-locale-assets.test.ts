import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PiBundledAssetsError, TODO_LOCALE_ASSET_PATHS, bundledAssetRoot, locateBundledPiAssets, verifyTodoLocaleAssets } from '../adapters/pi/todo-locale-assets';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'todo-locales-')); roots.push(root);
  cpSync(path.resolve(import.meta.dirname, '../../dist/assets'), root, { recursive: true });
  const manifestPath = path.join(root, 'extensions/rpiv-todo/2.8.0/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return { root, manifest, manifestPath };
}
describe('todo locale preverification', () => {
  it('verifies all nine assets', () => {
    const f = fixture(); const resolver = vi.fn(() => f.root);
    expect(verifyTodoLocaleAssets(resolver)).toMatch(/extensions\/rpiv-todo\/2.8.0\/$/);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
  it('reads a single-file product asset root from PI_PACKAGE_DIR, else beside a compiled executable', () => {
    const f = fixture();
    vi.stubEnv('PI_PACKAGE_DIR', f.root);
    expect(bundledAssetRoot()).toBe(f.root);
    expect(verifyTodoLocaleAssets(bundledAssetRoot)).toMatch(/extensions\/rpiv-todo\/2.8.0\/$/);
    expect(locateBundledPiAssets({ piPackageDir: undefined, executable: path.join(f.root, 'product') })).toBe(f.root);
  });

  it('refuses a missing or manifest-less product asset root with a typed error, not ENOENT', () => {
    const f = fixture();
    const empty = mkdtempSync(path.join(tmpdir(), 'todo-locales-empty-')); roots.push(empty);
    const refusal = (input: Parameters<typeof locateBundledPiAssets>[0]) => {
      try { locateBundledPiAssets(input); } catch (error) { return error; }
      throw new Error('expected a refusal');
    };
    const bundleUnset = refusal({ piPackageDir: undefined, executable: path.join(f.root, 'bun'), entry: '/product/sdk.js' });
    expect(bundleUnset).toBeInstanceOf(PiBundledAssetsError);
    expect((bundleUnset as Error).message).toMatch(/interpreter \+ bundle product must set PI_PACKAGE_DIR/);
    expect(refusal({ piPackageDir: empty, executable: process.execPath })).toMatchObject({ code: 'pi_bundled_assets_unavailable', message: expect.stringMatching(/PI_PACKAGE_DIR holds no SDK Pi asset manifest/) });
    expect(refusal({ piPackageDir: '', executable: path.join(empty, 'product') })).toMatchObject({ message: expect.stringMatching(/beside the executable; set PI_PACKAGE_DIR/) });
    vi.stubEnv('PI_PACKAGE_DIR', empty);
    expect(() => bundledAssetRoot()).toThrow(PiBundledAssetsError);
  });
  it('rejects every missing or byte-mutated locale', () => {
    const f = fixture();
    for (const relative of TODO_LOCALE_ASSET_PATHS) {
      const file = path.join(f.root, relative); const original = readFileSync(file);
      unlinkSync(file); expect(() => verifyTodoLocaleAssets(() => f.root)).toThrow();
      writeFileSync(file, Buffer.concat([original, Buffer.from(' ')]));
      expect(() => verifyTodoLocaleAssets(() => f.root)).toThrow('todo_locale_asset_digest_mismatch');
      writeFileSync(file, original);
    }
  });
  it('rejects malformed, incomplete and reordered shipped digest manifests', () => {
    const f = fixture();
    for (const manifest of [{ ...f.manifest, version: 2 }, { ...f.manifest, extra: true },
      { ...f.manifest, assets: f.manifest.assets.slice(1) }, { ...f.manifest, assets: [...f.manifest.assets].reverse() }]) {
      writeFileSync(f.manifestPath, JSON.stringify(manifest));
      expect(() => verifyTodoLocaleAssets(() => f.root)).toThrow('todo_locale_manifest_invalid');
    }
  });
  it('refuses invalid locale data even if its declared hash matches', () => {
    const f = fixture(); const relative = TODO_LOCALE_ASSET_PATHS[0]!;
    writeFileSync(path.join(f.root, relative), '[]');
    f.manifest.assets[0].digest = createHash('sha256').update('[]').digest('hex');
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    expect(() => verifyTodoLocaleAssets(() => f.root)).toThrow('todo_locale_asset_invalid');
  });
});
