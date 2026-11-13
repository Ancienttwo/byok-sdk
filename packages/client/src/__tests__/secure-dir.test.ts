import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSystemTool } from '@byok-sdk/core/system-tool';
import { COMMAND_TIMEOUT_MS, PlatformCommandTimeoutError } from '../util/command-timeouts';
import type { Runner } from '../util/exec-runner';
import { buildIcaclsArgs, ensurePiProjectionDir, ensureSecureDir, ensureSecureStoreRoot, SecureDirHardeningError, SecureDirModeError } from '../util/secure-dir';

vi.mock('@byok-sdk/core/system-tool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@byok-sdk/core/system-tool')>();
  return { ...actual, resolveSystemTool: vi.fn(actual.resolveSystemTool) };
});

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

  it.runIf(process.platform !== 'win32')('#1971: the real icacls run is bounded by the platform bound and surfaces its timeout', async () => {
    const root = await tmpDir('byok-secure-dir-icacls-');
    // A stand-in icacls that never exits.
    const icacls = path.join(root, 'icacls');
    await fs.writeFile(icacls, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    vi.mocked(resolveSystemTool).mockReturnValueOnce(icacls);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      let settled = false;
      const secured = ensureSecureDir(path.join(root, 'store'), { platform: 'win32' }).catch((error: unknown) => error).finally(() => (settled = true));
      // The bound is armed once the command has started.
      await vi.waitUntil(() => vi.getTimerCount() > 0);
      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS.platform - 500);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(await secured).toMatchObject({ constructor: PlatformCommandTimeoutError, exitConfirmed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('#1971: an icacls timeout surfaces as PlatformCommandTimeoutError, not a hardening error', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-win-'), 'store');
    const timeout = new PlatformCommandTimeoutError('icacls timed out', false);
    await expect(ensureSecureDir(dir, { platform: 'win32', run: async () => Promise.reject(timeout) })).rejects.toBe(timeout);
  });

  // #1373: only the keys Pi projection directory also grants OWNER RIGHTS READ_CONTROL, without inheritance.
  it('on win32, the Pi projection directory adds an OWNER RIGHTS READ_CONTROL grant to the same DACL', async () => {
    const dir = path.join(await tmpDir('byok-secure-dir-projection-'), 'pi-abc123');
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'winuser', uid: -1, gid: -1, shell: null, homedir: 'C:\\Users\\winuser' });
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await ensurePiProjectionDir(dir, { platform: 'win32', run });

    expect(run).toHaveBeenCalledExactlyOnceWith('icacls', [...buildIcaclsArgs(dir, 'winuser'), '/grant', '*S-1-3-4:(RC)']);
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

describe.skipIf(process.platform === 'win32')('util/secure-dir: POSIX mode contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an owned 0755 directory becomes 0700, for both entry points', async () => {
    for (const ensure of [ensureSecureDir, ensureSecureStoreRoot]) {
      const dir = await tmpDir('byok-secure-dir-mode-');
      await fs.chmod(dir, 0o755);
      await ensure(dir);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it('refuses an owned directory whose mode cannot be set, with the chmod error as cause', async () => {
    const dir = await tmpDir('byok-secure-dir-chmod-denied-');
    await fs.chmod(dir, 0o755);
    const denied = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    vi.spyOn(fs, 'chmod').mockRejectedValue(denied);
    const err = await ensureSecureDir(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecureDirModeError);
    expect(err).toMatchObject({ code: 'secure_dir_mode', dir, cause: denied });
  });

  it('does not chmod an owned directory that is already 0700', async () => {
    const dir = await tmpDir('byok-secure-dir-already-');
    const chmod = vi.spyOn(fs, 'chmod').mockRejectedValue(new Error('EPERM'));
    await expect(ensureSecureDir(dir)).resolves.toBeUndefined();
    expect(chmod).not.toHaveBeenCalled();
  });

  it('leaves a foreign-owned store root unchanged: no chmod, no refusal', async () => {
    const dir = await tmpDir('byok-secure-dir-foreign-');
    await fs.chmod(dir, 0o755);
    const real = await fs.stat(dir);
    vi.spyOn(fs, 'stat').mockResolvedValue(Object.assign(Object.create(Object.getPrototypeOf(real)), real, { uid: real.uid + 1 }));
    const chmod = vi.spyOn(fs, 'chmod');
    await expect(ensureSecureStoreRoot(dir)).resolves.toBeUndefined();
    expect(chmod).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o755);
  });
});
