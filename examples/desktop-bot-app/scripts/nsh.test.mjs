import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertNshVersion,
  buildCliFromSourceEnv,
  loadPin,
  pinnedInstallRoot,
  readBundleSourceMap,
  readPinnedRustToolchain,
  runCargoGuard,
  verifyBundle,
  verifyBundleSources,
  verifyBundleSpecifiers,
  verifyCapabilitiesAgainstGolden,
  verifyCargoMetadataNshProvenance,
  verifyFileSha256,
  verifyTrayAssetsProjection,
} from './nsh.mjs';

const pin = loadPin();

test('assertNshVersion accepts matching pinned CLI output and rejects channel or version drift', () => {
  assert.equal(
    assertNshVersion(`nsh ${pin.version} (${pin.shortCommit} nightly ${pin.date})\n`, pin),
    `nsh ${pin.version} (${pin.shortCommit} nightly ${pin.date})`,
  );
  // A nightly pin must reject a CLI built without NSH_CHANNEL=nightly (which stamps stable).
  assert.throws(
    () => assertNshVersion(`nsh ${pin.version} (${pin.shortCommit})`, pin),
    /mismatch/i,
  );
  const stablePin = { ...pin, channel: 'stable' };
  assert.equal(
    assertNshVersion(`nsh ${pin.version} (${pin.shortCommit})`, stablePin),
    `nsh ${pin.version} (${pin.shortCommit})`,
  );
  assert.throws(
    () => assertNshVersion(`nsh ${pin.version} (${pin.shortCommit} nightly ${pin.date})`, stablePin),
    /mismatch/i,
  );
  assert.throws(() => assertNshVersion('nsh 0.4.0 (abcdef0)', pin), /mismatch/i);
  assert.throws(() => assertNshVersion('nsh 0.6.1 (f577c51 nightly 2026-11-22)', pin), /mismatch/i);
});

test('buildCliFromSourceEnv stamps NSH_CHANNEL, SOURCE_DATE_EPOCH, fast release profile, and full-commit root', () => {
  const nightlyEnv = buildCliFromSourceEnv(pin, {});
  assert.equal(nightlyEnv.NSH_CHANNEL, 'nightly');
  assert.equal(nightlyEnv.SOURCE_DATE_EPOCH, String(Date.parse(`${pin.date}T00:00:00Z`) / 1000));
  assert.equal(nightlyEnv.CARGO_PROFILE_RELEASE_LTO, 'off');
  assert.equal(nightlyEnv.CARGO_PROFILE_RELEASE_OPT_LEVEL, '2');
  assert.equal(nightlyEnv.CARGO_PROFILE_RELEASE_CODEGEN_UNITS, '16');
  assert.equal(nightlyEnv.RUSTUP_TOOLCHAIN, readPinnedRustToolchain());

  const stableEnv = buildCliFromSourceEnv({ ...pin, channel: 'stable' }, {});
  assert.equal(stableEnv.NSH_CHANNEL, 'stable');
  assert.equal(stableEnv.SOURCE_DATE_EPOCH, undefined);

  assert.equal(
    pinnedInstallRoot(pin).replaceAll('\\', '/').endsWith(`/_ops/nsh-pinned/${pin.commit}`),
    true,
  );
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
    () => verifyCargoMetadataNshProvenance({
      packages: [
        { name: 'nsh-core', version: '0.6.0', source },
        { name: 'nsh-core', version: '0.6.0', source: 'registry+https://github.com/rust-lang/crates.io-index' },
      ],
    }, pin),
    /nsh-core resolved from multiple sources:.*git\+.*registry\+/i,
  );
  assert.throws(
    () => verifyCargoMetadataNshProvenance({ packages: [{ name: 'serde', version: '1.0.0', source: 'registry+x' }] }, pin),
    /no nsh/i,
  );
});

