import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// #1103: install one runtime CLI for the runtime contract suite and hand its
// path (and, for a latest run, its version) to the suite through GITHUB_ENV.
// The qualified versions are read from their single authorities, never copied.

const root = resolve(import.meta.dirname, '../..');
const adapters = join(root, 'packages/client/src/adapters');

export const RUNTIMES = Object.freeze(['pi', 'claude', 'codex', 'grok', 'hermes', 'dsh', 'agy', 'opencode1', 'opencode2']);

/** npm packages of the CLIs the SDK does not bundle. */
export const NPM_PACKAGES = Object.freeze({
  claude: { name: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { name: '@openai/codex', bin: 'codex' },
  grok: { name: '@xai-official/grok', bin: 'grok' },
  dsh: { name: '@deepseek-ai/dsh', bin: 'dsh' },
  opencode1: { name: 'opencode-ai', bin: 'opencode', winBin: 'opencode-ai/bin/opencode.exe' },
  opencode2: { name: '@opencode/cli', bin: 'opencode', winBin: '@opencode/cli/bin/opencode.exe' },
});

export const HERMES_INSTALLER = Object.freeze({
  repository: 'https://github.com/NousResearch/hermes-agent',
});

/**
 * The official agy CLI archives of the qualified release, from its platform
 * updater manifests. agy is not on npm. A qualification bump changes both.
 */
const AGY_ARCHIVE_ROOT = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.1-4523430503120896';
export const AGY_QUALIFIED = Object.freeze({
  version: '1.5.1',
  archives: Object.freeze({
    'linux-x64': { url: `${AGY_ARCHIVE_ROOT}/linux-x64/cli_linux_x64.tar.gz`, sha512: 'f70406654ebd966f211424338259e2d38d099c48734e901dc06975063e5a0137d55b6eb9366b75983c6908bbc20ae92a2617656bb191d8ed6fe429d654bca4f5' },
    'darwin-arm64': { url: `${AGY_ARCHIVE_ROOT}/darwin-arm/cli_mac_arm64.tar.gz`, sha512: '078399b392c3bfce70bc5d9fb1a447a4b0a2a26bd40c36148f4944028b8f21e358890d5b9bedcde69296677b1da2c026b4e283ae918823429c13b91ddcb913ce' },
    'darwin-x64': { url: `${AGY_ARCHIVE_ROOT}/darwin-x64/cli_mac_x64.tar.gz`, sha512: '736a0f1210b42edc6ec292e1f8438696f616bf6906ad5e878d415b18aa53accc59a678205c332e5af564fab8d32ca5ac5b41c9baad8ced0a7bc224a0ccfcc3b5' },
    'win32-x64': { url: `${AGY_ARCHIVE_ROOT}/windows-x64/cli_windows_x64.exe`, sha512: '218d2751189e25a275122519a2afc6a3d0af5ff68306cebc68a5da3127bca69a497760988bfd40a884a619d4fa58ccafcb2fba1289dc1fc56e3d7d7b565f4cec' },
  }),
});

/** Each runtime's qualified version, from the adapter's own constant or the client manifest. */
export async function qualifiedVersions() {
  const load = async (file, name) => (await import(pathToFileURL(join(adapters, file)).href))[name];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'packages/client/package.json'), 'utf8'));
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
    hermes: await load('hermes/hermes-version.ts', 'QUALIFIED_HERMES_VERSION'),
    dsh: await load('dsh/dsh-version.ts', 'QUALIFIED_DSH_VERSION'),
    agy: await load('antigravity/agy-version.ts', 'QUALIFIED_AGY_VERSION'),
    opencode1: await load('opencode/opencode-version.ts', 'CONTRACT_OPENCODE_V1_VERSION'),
    opencode2: await load('opencode/opencode-version.ts', 'QUALIFIED_OPENCODE_VERSION'),
  };
}

/** The commit a Hermes build names: `0.22.2+2364.g0b10b9f` → `0b10b9f`. */
export function hermesBuildCommit(version) {
  const commit = /\.g([0-9a-f]{7,40})$/.exec(version)?.[1];
  if (commit === undefined) throw new Error(`Hermes version ${JSON.stringify(version)} names no commit`);
  return commit;
}

