import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

it('ships only the measurement authority and the approved Node builtin dependencies', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(manifest.dependencies ?? {}).toEqual({});
  const violations: string[] = [];
  const sourceRoot = path.join(root, 'src');
  const builtins = new Set(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path']);
  for (const entry of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.parentPath.includes('__tests__')) continue;
    const file = path.join(entry.parentPath, entry.name);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/gu)) {
      const specifier = match[1]!;
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        if (!target.startsWith(`${sourceRoot}${path.sep}`)) violations.push(`${file}: escaping import`);
      } else if (!builtins.has(specifier)) violations.push(`${file}: ${specifier}`);
    }
    if (/\b(?:import|require|createRequire|eval|Function)\s*\(/u.test(source)) {
      violations.push(`${file}: dynamic loading or evaluation`);
    }
  }
  expect(violations).toEqual([]);
});
