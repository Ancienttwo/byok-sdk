import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import { TODO_LOCALE_ASSET_PATHS, verifyTodoLocaleAssets } from '../adapters/pi/todo-locale-assets';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(attested: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'todo-locales-')); roots.push(root);
  cpSync(path.resolve(import.meta.dirname, '../../dist/assets'), root, { recursive: true });
  const manifestPath = path.join(root, 'extensions/rpiv-todo/2.8.0/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // This unit exercises the post-binding asset stage; physical binding/reverify
  // remains covered by the real runtime-host/S2 tests, not this minimal object.
  const binding = { identity: attested ? { kind: 'attested', assetRoot: root, assets: manifest.assets }
    : { kind: 'unavailable', reason: 'resolver_unconfigured' }, envCommitments: { PI_PACKAGE_DIR: root } } as unknown as ImplementationSpawnBindingV1;
  return { root, binding, manifest, manifestPath };
}
describe('todo locale preverification', () => {
  it.each([false, true])('verifies all nine assets, attested=%s', attested => {
    const f = fixture(attested); const resolver = vi.fn(() => f.root);
    expect(verifyTodoLocaleAssets(f.binding, resolver)).toMatch(/extensions\/rpiv-todo\/2.8.0\/$/);
    expect(resolver).toHaveBeenCalledTimes(attested ? 0 : 1);
  });
  it.each([false, true])('rejects every missing or byte-mutated locale, attested=%s', attested => {
    const f = fixture(attested);
    for (const relative of TODO_LOCALE_ASSET_PATHS) {
      const file = path.join(f.root, relative); const original = readFileSync(file);
      unlinkSync(file); expect(() => verifyTodoLocaleAssets(f.binding, () => f.root)).toThrow();
      writeFileSync(file, Buffer.concat([original, Buffer.from(' ')]));
      expect(() => verifyTodoLocaleAssets(f.binding, () => f.root)).toThrow('todo_locale_asset_digest_mismatch');
      writeFileSync(file, original);
    }
  });
  it('refuses missing attested declaration without touching the unconfigured root', () => {
    const f = fixture(true); f.manifest.assets.pop();
    const resolve = vi.fn(() => { throw new Error('must never run'); });
    expect(() => verifyTodoLocaleAssets(f.binding, resolve)).toThrow('todo_locale_asset_undeclared');
    expect(resolve).not.toHaveBeenCalled();
  });
  it('rejects malformed, incomplete and reordered shipped digest manifests', () => {
    const f = fixture(false);
    for (const manifest of [{ ...f.manifest, version: 2 }, { ...f.manifest, extra: true },
      { ...f.manifest, assets: f.manifest.assets.slice(1) }, { ...f.manifest, assets: [...f.manifest.assets].reverse() }]) {
      writeFileSync(f.manifestPath, JSON.stringify(manifest));
      expect(() => verifyTodoLocaleAssets(f.binding, () => f.root)).toThrow('todo_locale_manifest_invalid');
    }
  });
  it('refuses invalid locale data even if its declared hash matches', () => {
    const f = fixture(true); const relative = TODO_LOCALE_ASSET_PATHS[0]!;
    writeFileSync(path.join(f.root, relative), '[]');
    f.manifest.assets[0].digest = createHash('sha256').update('[]').digest('hex');
    expect(() => verifyTodoLocaleAssets(f.binding, () => f.root)).toThrow('todo_locale_asset_invalid');
  });
});
