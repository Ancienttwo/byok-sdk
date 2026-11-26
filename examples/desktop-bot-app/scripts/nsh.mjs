import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { SyntaxKind as K } from 'typescript/unstable/ast';
import { API as TsApi } from 'typescript/unstable/sync';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
export const DEFAULT_PIN_PATH = resolve(SCRIPT_DIR, 'nsh-pin.json');
const DESKTOP_APP_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(DESKTOP_APP_DIR, '../..');
const NSH_APP_DIR = resolve(DESKTOP_APP_DIR, 'nsh-app');
const ADAPTER_MANIFEST = resolve(NSH_APP_DIR, 'ext/byok-nsh-adapter/Cargo.toml');
const ADAPTER_TOOLCHAIN_PATH = resolve(NSH_APP_DIR, 'ext/byok-nsh-adapter/rust-toolchain.toml');
const GENERATED_RUNNER_MANIFEST = resolve(NSH_APP_DIR, '.nsh/rust/Cargo.toml');
const DEFAULT_BUILT_CAPABILITIES = resolve(NSH_APP_DIR, '.nsh/out/capabilities.json');
const DEFAULT_EXPECTED_CAPABILITIES = resolve(NSH_APP_DIR, 'capabilities.expected.json');
const DEFAULT_BUILT_BUNDLE = resolve(NSH_APP_DIR, '.nsh/out/bundle.js');
const DEFAULT_TRAY_ASSETS_SOURCE = resolve(DESKTOP_APP_DIR, 'assets/tray');
const DEFAULT_TRAY_ASSETS_TARGET = resolve(NSH_APP_DIR, 'assets/tray');
const DEFAULT_APP_CONFIG = resolve(NSH_APP_DIR, 'nsh.json');
const DEFAULT_RUST_WORKSPACE = resolve(NSH_APP_DIR, '.nsh/rust');
/** The app-owned Rust code linked into the release runner: the NSH adapter crate and the `byok-shell` it wraps. */
const DEFAULT_APP_RUST_SOURCES = [
  resolve(NSH_APP_DIR, 'ext/byok-nsh-adapter/src'),
  resolve(DESKTOP_APP_DIR, 'native/byok-shell/src'),
];

/** ADR-052 D2: the `nsh.json` `capabilities` the owner signed (2026-11-25), verbatim. */
export const D2_DECLARED_CAPABILITIES = { application: true, openUrl: { schemes: ['https'] } };

/** The desktop release runners `nsh build` generates: each must start its platform's `nsh-<os>-app` runner. */
const RELEASE_RUNNER_OSES = ['macos', 'linux', 'windows'];

/** Rust that turns off `Policy::harden` (`nsh-engine/src/lib.rs` `Policy`): only NSH's development hosts may do it. */
const DEVELOPMENT_POLICY_PATTERN = /\bPolicy::development\b|\bharden\s*[:=]\s*false\b|\.with_policy\s*\(/;

/** Text that only the development-only Foundations Gallery puts into a bundle. */
const GALLERY_ONLY_TEXT = ['Foundations Gallery', 'GalleryScreen'];
const GALLERY_SOURCE_SEGMENT = 'src/features/gallery/';
/** The one module that may reach `openUrl` (`nsh-app/src/links.ts`), as the bundle's source map names it. */
const LINKS_SOURCE = 'src/links.ts';
const CODE_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Packages the QuickJS TSX bundle must never contain. The single source for both release checks:
 * source-map provenance (`node_modules/<name>/`, plus `packages/<dir>/` for workspace packages)
 * and the import/require specifiers left in `bundle.js`. Node builtins are checked separately.
 */
export const FORBIDDEN_BUNDLE_PACKAGES = [
  'react',
  'react-dom',
  'hono',
  'electron',
  '@byok-sdk/client',
  '@byok-sdk/server',
  '@byok-sdk/ui-runtime',
  '@byok-sdk/cloud',
];
const WORKSPACE_SCOPE = '@byok-sdk/';
const NODE_BUILTINS = new Set(builtinModules);

const NSH_VERSION_PATTERN = /^nsh\s+(\S+)\s+\(([^)\s]+)(?:\s+([^)]+))?\)$/;

export function loadPin(pinPath = DEFAULT_PIN_PATH) {
  return JSON.parse(readFileSync(pinPath, 'utf8'));
}

