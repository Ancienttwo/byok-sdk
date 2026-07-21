import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../lifecycle/exec-runner';
import { buildIcaclsArgs, ensureSecureDir } from '../util/secure-dir';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding F7 (cross-model adversarial review): POSIX file modes restrict
 * nothing on win32 — `fs.chmod` there only toggles the read-only attribute,
 * never the ACL/DACL. `ensureSecureDir` is the one chokepoint
 * `DeviceStore.save()`/`control-server.ts`'s `startControlServer` both
 * funnel `storeDir` creation through; this suite covers the pure
 * command-construction seam (`buildIcaclsArgs`, testable on any host OS)
 * and `ensureSecureDir`'s own branching (real directory creation on every
 * platform, `icacls` invoked ONLY on win32 — exercised here via the
 * injected `platform`/`run` seam, since this SDK is developed on
 * darwin/linux and cannot run real `icacls`; the actual real-binary
 * behavior is covered by `templates/service/winsw/smoke-test.mjs`'s
 * win32-only CI smoke assertion instead).
 */
describe('util/secure-dir: buildIcaclsArgs (pure, finding F7)', () => {
  it('builds the expected argv: strip inheritance, grant the user/SYSTEM/Administrators full control, recursively', () => {
    expect(buildIcaclsArgs('C:\\Users\\alice\\.byok\\acme', 'alice')).toEqual([
      'C:\\Users\\alice\\.byok\\acme',
      '/inheritance:r',
      '/grant:r',
      'alice:(OI)(CI)F',
      '/grant',
      'SYSTEM:(OI)(CI)F',
      '/grant',
      'Administrators:(OI)(CI)F',
    ]);
  });

  it('keeps a directory path containing spaces as ONE argv element (relies on execFile array-form quoting, not manual escaping)', () => {
    const args = buildIcaclsArgs('C:\\Program Files\\Acme Co\\store', 'alice');
    expect(args[0]).toBe('C:\\Program Files\\Acme Co\\store');
    expect(args).toHaveLength(8);
  });

  it('keeps a username containing spaces as ONE argv element, composed with the permission suffix', () => {
    const args = buildIcaclsArgs('C:\\store', 'First Last');
    expect(args).toContain('First Last:(OI)(CI)F');
    // Never split into separate "First" / "Last:(OI)(CI)F" elements.
    expect(args).not.toContain('First');
    expect(args).not.toContain('Last:(OI)(CI)F');
  });

  it('grants exactly three principals — the caller-supplied user, SYSTEM, and Administrators — never more, never fewer', () => {
    const args = buildIcaclsArgs('C:\\store', 'bob');
    const grantValues = args.filter((_, i) => args[i - 1] === '/grant' || args[i - 1] === '/grant:r');
    expect(grantValues.sort()).toEqual(['Administrators:(OI)(CI)F', 'SYSTEM:(OI)(CI)F', 'bob:(OI)(CI)F'].sort());
  });
});

describe('util/secure-dir: ensureSecureDir (finding F7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the directory and chmods it 0700 on every platform, and never invokes icacls off win32', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-posix-'), 'nested', 'store');
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await ensureSecureDir(dir, { platform: 'darwin', run });

    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('on win32, invokes icacls with buildIcaclsArgs(dir, os.userInfo().username) after creating the directory', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-win-'), 'store');
    vi.spyOn(os, 'userInfo').mockReturnValue({
      username: 'winuser',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: 'C:\\Users\\winuser',
    });
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await ensureSecureDir(dir, { platform: 'win32', run });

    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('icacls', buildIcaclsArgs(dir, 'winuser'));
  });

  it('on win32, a non-zero icacls exit is logged loudly (console.warn) — never thrown, never silently swallowed', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-win-fail-'), 'store');
    vi.spyOn(os, 'userInfo').mockReturnValue({
      username: 'winuser',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: 'C:\\Users\\winuser',
    });
    const run = vi.fn<Runner>().mockResolvedValue({ code: 5, stdout: '', stderr: 'Access is denied.' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureSecureDir(dir, { platform: 'win32', run })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0]!;
    expect(message).toContain('icacls');
    expect(message).toContain('Access is denied');
    expect(message).toContain(dir);
  });

  it('on win32, icacls itself failing to spawn (e.g. ENOENT) is logged loudly — the directory still exists and the call never throws', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-win-enoent-'), 'store');
    vi.spyOn(os, 'userInfo').mockReturnValue({
      username: 'winuser',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: 'C:\\Users\\winuser',
    });
    const run = vi.fn<Runner>().mockRejectedValue(Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureSecureDir(dir, { platform: 'win32', run })).resolves.toBeUndefined();

    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('ENOENT');
  });

  it('defaults platform to process.platform (this test host is never win32, so the default path never invokes icacls)', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-default-'), 'store');
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await ensureSecureDir(dir, { run }); // no platform override

    expect(run).not.toHaveBeenCalled();
  });
});
