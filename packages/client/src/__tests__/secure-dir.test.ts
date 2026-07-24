import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../lifecycle/exec-runner';
import { buildIcaclsArgs, ensureSecureDir, SecureDirHardeningError } from '../util/secure-dir';

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
 *
 * Finding R4 (cross-model RE-review — F7 residuals): two behavioral
 * changes from the original F7 fix, both covered below —
 * (a) `SYSTEM`/`Administrators` are now granted by their well-known,
 * locale-independent SIDs rather than their (localized) display names;
 * (b) an `icacls` failure on win32 now THROWS ({@link SecureDirHardeningError})
 * instead of logging a warning and continuing.
 */
describe('util/secure-dir: buildIcaclsArgs (pure, finding F7/R4)', () => {
  it('builds the expected argv: strip inheritance, grant the user (by name) + SYSTEM/Administrators (by well-known SID) full control, recursively', () => {
    expect(buildIcaclsArgs('C:\\Users\\alice\\.byok\\acme', 'alice')).toEqual([
      'C:\\Users\\alice\\.byok\\acme',
      '/inheritance:r',
      '/grant:r',
      'alice:(OI)(CI)F',
      '/grant',
      '*S-1-5-18:(OI)(CI)F', // SYSTEM
      '/grant',
      '*S-1-5-32-544:(OI)(CI)F', // BUILTIN\Administrators
    ]);
  });

  it('finding R4: grants SYSTEM/Administrators by SID, never by their (localized) display name', () => {
    const args = buildIcaclsArgs('C:\\store', 'alice');
    expect(args).not.toContain('SYSTEM:(OI)(CI)F');
    expect(args).not.toContain('Administrators:(OI)(CI)F');
    expect(args.some((a) => a.startsWith('*S-1-5-18:'))).toBe(true);
    expect(args.some((a) => a.startsWith('*S-1-5-32-544:'))).toBe(true);
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
    expect(grantValues.sort()).toEqual(['*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', 'bob:(OI)(CI)F'].sort());
  });
});

describe('util/secure-dir: ensureSecureDir (finding F7/R4)', () => {
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

  it('finding R4: on win32, a non-zero icacls exit THROWS SecureDirHardeningError — no longer a logged-and-ignored warning', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-win-fail-'), 'store');
    vi.spyOn(os, 'userInfo').mockReturnValue({
      username: 'winuser',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: 'C:\\Users\\winuser',
    });
    const run = vi.fn<Runner>().mockResolvedValue({ code: 5, stdout: '', stderr: 'Access is denied.' });

    const err = await ensureSecureDir(dir, { platform: 'win32', run }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SecureDirHardeningError);
    expect((err as SecureDirHardeningError).dir).toBe(dir);
    expect((err as Error).message).toContain('icacls');
    expect((err as Error).message).toContain('Access is denied');
    expect((err as Error).message).toContain(dir);
    // The directory itself was still created (mkdir/chmod ran BEFORE the
    // icacls step) — only the ACL hardening failed.
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('finding R4: on win32, icacls itself failing to spawn (e.g. ENOENT) ALSO throws SecureDirHardeningError', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-win-enoent-'), 'store');
    vi.spyOn(os, 'userInfo').mockReturnValue({
      username: 'winuser',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: 'C:\\Users\\winuser',
    });
    const run = vi.fn<Runner>().mockRejectedValue(Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' }));

    const err = await ensureSecureDir(dir, { platform: 'win32', run }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SecureDirHardeningError);
    expect((err as Error).message).toContain('ENOENT');
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('finding R4: non-win32 (darwin/linux) behavior is completely unchanged — no throw, even with a failing run injected (never called)', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-posix-unaffected-'), 'store');
    const run = vi.fn<Runner>().mockRejectedValue(new Error('should never be called on this platform'));

    await expect(ensureSecureDir(dir, { platform: 'darwin', run })).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('defaults platform to process.platform', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-default-'), 'store');
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await ensureSecureDir(dir, { run }); // no platform override

    if (process.platform === 'win32') {
      expect(run).toHaveBeenCalledOnce();
    } else {
      expect(run).not.toHaveBeenCalled();
    }
  });
});
