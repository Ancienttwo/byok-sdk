/** Client-owned lazy boundaries. Dependency policies live in entries.json. */
import { parse, type Node } from 'acorn';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = path.join(PACKAGE_ROOT, 'dist');

function staticImports(source: string): string[] {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.flatMap(statement => {
    const node = statement as Node & { source?: { value?: unknown } };
    return node.source && typeof node.source.value === 'string' ? [node.source.value] : [];
  });
}

describe('client build and private lazy entry boundaries', () => {
  it('keeps splitting false and requires the built dist', () => {
    const config = readFileSync(path.join(PACKAGE_ROOT, 'tsup.config.ts'), 'utf8');
    expect(config).toMatch(/\bsplitting\s*:\s*false\b/);
    expect(config).not.toMatch(/\bsplitting\s*:\s*true\b/);
    expect(existsSync(path.join(DIST, 'index.js'))).toBe(true);
  });

  it('resolves the private Pi host to shipped dist and retains lazy loading', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(manifest.imports['#byok-pi-runtime-host']).toEqual({
      types: './dist/bin/pi-runtime-host.d.ts', default: './dist/bin/pi-runtime-host.js',
    });
    expect(manifest.files).toContain('dist');
    for (const target of Object.values(manifest.imports['#byok-pi-runtime-host']) as string[]) {
      const resolved = path.resolve(PACKAGE_ROOT, target);
      expect(resolved.startsWith(DIST + path.sep)).toBe(true);
      expect(existsSync(resolved)).toBe(true);
    }
    const root = readFileSync(path.join(DIST, 'index.js'), 'utf8');
    expect(staticImports(root).filter(name => name.includes('@earendil-works/'))).toEqual([]);
    expect(root).toMatch(/import\(["']#byok-pi-runtime-host["']\)/);
  });

  it('keeps todo initialization behind its sole private literal lazy entry', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(manifest.imports['#byok-pi-todo-runtime']).toEqual({
      types: './dist/bin/pi-todo-runtime.d.ts', default: './dist/bin/pi-todo-runtime.js',
    });
    expect(manifest.files).toContain('dist');
    expect(existsSync(path.join(DIST, 'bin/pi-todo-runtime.d.ts'))).toBe(true);
    const host = readFileSync(path.join(DIST, 'bin/pi-runtime-host.js'), 'utf8');
    const root = readFileSync(path.join(DIST, 'index.js'), 'utf8');
    for (const source of [host, root]) {
      expect(staticImports(source).filter(name => /pi-todo-runtime|rpiv-todo|rpiv-i18n/.test(name))).toEqual([]);
      expect(source).not.toContain('rpiv-i18n.runtime');
    }
    expect(host.match(/import\(["']#byok-pi-todo-runtime["']\)/g)).toHaveLength(1);
    const todo = readFileSync(path.join(DIST, 'bin/pi-todo-runtime.js'), 'utf8');
    expect(todo).toContain('rpiv-i18n.runtime');
    expect(todo).not.toMatch(/native-modifiers|createRequire|\.node|TypeCompiler|codegen/);
    expect(manifest.dependencies['@juicesharp/rpiv-todo']).toBeUndefined();
  });
});
