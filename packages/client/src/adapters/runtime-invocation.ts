import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The program an adapter spawns, and the arguments that go before the adapter's own. */
export interface RuntimeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** The runtime file this resolution chose: the found `.exe`/`.cmd` on win32, else `command` as given. */
  readonly executable: string;
}

export interface RuntimeInvocationHost {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  isFile(file: string): boolean;
  readFile(file: string): string;
}

/** This process's platform and filesystem, searching `env` — the runtime environment the command will run in (#1095). */
export function runtimeInvocationHost(env: Readonly<Record<string, string>>): RuntimeInvocationHost {
  return {
    platform: process.platform,
    env,
    isFile: file => { try { return statSync(file).isFile(); } catch { return false; } },
    readFile: file => readFileSync(file, 'utf8'),
  };
}

const NATIVE = new Set(['.com', '.exe']);
const BATCH = new Set(['.bat', '.cmd']);

/**
 * Turn an adapter's resolved command into the process it spawns. Adapters
 * spawn without a shell so that cmd.exe never interprets a task argument.
 * Windows cannot start a .cmd or .bat file without cmd.exe, and npm installs
 * claude and codex on Windows only as .cmd shims (#763).
 *
 * On win32 this finds the command as cmd.exe would (PATH order, then PATHEXT
 * order; never the current directory). A native .exe or .com runs directly.
 * An npm node shim runs its JavaScript entry with the node the shim itself
 * selects: `node.exe` next to the shim, else `node` from PATH. It does not use
 * `process.execPath`: a single-file daemon build is not a node binary. Any
 * other batch file fails with ENOEXEC, never through a shell. A command that
 * is not found fails with ENOENT, so the spawn never searches its own current
 * directory. A found file with another extension is returned unchanged. Every
 * error names no local path: a prepare rejection reason leaves the device.
 * Other platforms are unchanged.
 */
export function resolveRuntimeInvocation(command: string, host: RuntimeInvocationHost): RuntimeInvocation {
  if (host.platform !== 'win32') return { command, args: [], executable: command };
  const file = findWindowsCommand(command, host, runnableExtensions(host.env));
  if (file === undefined) throw spawnError('ENOENT', 'the runtime command was not found');
  const extension = path.win32.extname(file).toLowerCase();
  if (NATIVE.has(extension)) return { command: file, args: [], executable: file };
  if (!BATCH.has(extension)) return { command, args: [], executable: command };
  const entry = extension === '.cmd' ? npmNodeShimEntry(readShim(host, file)) : undefined;
  if (entry === undefined) throw spawnError('ENOEXEC', 'the runtime command is a batch file that is not an npm node shim; only cmd.exe can run it');
  const shimDir = path.win32.dirname(file);
  const localNode = path.win32.join(shimDir, 'node.exe');
  const node = host.isFile(localNode) ? localNode : findWindowsCommand('node', host, ['.com', '.exe']);
  if (node === undefined) throw spawnError('ENOENT', 'node was not found for the runtime command npm shim');
  return { command: node, args: [path.win32.join(shimDir, entry)], executable: file };
}

function envValue(env: RuntimeInvocationHost['env'], name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * PATHEXT order, kept to the extensions this resolver can decide on. `.com`
 * and `.exe` stay last when PATHEXT omits them, as a shell-less spawn tries them.
 */
function runnableExtensions(env: RuntimeInvocationHost['env']): string[] {
  const listed = (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim().toLowerCase());
  const runnable = listed.filter(ext => NATIVE.has(ext) || BATCH.has(ext));
  return [...new Set([...runnable, ...NATIVE])];
}

/** A read failure keeps its code and drops the path that Node puts in its message. */
function readShim(host: RuntimeInvocationHost, file: string): string {
  try {
    return host.readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw spawnError(typeof code === 'string' ? code : 'EIO', 'the runtime command npm shim could not be read');
  }
}

function findWindowsCommand(command: string, host: RuntimeInvocationHost, extensions: readonly string[]): string | undefined {
  const named = path.win32.extname(command) === '' ? [] : [command];
  const candidates = [...named, ...extensions.map(ext => command + ext)];
  const dirs = /[\\/]/.test(command) || path.win32.isAbsolute(command)
    ? ['']
    : (envValue(host.env, 'PATH') ?? '').split(';').map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(dir => dir !== '');
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const file = dir === '' ? candidate : path.win32.join(dir, candidate);
      if (host.isFile(file)) return file;
    }
  }
  return undefined;
}

/**
 * npm's cmd-shim output for a `#!/usr/bin/env node` bin with no extra
 * arguments. cmd-shim 4.1.0 to 9.0.1 (npm 11 bundles 8.0.0) strips `.JS` from
 * PATHEXT in the ELSE branch; 9.0.2 (npm 12) does it on the last line.
 */
function npmNodeShims(entry: string): string[] {
  const head = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"'];
  const pathext = 'set PATHEXT=%PATHEXT:;.JS;=;% & ';
  const run = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ';
  const exec = `"%_prog%"  "%dp0%\\${entry}" %*`;
  return [
    [...head, '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', run + exec, ''],
    [...head, ')', '', run + pathext + exec, ''],
  ].map(lines => lines.join('\r\n'));
}

/** The shim's entry, relative to the shim directory, only when the file is exactly npm's node shim. */
function npmNodeShimEntry(text: string): string | undefined {
  const entry = /"%dp0%\\([^"%\r\n]+)" %\*\r\n$/.exec(text)?.[1];
  return entry !== undefined && npmNodeShims(entry).includes(text) ? entry : undefined;
}

function spawnError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