export function assetKeyForPlatform(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function assertNshVersion(output, pin) {
  const trimmed = String(output ?? '').trim();
  const match = NSH_VERSION_PATTERN.exec(trimmed);
  const versionOk = match?.[1] === pin.version && match?.[2] === pin.shortCommit;
  const meta = match?.[3] ?? '';
  const channelOk = pin.channel === 'nightly'
    ? meta === 'nightly' || meta.startsWith('nightly ')
    : meta === '';
  if (!versionOk || !channelOk) {
    const expected = pin.channel === 'nightly'
      ? `nsh ${pin.version} (${pin.shortCommit} nightly ...)`
      : `nsh ${pin.version} (${pin.shortCommit})`;
    throw new Error(
      `NSH CLI version mismatch: expected ${expected}, got ${JSON.stringify(trimmed)}`,
    );
  }
  return trimmed;
}

export function verifyFileSha256(filePath, expectedSha256) {
  const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex').toLowerCase();
  const expected = expectedSha256.toLowerCase();
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${filePath}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function collectNshSourcesByCrate(nshPackages) {
  const sourcesByCrate = new Map();
  for (const pkg of nshPackages) {
    const label = typeof pkg.source === 'string' && pkg.source ? pkg.source : '<path>';
    let set = sourcesByCrate.get(pkg.name);
    if (!set) {
      set = new Set();
      sourcesByCrate.set(pkg.name, set);
    }
    set.add(label);
  }
  for (const [name, sources] of sourcesByCrate) {
    if (sources.size > 1) {
      throw new Error(
        `NSH crate ${name} resolved from multiple sources: ${[...sources].sort().join(', ')}`,
      );
    }
  }
  return sourcesByCrate;
}

function assertPinnedNshPackageSource(pkg, pin) {
  if (typeof pkg.source !== 'string' || !pkg.source) {
    throw new Error(`NSH crate ${pkg.name} uses an unpinned path dependency (source missing); expected git rev ${pin.commit}`);
  }
  if (pkg.source.startsWith('path+')) {
    throw new Error(`NSH crate ${pkg.name} uses forbidden path dependency (${pkg.source})`);
  }
  if (pin.channel === 'stable') {
    if (!pkg.source.startsWith('registry+')) {
      throw new Error(`NSH crate ${pkg.name} must come from crates.io in stable mode, got ${pkg.source}`);
    }
    if (pkg.version !== pin.version) {
      throw new Error(`NSH crate ${pkg.name} version ${pkg.version} !== pinned ${pin.version}`);
    }
    return;
  }
  const expectedPrefix = `git+${pin.sourceRepo}`;
  const expectedFragment = `#${pin.commit}`;
  if (!pkg.source.startsWith(expectedPrefix) || !pkg.source.endsWith(expectedFragment)) {
    throw new Error(
      `NSH crate ${pkg.name} resolved to ${pkg.source}, expected ${expectedPrefix}?rev=${pin.commit}${expectedFragment}`,
    );
  }
}

export function verifyCargoMetadataNshProvenance(metadata, pin) {
  if (!metadata || !Array.isArray(metadata.packages)) {
    throw new Error('cargo metadata output missing packages array');
  }
  const isGeneratedRunnerCrate = pkg =>
    pkg.name.startsWith('nsh-app-')
    && typeof pkg.manifest_path === 'string'
    && /[/\\]\.nsh[/\\]rust[/\\]/.test(pkg.manifest_path);
  const nshPackages = metadata.packages.filter(
    pkg => (pkg.name === 'nsh' || pkg.name.startsWith('nsh-')) && !isGeneratedRunnerCrate(pkg),
  );
  if (nshPackages.length === 0) {
    throw new Error('cargo metadata contains no nsh or nsh-* packages');
  }

  const sourcesByCrate = collectNshSourcesByCrate(nshPackages);
  const seenSources = new Set();
  for (const pkg of nshPackages) {
    assertPinnedNshPackageSource(pkg, pin);
    seenSources.add(pkg.source);
  }

  if (seenSources.size !== 1) {
    const details = [...sourcesByCrate.entries()]
      .map(([name, sources]) => `${name}=${[...sources].join('|')}`)
      .join(', ');
    throw new Error(
      `Multiple NSH crate sources resolved in one lockfile: ${[...seenSources].sort().join(', ')} (${details})`,
    );
  }

  return {
    count: nshPackages.length,
    source: [...seenSources][0],
  };
}

export function verifyCapabilitiesAgainstGolden(actual, expected) {
  assert.deepStrictEqual(actual, expected, 'Built capabilities.json diverges from golden capabilities.expected.json');
  assert.equal(actual.application, true, 'ADR-052 D2 requires application: true');
  assert.deepStrictEqual(actual.openUrl, { schemes: ['https'] }, 'ADR-052 D2 restricts openUrl to https only');
  assert.equal(actual.webview, undefined, 'ADR-052 D2 forbids webview capability');
  assert.equal(actual.host, undefined, 'ADR-052 D2 forbids host capability');
  assert.equal(Boolean(actual.statusBar), false, 'ADR-052 D2 forbids statusBar capability');
  assert.equal(Boolean(actual.clipboard), false, 'ADR-052 D2 forbids clipboard capability');
  assert.equal(Boolean(actual.picker), false, 'ADR-052 D2 forbids picker capability');
  assert.equal(Boolean(actual.speech), false, 'ADR-052 D2 forbids speech capability');
  assert.equal(Boolean(actual.notifications), false, 'ADR-052 D2 forbids notifications capability');

  assert.deepStrictEqual(actual.process?.execute ?? [], [], 'ADR-052 D2 forbids process.execute');
  assert.equal(actual.process?.exit ?? false, false, 'ADR-052 D2 forbids process.exit');
  assert.deepStrictEqual(actual.process?.env ?? [], [], 'ADR-052 D2 forbids process.env');
  assert.deepStrictEqual(actual.fs?.read ?? [], [], 'ADR-052 D2 forbids fs.read');
  assert.deepStrictEqual(actual.fs?.write ?? [], [], 'ADR-052 D2 forbids fs.write');
  assert.deepStrictEqual(actual.network?.hosts ?? [], [], 'ADR-052 D2 forbids network.hosts');
  assert.deepStrictEqual(actual.network?.http ?? [], [], 'ADR-052 D2 forbids network.http');
  assert.deepStrictEqual(actual.network?.sockets ?? [], [], 'ADR-052 D2 forbids network.sockets');
}

function checkBinaryVersion(binPath, pin) {
  const out = execFileSync(binPath, ['--version'], { encoding: 'utf8' });
  assertNshVersion(out, pin);
  return binPath;
}

export function pinnedInstallRoot(pin) {
  return join(REPO_ROOT, '_ops', 'nsh-pinned', pin.commit);
}

function findInstalledBinary(root) {
  const exe = process.platform === 'win32' ? 'nsh.exe' : 'nsh';
  const candidates = [
    join(root, 'nsh', 'bin', exe),
    join(root, 'bin', exe),
    join(root, exe),
  ];
  return candidates.find(candidate => existsSync(candidate));
}

async function downloadFile(url, destPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
}

function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
    return;
  }
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync(
        'pwsh',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`],
        { stdio: 'inherit' },
      );
    } else {
      execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' });
    }
    return;
  }
  throw new Error(`Unsupported NSH archive extension: ${archivePath}`);
}

export async function ensurePinnedNsh(pin = loadPin()) {
  const overrideBin = process.env.BYOK_NSH_BIN?.trim();
  if (overrideBin) {
    if (!existsSync(overrideBin)) {
      throw new Error(`BYOK_NSH_BIN does not exist: ${overrideBin}`);
    }
    return checkBinaryVersion(overrideBin, pin);
  }

  const root = pinnedInstallRoot(pin);
  const cached = findInstalledBinary(root);
  if (cached) {
    return checkBinaryVersion(cached, pin);
  }

  const key = assetKeyForPlatform();
  const asset = pin.assets[key];
  if (!asset) {
    throw new Error(`No pinned NSH CLI asset for platform ${key}; use \`build-cli-from-source\``);
  }

  const baseUrl = process.env.BYOK_NSH_RELEASE_BASE ?? `${pin.sourceRepo}/releases/download/${pin.releaseTag}`;
  const url = `${baseUrl}/${asset.file}`;
  const downloadsDir = join(REPO_ROOT, '_ops', 'nsh-pinned', 'downloads');
  const archivePath = join(downloadsDir, `${pin.shortCommit}-${asset.file}`);

  try {
    await downloadFile(url, archivePath);
    verifyFileSha256(archivePath, asset.sha256);
  } catch (error) {
    rmSync(archivePath, { force: true });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n`
      + `Note: the upstream '${pin.releaseTag}' release tag moves on new nightlies. `
      + `If the archive changed or moved, run \`node examples/desktop-bot-app/scripts/nsh.mjs build-cli-from-source\` `
      + `or provide BYOK_NSH_BIN pointing to pinned ${pin.shortCommit}.`,
    );
  }

  rmSync(root, { recursive: true, force: true });
  extractArchive(archivePath, root);
  const installed = findInstalledBinary(root);
  if (!installed) {
    throw new Error(`Extracted ${archivePath} into ${root} but found no nsh binary`);
  }
  if (process.platform !== 'win32') {
    chmodSync(installed, 0o755);
  }
  return checkBinaryVersion(installed, pin);
}

