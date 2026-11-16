import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { REQUEST_RECEIPT_PREFIXES } from '../receipt-retention';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (entry.name === '__tests__' ? [] : sourceFiles(join(path, entry.name))) : entry.name.endsWith('.ts') ? [join(path, entry.name)] : []);
}
it('keeps the request projection confined to its authority and two drivers', () => {
  // The embedded server's SQLite store expires no receipt (#2286 D13).
  const allowed = new Set(['packages/cloud/src/receipt-retention.ts', 'packages/cloud/src/index.ts', 'packages/cloud/src/stores/in-memory/receipts.ts', 'packages/cloud-dataplane/src/stores/receipts.ts']);
  const readers = ['cloud', 'server', 'cloud-dataplane'].flatMap(name => sourceFiles(join(root, 'packages', name, 'src'))).filter(path => readFileSync(path, 'utf8').includes('REQUEST_RECEIPT_PREFIXES')).map(path => relative(root, path));
  expect(readers.sort()).toEqual([...allowed].sort());
  expect(REQUEST_RECEIPT_PREFIXES).toEqual([]);
});
