import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// #1103: install one runtime CLI for the runtime contract suite and hand its
// path (and, for a latest run, its version) to the suite through GITHUB_ENV.
// The qualified versions are read from their single authorities, never copied.

const root = resolve(import.meta.dirname, '../..');

export const RUNTIMES = Object.freeze(['pi', 'claude', 'codex', 'grok', 'dsh', 'agy', 'opencode1', 'opencode2']);

/** npm packages of the CLIs the SDK does not bundle. */
export const NPM_PACKAGES = Object.freeze({
  claude: { name: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { name: '@openai/codex', bin: 'codex' },
  grok: { name: '@xai-official/grok', bin: 'grok' },
  dsh: { name: '@deepseek-ai/dsh', bin: 'dsh' },
  opencode1: { name: 'opencode-ai', bin: 'opencode', winBin: 'opencode-ai/bin/opencode.exe' },
  opencode2: { name: '@opencode/cli', bin: 'opencode', winBin: '@opencode/cli/bin/opencode.exe' },
});

/**
 * The official agy CLI archives of the qualified release, from its platform
 * updater manifests. agy is not on npm. A qualification bump changes both.
 */
const AGY_ARCHIVE_ROOT = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-6386224290725888';
export const AGY_QUALIFIED = Object.freeze({
  version: '1.5.18',
  archives: Object.freeze({
    'linux-x64': { url: `${AGY_ARCHIVE_ROOT}/linux-x64/cli_linux_x64.tar.gz`, sha512: 'ef379ec869719112f696e8c7cfddf776618712e58fc38e53df80801d6528abb4677782c7c8778f9c09c9123fa44c2c32675d228c06f2a8f7a8f4214e75f5bb26' },
    'darwin-arm64': { url: `${AGY_ARCHIVE_ROOT}/darwin-arm/cli_mac_arm64.tar.gz`, sha512: 'd10e124f5eb4da94ebb6c494cd2e7b38744f9f66e8e87145d2cbad1cbd3c4160fd88a79cd4220dfce7c9da0ddead652346bcc839914575f6447438ae8d1d5dcc' },
    'darwin-x64': { url: `${AGY_ARCHIVE_ROOT}/darwin-x64/cli_mac_x64.tar.gz`, sha512: 'c6ab39b41511ee0951223b6c178e0571e83105800701041d9abc520161ef0381724425ec6e9273fbc609411941c8986ed9aafd711b1a3f86857c705efe3ac2a0' },
    'win32-x64': { url: `${AGY_ARCHIVE_ROOT}/windows-x64/cli_windows_x64.exe`, sha512: '53605db7013dfed51e8c416d51e0c17a3b5ad0750c13da5669954ba4a281318746be0cf8cde2b256cfdb4bfbdade4badad1a0503931f8458416184549afa06b6' },
  }),
});

/** Each runtime's qualified version, from the adapter's own constant or the client manifest. */
export async function qualifiedVersions(repoRoot = root) {
  const adapters = join(repoRoot, 'packages/client/src/adapters');
  const load = async (file, name) => (await import(pathToFileURL(join(adapters, file)).href))[name];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, 'packages/client/package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`packages/client/package.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pin = manifest?.byok?.piRuntimePin;
  if (typeof pin !== 'string') throw new Error('packages/client/package.json has no byok.piRuntimePin');
  return {
    pi: pin,
    claude: await load('claude/claude-version.ts', 'QUALIFIED_CLAUDE_VERSION'),
    codex: await load('codex/codex-version.ts', 'QUALIFIED_CODEX_VERSION'),
    grok: await load('grok/grok-version.ts', 'QUALIFIED_GROK_VERSION'),
    dsh: await load('dsh/dsh-version.ts', 'QUALIFIED_DSH_VERSION'),
    agy: await load('antigravity/agy-version.ts', 'QUALIFIED_AGY_VERSION'),
    opencode1: await load('opencode/opencode-version.ts', 'CONTRACT_OPENCODE_V1_VERSION'),
    opencode2: await load('opencode/opencode-version.ts', 'QUALIFIED_OPENCODE_VERSION'),
  };
}

/** The GITHUB_ENV lines the suite reads. A qualified run needs no version: the suite reads the same authority. */
export function contractEnv(runtime, bin, latestVersion) {
  const key = runtime.toUpperCase();
  return [`BYOK_CONTRACT_${key}_BIN=${bin}`, ...(latestVersion === undefined ? [] : [`BYOK_CONTRACT_${key}_VERSION=${latestVersion}`])];
}

/** One exact npm version; dsh publishes only prereleases (`0.2.1-rc.5`). */
export const isExactVersion = (version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version);

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();

/** npm is `npm.cmd` on Windows, which Node runs only through a shell; every argument here is a fixed, validated token. */
function npm(args, options = {}) {
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', ...(process.platform === 'win32' ? { shell: true } : {}), ...options });
}

const npmRuntimeLocks = join(root, 'scripts/ci/vendor/npm-runtimes');
// pi-ai 1.5.2 was published without its matching pi-schema on 2026-11-10.
const DSH_LOCK_BEFORE = '2026-11-10T12:20:45.000Z';

export function updateNpmLock(runtime, version, vendor = npmRuntimeLocks, npmCommand = npm) {
  const pkg = NPM_PACKAGES[runtime];
  if (pkg === undefined) throw new Error(`no npm runtime ${JSON.stringify(runtime)}`);
  if (!isExactVersion(version)) throw new Error(`${pkg.name}: not an exact version: ${JSON.stringify(version)}`);
  const dir = join(vendor, runtime);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ private: true, dependencies: { [pkg.name]: version } }, null, 2)}\n`);
  // Discard the old resolution so this command actually regenerates the tree.
  rmSync(join(dir, 'package-lock.json'), { force: true });
  npmCommand(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', ...(runtime === 'dsh' ? [`--before=${DSH_LOCK_BEFORE}`] : [])], { cwd: dir, stdio: 'inherit' });
}

export function installNpm(runtime, mode, version, dir, npmCommand = npm, vendor = npmRuntimeLocks) {
  const { name, bin, winBin } = NPM_PACKAGES[runtime];
  const exact = mode === 'latest' ? npmCommand(['view', name, 'version'], { stdio: ['ignore', 'pipe', 'inherit'] }).trim() : version;
  if (!isExactVersion(exact)) throw new Error(`${name}: not an exact version: ${JSON.stringify(exact)}`);
  mkdirSync(dir, { recursive: true });
  if (mode === 'qualified') {
    const source = join(vendor, runtime);
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'));
    if (manifest.dependencies?.[name] !== exact || lock.packages?.['']?.dependencies?.[name] !== exact || lock.packages?.[`node_modules/${name}`]?.version !== exact)
      throw new Error(`${name}: npm runtime lock does not match qualified version ${exact}`);
    copyFileSync(join(source, 'package.json'), join(dir, 'package.json'));
    copyFileSync(join(source, 'package-lock.json'), join(dir, 'package-lock.json'));
    npmCommand(['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  } else {
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
    npmCommand(['install', '--no-audit', '--no-fund', '--save-exact', `${name}@${exact}`], { cwd: dir, stdio: 'inherit' });
  }
  // On Windows the `.bin` entry is a `.cmd` shim, which the adapter cannot execute; use the package's own executable.
  const installed = process.platform === 'win32' && winBin !== undefined ? join(dir, 'node_modules', ...winBin.split('/')) : join(dir, 'node_modules', '.bin', bin);
  return { bin: installed, version: exact };
}

/** The updater manifest of one platform, which names the latest release with its url and SHA-512. */
export function agyUpdaterManifest(platform = process.platform, arch = process.arch) {
  const system = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform];
  const architecture = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (system === undefined || architecture === undefined) throw new Error(`no agy release for ${platform}-${arch}`);
  return `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${system}_${architecture}.json`;
}

async function agyRelease(mode, version, download) {
  if (mode === 'qualified') {
    if (AGY_QUALIFIED.version !== version) throw new Error(`AGY_QUALIFIED pins ${AGY_QUALIFIED.version}, the adapter qualifies ${version}`);
    const archive = AGY_QUALIFIED.archives[`${process.platform}-${process.arch}`];
    if (archive === undefined) throw new Error(`no qualified agy archive for ${process.platform}-${process.arch}`);
    return { ...archive, version };
  }
  const manifest = JSON.parse(Buffer.from(await download(agyUpdaterManifest())).toString('utf8'));
  if (!isExactVersion(manifest.version) || !/^[0-9a-f]{128}$/.test(manifest.sha512 ?? '') || !String(manifest.url).startsWith('https://'))
    throw new Error(`agy updater manifest is malformed: ${JSON.stringify(manifest)}`);
  return manifest;
}

/** The archive is a tar.gz holding `antigravity`, or the Windows executable itself. */
async function installAgy(mode, version, dir, download) {
  const release = await agyRelease(mode, version, download);
  const bytes = Buffer.from(await download(release.url));
  const actual = createHash('sha512').update(bytes).digest('hex');
  if (actual !== release.sha512) throw new Error(`agy archive checksum mismatch: expected ${release.sha512}, got ${actual}`);
  mkdirSync(dir, { recursive: true });
  let bin;
  if (release.url.endsWith('.exe')) {
    bin = join(dir, 'agy.exe');
    writeFileSync(bin, bytes);
  } else {
    const archive = join(dir, 'agy.tar.gz');
    writeFileSync(archive, bytes);
    execFileSync('tar', ['-xzf', archive, '-C', dir]);
    const found = readdirSync(dir, { recursive: true }).filter(file => basename(String(file)) === 'antigravity');
    if (found.length !== 1) throw new Error(`expected one agy executable in the archive, found ${found.length}`);
    bin = join(dir, String(found[0]));
    chmodSync(bin, 0o755);
  }
  const reported = run(bin, ['--version'], { timeout: 30_000 });
  if (reported !== release.version) throw new Error(`agy reports ${JSON.stringify(reported)}, expected ${release.version}`);
  return { bin, version: release.version };
}

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

export async function install(runtime, mode, { dir, githubEnv = process.env.GITHUB_ENV, download = fetchBytes } = {}) {
  if (!RUNTIMES.includes(runtime)) throw new Error(`unknown runtime ${JSON.stringify(runtime)}; one of ${RUNTIMES.join(', ')}`);
  if (mode !== 'qualified' && mode !== 'latest') throw new Error('mode must be qualified or latest');
  // Pi is bundled at byok.piRuntimePin: nothing to install, and the suite skips a latest run.
  if (runtime === 'pi') return [];
  const version = (await qualifiedVersions())[runtime];
  const target = dir ?? join(process.env.RUNNER_TEMP ?? root, 'runtime-contract', runtime);
  const installed = runtime === 'agy' ? await installAgy(mode, version, target, download) : installNpm(runtime, mode, version, target);
  const lines = contractEnv(runtime, installed.bin, mode === 'latest' ? installed.version : undefined);
  if (githubEnv) appendFileSync(githubEnv, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  return lines;
}

if (import.meta.main) {
  const [runtime, mode] = process.argv.slice(2);
  const action = runtime === '--update-lock'
    ? qualifiedVersions().then(versions => updateNpmLock(mode, versions[mode]))
    : install(runtime, mode);
  action.catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
