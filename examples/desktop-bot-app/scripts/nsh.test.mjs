import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertNshVersion,
  loadPin,
  readBundleSourceMap,
  verifyBundleSources,
  verifyBundleSpecifiers,
  verifyCapabilitiesAgainstGolden,
  verifyCargoMetadataNshProvenance,
  verifyFileSha256,
} from './nsh.mjs';

const pin = loadPin();

test('assertNshVersion accepts matching pinned CLI output and rejects drift', () => {
  assert.equal(
    assertNshVersion(`nsh ${pin.version} (${pin.shortCommit} nightly ${pin.date})\n`, pin),
    `nsh ${pin.version} (${pin.shortCommit} nightly ${pin.date})`,
  );
  assert.equal(
    assertNshVersion(`nsh ${pin.version} (${pin.shortCommit})`, pin),
    `nsh ${pin.version} (${pin.shortCommit})`,
  );
  assert.throws(() => assertNshVersion('nsh 0.4.0 (abcdef0)', pin), /mismatch/i);
  assert.throws(() => assertNshVersion('nsh 0.6.1 (f577c51 nightly 2026-11-22)', pin), /mismatch/i);
});

test('verifyFileSha256 accepts matching digest and rejects tampered files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byok-nsh-pin-test-'));
  try {
    const file = join(dir, 'sample.bin');
    const bytes = Buffer.from('byok-nsh-pinned-payload');
    writeFileSync(file, bytes);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(verifyFileSha256(file, expected.toUpperCase()), expected);
    assert.throws(() => verifyFileSha256(file, '0'.repeat(64)), /SHA-256 mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCargoMetadataNshProvenance enforces a single pinned git source', () => {
  const source = `git+${pin.sourceRepo}?rev=${pin.commit}#${pin.commit}`;
  assert.deepStrictEqual(
    verifyCargoMetadataNshProvenance({
      packages: [
        { name: 'byok-nsh-adapter', version: '0.1.0', source: null },
        {
          name: 'nsh-app-byok-nsh-adapter-macos-host',
          version: '0.1.0',
          source: null,
          manifest_path: '/tmp/repo/examples/desktop-bot-app/nsh-app/.nsh/rust/macos-host/Cargo.toml',
        },
        { name: 'nsh-core', version: '0.6.0', source },
        { name: 'nsh-base', version: '0.6.0', source },
      ],
    }, pin),
    { count: 2, source },
  );

  assert.throws(
    () => verifyCargoMetadataNshProvenance({ packages: [{ name: 'nsh-core', version: '0.6.0', source: null }] }, pin),
    /unpinned path dependency/i,
  );
  assert.throws(
    () => verifyCargoMetadataNshProvenance({
      packages: [{ name: 'nsh-core', version: '0.6.1', source: 'registry+https://github.com/rust-lang/crates.io-index' }],
    }, pin),
    /expected git\+/i,
  );
  assert.throws(
    () => verifyCargoMetadataNshProvenance({
      packages: [
        { name: 'nsh-core', version: '0.6.0', source },
        { name: 'nsh-base', version: '0.6.0', source: `git+${pin.sourceRepo}?rev=deadbeef#deadbeef` },
      ],
    }, pin),
    /expected git\+/i,
  );
  assert.throws(
    () => verifyCargoMetadataNshProvenance({ packages: [{ name: 'serde', version: '1.0.0', source: 'registry+x' }] }, pin),
    /no nsh/i,
  );
});

test('verifyCapabilitiesAgainstGolden validates D2 golden equality and rejects widened permissions', () => {
  const golden = {
    network: { hosts: [], http: [] },
    process: { execute: [], exit: false, env: [] },
    fs: { read: [], write: [] },
    statusBar: false,
    clipboard: false,
    picker: false,
    application: true,
    openUrl: { schemes: ['https'] },
  };
  verifyCapabilitiesAgainstGolden(structuredClone(golden), golden);

  const widenedFs = structuredClone(golden);
  widenedFs.fs.read.push('/tmp');
  assert.throws(() => verifyCapabilitiesAgainstGolden(widenedFs, golden), /golden/i);

  const widenedUrl = { ...structuredClone(golden), openUrl: { schemes: ['https', 'http'] } };
  assert.throws(
    () => verifyCapabilitiesAgainstGolden(widenedUrl, widenedUrl),
    /https only/i,
  );

  const missingApp = { ...structuredClone(golden), application: false };
  assert.throws(
    () => verifyCapabilitiesAgainstGolden(missingApp, missingApp),
    /application: true/i,
  );

  const widenedHost = { ...structuredClone(golden), host: ['*'] };
  assert.throws(
    () => verifyCapabilitiesAgainstGolden(widenedHost, widenedHost),
    /forbids host/i,
  );
});

test('verifyBundleSources rejects a source map module from a forbidden package root', () => {
  const sourceBase = '/repo/examples/desktop-bot-app/nsh-app';
  const repoRoot = '/repo';
  const check = (entry) => verifyBundleSources({ sources: ['App.tsx', entry] }, { sourceBase, repoRoot });
  check('../../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/core.js');
  check('../../../packages/keys/dist/model-route.js');
  check('../../../packages/cloud-dataplane/dist/index.js');
  assert.throws(
    () => check('../../../node_modules/.bun/react@19.0.0/node_modules/react/index.js'),
    /under node_modules\/react\//,
  );
  assert.throws(
    () => check('../../../node_modules/@byok-sdk/client/dist/index.js'),
    /under node_modules\/@byok-sdk\/client\//,
  );
  assert.throws(() => check('../../../packages/server/src/index.ts'), /under packages\/server\//);
});

test('readBundleSourceMap fails closed on a missing or unparsable map and names its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byok-nsh-bundle-map-test-'));
  try {
    const missing = join(dir, 'bundle.js.map');
    assert.throws(() => readBundleSourceMap(missing), (error) => error.message.includes(missing));
    writeFileSync(missing, '{not json');
    assert.throws(() => readBundleSourceMap(missing), (error) => error.message.includes(missing));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyBundleSpecifiers rejects forbidden import, require and dynamic-import specifiers', () => {
  verifyBundleSpecifiers('import{a as b}from"nsh";import"nsh/base";export*from"byok-nsh-adapter";import("@byok-sdk/keys/model-route");');
  assert.throws(() => verifyBundleSpecifiers('   '), /empty/i);
  for (const code of [
    'import{version as v}from"react";',
    'import x from"@byok-sdk/client";',
    'export*from"@byok-sdk/server/node";',
    'import"node:path";',
    'const fs=require("fs");',
    'await import("electron");',
  ]) {
    assert.throws(() => verifyBundleSpecifiers(code), /Forbidden module specifier/, code);
  }
});

test('verifyBundleSpecifiers ignores unrelated text that mentions electron', () => {
  verifyBundleSpecifiers('const note="Runs without electron; see electron.md";import{a}from"nsh";');
});
