// Keep this check at root, outside package source and declaration build roots.
// It compares the private JS/declaration bridge with vendor and SDK source types.
// The SDK projection imports built protocol types, so run after `bun run build`.
// On re-vendor, update the 087df16 pins together in these four files:
// packages/client/src/runtime/codex-session-runtime.js,
// packages/client/src/runtime/oar-process-tree.js, this test, and
// scripts/api-surface/oar-bridge-types.ts.
// The bridge is outside the API golden. New type exports need explicit checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

test('OAR JS bridge re-exports the checked vendored codexSession', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/codex-session-runtime.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(body.length, 1, 'OAR JS bridge must have one checked re-export');
  const statement = body[0];
  assert.equal(statement.type, 'ExportNamedDeclaration');
  assert.equal(statement.source?.value, '../../vendor/oar/087df16/runtimes/codex/session.js');
  assert.deepEqual(statement.specifiers.map(({ local, exported }) => [local.name, exported.name]), [
    ['codexSession', 'codexSession'],
  ]);
});

test('OAR process-tree JS bridge re-exports the checked vendored functions', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/oar-process-tree.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(body.length, 1, 'OAR process-tree bridge must have one checked re-export');
  const statement = body[0];
  assert.equal(statement.type, 'ExportNamedDeclaration');
  assert.equal(statement.source?.value, '../../vendor/oar/087df16/shared/executable/process-tree.js');
  assert.deepEqual(statement.specifiers.map(({ local, exported }) => [local.name, exported.name]), [
    ['descendantsOf', 'descendantsOf'],
    ['killEntries', 'killEntries'],
    ['readProcessTable', 'readProcessTable'],
  ]);
});

test('OAR declaration bridge matches the vendor types and BYOK consumers', () => {
  const result = spawnSync(process.execPath, [
    path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
    '--project', 'scripts/api-surface/tsconfig.oar-bridge.json',
    '--pretty', 'false',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, [
    'OAR declaration bridge drift: check scripts/api-surface/oar-bridge-types.ts.',
    result.error?.message,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n'));
});
