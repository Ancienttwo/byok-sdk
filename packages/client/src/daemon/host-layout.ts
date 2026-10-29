import os from 'node:os';
import path from 'node:path';
import { AGENT_HOME_DIRECTORY } from '../agent-home';
import { HostLayoutInputError } from './daemon-errors';
import { scratchRootSocketBudget, shortScratchRoot } from './retention/scratch';

/** Platforms `resolveHostLayout` has a layout for. */
export type HostLayoutPlatform = 'darwin' | 'linux' | 'win32';

export interface HostLayoutOptions {
  /** `DaemonConfig.productId`. Names the SDK store: `<home>/.byok/<productId>`; on Linux also the Host root. */
  readonly productId: string;
  /** `DaemonConfig.productName`. Names the Host root on macOS and Windows, e.g. `Salesko`. */
  readonly productName: string;
  /** Default: `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** The user's home directory. Default: `os.homedir()`. */
  readonly homeDir?: string;
  /** Reads `XDG_DATA_HOME` (Linux) and `LOCALAPPDATA` (Windows). Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The recommended local directories of one Host product on one platform
 * (#1094). Who owns what:
 *
 * - `storeDir` is the SDK's. Pass it as `DaemonConfig.storeDir`, or leave
 *   that field unset: the default is the same path.
 * - `hostStorageRoot` is the Host's. Pass it as `agentHome.hostStorageRoot`;
 *   the SDK composes `agentHomes` (`<hostStorageRoot>/agents`) and every
 *   `agents/<agentId>` under it. Keep Host files beside `agents/`, not in it.
 * - `logDir` is where `byok-agent service install` sends the daemon's stdout
 *   and stderr.
 * - The Host keeps its config file and its own state outside `storeDir`.
 */
export interface HostLayout {
  readonly platform: HostLayoutPlatform;
  readonly storeDir: string;
  /**
   * Where execution scratch goes with this `storeDir` and no
   * `storage.scratchRoot` (#493). `store`: `<storeDir>/tmp` fits the runtime
   * Unix socket budget. `short-root`: it does not, so the daemon moves
   * scratch to a fixed short root keyed by the store path. Computed from the
   * lexical path; a symbolic link in an existing ancestor can change it, and
   * `byok-agent config check` reports the value a daemon resolves.
   */
  readonly scratchRoot: {
    readonly path: string;
    readonly source: 'store' | 'short-root';
    readonly socketPathBytes: number;
    /** Absent on Windows, which has no socket path limit. */
    readonly socketPathMaximumBytes?: number;
  };
  readonly hostStorageRoot: string;
  readonly agentHomes: string;
  readonly logDir: string;
}

const LAYOUT_PLATFORMS: ReadonlySet<string> = new Set<HostLayoutPlatform>(['darwin', 'linux', 'win32']);

function platformPath(platform: HostLayoutPlatform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** One portable path segment: the rule `AgentRef.agentId` follows. */
function isPortableSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[^\u0000-\u001f\u007f\\/:<>"|?*]+$/u.test(value)
    && value !== '.' && value !== '..' && !/[. ]$/u.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(value);
}

/** Absolute on `platform`. Windows requires a drive (`C:\\`) or complete UNC (`\\\\server\\share`) root; incomplete roots depend on the current drive. */
function isAbsoluteFor(platform: HostLayoutPlatform, value: unknown): value is string {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) return false;
  return platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/u.test(value) : path.posix.isAbsolute(value);
}

/**
 * The SDK store directory a daemon uses when `DaemonConfig.storeDir` is
 * unset: `<homeDir>/.byok/<productId>` on every platform. `DeviceStore.resolveDir`
 * and `resolveHostLayout` both use it; it is the only definition.
 */
export function defaultStoreDir(productId: string, homeDir: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(homeDir, '.byok', productId);
}

/** Where `byok-agent service install` sends the daemon's stdout and stderr. */
export function serviceLogDir(storeDir: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(storeDir, 'service-logs');
}

/**
 * The recommended `storeDir`, `hostStorageRoot` and log directory for a Host
 * product (#1094), with the #493 scratch placement of that `storeDir`.
 * Pure: it reads no file and creates nothing, so a Host can call it for any
 * platform, e.g. in an installer or a test.
 *
 * `hostStorageRoot` follows each platform's convention for per-user
 * application data:
 *
 * - macOS: `~/Library/Application Support/<productName>`
 * - Linux: `$XDG_DATA_HOME/<productId>`, default `~/.local/share/<productId>`
 * - Windows: `%LOCALAPPDATA%\<productName>`, default `~\AppData\Local\<productName>`
 *
 * `storeDir` is the SDK default, `~/.byok/<productId>`, on every platform. It
 * is short on purpose: an application-data path is often too long for
 * runtime Unix sockets under `<storeDir>/tmp` (#493).
 *
 * @throws {HostLayoutInputError} `productId` or `productName` is not one
 * portable path segment, `homeDir` is not absolute, or the platform is not
 * macOS, Linux or Windows.
 */
export function resolveHostLayout(options: HostLayoutOptions): HostLayout {
  const platform = options.platform ?? process.platform;
  if (!LAYOUT_PLATFORMS.has(platform)) {
    throw new HostLayoutInputError('platform', `resolveHostLayout has no layout for platform ${JSON.stringify(platform)}; use darwin, linux or win32`);
  }
  const target = platform as HostLayoutPlatform;
  const rules = platformPath(target);
  if (!isPortableSegment(options.productId)) {
    throw new HostLayoutInputError('productId', 'HostLayoutOptions.productId must be one portable path segment');
  }
  if (!isPortableSegment(options.productName)) {
    throw new HostLayoutInputError('productName', 'HostLayoutOptions.productName must be one portable path segment');
  }
  const homeDir = options.homeDir ?? os.homedir();
  if (!isAbsoluteFor(target, homeDir)) {
    throw new HostLayoutInputError('homeDir', `HostLayoutOptions.homeDir must be an absolute ${target} path`);
  }
  const home = rules.resolve(homeDir);
  const env = options.env ?? process.env;
  /** An env directory counts only when absolute (the XDG rule); otherwise the default applies. */
  const envDir = (name: string, fallback: string): string => {
    const value = env[name];
    return isAbsoluteFor(target, value) ? rules.resolve(value) : fallback;
  };

  const storeDir = defaultStoreDir(options.productId, home, target);
  const shortRoot = shortScratchRoot(storeDir, target);
  const scratchPath = shortRoot ?? rules.join(storeDir, 'tmp');
  const budget = scratchRootSocketBudget(scratchPath, target);
  const hostStorageRoot = target === 'darwin'
    ? rules.join(home, 'Library', 'Application Support', options.productName)
    : target === 'linux'
      ? rules.join(envDir('XDG_DATA_HOME', rules.join(home, '.local', 'share')), options.productId)
      : rules.join(envDir('LOCALAPPDATA', rules.join(home, 'AppData', 'Local')), options.productName);

  return Object.freeze({
    platform: target,
    storeDir,
    scratchRoot: Object.freeze({
      path: scratchPath,
      source: shortRoot === undefined ? 'store' : 'short-root',
      socketPathBytes: budget.bytes,
      ...(budget.maximumBytes === undefined ? {} : { socketPathMaximumBytes: budget.maximumBytes }),
    }),
    hostStorageRoot,
    agentHomes: rules.join(hostStorageRoot, AGENT_HOME_DIRECTORY),
    logDir: serviceLogDir(storeDir, target),
  });
}
