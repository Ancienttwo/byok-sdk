import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COLUMNS, ROWS, generateDoc, matrixTable } from './capability-matrix.mjs';

const doc = readFileSync(new URL('../../docs/adapter-capabilities.md', import.meta.url), 'utf8');

test('the committed matrix is the projection of the adapter capability constants', () => {
  assert.equal(generateDoc(doc), doc);
});
test('generation is deterministic and repairs a hand-edited cell', () => {
  const table = matrixTable();
  assert.equal(generateDoc(doc.replace(table, table.replace('| `toolAuthorizationAuto` | yes', '| `toolAuthorizationAuto` | no'))), doc);
});
test('every column is a bundled adapter and every cell is yes or no', () => {
  assert.deepEqual(COLUMNS.map(([name]) => name), ['Claude', 'Codex', 'dsh', 'Grok', 'Hermes', 'Pi', 'Pi (`durablePi`)']);
  for (const line of matrixTable().split('\n').slice(3)) {
    for (const cell of line.split('|').slice(3, -1)) assert.match(cell.trim(), /^(yes|no)$/u);
  }
});
test('a missing or duplicated marker fails instead of writing elsewhere', () => {
  assert.throws(() => generateDoc(doc.replace('<!-- generated:capability-matrix:end -->', '')), /capability-matrix/);
  assert.throws(() => generateDoc(`${doc}\n<!-- generated:capability-matrix:start -->`), /capability-matrix/);
});

test('every top-level capability field is a matrix row (no undeclared capability)', () => {
  const fields = new Set(COLUMNS.flatMap(([, capabilities]) => Object.keys(capabilities)));
  const rows = new Set(ROWS.map(([, field]) => field.split('.')[0]));
  assert.deepEqual([...fields].filter(field => !rows.has(field)), []);
});

test('every matrix row reads a field at least one descriptor declares', () => {
  for (const [label, , read] of ROWS) {
    assert.ok(COLUMNS.some(([, capabilities]) => read(capabilities) !== undefined), label);
  }
});

test('the isolation rows cover exactly the descriptor isolation keys', () => {
  const declared = new Set(COLUMNS.flatMap(([, capabilities]) => Object.keys(capabilities.isolation ?? {})).map(key => `isolation.${key}`));
  const rows = new Set(ROWS.map(([, field]) => field).filter(field => field.startsWith('isolation.')));
  assert.deepEqual([...declared].sort(), [...rows].sort());
});
