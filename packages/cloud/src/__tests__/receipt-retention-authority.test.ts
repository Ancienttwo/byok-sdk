import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { receiptRetentionClass, REQUEST_RECEIPT_PREFIXES } from '../receipt-retention';
import { inputPreparationRequestKey, inputPreparationCompletionKey } from '../input-preparations';
import { agentHomeProjectionRequestKey, agentHomeProjectionCompletionKey } from '../agent-home-projections';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (entry.name === '__tests__' ? [] : sourceFiles(join(path, entry.name))) : entry.name.endsWith('.ts') ? [join(path, entry.name)] : []);
}
it('keeps the request projection confined to its authority and three drivers', () => {
  const allowed = new Set(['packages/cloud/src/receipt-retention.ts', 'packages/cloud/src/index.ts', 'packages/cloud/src/stores/in-memory/receipts.ts', 'packages/server/src/stores/sqlite/index.ts', 'packages/cloud-dataplane/src/stores/receipts.ts']);
  const readers = ['cloud', 'server', 'cloud-dataplane'].flatMap(name => sourceFiles(join(root, 'packages', name, 'src'))).filter(path => readFileSync(path, 'utf8').includes('REQUEST_RECEIPT_PREFIXES')).map(path => relative(root, path));
  expect(readers.sort()).toEqual([...allowed].sort());
  expect(REQUEST_RECEIPT_PREFIXES).toEqual([]);
});
it('classifies SDK key-builder output and unknown keys as identity', () => {
  for (const key of [
    inputPreparationRequestKey('device', { agentId: 'agent', profileRevision: '1' }, 'request'), inputPreparationCompletionKey('device', { agentId: 'agent', profileRevision: '1' }, 'request'),
    agentHomeProjectionRequestKey('device', { agentId: 'agent', profileRevision: '1' }, 'request'), agentHomeProjectionCompletionKey('device', { agentId: 'agent', profileRevision: '1' }, 'request'),
    'unknown-host-key',
  ]) expect(receiptRetentionClass(key)).toBe('identity');
});