/** Reads the single pinned Rust toolchain channel from the adapter crate's `rust-toolchain.toml`. */
export function readPinnedRustToolchain(toolchainPath = ADAPTER_TOOLCHAIN_PATH) {
  const raw = readFileSync(toolchainPath, 'utf8');
  const match = /^\s*channel\s*=\s*"([^"]+)"/m.exec(raw);
  if (!match || !match[1].trim()) {
    throw new Error(`Pinned Rust toolchain channel missing in ${toolchainPath}`);
  }
  return match[1];
}

function rustToolEnv(baseEnv = process.env) {
  if (baseEnv.RUSTUP_TOOLCHAIN?.trim()) {
    return baseEnv;
  }
  return { ...baseEnv, RUSTUP_TOOLCHAIN: readPinnedRustToolchain() };
}

/**
 * Build environment for source-building the pinned `nsh-cli`.
 * Stamps `NSH_CHANNEL` (`crates/nsh-cli/build.rs:94-101`) so a nightly CLI selects
 * `Nsh::Nightly(rev)` and emits `[patch.crates-io]` for every `nsh-*` crate in generated
 * `.nsh/rust` workspaces (`crates/nsh-cli/src/rust_app.rs:542-574, 3419-3431`), and disables
 * upstream's `Cargo.toml` fat-LTO / single-CGU release profile (`opt-level=2`, `lto=off`,
 * `codegen-units=16`) so cold source builds finish well within the 3-OS CI budget.
 */
export function buildCliFromSourceEnv(pin, baseEnv = process.env) {
  const env = {
    ...rustToolEnv(baseEnv),
    NSH_CHANNEL: pin.channel === 'nightly' ? 'nightly' : 'stable',
    CARGO_PROFILE_RELEASE_LTO: baseEnv.CARGO_PROFILE_RELEASE_LTO?.trim() || 'off',
    CARGO_PROFILE_RELEASE_OPT_LEVEL: baseEnv.CARGO_PROFILE_RELEASE_OPT_LEVEL?.trim() || '2',
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: baseEnv.CARGO_PROFILE_RELEASE_CODEGEN_UNITS?.trim() || '16',
  };
  if (pin.channel === 'nightly' && typeof pin.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(pin.date)) {
    const parsed = Date.parse(`${pin.date}T00:00:00Z`);
    if (Number.isFinite(parsed) && parsed >= 0) {
      env.SOURCE_DATE_EPOCH = String(Math.floor(parsed / 1000));
    }
  }
  return env;
}

export function buildCliFromSource(pin = loadPin()) {
  const root = pinnedInstallRoot(pin);
  mkdirSync(root, { recursive: true });
  execFileSync(
    'cargo',
    ['install', '--git', pin.sourceRepo, '--rev', pin.commit, '--locked', '--force', '--root', root, 'nsh-cli'],
    { stdio: 'inherit', env: buildCliFromSourceEnv(pin) },
  );
  const exe = process.platform === 'win32' ? 'nsh.exe' : 'nsh';
  const installed = join(root, 'bin', exe);
  return checkBinaryVersion(installed, pin);
}

