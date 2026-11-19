import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync, promises as fs, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { probeRuntimeVersion } from '../adapters/detect-outcome.js';
import { managedRuntimeDirectory, ManagedRuntimeUnavailableError, resolveManagedRuntime, type ManagedRuntimeId, type ManagedRuntimePointer } from '../adapters/managed-runtime-path.js';
import { withoutProviderCredentials } from '../adapters/provider-credential-environment.js';
import { resolveRuntimeInvocation, runtimeInvocationHost } from '../adapters/runtime-invocation.js';
import { acquirePathMutationGate } from '../util/path-mutation-gate.js';
import { ensureOwnedPrivateDirectory } from '../util/private-unix-socket.js';
import { runtimeRelease, type UpgradeableRuntimeId } from '../runtime/runtime-releases.js';

const run = promisify(execFile);

export interface RuntimeUpgradeOptions {
  /** Root shared with DaemonConfig.runtimeInstallRoot. */
  readonly installRoot: string;
  readonly runtimeId: UpgradeableRuntimeId;
}

export type RuntimeUpgradeResult =
  | { readonly kind: 'installed' | 'current'; readonly version: string; readonly executable: string }
  | { readonly kind: 'vendor'; readonly command: string; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: 'install_failed' | 'binary_unavailable' | 'version_mismatch' | 'probe_failed' | 'mutation_failed' };

interface NativePlatform {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly musl: boolean;
  readonly avx2: boolean;
}

