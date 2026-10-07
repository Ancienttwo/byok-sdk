import { buildAllowlistedEnv } from '../../daemon/environment';
import { PROVIDER_CREDENTIAL_ENV_NAMES } from '../provider-credential-environment';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureSecureDir } from '../../util/secure-dir';
import { RuntimeExecutionFailure } from '../../runtime-failure';
import { CONTROLLED_PI_DIRECTORY_ENV_NAMES } from './mcp-environment';

/** The SDK-owned Pi entry a launch starts. */
export type PiRuntimeLaunchKind = 'pi-rpc' | 'pi-prepared' | 'pi-durable';

export interface PiRuntimeLaunchResources {
  readonly kind: PiRuntimeLaunchKind;
  /** The interpreter, or the executable itself. */
  readonly command: string;
  /** The script the interpreter runs. Absent for an executable. */
  readonly entry?: string;
  /**
   * The fixed argv after the entry. A single-file product re-enters itself
   * with `__byok_sdk_helper <kind>`; the installed package needs none.
   */
  readonly fixedArgs: readonly string[];
  /** The real path of the session cwd. The Pi process starts in it, as in OAR. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sessionCwd: string;
  readonly credentialSource: 'pi-auth-store' | 'keys-profile';
  /**
   * The fresh 0700 directory the keys launcher writes the provider projection
   * into. Present exactly when `credentialSource` is `keys-profile`.
   */
  readonly projectionDir?: string;
  /** A single client-owned cleanup authority, idempotent across declined/start/terminal paths. */
  release(): Promise<void>;
}

function failure(reason: string): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });
}

/**
 * The real path of the session cwd. The daemon can resolve a launch before it
 * creates a new workspace directory, so a missing tail keeps its own names
 * under the real path of its nearest existing parent.
 */
async function realSessionPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    const parent = path.dirname(absolute);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === absolute) throw error;
    return path.join(await realSessionPath(parent), path.basename(absolute));
  }
}

/** Create the per-launch keys projection directory outside the session cwd. */
async function createProjectionDir(projectionRoot: string, sessionCwd: string): Promise<string> {
  const root = path.resolve(projectionRoot);
  const session = path.resolve(sessionCwd);
  if (root === session || root.startsWith(`${session}${path.sep}`)) throw failure('runtime projection root is inside session cwd');
  await ensureSecureDir(root);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)
    || (process.getuid !== undefined && stat.uid !== process.getuid())) throw failure('runtime projection root is not owned private directory');
  const canonicalRoot = await fs.realpath(root);
  const canonicalSession = await fs.realpath(session);
  if (canonicalRoot === canonicalSession || canonicalRoot.startsWith(`${canonicalSession}${path.sep}`)) {
    throw failure('runtime projection root resolves inside session cwd');
  }
  const projectionDir = await fs.mkdtemp(path.join(canonicalRoot, 'pi-'));
  await ensureSecureDir(projectionDir);
  return projectionDir;
}

export async function resolvePiRuntimeLaunch(options: {
  kind: PiRuntimeLaunchKind;
  sessionCwd: string;
  env: Readonly<Record<string, string | undefined>>;
  projectionRoot: string;
  keysSessionDir?: string;
  /** The SDK Pi entry for this kind. */
  resolveInvocation: () => { command: string; entry?: string; fixedArgs?: readonly string[] };
}): Promise<PiRuntimeLaunchResources> {
  const source = options.keysSessionDir === undefined ? 'pi-auth-store' : 'keys-profile';
  const original = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // The prepared host must send the counted request as is, so it gets only
  // the platform baseline, the Pi directories and the provider names. In the
  // keys lane the launcher also narrows the environment of its own Pi child.
  const env = options.kind === 'pi-prepared'
    ? buildAllowlistedEnv({ ambient: original, allow: [...CONTROLLED_PI_DIRECTORY_ENV_NAMES, ...PROVIDER_CREDENTIAL_ENV_NAMES] })
    : original;
  let projectionDir: string | undefined;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    if (projectionDir !== undefined) await fs.rm(projectionDir, { recursive: true, force: true });
    released = true;
  };
  try {
    if (options.keysSessionDir !== undefined) projectionDir = await createProjectionDir(options.projectionRoot, options.sessionCwd);
    const invocation = options.resolveInvocation();
    return Object.freeze({
      kind: options.kind,
      command: invocation.command,
      ...(invocation.entry === undefined ? {} : { entry: invocation.entry }),
      fixedArgs: Object.freeze([...(invocation.fixedArgs ?? [])]),
      cwd: await realSessionPath(options.sessionCwd),
      env: Object.freeze(env),
      sessionCwd: options.sessionCwd,
      credentialSource: source,
      ...(projectionDir === undefined ? {} : { projectionDir }),
      release,
    });
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * The spawn command of one Pi host launch. Without a launcher the host starts
 * directly. With one, the keys launcher starts the host and writes the
 * provider projection into the launch's projection directory.
 */
export function piLaunchCommand(
  launch: PiRuntimeLaunchResources,
  runtimeEntry: 'pi-rpc' | 'pi-prepared' | 'pi-durable',
  configDigest: string,
  hostArgs: readonly string[],
  launcher: { readonly command: string; readonly args: readonly string[]; readonly profileArgs: readonly string[] } | undefined,
): { command: string; args: string[] } {
  if (launcher === undefined) {
    return { command: launch.command, args: [...(launch.entry === undefined ? [] : [launch.entry]), ...launch.fixedArgs, `--config-digest=${configDigest}`, ...hostArgs] };
  }
  if (launch.projectionDir === undefined) throw failure('Pi keys launch requires its projection directory');
  return {
    command: launcher.command,
    args: [...launcher.args, '--pi-bin', launch.command, ...launcher.profileArgs,
      '--runtime-entry', runtimeEntry,
      ...(launch.entry === undefined ? [] : ['--pi-entry', launch.entry]),
      ...(launch.fixedArgs.length === 0 ? [] : ['--pi-fixed-args', JSON.stringify(launch.fixedArgs)]),
      '--pi-cwd', launch.cwd, '--pi-projection-dir', launch.projectionDir,
      '--pi-config-digest', configDigest, '--', ...hostArgs],
  };
}
