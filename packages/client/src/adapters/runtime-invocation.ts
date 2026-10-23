import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The program an adapter spawns, and the arguments that go before the adapter's own. */
export interface RuntimeInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RuntimeInvocationHost {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  isFile(file: string): boolean;
  readFile(file: string): string;
}

function nodeHost(): RuntimeInvocationHost {
  return {
    platform: process.platform,
    env: process.env,
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
 * is not found, or has another extension, is returned unchanged, so the spawn
 * reports what it reported before. Other platforms are unchanged.
 */
export function resolveRuntimeInvocation(command: string, host: RuntimeInvocationHost = nodeHost()): RuntimeInvocation {
  if (host.platform !== 'win32') return { command, args: [] };
  const file = findWindowsCommand(command, host, runnableExtensions(host.env));
  if (file === undefined) return { command, args: [] };
  const extension = path.win32.extname(file).toLowerCase();
  if (NATIVE.has(extension)) return { command: file, args: [] };
  if (!BATCH.has(extension)) return { command, args: [] };
  const entry = extension === '.cmd' ? npmNodeShimEntry(host.readFile(file)) : undefined;
  if (entry === undefined) throw spawnError('ENOEXEC', `${file} needs cmd.exe; only native executables and npm node shims run without a shell`);
  const shimDir = path.win32.dirname(file);
  const localNode = path.win32.join(shimDir, 'node.exe');
  const node = host.isFile(localNode) ? localNode : findWindowsCommand('node', host, ['.com', '.exe']);
  if (node === undefined) throw spawnError('ENOENT', `node was not found for npm shim ${file}`);
  return { command: node, args: [path.win32.join(shimDir, entry)] };
}

function envValue(env: RuntimeInvocationHost['env'], name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** PATHEXT order, kept to the extensions this resolver can decide on. */
function runnableExtensions(env: RuntimeInvocationHost['env']): string[] {
  const listed = (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim().toLowerCase());
  return listed.filter(ext => NATIVE.has(ext) || BATCH.has(ext));
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

/** npm's cmd-shim output for a `#!/usr/bin/env node` bin with no extra arguments. */
function npmNodeShim(entry: string): string {
  return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`, '',
  ].join('\r\n');
}

/** The shim's entry, relative to the shim directory, only when the file is exactly npm's node shim. */
function npmNodeShimEntry(text: string): string | undefined {
  const entry = /"%dp0%\\([^"%\r\n]+)" %\*\r\n$/.exec(text)?.[1];
  return entry !== undefined && text === npmNodeShim(entry) ? entry : undefined;
}

function spawnError(code: 'ENOENT' | 'ENOEXEC', message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