test('runCargoGuard fails closed naming nsh-core before cargo compiles when a generated runner mixes crates.io and git', () => {
  const gitSource = `git+${pin.sourceRepo}?rev=${pin.commit}#${pin.commit}`;
  const runnerManifest = resolve('/repo/examples/desktop-bot-app/nsh-app/.nsh/rust/Cargo.toml');
  let compiled = false;

  assert.throws(
    () => runCargoGuard(
      ['build', '--manifest-path', runnerManifest, '-p', 'nsh-app-byok-nsh-adapter-describe'],
      {
        pin,
        realCargo: 'cargo',
        realCargoWasSet: false,
        env: { CARGO: '/tmp/fake-guard', BYOK_REAL_CARGO: 'cargo', BYOK_REAL_CARGO_SET: '0' },
        verifyManifest: () => verifyCargoMetadataNshProvenance({
          packages: [
            { name: 'nsh-core', version: '0.6.0', source: gitSource },
            { name: 'nsh-core', version: '0.6.0', source: 'registry+https://github.com/rust-lang/crates.io-index' },
          ],
        }, pin),
        spawn: () => {
          compiled = true;
          return { status: 0 };
        },
      },
    ),
    /nsh-core resolved from multiple sources/i,
  );
  assert.equal(compiled, false, 'cargo build must never run when generated runner provenance fails');

  // A valid generated runner passes provenance and delegates to real cargo without recursive CARGO env.
  let spawnedArgs = null;
  let spawnedEnv = null;
  const status = runCargoGuard(
    ['build', '--manifest-path', runnerManifest, '-p', 'nsh-app-byok-nsh-adapter-describe'],
    {
      pin,
      realCargo: 'cargo',
      realCargoWasSet: false,
      env: { CARGO: '/tmp/fake-guard', BYOK_REAL_CARGO: 'cargo', BYOK_REAL_CARGO_SET: '0' },
      verifyManifest: () => verifyCargoMetadataNshProvenance({
        packages: [{ name: 'nsh-core', version: '0.6.0', source: gitSource }],
      }, pin),
      spawn: (_cmd, args, opts) => {
        spawnedArgs = args;
        spawnedEnv = opts.env;
        return { status: 0 };
      },
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(spawnedArgs, ['build', '--manifest-path', runnerManifest, '-p', 'nsh-app-byok-nsh-adapter-describe']);
  assert.equal(spawnedEnv.CARGO, undefined);
  assert.equal(spawnedEnv.BYOK_REAL_CARGO, undefined);

  // Non-compile subcommands (metadata) pass directly without re-running provenance.
  let metadataVerified = false;
  const metaStatus = runCargoGuard(
    ['metadata', '--format-version', '1', '--manifest-path', runnerManifest],
    {
      pin,
      realCargo: 'cargo',
      realCargoWasSet: false,
      env: {},
      verifyManifest: () => {
        metadataVerified = true;
      },
      spawn: () => ({ status: 0 }),
    },
  );
  assert.equal(metaStatus, 0);
  assert.equal(metadataVerified, false);
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

test('verifyBundleSpecifiers parses AST import, export, dynamic import() and require() and fails closed on syntax errors', () => {
  verifyBundleSpecifiers('import{a as b}from"nsh";import"nsh/base";export*from"byok-nsh-adapter";import("@byok-sdk/keys/model-route");');
  assert.throws(() => verifyBundleSpecifiers('   '), /empty/i);
  assert.throws(() => verifyBundleSpecifiers('import { from "broken";'), /failed to parse/i);
  for (const code of [
    'import{version as v}from"react";',
    'import x from"@byok-sdk/client";',
    'export*from"@byok-sdk/server/node";',
    'export{a}from"hono";',
    'import"node:path";',
    'const fs=require("fs");',
    'const fs=(require)(`fs/promises`);',
    'await import("electron");',
    'await import(`electron`);',
  ]) {
    assert.throws(() => verifyBundleSpecifiers(code), /Forbidden module specifier/, code);
  }
});

test('verifyBundleSpecifiers ignores import/require text inside string literals, templates, comments, and member calls', () => {
  verifyBundleSpecifiers([
    'const example = \'Example: import "electron"\';',
    'const tmpl = `export * from "@byok-sdk/server"; require("fs")`;',
    '// import "react"\n/* await import("electron") */',
    'const note = "Runs without electron; see electron.md";',
    'const custom = { require: (x) => x }; custom.require("fs");',
    'import { a } from "nsh";',
    'console.log(example, tmpl, note, a);',
  ].join('\n'));
});

test('verifyBundle checks every split chunk and map and resolves map sources against dirname(bundlePath)', () => {
  const root = mkdtempSync(join(tmpdir(), 'byok-nsh-split-bundle-test-'));
  try {
    const outDir = join(root, 'out-split');
    mkdirSync(join(outDir, 'assets'), { recursive: true });
    writeFileSync(join(outDir, 'assets', 'ignore.js'), 'import "electron";');
    writeFileSync(join(outDir, 'bundle.js'), 'import{a}from"nsh";export const entry=a;');
    writeFileSync(join(outDir, 'bundle.js.map'), JSON.stringify({ version: 3, sources: ['App.tsx'] }));
    writeFileSync(join(outDir, 'Settings.js'), 'import{entry}from"./bundle.js";export const s=\'Example: import "electron"\'+entry;');
    writeFileSync(join(outDir, 'Settings.js.map'), JSON.stringify({ version: 3, sources: ['src/Settings.tsx'] }));

    const ok = verifyBundle(join(outDir, 'bundle.js'), { repoRoot: root });
    assert.equal(ok.files.length, 2);
    assert.equal(ok.totalMapSources, 2);

    // Forbidden specifier in a split chunk fails naming the chunk.
    writeFileSync(join(outDir, 'Settings.js'), 'await import("electron");');
    assert.throws(
      () => verifyBundle(join(outDir, 'bundle.js'), { repoRoot: root }),
      /Settings\.js.*electron/i,
    );

    // Restore clean JS; forbidden source in a split chunk map fails.
    writeFileSync(join(outDir, 'Settings.js'), 'export const s=1;');
    writeFileSync(
      join(outDir, 'Settings.js.map'),
      JSON.stringify({ version: 3, sources: ['../node_modules/react/index.js'] }),
    );
    assert.throws(
      () => verifyBundle(join(outDir, 'bundle.js'), { repoRoot: root }),
      /under node_modules\/react\//,
    );

    // Missing source map for a split chunk fails closed.
    rmSync(join(outDir, 'Settings.js.map'));
    assert.throws(
      () => verifyBundle(join(outDir, 'bundle.js'), { repoRoot: root }),
      /Settings\.js\.map/,
    );

    // Orphan source map without a matching JS chunk fails closed.
    writeFileSync(join(outDir, 'Settings.js.map'), JSON.stringify({ version: 3, sources: ['src/Settings.tsx'] }));
    writeFileSync(join(outDir, 'Orphan.js.map'), JSON.stringify({ version: 3, sources: ['src/Orphan.tsx'] }));
    assert.throws(
      () => verifyBundle(join(outDir, 'bundle.js'), { repoRoot: root }),
      /Orphan\.js\.map/,
    );
    rmSync(join(outDir, 'Orphan.js.map'));

    // Map sources resolve against dirname(bundlePath), not a hardcoded app directory.
    const nestedDir = join(root, 'packages', 'server', 'dist');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'bundle.js'), 'import{a}from"nsh";export{a};');
    writeFileSync(join(nestedDir, 'bundle.js.map'), JSON.stringify({ version: 3, sources: ['../src/index.ts'] }));
    assert.throws(
      () => verifyBundle(join(nestedDir, 'bundle.js'), { repoRoot: root }),
      /under packages\/server\//,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readPinnedRustToolchain parses adapter toolchain channel and fails closed when missing', () => {
  assert.equal(readPinnedRustToolchain(), '1.98.1');
  const dir = mkdtempSync(join(tmpdir(), 'byok-nsh-toolchain-test-'));
  try {
    const file = join(dir, 'rust-toolchain.toml');
    writeFileSync(file, '[toolchain]\nprofile = "minimal"\n');
    assert.throws(() => readPinnedRustToolchain(file), error => error.message.includes(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop CI workflow runs the full 3-OS S2.5 NSH verification and test lane', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const desktop = workflow.split('\n  desktop:\n')[1]?.split('\n  ci-required:\n')[0];
  assert.ok(desktop, 'desktop job must exist before ci-required in ci.yml');
  assert.match(desktop, /libclang-dev/);
  assert.match(desktop, /LIBCLANG_PATH=C:\\Program Files\\LLVM\\bin/);
  assert.match(desktop, /RUST_MIN_STACK=268435456/);
  assert.match(desktop, /if \[ "\$channel" = nightly \][\s\S]*nsh\.mjs build-cli-from-source/);

  const stepSections = desktop.split('\n      - name: ').slice(1);
  const indexOfStep = name => stepSections.findIndex(section => section.startsWith(`${name}\n`));
  const restoreIdx = indexOfStep('Restore pinned NSH CLI cache');
  const ensureIdx = indexOfStep('Ensure pinned NSH CLI');
  const saveIdx = indexOfStep('Save pinned NSH CLI cache');
  assert.ok(restoreIdx >= 0 && ensureIdx > restoreIdx && saveIdx > ensureIdx, 'cache restore must run before ensure and save after ensure');

  const restoreStep = stepSections[restoreIdx];
  assert.match(restoreStep, /uses:\s*actions\/cache\/restore@[0-9a-f]{40}/);
  assert.match(restoreStep, /path:\s*_ops\/nsh-pinned\/\$\{\{\s*steps\.nsh-pin\.outputs\.commit\s*\}\}/);
  assert.match(
    restoreStep,
    /key:.*\$\{\{\s*runner\.os\s*\}\}.*\$\{\{\s*runner\.arch\s*\}\}.*\$\{\{\s*steps\.nsh-pin\.outputs\.commit\s*\}\}.*\$\{\{\s*hashFiles\('examples\/desktop-bot-app\/scripts\/nsh\.mjs'\)\s*\}\}/,
  );
  const saveStep = stepSections[saveIdx];
  assert.match(saveStep, /uses:\s*actions\/cache\/save@[0-9a-f]{40}/);
  assert.match(saveStep, /if:\s*steps\.nsh-cli-cache\.outputs\.cache-hit != 'true'/);
  assert.match(saveStep, /path:\s*_ops\/nsh-pinned\/\$\{\{\s*steps\.nsh-pin\.outputs\.commit\s*\}\}/);

  for (const requiredCmd of [
    'node examples/desktop-bot-app/scripts/nsh.mjs ensure',
    'node examples/desktop-bot-app/scripts/nsh.mjs check',
    'node examples/desktop-bot-app/scripts/nsh.mjs build --release',
    'node examples/desktop-bot-app/scripts/nsh.mjs verify-capabilities',
    'node examples/desktop-bot-app/scripts/nsh.mjs verify-bundle',
    'node examples/desktop-bot-app/scripts/nsh.mjs build --release --split',
    'node examples/desktop-bot-app/scripts/nsh.mjs test',
    'node examples/desktop-bot-app/scripts/nsh.mjs verify-lock --all',
  ]) {
    const step = stepSections.find(section => section.includes(requiredCmd));
    assert.ok(step, `desktop job missing S2.5 step: ${requiredCmd}`);
    assert.doesNotMatch(step, /^\s*if:\s*runner\.os\s*==/m, `step must run on all 3 OSes: ${requiredCmd}`);
  }
  const buildGateStep = stepSections.find(section => section.includes('nsh.mjs build --release --split'));
  assert.match(
    buildGateStep,
    /nsh\.mjs build --release --split\n\s+node examples\/desktop-bot-app\/scripts\/nsh\.mjs verify-bundle/,
    'split release build must be followed by verify-bundle',
  );
});

test('verifyTrayAssetsProjection matches authoritative assets/tray byte-for-byte and rejects drift', () => {
  assert.deepStrictEqual(verifyTrayAssetsProjection(), {
    count: 4,
    files: ['tray.png', 'trayTemplate.png', 'trayTemplate.svg', 'trayTemplate@2x.png'],
  });

  const dir = mkdtempSync(join(tmpdir(), 'byok-tray-projection-test-'));
  try {
    const sourceDir = join(dir, 'source');
    const targetDir = join(dir, 'target');
    mkdirSync(sourceDir);
    mkdirSync(targetDir);
    writeFileSync(join(sourceDir, 'tray.png'), Buffer.from([1, 2, 3, 4]));
    writeFileSync(join(sourceDir, 'trayTemplate.png'), Buffer.from([5, 6, 7, 8]));
    writeFileSync(join(targetDir, 'tray.png'), Buffer.from([1, 2, 3, 4]));
    assert.throws(() => verifyTrayAssetsProjection({ sourceDir, targetDir }), /file list diverges/i);

    writeFileSync(join(targetDir, 'trayTemplate.png'), Buffer.from([5, 6, 7, 8]));
    writeFileSync(join(targetDir, 'extra.png'), Buffer.from([9]));
    assert.throws(() => verifyTrayAssetsProjection({ sourceDir, targetDir }), /file list diverges/i);

    rmSync(join(targetDir, 'extra.png'));
    writeFileSync(join(targetDir, 'trayTemplate.png'), Buffer.from([5, 6, 7, 9]));
    assert.throws(() => verifyTrayAssetsProjection({ sourceDir, targetDir }), /Tray asset projection drift for trayTemplate\.png/);

    // A target-only symlink is an extra name; a symlink under a matched name is compared by the bytes it reaches.
    writeFileSync(join(targetDir, 'trayTemplate.png'), Buffer.from([5, 6, 7, 8]));
    symlinkSync('trayTemplate.png', join(targetDir, 'trayTemplate@3x.png'));
    assert.throws(() => verifyTrayAssetsProjection({ sourceDir, targetDir }), /file list diverges/i);
    rmSync(join(targetDir, 'trayTemplate@3x.png'));
    rmSync(join(targetDir, 'trayTemplate.png'));
    symlinkSync('tray.png', join(targetDir, 'trayTemplate.png'));
    assert.throws(() => verifyTrayAssetsProjection({ sourceDir, targetDir }), /Tray asset projection drift for trayTemplate\.png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