/** Runs `cargo metadata` on `manifestPath` and enforces single-source pinned `nsh-*` provenance. */
export function verifyManifestNshProvenance(
  manifestPath,
  pin = loadPin(),
  { cargoBin = 'cargo', env = rustToolEnv(), locked = false } = {},
) {
  const args = ['metadata', '--format-version', '1'];
  if (locked) {
    args.push('--locked');
  }
  args.push('--manifest-path', manifestPath);
  const raw = execFileSync(cargoBin, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  return verifyCargoMetadataNshProvenance(JSON.parse(raw), pin);
}

const CARGO_COMPILE_SUBCOMMANDS = new Set(['build', 'check', 'test', 'run', 'rustc']);

export function parseCargoInvocation(args, cwd = process.cwd()) {
  let subcommand = null;
  let manifestPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '--manifest-path' && i + 1 < args.length) {
      manifestPath = resolve(cwd, args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--manifest-path=')) {
      manifestPath = resolve(cwd, arg.slice('--manifest-path='.length));
      continue;
    }
    if (subcommand === null && !arg.startsWith('-') && !arg.startsWith('+')) {
      subcommand = arg;
    }
  }
  return {
    subcommand,
    manifestPath: manifestPath ?? resolve(cwd, 'Cargo.toml'),
  };
}

export function isGeneratedRunnerManifest(manifestPath) {
  return /(?:^|[/\\])\.nsh[/\\]rust[/\\](?:[^/\\]+[/\\])?Cargo\.toml$/.test(manifestPath);
}

/**
 * Guards `cargo` invocations made by `nsh` so a generated `.nsh/rust` workspace whose dependency
 * graph resolves any `nsh-*` crate from more than one source (or a non-pinned source) fails closed
 * before `cargo` compiles.
 */