function nativePlatform(): NativePlatform {
  const { platform, arch } = process;
  let musl = false;
  let avx2 = false;
  if (platform === 'linux') {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    musl = existsSync('/etc/alpine-release') || (header !== undefined && !header.glibcVersionRuntime);
    if (arch === 'x64') {
      try { avx2 = /\bavx2\b/i.test(readFileSync('/proc/cpuinfo', 'utf8')); } catch { /* Choose the baseline binary. */ }
    }
  } else if (platform === 'darwin' && arch === 'x64') {
    try { avx2 = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.avx2_0'], { encoding: 'utf8', timeout: 1_500 }).trim() === '1'; } catch { /* Choose the baseline binary. */ }
  }
  // OpenCode's baseline x64 build runs on Windows with or without AVX2.
  return { platform, arch, musl, avx2 };
}

/** Select the optional native package. The top-level bin may be an installer placeholder. */
export function managedBinaryPath(id: ManagedRuntimeId, host: NativePlatform): string {
  const { platform, arch, musl, avx2 } = host;
  const modules = 'node_modules';
  const suffix = platform === 'win32' ? '.exe' : '';
  if (id === 'claude') {
    return path.join(modules, '@anthropic-ai', `claude-code-${platform}-${arch}${musl ? '-musl' : ''}`, `claude${suffix}`);
  }
  if (id === 'opencode') {
    const platformName = platform === 'win32' ? 'windows' : platform;
    const baseline = arch === 'x64' && !avx2 ? '-baseline' : '';
    return path.join(modules, '@opencode', `cli-${platformName}-${arch}${baseline}${musl ? '-musl' : ''}`, 'bin', `opencode${suffix}`);
  }
  return path.join(modules, '.bin', `${id}${platform === 'win32' ? '.cmd' : ''}`);
}

async function restoreDshSpawnHelper(root: string, host: NativePlatform): Promise<void> {
  if (host.platform === 'win32') return;
  const require = createRequire(path.join(root, 'package.json'));
  const subprocess = require.resolve('@deepseek-ai/dsh-subprocess-local/package.json');
  const ptyEntry = createRequire(subprocess).resolve('node-pty');
  const pty = path.dirname(path.dirname(ptyEntry));
  for (const candidate of [path.join(pty, 'prebuilds', `${host.platform}-${host.arch}`, 'spawn-helper'), path.join(pty, 'build', 'Release', 'spawn-helper')]) {
    if (!existsSync(candidate)) continue;
    const helper = realpathSync(candidate);
    if (!helper.startsWith(`${realpathSync(root)}${path.sep}`) || !(await fs.lstat(candidate)).isFile()) {
      throw new ManagedRuntimeUnavailableError();
    }
    await fs.chmod(helper, 0o755);
  }
}

async function runLocal(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<void> {
  const invocation = resolveRuntimeInvocation(command, runtimeInvocationHost(env));
  await run(invocation.command, [...invocation.args, ...args], { cwd, env, timeout, killSignal: 'SIGKILL', windowsHide: true });
}

const PROBE_ARGS: Readonly<Record<ManagedRuntimeId, readonly string[]>> = {
  claude: ['--help'], codex: ['app-server', '--help'], dsh: ['--profile', 'acp', '--help'], opencode: ['acp', '--help'],
};

/** Explicit Host operation. Installs and probes a new generation before publishing it. */
export async function upgradeRuntime(options: RuntimeUpgradeOptions): Promise<RuntimeUpgradeResult> {
  const { installRoot, runtimeId } = options;
  const release = runtimeRelease(runtimeId);
  if (release === undefined) throw new TypeError('unknown upgradeable runtime');
  if (release.kind === 'vendor') return { kind: 'vendor', command: release.command, reason: release.reason };
  const directory = managedRuntimeDirectory(installRoot, runtimeId as ManagedRuntimeId);
  const id = runtimeId as ManagedRuntimeId;
  const gate = await acquirePathMutationGate({ scope: 'install-root', targetPath: installRoot });
  let staging: string | undefined;
  let next: string | undefined;
  let reason: Extract<RuntimeUpgradeResult, { kind: 'failed' }>['reason'] = 'mutation_failed';
  const env = withoutProviderCredentials(process.env);
  try {
    await ensureOwnedPrivateDirectory(path.dirname(directory));
    await ensureOwnedPrivateDirectory(directory);
    let current: ReturnType<typeof resolveManagedRuntime>;
    try { current = resolveManagedRuntime(installRoot, id); } catch (error) {
      if (!(error instanceof ManagedRuntimeUnavailableError)) throw error;
    }
    if (current?.version === release.qualifiedVersion && await validateInstallation(id, current.command, directory, env) === release.qualifiedVersion) {
      return { kind: 'current', version: current.version, executable: current.command };
    }
    const generation = `generation-${randomUUID()}`;
    staging = path.join(directory, generation);
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.writeFile(path.join(staging, 'package.json'), '{"private":true}\n', { mode: 0o600 });
    reason = 'install_failed';
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await runLocal(npm, ['install', '--prefix', staging, '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--no-progress', `${release.package}@${release.qualifiedVersion}`], staging, env, 180_000);
    reason = 'binary_unavailable';
    const platform = nativePlatform();
    if (id === 'dsh') await restoreDshSpawnHelper(staging, platform);
    const executable = managedBinaryPath(id, platform);
    const command = path.join(staging, executable);
    await fs.access(command, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    reason = 'probe_failed';
    const installed = await validateInstallation(id, command, staging, env);
    if (installed !== release.qualifiedVersion) return { kind: 'failed', reason: installed === undefined ? 'probe_failed' : 'version_mismatch' };
    reason = 'mutation_failed';
    const pointer: ManagedRuntimePointer = { generation, executable, version: installed };
    next = path.join(directory, `.current-${randomUUID()}.json`);
    await fs.writeFile(next, JSON.stringify(pointer), { flag: 'wx', mode: 0o600 });
    await fs.rename(next, path.join(directory, 'current.json'));
    staging = undefined;
    return { kind: 'installed', version: installed, executable: command };
  } catch {
    return { kind: 'failed', reason };
  } finally {
    try {
      if (next !== undefined) await fs.rm(next, { force: true });
      if (staging !== undefined) await fs.rm(staging, { recursive: true, force: true });
    } finally { await gate.release(); }
  }
}

async function validateInstallation(id: ManagedRuntimeId, command: string, cwd: string, ambient: NodeJS.ProcessEnv): Promise<string | undefined> {
  const release = runtimeRelease(id)!;
  try {
    const env = Object.fromEntries(Object.entries(ambient).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const invocation = resolveRuntimeInvocation(command, runtimeInvocationHost(env));
    const probe = await probeRuntimeVersion(invocation.command, 15_000, env, invocation.args);
    if (probe.kind !== 'available') return undefined;
    const version = release.token(probe.stdout.trim() || probe.stderr.trim());
    if (version !== release.qualifiedVersion) return version;
    await runLocal(command, PROBE_ARGS[id], cwd, { ...env, ...(id === 'dsh' ? { DSH_HOME: path.join(cwd, '.dsh-probe') } : {}) }, 35_000);
    return version;
  } catch { return undefined; }
}

/** Remove the managed copy. Stop tasks using it before uninstalling. */
export async function uninstallManagedRuntime(installRoot: string, runtimeId: ManagedRuntimeId): Promise<void> {
  const release = runtimeRelease(runtimeId);
  if (release?.kind !== 'managed') throw new TypeError('runtime has no managed installation');
  const directory = managedRuntimeDirectory(installRoot, runtimeId);
  const gate = await acquirePathMutationGate({ scope: 'install-root', targetPath: installRoot });
  try { await fs.rm(directory, { recursive: true, force: true }); }
  finally { await gate.release(); }
}
