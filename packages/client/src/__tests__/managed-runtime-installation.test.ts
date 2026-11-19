import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedBinaryPath, npmInstallInvocation, upgradeRuntime } from '../lifecycle/runtime-installation';
import { runtimeUpgradeAdvice } from '../runtime/runtime-releases';
import { managedRuntimeDirectory, resolveManagedRuntime } from '../adapters/managed-runtime-path';
import { resolveRuntimeCommand } from '../adapters/runtime-executable';
import { QUALIFIED_CLAUDE_VERSION } from '../adapters/claude/claude-version';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-managed-runtime-'));
  roots.push(root);
  return root;
}

describe('managed native executables', () => {
  it('launches the installed npm CLI with Node on Windows without opening the npm batch wrapper', () => {
    const directory = 'C:\\Program Files\\nodejs';
    const command = path.win32.join(directory, 'node.exe');
    const entry = path.win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const isFile = (file: string) => [path.win32.join(directory, 'npm.cmd'), command, entry].includes(file);
    const readFile = vi.fn(() => { throw new Error('npm batch files must not be read'); });
    expect(npmInstallInvocation({ platform: 'win32', env: { Path: `"${directory}"` }, isFile, isExecutable: isFile, readFile }))
      .toEqual({ command, args: [entry] });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    ['claude', 'darwin', 'arm64', false, false, '@anthropic-ai/claude-code-darwin-arm64/claude'],
    ['claude', 'linux', 'x64', true, true, '@anthropic-ai/claude-code-linux-x64-musl/claude'],
    ['claude', 'win32', 'x64', false, true, '@anthropic-ai/claude-code-win32-x64/claude.exe'],
    ['opencode', 'linux', 'x64', true, false, '@opencode/cli-linux-x64-baseline-musl/bin/opencode'],
    ['opencode', 'linux', 'x64', true, true, '@opencode/cli-linux-x64-musl/bin/opencode'],
    ['opencode', 'darwin', 'x64', false, false, '@opencode/cli-darwin-x64-baseline/bin/opencode'],
    ['opencode', 'win32', 'arm64', false, false, '@opencode/cli-windows-arm64/bin/opencode.exe'],
  ] as const)('resolves %s %s %s musl=%s avx2=%s', (id, platform, arch, musl, avx2, expected) => {
    expect(managedBinaryPath(id, { platform, arch, musl, avx2 })).toBe(path.join('node_modules', expected));
  });

  it.skipIf(process.platform === 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64'))('uses the native binary and preserves the active generation on failure', async () => {
    const root = await tempRoot();
    const bin = path.join(root, 'fixture-bin');
    await mkdir(bin);
    const suffix = process.platform === 'linux' && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header?.glibcVersionRuntime ? '-musl' : '';
    const native = `node_modules/@anthropic-ai/claude-code-${process.platform}-${process.arch}${suffix}/claude`;
    const npm = path.join(bin, 'npm');
    const installScript = `#!/bin/sh
set -eu
[ "$1" = install ]
[ "$2" = --prefix ]
[ "$3" = "$PWD" ]
[ "$4" = --ignore-scripts ]
[ "$9" = @anthropic-ai/claude-code@${QUALIFIED_CLAUDE_VERSION} ]
mkdir -p node_modules/@anthropic-ai/claude-code/bin "$(dirname '${native}')"
printf '#!/bin/sh\\nexit 23\\n' > node_modules/@anthropic-ai/claude-code/bin/claude.exe
printf '#!/bin/sh\\nprintf "%%s\\\\n" "${QUALIFIED_CLAUDE_VERSION} (Claude Code)"\\n' > '${native}'
chmod +x '${native}'
`;
    await writeFile(npm, installScript, { mode: 0o700 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    const options = { installRoot: path.join(root, 'sdk'), runtimeId: 'claude' as const };
    expect(resolveManagedRuntime(options.installRoot, 'claude')).toBeUndefined();
    const first = await upgradeRuntime(options);
    expect(first).toMatchObject({ kind: 'installed', version: QUALIFIED_CLAUDE_VERSION });
    if (first.kind !== 'installed' && first.kind !== 'current') throw new Error('managed fixture did not install');
    expect(first.executable.endsWith(native)).toBe(true);
    expect(await upgradeRuntime(options)).toEqual({ kind: 'current', version: QUALIFIED_CLAUDE_VERSION, executable: first.executable });
    const pointer = path.join(managedRuntimeDirectory(options.installRoot, 'claude'), 'current.json');
    const current = resolveManagedRuntime(options.installRoot, 'claude');
    expect(current).toMatchObject({ command: first.executable, version: QUALIFIED_CLAUDE_VERSION });
    const before = await readFile(pointer, 'utf8');
    await writeFile(npm, installScript.replace(`${QUALIFIED_CLAUDE_VERSION} (Claude Code)`, '2.0.0 (Claude Code)'));
    const empty = { ...options, installRoot: path.join(root, 'empty-sdk') };
    expect(await upgradeRuntime(empty)).toEqual({ kind: 'failed', reason: 'version_mismatch' });
    expect(resolveManagedRuntime(empty.installRoot, 'claude')).toBeUndefined();
    await writeFile(first.executable, `#!/bin/sh\n[ "$1" = --version ] || exit 17\nprintf '%s\\n' '${QUALIFIED_CLAUDE_VERSION} (Claude Code)'\n`);
    await writeFile(npm, '#!/bin/sh\nexit 19\n');
    expect(await upgradeRuntime(options)).toEqual({ kind: 'failed', reason: 'install_failed' });
    expect(await readFile(pointer, 'utf8')).toBe(before);
    expect(await readFile(first.executable, 'utf8')).toContain(QUALIFIED_CLAUDE_VERSION);
    expect(resolveRuntimeCommand(undefined, () => ({ command: 'claude', source: 'path' as const }), () =>
      resolveManagedRuntime(options.installRoot, 'claude'))).toMatchObject({ source: 'managed', bin: { command: first.executable } });
    await rm(first.executable);
    expect(() => resolveManagedRuntime(options.installRoot, 'claude')).toThrow('managed runtime installation is unusable');
  });
});

describe('runtime upgrade advice', () => {
  it('requires an upgrade when a proven ACP floor refuses the version', () => {
    expect(runtimeUpgradeAdvice('opencode', '1.18.34', '1.18.35')).toMatchObject({ state: 'required', minimumVersion: '1.18.35' });
  });
  it('offers an upgrade at the floor and below the qualified version, including allow-policy Claude', () => {
    expect(runtimeUpgradeAdvice('opencode', '2.0.26')).toMatchObject({ state: 'available' });
    expect(runtimeUpgradeAdvice('claude', '2.1.100 (Claude Code)')).toMatchObject({ state: 'available', qualifiedVersion: QUALIFIED_CLAUDE_VERSION });
  });
  it('omits an upgrade at and above the qualified version', () => {
    expect(runtimeUpgradeAdvice('claude', QUALIFIED_CLAUDE_VERSION)).toBeUndefined();
    expect(runtimeUpgradeAdvice('claude', '99.1.0 (Claude Code)')).toBeUndefined();
  });
  it.each([
    ['agy', 'agy update', 'standalone CLI'],
    ['grok', 'npm install -g @xai-official/grok', 'global Grok directory'],
  ] as const)('returns vendor instructions for %s without creating an install root', async (runtimeId, command, reason) => {
    const root = await tempRoot();
    const installRoot = path.join(root, 'unused');
    expect(await upgradeRuntime({ installRoot, runtimeId })).toMatchObject({
      kind: 'vendor', command, reason: expect.stringContaining(reason),
    });
    await expect(readFile(path.join(installRoot, 'runtimes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
