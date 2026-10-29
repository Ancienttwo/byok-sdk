import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { code, imports } from './import-scan.test-support';

/**
 * #606 §5.5: `rules/` can be copied alone. Its files import only `@byok-sdk/protocol`, `@byok-sdk/core`,
 * `hash` and `canonical` of the K4 `@byok-sdk/server/execution-core/canonical` entry, and other files in `rules/`. Rule tests can also import vitest.
 * So no rule and no rule test reaches `LedgerState`, `HostLedger`, `stateOf` or `CollaborationState`.
 * #884: the K4 root entry loads `node:sqlite` and `node:async_hooks`, so the rules never import it.
 */
const RULES = new URL('./rules/', import.meta.url);
const K4_CANONICAL = new URL('../../../packages/server/src/execution-core/canonical.ts', import.meta.url);
const K4 = '@byok-sdk/server/execution-core/canonical';
const K4_NAMES = new Set(['hash', 'canonical']);
const HOST_STATE = /\b(?:LedgerState|HostLedger|stateOf|CollaborationState)\b/;

function violations(file: string, source: string): string[] {
  const allowed = ({ from, names }: { from: string; names?: string[] }) => from === '@byok-sdk/protocol' || from === '@byok-sdk/core'
    || from === K4 && !!names?.length && names.every(name => K4_NAMES.has(name))
    || from.startsWith('./') && !from.includes('..')
    || file.endsWith('.test.ts') && from === 'vitest';
  const found = imports(source).filter(row => !allowed(row)).map(({ from, names }) => `${file}: ${from}${names ? ` {${names.join(', ')}}` : ''}`);
  return HOST_STATE.test(code(source)) ? [...found, `${file}: names Host ledger state`] : found;
}

it('keeps every rule and rule test inside the import boundary', () => {
  const files = readdirSync(RULES).filter(name => name.endsWith('.ts'));
  expect(files.filter(name => !name.endsWith('.test.ts'))).not.toEqual([]);
  expect(files.flatMap(name => violations(name, readFileSync(new URL(name, RULES), 'utf8')))).toEqual([]);
});

it('finds a boundary break in each import form that it reads', () => {
  const sample = [
    "import {\n  hash,\n  HostLedger,\n} from '@byok-sdk/server/execution-core';",
    "import type { Turn } from '../model';",
    "export { roomContext } from '../rooms';",
    "import * as k4 from '@byok-sdk/server/execution-core';",
    "import { expect } from 'vitest';",
    "import 'node:fs';",
    "const team = await import('./../team');",
  ].join('\r\n');
  expect(violations('sample.ts', sample)).toEqual([
    'sample.ts: @byok-sdk/server/execution-core {hash, HostLedger}', 'sample.ts: ../model {Turn}', 'sample.ts: ../rooms {roomContext}',
    'sample.ts: @byok-sdk/server/execution-core', 'sample.ts: vitest {expect}', 'sample.ts: node:fs', 'sample.ts: ./../team',
    'sample.ts: names Host ledger state',
  ]);
  expect(violations('sample.test.ts', "import { expect } from 'vitest';\nimport { canonical, hash } from '@byok-sdk/server/execution-core/canonical';")).toEqual([]);
  expect(violations('sample.ts', "import { hash } from '@byok-sdk/server/execution-core';"))
    .toEqual(['sample.ts: @byok-sdk/server/execution-core {hash}']);
});

it('#884: the K4 entry of the rules loads only node:crypto', () => {
  expect(imports(readFileSync(K4_CANONICAL, 'utf8'))).toEqual([{ from: 'node:crypto', names: ['createHash'] }]);
});

it('holds the #739 D1 pure modules under the boundary', () => {
  const files = new Set(readdirSync(RULES));
  for (const name of ['turn', 'team', 'history', 'delegation', 'schema', 'context', 'outcome', 'message', 'commit', 'commands']) expect(files.has(`${name}.ts`), name).toBe(true);
});
