import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * #884: `@byok-sdk/server/execution-core/canonical` must load where `node:sqlite` and `node:async_hooks` do not exist
 * (Workers with `nodejs_compat`), so K8 `rules/` can import `hash` and `canonical`. Its module graph may reach
 * `node:crypto` and nothing else: no other builtin, no package, no sibling module.
 */
const ENTRY = new URL('../../execution-core/canonical.ts', import.meta.url);

function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map(match => match[1]!);
}

it('reaches only node:crypto', () => {
  expect(specifiers(readFileSync(ENTRY, 'utf8'))).toEqual(['node:crypto']);
});

it('detects each import form it guards against', () => {
  expect(specifiers("import { a } from './ledger';\nimport 'node:sqlite';\nconst m = await import('node:async_hooks');\nexport * from '@byok-sdk/protocol';"))
    .toEqual(['./ledger', 'node:sqlite', 'node:async_hooks', '@byok-sdk/protocol']);
});
