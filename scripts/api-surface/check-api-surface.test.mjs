import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-api-surface.mjs');

function makeRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'api-surface-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Writes packages/<pkg>/package.json plus a dist/ tree from a {relPath: content} map.
function writePackage(root, pkg, { exports: exportsField, dist }) {
  const packageDir = path.join(root, 'packages', pkg);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify({ name: `@byok-sdk/${pkg}`, version: '0.0.0', exports: exportsField }, null, 2)}\n`,
  );
  for (const [relative, content] of Object.entries(dist ?? {})) {
    const file = path.join(packageDir, 'dist', relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return packageDir;
}

const singleEntry = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };

function runCheck(root, args = []) {
  const scoped = args.includes('--package') ? args : ['--package', 'core', ...args];
  return spawnSync(process.execPath, [script, '--root', root, ...scoped], { encoding: 'utf8' });
}

const goldenPath = (root, pkg) => path.join(root, 'api-surface', `${pkg}.d.ts`);

test('walks a two-hop relative chain, orders by path, and ignores unreachable files', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'core', {
    exports: singleEntry,
    dist: {
      'index.d.ts': "export * from './a.js';\nexport declare const entry: number;\n",
      'a.d.ts': "export * from './nested/b.js';\nexport declare const a: string;\n",
      'nested/b.d.ts': 'export declare const b: boolean;\n',
      'unreachable.d.ts': 'export declare const unreachable: never;\n',
    },
  });

  assert.equal(runCheck(root, ['--update']).status, 0);
  const golden = readFileSync(goldenPath(root, 'core'), 'utf8');

  assert.equal(
    golden,
    [
      '// ==== @byok-sdk/core dist/a.d.ts ====',
      "export * from './nested/b.js';",
      'export declare const a: string;',
      '// ==== @byok-sdk/core dist/index.d.ts ====',
      "export * from './a.js';",
      'export declare const entry: number;',
      '// ==== @byok-sdk/core dist/nested/b.d.ts ====',
      'export declare const b: boolean;',
      '',
    ].join('\n'),
  );
  assert.ok(!golden.includes('unreachable'));
});

test('drift against the committed golden exits 1 with a diff', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'core', {
    exports: singleEntry,
    dist: { 'index.d.ts': 'export declare const entry: number;\n' },
  });
  assert.equal(runCheck(root, ['--update']).status, 0);

  writeFileSync(
    path.join(root, 'packages', 'core', 'dist', 'index.d.ts'),
    'export declare const entry: string;\n',
  );
  const drifted = runCheck(root);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /api-surface\/core\.d\.ts/);
  assert.match(drifted.stderr, /-export declare const entry: number;/);
  assert.match(drifted.stderr, /\+export declare const entry: string;/);

  const updated = runCheck(root, ['--update']);
  assert.equal(updated.status, 0);
  assert.match(updated.stdout, /updated 1 golden/);
  assert.equal(runCheck(root).status, 0);
});

test('a missing golden fails closed instead of silently passing', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'core', {
    exports: singleEntry,
    dist: { 'index.d.ts': 'export declare const entry: number;\n' },
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /api-surface\/core\.d\.ts is missing/);
});

test('normalises CRLF, sourceMappingURL comments, and trailing blank lines', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'core', {
    exports: singleEntry,
    dist: {
      'index.d.ts':
        'export declare const entry: number;\r\nexport declare const other: string;\r\n//# sourceMappingURL=index.d.ts.map\r\n\r\n',
    },
  });
  assert.equal(runCheck(root, ['--update']).status, 0);
  assert.equal(
    readFileSync(goldenPath(root, 'core'), 'utf8'),
    [
      '// ==== @byok-sdk/core dist/index.d.ts ====',
      'export declare const entry: number;',
      'export declare const other: string;',
      '',
    ].join('\n'),
  );

  // The same declarations written with LF must produce the identical golden.
  writeFileSync(
    path.join(root, 'packages', 'core', 'dist', 'index.d.ts'),
    'export declare const entry: number;\nexport declare const other: string;\n//# sourceMappingURL=index.d.ts.map\n',
  );
  assert.equal(runCheck(root).status, 0);
});

test('a package with several exports entries walks every entry exactly once', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'cloud-dataplane', {
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './runtime': { types: './dist/runtime.d.ts', import: './dist/runtime.js' },
      './package.json': './package.json',
    },
    dist: {
      'index.d.ts': "export * from './shared.js';\nexport declare const index: number;\n",
      'runtime.d.ts': "export * from './shared.js';\nexport declare const runtime: number;\n",
      'shared.d.ts': 'export declare const shared: number;\n',
    },
  });
  assert.equal(runCheck(root, ['--update', '--package', 'cloud-dataplane']).status, 0);

  const golden = readFileSync(goldenPath(root, 'cloud-dataplane'), 'utf8');
  const headers = golden.split('\n').filter((line) => line.startsWith('// ===='));
  assert.deepEqual(headers, [
    '// ==== @byok-sdk/cloud-dataplane dist/index.d.ts ====',
    '// ==== @byok-sdk/cloud-dataplane dist/runtime.d.ts ====',
    '// ==== @byok-sdk/cloud-dataplane dist/shared.d.ts ====',
  ]);
  assert.equal(golden.split('dist/shared.d.ts ====').length - 1, 1);
});

test('directory specifiers resolve to index.d.ts and bare specifiers are skipped', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'core', {
    exports: singleEntry,
    dist: {
      'index.d.ts':
        "import type { Wire } from '@byok-sdk/protocol';\nexport * from './adapters';\nexport declare const entry: Wire;\n",
      'adapters/index.d.ts': 'export declare const adapter: number;\n',
    },
  });
  assert.equal(runCheck(root, ['--update']).status, 0);
  const golden = readFileSync(goldenPath(root, 'core'), 'utf8');
  assert.match(golden, /dist\/adapters\/index\.d\.ts ====/);
  assert.match(golden, /@byok-sdk\/protocol/);
});

test('a missing dist tells the reader to build first', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'core', { exports: singleEntry });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/core\/dist is missing/);
  assert.match(result.stderr, /bun run build/);
});

test('an unresolvable relative dynamic import is refused, not skipped', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'core', {
    exports: singleEntry,
    dist: {
      'index.d.ts': "export declare const lazy: typeof import('./gone.js');\n",
    },
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unresolvable relative dynamic import/);
  assert.match(result.stderr, /\.\/gone\.js/);
});

test('a relative specifier escaping the package dist is refused, not skipped', (t) => {
  const root = makeRoot(t);
  const packageDir = writePackage(root, 'core', {
    exports: singleEntry,
    dist: {
      'index.d.ts': "export * from '../outside.js';\nexport declare const entry: number;\n",
    },
  });
  writeFileSync(path.join(packageDir, 'outside.d.ts'), 'export declare const outside: number;\n');

  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/core\/dist\/index\.d\.ts/);
  assert.match(result.stderr, /"\.\.\/outside\.js"/);
  assert.match(result.stderr, /outside packages\/core\/dist/);
});

test('a resolvable relative dynamic import is part of the closure', (t) => {
  const root = makeRoot(t);
  writePackage(root, 'core', {
    exports: singleEntry,
    dist: {
      'index.d.ts': "export declare const lazy: typeof import('./lazy.js');\n",
      'lazy.d.ts': 'export declare const lazy: number;\n',
    },
  });
  assert.equal(runCheck(root, ['--update']).status, 0);
  assert.match(readFileSync(goldenPath(root, 'core'), 'utf8'), /dist\/lazy\.d\.ts ====/);
});

test('--package rejects a name outside the publishable set', (t) => {
  const root = makeRoot(t);
  const result = runCheck(root, ['--package', 'not-a-package']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown package: not-a-package/);
});
