import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertNshVersion,
  loadPin,
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
