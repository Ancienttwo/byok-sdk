import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// #1103: install one runtime CLI for the runtime contract suite and hand its
// path (and, for a latest run, its version) to the suite through GITHUB_ENV.
// The qualified versions are read from their single authorities, never copied.

const root = resolve(import.meta.dirname, '../..');
const adapters = join(root, 'packages/client/src/adapters');

export const RUNTIMES = Object.freeze(['pi', 'claude', 'codex', 'grok', 'hermes', 'dsh']);

/** npm packages of the CLIs the SDK does not bundle. */
export const NPM_PACKAGES = Object.freeze({
  claude: { name: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { name: '@openai/codex', bin: 'codex' },
  grok: { name: '@xai-official/grok', bin: 'grok' },
  dsh: { name: '@deepseek-ai/dsh', bin: 'dsh' },
});

/**
 * The Hermes installer at the qualified commit, checksum-pinned like the
 * Windows job's install.ps1. A qualification bump changes both.
 */
export const HERMES_INSTALLER = Object.freeze({
  repository: 'https://github.com/NousResearch/hermes-agent',
  sha256: '20f44240ebada354a468104a6a6724d037afcb8883d4d09ddeb4815622c52d8b',
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
  };
}

/** The commit a Hermes build names: `0.22.2+2364.g0b10b9f` → `0b10b9f`. */
export function hermesBuildCommit(version) {
  const commit = /\.g([0-9a-f]{7,40})$/.exec(version)?.[1];
  if (commit === undefined) throw new Error(`Hermes version ${JSON.stringify(version)} names no commit`);
  return commit;
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
  const { name, bin } = NPM_PACKAGES[runtime];
  const exact = mode === 'latest' ? run('npm', ['view', name, 'version']) : version;
  if (!isExactVersion(exact)) throw new Error(`${name}: not an exact version: ${JSON.stringify(exact)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--save-exact', `${name}@${exact}`], { cwd: dir, stdio: 'inherit' });
  return { bin: join(dir, 'node_modules', '.bin', bin), version: exact };
}

function installHermes(mode, version, dir) {
  const home = join(dir, 'home');
  const agent = join(dir, 'agent');
  // The installer edits shell profiles and ~/.local/bin; give it a throwaway HOME.
  const fakeHome = join(dir, 'installer-home');
  mkdirSync(fakeHome, { recursive: true });
  const ref = mode === 'latest' ? 'HEAD' : hermesBuildCommit(version);
  const installerUrl = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${mode === 'latest' ? 'main' : ref}/scripts/install.sh`;
  const installer = join(dir, 'install.sh');
  execFileSync('curl', ['-fsSL', '-o', installer, installerUrl], { stdio: 'inherit' });
  if (mode === 'qualified') {
    const actual = createHash('sha256').update(readFileSync(installer)).digest('hex');
    if (actual !== HERMES_INSTALLER.sha256) throw new Error(`Hermes installer checksum mismatch: expected ${HERMES_INSTALLER.sha256}, got ${actual}`);
  }
  const commit = mode === 'latest' ? run('git', ['ls-remote', HERMES_INSTALLER.repository, 'HEAD']).split(/\s/)[0] : ref;
  execFileSync('bash', [installer, '--commit', commit, '--non-interactive', '--skip-browser', '--skip-computer-use', '--hermes-home', home, '--dir', agent],
    { stdio: 'inherit', env: { ...process.env, HOME: fakeHome } });
  const bin = [join(agent, '.hermes', 'bin', 'hermes'), join(home, 'bin', 'hermes'), join(fakeHome, '.local', 'bin', 'hermes')].find(existsSync);
  if (bin === undefined) throw new Error('Hermes installed no hermes executable');
  // A latest run names the installed commit; the suite checks the build suffix against it.
  return { bin, version: run('git', ['-C', agent, 'rev-parse', 'HEAD']) };
}

export async function install(runtime, mode, { dir, githubEnv = process.env.GITHUB_ENV } = {}) {
  if (!RUNTIMES.includes(runtime)) throw new Error(`unknown runtime ${JSON.stringify(runtime)}; one of ${RUNTIMES.join(', ')}`);
  if (mode !== 'qualified' && mode !== 'latest') throw new Error('mode must be qualified or latest');
  // Pi is bundled at byok.piRuntimePin: nothing to install, and the suite skips a latest run.
  if (runtime === 'pi') return [];
  const version = (await qualifiedVersions())[runtime];
  const target = dir ?? join(process.env.RUNNER_TEMP ?? root, 'runtime-contract', runtime);
  const installed = runtime === 'hermes' ? installHermes(mode, version, target) : installNpm(runtime, mode, version, target);
  const lines = contractEnv(runtime, installed.bin, mode === 'latest' ? installed.version : undefined);
  if (githubEnv) appendFileSync(githubEnv, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runtime, mode] = process.argv.slice(2);
  install(runtime, mode).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
