import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PIN_PATH = resolve(SCRIPT_DIR, 'nsh-pin.json');
const DESKTOP_APP_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(DESKTOP_APP_DIR, '../..');
const NSH_APP_DIR = resolve(DESKTOP_APP_DIR, 'nsh-app');
const ADAPTER_MANIFEST = resolve(NSH_APP_DIR, 'ext/byok-nsh-adapter/Cargo.toml');
const GENERATED_RUNNER_MANIFEST = resolve(NSH_APP_DIR, '.nsh/rust/Cargo.toml');
const DEFAULT_BUILT_CAPABILITIES = resolve(NSH_APP_DIR, '.nsh/out/capabilities.json');
const DEFAULT_EXPECTED_CAPABILITIES = resolve(NSH_APP_DIR, 'capabilities.expected.json');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function loadPin(pinPath = DEFAULT_PIN_PATH) {
  return JSON.parse(readFileSync(pinPath, 'utf8'));
}

export function assetKeyForPlatform(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function assertNshVersion(output, pin) {
  const trimmed = String(output ?? '').trim();
  const pattern = new RegExp(`^nsh\\s+${escapeRegExp(pin.version)}\\s+\\(${escapeRegExp(pin.shortCommit)}(?:\\s|\\))`);
  if (!pattern.test(trimmed)) {
    throw new Error(
      `NSH CLI version mismatch: expected nsh ${pin.version} (${pin.shortCommit} ...), got ${JSON.stringify(trimmed)}`,
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

  const seenSources = new Set();
  for (const pkg of nshPackages) {
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
    } else {
      const expectedPrefix = `git+${pin.sourceRepo}`;
      const expectedFragment = `#${pin.commit}`;
      if (!pkg.source.startsWith(expectedPrefix) || !pkg.source.endsWith(expectedFragment)) {
        throw new Error(
          `NSH crate ${pkg.name} resolved to ${pkg.source}, expected ${expectedPrefix}?rev=${pin.commit}${expectedFragment}`,
        );
      }
    }
    seenSources.add(pkg.source);
  }

  if (seenSources.size !== 1) {
    throw new Error(`Multiple NSH crate sources resolved in one lockfile: ${[...seenSources].join(', ')}`);
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

function pinnedInstallRoot(pin) {
  return join(REPO_ROOT, '_ops', 'nsh-pinned', pin.shortCommit);
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

export function buildCliFromSource(pin = loadPin()) {
  const root = pinnedInstallRoot(pin);
  mkdirSync(root, { recursive: true });
  execFileSync(
    'cargo',
    ['install', '--git', pin.sourceRepo, '--rev', pin.commit, '--locked', '--root', root, 'nsh-cli'],
    { stdio: 'inherit' },
  );
  const exe = process.platform === 'win32' ? 'nsh.exe' : 'nsh';
  const installed = join(root, 'bin', exe);
  return checkBinaryVersion(installed, pin);
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

  for (const manifestPath of targets) {
    const raw = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifestPath], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const result = verifyCargoMetadataNshProvenance(JSON.parse(raw), pin);
    console.log(`verify-lock OK (${manifestPath}): ${result.count} nsh crates -> ${result.source}`);
  }
}

function runVerifyCapabilities(args) {
  let builtPath = DEFAULT_BUILT_CAPABILITIES;
  let expectedPath = DEFAULT_EXPECTED_CAPABILITIES;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--built' && args[i + 1]) {
      builtPath = resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === '--expected' && args[i + 1]) {
      expectedPath = resolve(args[i + 1]);
      i += 1;
    } else {
      throw new Error(`Unknown verify-capabilities option: ${args[i]}`);
    }
  }

  const actual = JSON.parse(readFileSync(builtPath, 'utf8'));
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  verifyCapabilitiesAgainstGolden(actual, expected);
  console.log(`verify-capabilities OK (${builtPath} === ${expectedPath})`);
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  const pin = loadPin();

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
  if (command === 'check' || command === 'build' || command === 'test' || command === 'run') {
    const bin = await ensurePinnedNsh(pin);
    const result = spawnSync(bin, [command, ...rest], {
      cwd: NSH_APP_DIR,
      stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
    return;
  }

  throw new Error(
    `Usage: node examples/desktop-bot-app/scripts/nsh.mjs <ensure|build-cli-from-source|verify-lock|verify-capabilities|check|build|test|run> [args...]`,
  );
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
