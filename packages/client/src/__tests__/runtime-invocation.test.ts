import { describe, expect, it } from 'vitest';
import { classifyDetectError } from '../adapters/detect-outcome';
import { resolveRuntimeInvocation, type RuntimeInvocationHost } from '../adapters/runtime-invocation';

// Bytes npm's cmd-shim 8.0.0 writes for a `#!/usr/bin/env node` bin.
const npmNodeShim = (entry: string) => '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n'
  + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*\r\n`;
// cmd-shim 9.0.2 (npm 12) moves the PATHEXT change to the last line.
const npm12NodeShim = (entry: string) => npmNodeShim(entry)
  .replace('  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n', '')
  .replace('title %COMSPEC% & "%_prog%"', 'title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"');
// cmd-shim 8.0.0 for `#!/usr/bin/env node --max-old-space-size=99`, and for `#!/bin/sh`.
const npmNodeArgsShim = npmNodeShim('node_modules\\x\\cli.js').replace('"%_prog%"  ', '"%_prog%" --max-old-space-size=99 ');
const npmShShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\/bin/sh.exe" (\r\n  SET "_prog=%dp0%\\/bin/sh.exe"\r\n) ELSE (\r\n  SET "_prog=/bin/sh"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n'
  + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\x\\cli.sh" %*\r\n';

const CLAUDE_ENTRY = 'node_modules\\@anthropic-ai\\claude-code\\cli.js';

function windows(files: Record<string, string>, env: Record<string, string> = { Path: 'C:\\empty;C:\\npm;C:\\node' }) {
  const looked: string[] = [];
  const host: RuntimeInvocationHost = {
    platform: 'win32',
    env,
    isFile: file => { looked.push(file); return file in files; },
    readFile: file => {
      if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[file]!;
    },
  };
  return { host, looked };
}

// A prepare rejection reason leaves the device, so the message names no local path.
function thrownCode(run: () => unknown): unknown {
  try { run(); } catch (error) {
    expect((error as Error).message).not.toMatch(/[A-Za-z]:\\/);
    return { code: (error as NodeJS.ErrnoException).code, kind: classifyDetectError(error).kind };
  }
  return 'no error';
}

describe('resolveRuntimeInvocation', () => {
  it('keeps the command unchanged off Windows and reads no file', () => {
    const { host, looked } = windows({});
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolveRuntimeInvocation('claude', { ...host, platform })).toEqual({ command: 'claude', args: [] });
    }
    expect(looked).toEqual([]);
  });

  it('runs the entry of an npm node shim on PATH with node from PATH', () => {
    const { host } = windows({ 'C:\\npm\\claude.cmd': npmNodeShim(CLAUDE_ENTRY), 'C:\\node\\node.exe': '' });
    expect(resolveRuntimeInvocation('claude', host)).toEqual({
      command: 'C:\\node\\node.exe',
      args: [`C:\\npm\\${CLAUDE_ENTRY}`],
    });
  });

  it('accepts the npm 12 shim form', () => {
    const { host } = windows({ 'C:\\npm\\claude.cmd': npm12NodeShim(CLAUDE_ENTRY), 'C:\\node\\node.exe': '' });
    expect(resolveRuntimeInvocation('claude', host)).toEqual({
      command: 'C:\\node\\node.exe',
      args: [`C:\\npm\\${CLAUDE_ENTRY}`],
    });
  });

  it('prefers node.exe next to the shim, as the shim does', () => {
    const { host } = windows({ 'C:\\npm\\codex.cmd': npmNodeShim('node_modules\\@openai\\codex\\bin\\codex.js'), 'C:\\npm\\node.exe': '', 'C:\\node\\node.exe': '' });
    expect(resolveRuntimeInvocation('codex', host).command).toBe('C:\\npm\\node.exe');
  });

  it('resolves a full .cmd path from the override variable the same way', () => {
    const { host } = windows({ 'D:\\tools\\claude.cmd': npmNodeShim(CLAUDE_ENTRY), 'C:\\node\\node.exe': '' });
    expect(resolveRuntimeInvocation('D:\\tools\\claude.cmd', host)).toEqual({
      command: 'C:\\node\\node.exe',
      args: [`D:\\tools\\${CLAUDE_ENTRY}`],
    });
  });

  it('runs a native .exe directly and follows PATH order before PATHEXT order', () => {
    const { host } = windows({ 'C:\\empty\\claude.exe': '', 'C:\\npm\\claude.cmd': npmNodeShim(CLAUDE_ENTRY) });
    expect(resolveRuntimeInvocation('claude', host)).toEqual({ command: 'C:\\empty\\claude.exe', args: [] });
    const sameDir = windows({ 'C:\\npm\\claude.exe': '', 'C:\\npm\\claude.cmd': npmNodeShim(CLAUDE_ENTRY), 'C:\\node\\node.exe': '' },
      { PATH: 'C:\\npm;C:\\node', PATHEXT: '.CMD;.EXE' });
    expect(resolveRuntimeInvocation('claude', sameDir.host).command).toBe('C:\\node\\node.exe');
  });

  it('never searches the current directory and ignores the extensionless sh shim and the .ps1 shim', () => {
    const { host, looked } = windows({ 'claude.cmd': npmNodeShim(CLAUDE_ENTRY), 'C:\\npm\\claude': '', 'C:\\npm\\claude.ps1': '' });
    expect(resolveRuntimeInvocation('claude', host)).toEqual({ command: 'claude', args: [] });
    expect(looked).not.toContain('claude.cmd');
    expect(looked).not.toContain('C:\\npm\\claude');
    expect(looked).not.toContain('C:\\npm\\claude.ps1');
  });

  it('passes an unknown extension through unchanged', () => {
    const { host } = windows({ 'C:\\fixtures\\fake-claude.mjs': '' });
    expect(resolveRuntimeInvocation('C:\\fixtures\\fake-claude.mjs', host)).toEqual({ command: 'C:\\fixtures\\fake-claude.mjs', args: [] });
  });

  it('refuses every other batch file instead of running it through cmd.exe', () => {
    const cases = {
      'C:\\npm\\a.cmd': '@echo off\r\nnode "%~dp0\\cli.js" %*\r\n',
      'C:\\npm\\b.bat': npmNodeShim(CLAUDE_ENTRY),
      'C:\\npm\\c.cmd': npmNodeArgsShim,
      'C:\\npm\\d.cmd': npmShShim,
      'C:\\npm\\e.cmd': npmNodeShim(CLAUDE_ENTRY).replaceAll('\r\n', '\n'),
      'C:\\npm\\f.cmd': npmNodeShim(CLAUDE_ENTRY) + 'calc.exe\r\n',
    };
    const { host } = windows({ ...cases, 'C:\\node\\node.exe': '' });
    for (const file of Object.keys(cases)) {
      expect(thrownCode(() => resolveRuntimeInvocation(file, host)), file).toEqual({ code: 'ENOEXEC', kind: 'not-executable' });
    }
  });

  it('reports a shim without node as not found', () => {
    const { host } = windows({ 'C:\\npm\\claude.cmd': npmNodeShim(CLAUDE_ENTRY) });
    expect(thrownCode(() => resolveRuntimeInvocation('claude', host))).toEqual({ code: 'ENOENT', kind: 'not-found' });
  });
});