/** Verify the vendored installer and its relationship to the adapter's qualified build. */
export function vendoredHermesInstaller(version, file, vendor = join(root, 'scripts/ci/vendor/hermes')) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(vendor, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`Hermes installer manifest is unreadable: ${error.message}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.commit) || !manifest.commit.startsWith(hermesBuildCommit(version)))
    throw new Error('Hermes installer manifest commit does not match the qualified build');
  if (!['install.sh', 'install.ps1'].includes(file) || !/^[0-9a-f]{64}$/.test(manifest.sha256?.[file] ?? ''))
    throw new Error(`Hermes installer manifest has no checksum for ${file}`);
  const installer = join(vendor, manifest.commit, file);
  const actual = createHash('sha256').update(readFileSync(installer)).digest('hex');
  if (actual !== manifest.sha256[file]) throw new Error(`Hermes installer checksum mismatch: expected ${manifest.sha256[file]}, got ${actual}`);
  return installer;
}

/** The GITHUB_ENV lines the suite reads. A qualified run needs no version: the suite reads the same authority. */
export function contractEnv(runtime, bin, latestVersion) {
  const key = runtime.toUpperCase();
  return [`BYOK_CONTRACT_${key}_BIN=${bin}`, ...(latestVersion === undefined ? [] : [`BYOK_CONTRACT_${key}_VERSION=${latestVersion}`])];
}

/** One exact npm version; dsh publishes only prereleases (`0.2.1-rc.5`). */
export const isExactVersion = (version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version);

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();

function installNpm(runtime, mode, version, dir) {
  const { name, bin, winBin } = NPM_PACKAGES[runtime];
  const exact = mode === 'latest' ? run('npm', ['view', name, 'version']) : version;
  if (!isExactVersion(exact)) throw new Error(`${name}: not an exact version: ${JSON.stringify(exact)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--save-exact', `${name}@${exact}`], { cwd: dir, stdio: 'inherit' });
  // On Windows the `.bin` entry is a `.cmd` shim, which the adapter cannot execute; use the package's own executable.
  const installed = process.platform === 'win32' && winBin !== undefined ? join(dir, 'node_modules', ...winBin.split('/')) : join(dir, 'node_modules', '.bin', bin);
  return { bin: installed, version: exact };
}

function installHermes(mode, version, dir) {
  const home = join(dir, 'home');
  const agent = join(dir, 'agent');
  // The installer edits shell profiles and ~/.local/bin; give it a throwaway HOME.
  const fakeHome = join(dir, 'installer-home');
  mkdirSync(fakeHome, { recursive: true });
  let installer;
  if (mode === 'latest') {
    installer = join(dir, 'install.sh');
    const endpoint = 'repos/NousResearch/hermes-agent/contents/scripts/install.sh?ref=main';
    console.log(`Downloading the latest Hermes installer: https://api.github.com/${endpoint}`);
    writeFileSync(installer, execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', endpoint], { stdio: ['ignore', 'pipe', 'inherit'] }));
  } else {
    installer = vendoredHermesInstaller(version, 'install.sh');
    console.log(`Using vendored Hermes installer: ${installer}`);
  }
  const commit = mode === 'latest' ? run('git', ['ls-remote', HERMES_INSTALLER.repository, 'HEAD']).split(/\s/)[0] : basename(dirname(installer));
  execFileSync('bash', [installer, '--commit', commit, '--non-interactive', '--skip-browser', '--skip-computer-use', '--hermes-home', home, '--dir', agent],
    { stdio: 'inherit', env: { ...process.env, HOME: fakeHome } });
  const bin = [join(agent, '.hermes', 'bin', 'hermes'), join(home, 'bin', 'hermes'), join(fakeHome, '.local', 'bin', 'hermes')].find(existsSync);
  if (bin === undefined) throw new Error('Hermes installed no hermes executable');
  // A latest run names the installed commit; the suite checks the build suffix against it.
  return { bin, version: run('git', ['-C', agent, 'rev-parse', 'HEAD']) };
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
  const installed = runtime === 'hermes' ? installHermes(mode, version, target)
    : runtime === 'agy' ? await installAgy(mode, version, target, download) : installNpm(runtime, mode, version, target);
  const lines = contractEnv(runtime, installed.bin, mode === 'latest' ? installed.version : undefined);
  if (githubEnv) appendFileSync(githubEnv, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  return lines;
}

if (import.meta.main) {
  const [runtime, mode] = process.argv.slice(2);
  install(runtime, mode).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