export function runCargoGuard(
  args,
  {
    pin = loadPin(),
    realCargo = process.env.BYOK_REAL_CARGO?.trim() || 'cargo',
    realCargoWasSet = process.env.BYOK_REAL_CARGO_SET === '1',
    env = process.env,
    cwd = process.cwd(),
    spawn = spawnSync,
    verifyManifest = verifyManifestNshProvenance,
  } = {},
) {
  const cleanEnv = { ...env };
  delete cleanEnv.BYOK_REAL_CARGO;
  delete cleanEnv.BYOK_REAL_CARGO_SET;
  if (realCargoWasSet) {
    cleanEnv.CARGO = realCargo;
  } else {
    delete cleanEnv.CARGO;
  }

  const { subcommand, manifestPath } = parseCargoInvocation(args, cwd);
  if (subcommand && CARGO_COMPILE_SUBCOMMANDS.has(subcommand) && isGeneratedRunnerManifest(manifestPath)) {
    verifyManifest(manifestPath, pin, { cargoBin: realCargo, env: cleanEnv, locked: false });
  }

  const result = spawn(realCargo, args, {
    cwd,
    stdio: 'inherit',
    env: cleanEnv,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function withCargoGuardEnv(baseEnv, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'byok-nsh-cargo-guard-'));
  try {
    const isWin = process.platform === 'win32';
    const shimPath = join(dir, isWin ? 'cargo-guard.cmd' : 'cargo-guard');
    if (isWin) {
      writeFileSync(
        shimPath,
        `@echo off\r\n"${process.execPath}" "${SCRIPT_PATH}" __cargo-guard %*\r\nexit /b %ERRORLEVEL%\r\n`,
      );
    } else {
      writeFileSync(
        shimPath,
        `#!/bin/sh\nexec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(SCRIPT_PATH)} __cargo-guard "$@"\n`,
      );
      chmodSync(shimPath, 0o755);
    }
    const realCargoWasSet = Boolean(baseEnv.CARGO?.trim());
    const realCargo = realCargoWasSet ? baseEnv.CARGO.trim() : 'cargo';
    return fn({
      ...baseEnv,
      CARGO: shimPath,
      BYOK_REAL_CARGO: realCargo,
      BYOK_REAL_CARGO_SET: realCargoWasSet ? '1' : '0',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runVerifyLock(args, pin) {
  let manifest;
  let all = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--manifest' && args[i + 1]) {
      manifest = resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === '--all') {
      all = true;
    } else {
      throw new Error(`Unknown verify-lock option: ${args[i]}`);
    }
  }

  const targets = manifest ? [manifest] : [ADAPTER_MANIFEST];
  if (!manifest && (all || existsSync(GENERATED_RUNNER_MANIFEST))) {
    if (!existsSync(GENERATED_RUNNER_MANIFEST)) {
      throw new Error(`--all specified but generated runner manifest is missing at ${GENERATED_RUNNER_MANIFEST}`);
    }
    targets.push(GENERATED_RUNNER_MANIFEST);
  }

  const env = rustToolEnv();
  for (const manifestPath of targets) {
    const result = verifyManifestNshProvenance(manifestPath, pin, { env, locked: true });
    console.log(`verify-lock OK (${manifestPath}): ${result.count} nsh crates -> ${result.source}`);
  }
}

/**
 * ADR-052 D2 proof #1, source side: `nsh.json` declares exactly the signed D2 capabilities and configures no signed
 * packages (`updater.packages`), so no `.nshpkg` can replace the bundle over the air.
 */
export function verifyAppConfig(config) {
  assert.deepStrictEqual(
    config?.capabilities,
    D2_DECLARED_CAPABILITIES,
    'nsh.json capabilities must equal the ADR-052 D2 set exactly',
  );
  assert.equal(config.updater?.packages, undefined, 'ADR-052 D2 forbids updater.packages in nsh.json');
}

/** The updater configuration's file names: `nsh package` stages `.nsh-updater.json` and ships `nsh-updater.json`. */
const UPDATER_CONFIG_NAMES = new Set(['nsh-updater.json', '.nsh-updater.json']);

/**
 * ADR-052 D2 proof #1, output side: no updater configuration anywhere under `outDir` (a build output, or a package
 * with its `nsh/assets/nsh-updater.json`) takes signed packages (`Config`, camelCase: `packages: { roots }`).
 */
export function verifyNoUpdaterPackages(outDir) {
  const configs = readdirSync(outDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && UPDATER_CONFIG_NAMES.has(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  for (const path of configs) {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const packages = config.packages ?? null;
    assert.ok(
      packages === null || (Array.isArray(packages.roots) && packages.roots.length === 0),
      `ADR-052 D2 forbids signed packages: ${path} has packages.roots ${JSON.stringify(packages?.roots)}`,
    );
  }
}

function runVerifyCapabilities(args) {
  let builtPath = DEFAULT_BUILT_CAPABILITIES;
  let expectedPath = DEFAULT_EXPECTED_CAPABILITIES;
  let appConfigPath = DEFAULT_APP_CONFIG;
  let outputDir = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--built' && args[i + 1]) {
      builtPath = resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === '--expected' && args[i + 1]) {
      expectedPath = resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === '--app-config' && args[i + 1]) {
      appConfigPath = resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = resolve(args[i + 1]);
      i += 1;
    } else {
      throw new Error(`Unknown verify-capabilities option: ${args[i]}`);
    }
  }

  verifyAppConfig(JSON.parse(readFileSync(appConfigPath, 'utf8')));
  outputDir ??= dirname(builtPath);
  verifyNoUpdaterPackages(outputDir);
  const actual = JSON.parse(readFileSync(builtPath, 'utf8'));
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  verifyCapabilitiesAgainstGolden(actual, expected);
  console.log(
    `verify-capabilities OK (${appConfigPath} declares the D2 set without updater.packages; no signed packages under ${outputDir}; ${builtPath} === ${expectedPath})`,
  );
}

function forbiddenSourceRoots(name) {
  const roots = [`node_modules/${name}/`];
  if (name.startsWith(WORKSPACE_SCOPE)) {
    roots.push(`packages/${name.slice(WORKSPACE_SCOPE.length)}/`);
  }
  return roots;
}

/** Reads the release source map next to the bundle; a missing or unparsable map fails closed. */
export function readBundleSourceMap(mapPath) {
  if (!existsSync(mapPath)) {
    throw new Error(`Bundle source map not found: ${mapPath} (verify-bundle needs the map from build --release)`);
  }
  let map;
  try {
    map = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch (error) {
    throw new Error(`Bundle source map is not valid JSON: ${mapPath} (${error.message})`);
  }
  if (!Array.isArray(map?.sources) || map.sources.length === 0 || !map.sources.every((entry) => typeof entry === 'string')) {
    throw new Error(`Bundle source map has no string sources list: ${mapPath}`);
  }
  return map;
}

function resolveBundleSourcePath(entry, sourceBase, sourceRoot) {
  if (entry.startsWith('file://')) {
    return fileURLToPath(entry);
  }
  return sourceRoot ? resolve(sourceBase, sourceRoot, entry) : resolve(sourceBase, entry);
}

/**
 * Rejects a bundle whose source map shows a module from a forbidden package. Source map entries
 * are resolved against `sourceBase` (`dirname(bundlePath)`) and compared by path segment against
 * `node_modules/<name>/` and, for workspace packages, the repo's `packages/<dir>/`.
 */
export function verifyBundleSources(map, { sourceBase = dirname(DEFAULT_BUILT_BUNDLE), repoRoot = REPO_ROOT } = {}) {
  const roots = FORBIDDEN_BUNDLE_PACKAGES.flatMap(forbiddenSourceRoots);
  const sourceRoot = typeof map?.sourceRoot === 'string' && map.sourceRoot ? map.sourceRoot : '';
  for (const entry of map.sources) {
    const resolvedPath = resolveBundleSourcePath(entry, sourceBase, sourceRoot);
    const resolved = resolvedPath.replaceAll('\\', '/');
    const repoRelative = relative(repoRoot, resolvedPath).replaceAll('\\', '/');
    const candidate = `/${repoRelative.startsWith('..') ? resolved : repoRelative}`;
    const root = roots.find((r) => candidate.includes(`/${r}`));
    assert.ok(root === undefined, `Forbidden module source in TSX bundle: ${entry} (under ${root})`);
  }
}

function forbiddenSpecifier(specifier) {
  if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(specifier.split('/')[0])) {
    return 'Node builtin';
  }
  return FORBIDDEN_BUNDLE_PACKAGES.find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function normalizeTsPath(filePath) {
  const posix = filePath.replaceAll('\\', '/');
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

function unwrapParens(node) {
  let current = node;
  while (current?.kind === K.ParenthesizedExpression) {
    current = current.expression;
  }
  return current;
}

function staticModuleSpecifier(node) {
  const inner = unwrapParens(node);
  if (inner?.kind === K.StringLiteral || inner?.kind === K.NoSubstitutionTemplateLiteral) {
    return inner.text;
  }
  return null;
}

function extractSpecifiersFromAst(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (node.kind === K.ImportDeclaration) {
      const specifier = staticModuleSpecifier(node.moduleSpecifier);
      if (specifier !== null) specifiers.push(specifier);
    } else if (node.kind === K.ExportDeclaration) {
      const specifier = staticModuleSpecifier(node.moduleSpecifier);
      if (specifier !== null) specifiers.push(specifier);
    } else if (node.kind === K.CallExpression) {
      const callee = unwrapParens(node.expression);
      if (
        callee?.kind === K.ImportKeyword
        || (callee?.kind === K.Identifier && callee.text === 'require')
      ) {
        const specifier = staticModuleSpecifier(node.arguments[0]);
        if (specifier !== null) specifiers.push(specifier);
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return specifiers;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current?.kind === K.ParenthesizedExpression
    || current?.kind === K.AsExpression
    || current?.kind === K.SatisfiesExpression
  ) {
    current = current.expression;
  }
  return current;
}

function staticString(node) {
  const inner = unwrapExpression(node?.kind === K.JsxExpression ? node.expression : node);
  return inner?.kind === K.StringLiteral || inner?.kind === K.NoSubstitutionTemplateLiteral ? inner.text : null;
}

const propertyNameText = (name) =>
  name?.kind === K.Identifier || name?.kind === K.StringLiteral ? name.text : null;

/**
 * Lists the release-isolation findings in one source module: a `links` prop that is not a static string other than
 * `"open"`, a `links: "open"` object property, a `TextView` whose spread could supply `links` without a later static
 * `links` prop (model output must never open links itself; the default is `"report"`), and any `openUrl` name or
 * string (`links.ts` is its one gate).
 */
function isolationFindingsFromAst(sourceFile) {
  const textViewNames = new Set(['TextView']);
  const collectAliases = (node) => {
    if (node.kind === K.ImportSpecifier && (node.propertyName ?? node.name)?.text === 'TextView') {
      textViewNames.add(node.name.text);
    }
    node.forEachChild(collectAliases);
  };
  collectAliases(sourceFile);
  const isTextView = (tag) =>
    (tag?.kind === K.Identifier && textViewNames.has(tag.text))
    || (tag?.kind === K.PropertyAccessExpression && tag.name?.text === 'TextView');

  const findings = [];
  const visit = (node) => {
    if ((node.kind === K.JsxOpeningElement || node.kind === K.JsxSelfClosingElement) && isTextView(node.tagName)) {
      const attributes = node.attributes.properties;
      const lastSpread = attributes.findLastIndex((attribute) => attribute.kind === K.JsxSpreadAttribute);
      const linksAfter = attributes.some(
        (attribute, index) => index > lastSpread && attribute.kind === K.JsxAttribute && attribute.name?.text === 'links',
      );
      if (lastSpread >= 0 && !linksAfter) {
        findings.push('a TextView spread without a later links="report"');
      }
    }
    if (node.kind === K.JsxAttribute && node.name?.text === 'links') {
      const value = staticString(node.initializer);
      if (value === null || value === 'open') {
        findings.push(value === 'open' ? 'links="open"' : 'a links prop without a static value');
      }
    } else if (
      node.kind === K.PropertyAssignment
      && propertyNameText(node.name) === 'links'
      && staticString(node.initializer) === 'open'
    ) {
      findings.push('links: "open"');
    } else if (
      (node.kind === K.Identifier || node.kind === K.StringLiteral || node.kind === K.NoSubstitutionTemplateLiteral)
      && node.text === 'openUrl'
    ) {
      findings.push('openUrl');
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return findings;
}

/**
 * Parses each entry (`{ label, source, ext, visit }`) with the TypeScript AST parser and returns `visit(sourceFile)`
 * per entry; a syntax error fails closed naming the entry.
 */
function parseBatch(entries) {
  const root = DESKTOP_APP_DIR.replaceAll('\\', '/');
  const configPath = `${root}/.__verify-bundle.tsconfig.json`;
  const virtualPaths = entries.map((entry, index) => `${root}/.__verify-bundle-${index}${entry.ext}`);
  const virtualFiles = new Map([
    [
      normalizeTsPath(configPath),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          jsx: 'preserve',
          noResolve: true,
          noLib: true,
          target: 'esnext',
          module: 'esnext',
        },
        files: virtualPaths,
      }),
    ],
  ]);
  for (let i = 0; i < entries.length; i += 1) {
    virtualFiles.set(normalizeTsPath(virtualPaths[i]), entries[i].source);
  }

  const api = new TsApi({
    cwd: root,
    fs: {
      readFile: (file) => virtualFiles.get(normalizeTsPath(file)),
      fileExists: (file) => (virtualFiles.has(normalizeTsPath(file)) ? true : undefined),
    },
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const program = snapshot.getProject(configPath)?.program;
    if (!program) {
      throw new Error('TypeScript parser did not open the bundle verification project');
    }
    return entries.map((entry, index) => {
      const virtualPath = virtualPaths[index];
      const diagnostics = program.getSyntacticDiagnostics(virtualPath);
      if (diagnostics.length > 0) {
        throw new Error(
          `Bundled TSX output failed to parse (${entry.label}): ${diagnostics[0].text}`,
        );
      }
      const sourceFile = program.getSourceFile(virtualPath);
      if (!sourceFile) {
        throw new Error(`TypeScript parser did not produce an AST for ${entry.label}`);
      }
      return entry.visit(sourceFile);
    });
  } finally {
    api.close();
  }
}

function assertSpecifiersClear(specifiers, label) {
  for (const specifier of specifiers) {
    const rule = forbiddenSpecifier(specifier);
    assert.ok(
      rule === undefined,
      `Forbidden module specifier in TSX bundle (${label}): ${specifier} (${rule})`,
    );
  }
}

/**
 * Parses bundled TSX output with the TypeScript AST parser and rejects import, export, dynamic
 * `import()`, or `require()` specifiers that name a Node builtin or a forbidden package.
 */
export function verifyBundleSpecifiers(source, label = 'bundle.js') {
  assert.equal(typeof source, 'string', 'Bundled TSX output must be a string');
  assert.ok(source.trim().length > 0, 'Bundled TSX output must not be empty');
  const [specifiers] = parseBatch([{ label, source, ext: '.mjs', visit: extractSpecifiersFromAst }]);
  assertSpecifiersClear(specifiers, label);
}

/**
 * Lists the entry bundle and every emitted split JS chunk under `dirname(bundlePath)`
 * (excluding copied static files under `assets/`), failing closed on missing entry or orphan maps.
 */
export function collectBundleChunks(bundlePath) {
  const entryPath = resolve(bundlePath);
  if (!existsSync(entryPath)) {
    throw new Error(`Bundle entry not found: ${entryPath}`);
  }
  const outDir = dirname(entryPath);
  const chunks = new Set([entryPath]);
  const mapFiles = [];

  const walk = (dir, isRoot) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isRoot && entry.isDirectory() && entry.name === 'assets') {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, false);
      } else if (entry.isFile()) {
        if (/\.(?:js|mjs)$/.test(entry.name)) {
          chunks.add(full);
        } else if (/\.(?:js|mjs)\.map$/.test(entry.name)) {
          mapFiles.push(full);
        }
      }
    }
  };
  walk(outDir, true);

  for (const mapFile of mapFiles.sort()) {
    const expectedChunk = mapFile.slice(0, -'.map'.length);
    if (!chunks.has(expectedChunk)) {
      throw new Error(`Orphan bundle source map without JS chunk: ${mapFile}`);
    }
  }

  const rest = [...chunks].filter((file) => file !== entryPath).sort();
  return [entryPath, ...rest];
}

const normalizeMapSource = (entry) => entry.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');

/**
 * ADR-052 D2 proof #3, bundle side, for one chunk: no Gallery module or Gallery-only text, and the modules the map
 * names (parsed from `sourcesContent`, which must be present and, for a file that exists on disk relative to `appDir`,
 * equal it) use `openUrl` only in `src/links.ts` and never let a `TextView` open links. Returns the parse inputs;
 * `verifyBundle` parses every chunk's in one batch.
 */
function releaseIsolationInputs(chunkPath, source, map, appDir) {
  for (const text of GALLERY_ONLY_TEXT) {
    assert.ok(!source.includes(text), `Release bundle contains Gallery-only text "${text}": ${chunkPath}`);
  }
  if (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length) {
    throw new Error(`Bundle source map has no sourcesContent for each source: ${chunkPath}.map`);
  }
  const inputs = [];
  map.sources.forEach((entry, index) => {
    const name = normalizeMapSource(entry);
    assert.ok(!name.includes(GALLERY_SOURCE_SEGMENT), `Release bundle contains a Gallery module: ${entry} (${chunkPath})`);
    if (!CODE_SOURCE_EXTENSION.test(name)) {
      return;
    }
    const content = map.sourcesContent[index];
    if (typeof content !== 'string') {
      throw new Error(`Bundle source map has no sourcesContent for ${entry}: ${chunkPath}.map`);
    }
    // The check reads the map's copy of the source: it must be the file itself, not output standing in for it.
    const onDisk = resolve(appDir, name);
    if (existsSync(onDisk) && readFileSync(onDisk, 'utf8') !== content) {
      throw new Error(`Bundle source map sourcesContent for ${entry} differs from ${onDisk}: ${chunkPath}.map`);
    }
    inputs.push({
      label: `${entry} (${chunkPath})`,
      source: content,
      ext: extname(name),
      visit: (sourceFile) => {
        for (const finding of isolationFindingsFromAst(sourceFile)) {
          assert.ok(
            finding === 'openUrl' && name === LINKS_SOURCE,
            `Release isolation: ${finding} in ${entry} (${chunkPath}); only ${LINKS_SOURCE} may call openUrl, and TextView links never "open"`,
          );
        }
      },
    });
  });
  return inputs;
}

/**
 * Verifies the entry bundle and every split chunk under `dirname(bundlePath)`: reads each chunk's adjacent source map
 * (resolving `sources` against `dirname(chunkPath)`), validates non-empty JS, checks every AST
 * import/export/dynamic-import/require specifier, and checks release isolation (`releaseIsolationInputs`).
 */
export function verifyBundle(bundlePath, { repoRoot = REPO_ROOT, appDir = NSH_APP_DIR } = {}) {
  const chunkPaths = collectBundleChunks(bundlePath);
  let totalMapSources = 0;
  const parseInputs = [];

  for (const chunkPath of chunkPaths) {
    const mapPath = `${chunkPath}.map`;
    const map = readBundleSourceMap(mapPath);
    verifyBundleSources(map, { sourceBase: dirname(chunkPath), repoRoot });
    totalMapSources += map.sources.length;

    const source = readFileSync(chunkPath, 'utf8');
    assert.ok(source.trim().length > 0, `Bundled TSX output must not be empty: ${chunkPath}`);
    parseInputs.push({
      label: chunkPath,
      source,
      ext: '.mjs',
      visit: (sourceFile) => assertSpecifiersClear(extractSpecifiersFromAst(sourceFile), chunkPath),
    });
    parseInputs.push(...releaseIsolationInputs(chunkPath, source, map, appDir));
  }

  parseBatch(parseInputs);
  return { files: chunkPaths, totalMapSources };
}

function listRustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.rs'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function assertNoDevelopmentPolicy(file) {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    assert.ok(
      !DEVELOPMENT_POLICY_PATTERN.test(line),
      `Release runner code turns off Policy::harden at ${file}:${index + 1}: ${line.trim()}`,
    );
  });
}

