import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Where each operating-system tool the client starts lives. A daemon's `PATH`
 * is whatever its launcher, a shell profile or an installer left there, so it
 * never names a system tool:
 *
 * - darwin: the one path the OS ships the tool at;
 * - linux: the first of {@link LINUX_SYSTEM_DIRS} that holds it, since distros
 *   differ in which of them they populate;
 * - win32: `%SystemRoot%\System32\<file>`. `SystemRoot` is the one variable
 *   Windows itself sets in every process from the installation's own record;
 *   it must be a drive-qualified absolute path, so it can neither resolve
 *   against the working directory nor name a network share.
 */
const SYSTEM_TOOLS: Readonly<Record<string, Readonly<Partial<Record<NodeJS.Platform, string>>>>> = {
  launchctl: { darwin: '/bin/launchctl' },
  ioreg: { darwin: '/usr/sbin/ioreg' },
  systemctl: { linux: 'systemctl' },
  'secret-tool': { linux: 'secret-tool' },
  taskkill: { win32: 'taskkill.exe' },
  'sc.exe': { win32: 'sc.exe' },
  reg: { win32: 'reg.exe' },
  icacls: { win32: 'icacls.exe' },
};

const LINUX_SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;
const WINDOWS_SYSTEM_ROOT = /^[A-Za-z]:\\[^\0\r\n]*$/u;

/** A system tool has no trusted location on this platform, or is not at it. Nothing was started. */
export class SystemToolUnavailableError extends Error {
  constructor(readonly tool: string, detail: string) {
    super(`system tool ${tool} is unavailable: ${detail}`);
    this.name = 'SystemToolUnavailableError';
  }
}

/** What resolution reads from the host. Tests supply their own. */
export interface SystemToolHost {
  readonly platform: NodeJS.Platform;
  readonly systemRoot: string | undefined;
  isFile(file: string): boolean;
}

function isFile(file: string): boolean {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

const realHost = (): SystemToolHost => ({ platform: process.platform, systemRoot: process.env.SystemRoot, isFile });

/** The absolute path of `tool` at its trusted location ({@link SYSTEM_TOOLS}); throws {@link SystemToolUnavailableError}. */
export function resolveSystemTool(tool: string, host: SystemToolHost = realHost()): string {
  const file = Object.hasOwn(SYSTEM_TOOLS, tool) ? SYSTEM_TOOLS[tool]![host.platform] : undefined;
  if (file === undefined) throw new SystemToolUnavailableError(tool, `it has no trusted location on ${host.platform}`);
  let candidates: string[];
  if (host.platform === 'linux') candidates = LINUX_SYSTEM_DIRS.map((dir) => `${dir}/${file}`);
  else if (host.platform === 'win32') {
    if (host.systemRoot === undefined || !WINDOWS_SYSTEM_ROOT.test(host.systemRoot)) {
      throw new SystemToolUnavailableError(tool, 'SystemRoot is not a drive-qualified absolute path');
    }
    candidates = [path.win32.join(host.systemRoot, 'System32', file)];
  } else candidates = [file];
  const found = candidates.find((candidate) => host.isFile(candidate));
  if (found === undefined) throw new SystemToolUnavailableError(tool, `not found at ${candidates.join(', ')}`);
  return found;
}

/**
 * The file a real runner starts for `command`: an absolute path the caller
 * owns (a WinSW wrapper, a compiled bridge) as given, any other name as a
 * system tool from its trusted location. A bare name never reaches `PATH`.
 */
export function systemExecutable(command: string): string {
  return path.isAbsolute(command) ? command : resolveSystemTool(command);
}