/**
 * ADR-052 D2 proof #3, runner side: each generated desktop release runner (`<os>-app/main.rs`) starts its platform's
 * `nsh-<os>-app` runner, whose `Bundle::read_trusted` keeps `Policy::default()` (`harden: true`), and neither it nor
 * the app's own Rust (`appRustSources`) enables `Policy::development()`, `harden: false` or another policy.
 */
export function verifyReleaseRunners({ rustDir = DEFAULT_RUST_WORKSPACE, appRustSources = DEFAULT_APP_RUST_SOURCES } = {}) {
  const files = [];
  for (const os of RELEASE_RUNNER_OSES) {
    const runner = join(rustDir, `${os}-app`, 'main.rs');
    assert.ok(existsSync(runner), `Release runner missing: ${runner} (run build --release first)`);
    assert.ok(
      readFileSync(runner, 'utf8').includes(`nsh_${os}_app::main()`),
      `Release runner ${runner} must start nsh_${os}_app::main()`,
    );
    files.push(runner);
  }
  for (const dir of appRustSources) {
    assert.ok(existsSync(dir), `App Rust sources missing: ${dir}`);
    files.push(...listRustFiles(dir));
  }
  files.forEach(assertNoDevelopmentPolicy);
  return { files };
}

/** Lists regular files and symlinks: the NSH bundler ships a linked density variant like a file. */
function listTrayEntries(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Verifies the NSH tray asset projection matches `examples/desktop-bot-app/assets/tray/`
 * byte-for-byte while Electron and NSH coexist prior to P4 cutover.
 */
export function verifyTrayAssetsProjection({
  sourceDir = DEFAULT_TRAY_ASSETS_SOURCE,
  targetDir = DEFAULT_TRAY_ASSETS_TARGET,
} = {}) {
  assert.ok(existsSync(sourceDir), `Authoritative tray assets directory missing: ${sourceDir}`);
  assert.ok(
    existsSync(targetDir),
    `NSH tray asset projection directory missing: ${targetDir} (mirror ${sourceDir})`,
  );
  const sourceFiles = listTrayEntries(sourceDir);
  assert.ok(sourceFiles.length > 0, `Authoritative tray assets directory is empty: ${sourceDir}`);
  const targetFiles = listTrayEntries(targetDir);
  assert.deepStrictEqual(
    targetFiles,
    sourceFiles,
    `NSH tray asset projection file list diverges from examples/desktop-bot-app/assets/tray/`,
  );
  for (const file of sourceFiles) {
    // A link must reach a regular file: reading a FIFO would block, and a directory or device is no tray asset.
    for (const path of [join(sourceDir, file), join(targetDir, file)]) {
      assert.ok(
        statSync(path, { throwIfNoEntry: false })?.isFile(),
        `Tray asset projection drift for ${file}: ${path} is not a regular file`,
      );
    }
    const sourceBytes = readFileSync(join(sourceDir, file));
    const targetBytes = readFileSync(join(targetDir, file));
    assert.equal(
      Buffer.compare(sourceBytes, targetBytes),
      0,
      `Tray asset projection drift for ${file}: update projection from examples/desktop-bot-app/assets/tray/`,
    );
  }
  return { count: sourceFiles.length, files: sourceFiles };
}

function runVerifyBundle(args) {
  let bundlePath = DEFAULT_BUILT_BUNDLE;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--bundle' && args[i + 1]) {
      bundlePath = resolve(args[i + 1]);
      i += 1;
    } else {
      throw new Error(`Unknown verify-bundle option: ${args[i]}`);
    }
  }
  const { files, totalMapSources } = verifyBundle(bundlePath);
  const runners = verifyReleaseRunners();
  const trayAssets = verifyTrayAssetsProjection();
  console.log(
    `verify-bundle OK (${bundlePath}: ${files.length} bundle/chunk file(s), ${totalMapSources} map sources and AST import/export/require specifiers clear of forbidden packages and Node builtins; no Gallery module or text, openUrl only in ${LINKS_SOURCE}, no links="open"; ${runners.files.length} release runner and app Rust files keep Policy::harden; ${trayAssets.count} tray assets match source)`,
  );
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  const pin = loadPin();

  if (command === '__cargo-guard') {
    process.exitCode = runCargoGuard(rest, { pin });
    return;
  }
  if (command === 'ensure') {
    const bin = await ensurePinnedNsh(pin);
    console.log(bin);
    return;
  }
  if (command === 'build-cli-from-source') {
    const bin = buildCliFromSource(pin);
    console.log(bin);
    return;
  }
  if (command === 'verify-lock') {
    runVerifyLock(rest, pin);
    return;
  }
  if (command === 'verify-capabilities') {
    runVerifyCapabilities(rest);
    return;
  }
  if (command === 'verify-bundle') {
    runVerifyBundle(rest);
    return;
  }
  if (command === 'check' || command === 'build' || command === 'test' || command === 'run') {
    const bin = await ensurePinnedNsh(pin);
    const result = withCargoGuardEnv(rustToolEnv(), (env) =>
      spawnSync(bin, [command, ...rest], {
        cwd: NSH_APP_DIR,
        stdio: 'inherit',
        env,
      }),
    );
    process.exitCode = result.status ?? 1;
    return;
  }

  throw new Error(
    `Usage: node examples/desktop-bot-app/scripts/nsh.mjs <ensure|build-cli-from-source|verify-lock|verify-capabilities|verify-bundle|check|build|test|run> [args...]`,
  );
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
