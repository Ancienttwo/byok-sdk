import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveSystemTool } from '@byok-sdk/core/system-tool';
import { COMMAND_TIMEOUT_MS, PlatformCommandTimeoutError, stopRoot } from './command-timeouts.js';
import { type Runner } from './exec-runner.js';

/**
 * Runs `icacls` within the `platform` bound (#1971); past it the process is
 * killed and the run rejects with `PlatformCommandTimeoutError`, its exit
 * confirmed only when it exited within the `rootExit` bound. Not the lifecycle's
 * `defaultRunner` (`lifecycle/platform-command.ts`): `util` may not depend on
 * `lifecycle`, and this lazily loaded module would pull that runner's
 * process-tree graph into lazy initialisers. `icacls` starts no children, so
 * killing it stops the whole command.
 */
const runIcacls: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(resolveSystemTool(command), args, { windowsHide: true }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopRoot(child, command).then(reject);
    }, COMMAND_TIMEOUT_MS.platform);
  });

/**
 * Finding F7 (cross-model adversarial review): POSIX file MODES
 * (`fs.chmod(dir, 0o700)`) restrict nothing on win32 — Node's `fs.chmod` on
 * Windows only ever toggles the read-only ATTRIBUTE, it never touches the
 * ACL/DACL. Before this fix, `storeDir` (which holds `device.json` — an
 * Ed25519 private key + access token — and `control.token` — the control
 * socket's HMAC secret) was effectively unrestricted-by-this-codebase on
 * Windows despite every `{mode: 0o700}`/`{mode: 0o600}` call site looking
 * identical across platforms; only the OS's own default ACL (typically
 * readable by any local user in the same Users group, depending on parent
 * directory inheritance) applied.
 *
 * `ensureSecureDir` is the ONE chokepoint both `DeviceStore.save()`
 * (`daemon/store.ts`) and `control-server.ts`'s `startControlServer` funnel
 * `storeDir` creation through — the win32 hardening below only needs to
 * exist here, once, rather than being independently (and easily
 * inconsistently) re-added at each call site.
 */

/**
 * Finding R4 (cross-model re-review — F7 residual): the well-known SID for
 * the local `SYSTEM` account (`NT AUTHORITY\SYSTEM`) — invariant across
 * every Windows locale/edition. See `buildIcaclsArgs`'s own doc comment for
 * why SID form (`*S-...`, icacls's own documented "prefix with `*`" syntax)
 * is used here instead of the display name `SYSTEM`.
 */
const SYSTEM_SID = '*S-1-5-18';
/** Finding R4: the well-known SID for the built-in `Administrators` group (`BUILTIN\Administrators`) — same locale-independence rationale as {@link SYSTEM_SID}. */
const ADMINISTRATORS_SID = '*S-1-5-32-544';
/** OWNER RIGHTS: an ACE for it replaces the rights an owner gets implicitly (READ_CONTROL and WRITE_DAC). */
const OWNER_RIGHTS_SID = '*S-1-3-4';

/**
 * Pure command-construction seam (finding F7) — kept separate from the
 * actual `icacls` invocation below so it's unit-testable on ANY host OS,
 * not just win32 (this whole SDK is developed on darwin/linux — see
 * `templates/service/winsw/smoke-test.mjs`'s own header comment on the
 * identical constraint for WinSW itself).
 *
 * Removes inherited ACEs (`/inheritance:r`) and grants FULL CONTROL,
 * recursively (`(OI)(CI)F` — Object Inherit, Container Inherit, Full
 * control — so anything created under `dir` afterward inherits the SAME
 * restriction without needing to be re-ACL'd individually) to exactly
 * three principals:
 *
 * - the current user, via `os.userInfo().username` — deliberately NOT the
 *   `%USERNAME%` environment variable a hand-typed reference command might
 *   use: an env var can be stale, unset, or (in an unusual but real
 *   embedding) spoofed by whatever set up this process's environment;
 *   querying the OS directly cannot be. This one genuinely has to be a
 *   NAME (icacls has no "current user" SID shorthand), but it's the
 *   account's real name, not a translated built-in label.
 * - `SYSTEM` and `Administrators` — both needed for a Windows-SERVICE
 *   topology, where the daemon runs as `SYSTEM` (a WinSW-installed
 *   service's default account) while an operator's interactive CLI
 *   invocation runs as a normal user against the SAME `storeDir` — see
 *   `control-protocol.ts`'s `controlPipeName` doc comment for the
 *   identical service-account rationale on the pipe-naming side. Finding
 *   R4: referenced by their WELL-KNOWN SIDs ({@link SYSTEM_SID} /
 *   {@link ADMINISTRATORS_SID}), not the display names `SYSTEM`/
 *   `Administrators` — those two names are LOCALIZED (e.g. a
 *   French-language Windows renders the Administrators group as
 *   "Administrateurs"), so `icacls ... /grant Administrators:...` would
 *   silently fail to resolve (and thus fail the whole hardening step) on
 *   any non-English install. The SIDs themselves are invariant across
 *   every locale/edition; `icacls` accepts SID form directly when prefixed
 *   with `*` (its own documented syntax).
 *
 * Returns a plain ARGV array with NO manually-embedded quote characters —
 * this is meant for `child_process.execFile`'s array form (this codebase's
 * own established convention for every external command it ever runs; see
 * `lifecycle/platform-command.ts`'s `defaultRunner`), which is never a shell and
 * so has no shell-quoting hazard for a `dir`/username containing spaces —
 * Node's own Windows argv encoding (used internally by `execFile`/`spawn`
 * when given an array) already quotes/escapes each element correctly
 * regardless of embedded whitespace. Hand-rolling literal `"` characters
 * into an array element bound for that API would risk DOUBLE-quoting
 * instead of fixing anything — the icacls reference command sometimes
 * quoted as `"%USERNAME%":(OI)(CI)F` is a shell/cmd.exe-level concern that
 * simply does not apply once argv is passed as an array with no shell
 * involved.
 */
export function buildIcaclsArgs(dir: string, username: string): string[] {
  return [dir, '/inheritance:r', '/grant:r', `${username}:(OI)(CI)F`, '/grant', `${SYSTEM_SID}:(OI)(CI)F`, '/grant', `${ADMINISTRATORS_SID}:(OI)(CI)F`];
}

/** Restrictive ACL for one already-created file; no inheritance flags because the target cannot contain children. */
export function buildIcaclsFileArgs(filePath: string, username: string): string[] {
  return [
    filePath,
    '/inheritance:r',
    '/grant:r',
    `${username}:F`,
    '/grant',
    `${SYSTEM_SID}:F`,
    '/grant',
    `${ADMINISTRATORS_SID}:F`,
  ];
}

export interface EnsureSecureDirOptions {
  /** DI for tests — see `util/exec-runner.ts`'s identical `Runner` seam. Defaults to a bounded `icacls` run (real `execFile`, never a shell). */
  run?: Runner;
  /** DI for tests — lets the win32 branch below be exercised (with a fake `run`) from any host OS, mirroring `control-protocol.ts`'s `controlEndpointPath` platform-override convention. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Finding R4 (cross-model re-review — F7 residual): thrown by
 * {@link ensureSecureDir} on win32 when `icacls` either could not be run at
 * all (e.g. missing binary, or a restricted service account lacking
 * permission to spawn it) or ran and exited non-zero (e.g. it couldn't
 * resolve a principal, or was itself denied). This directory's contents —
 * `device.json` (an Ed25519 private key + access token) or `control.token`
 * (the control socket's HMAC secret) — would otherwise be protected by
 * nothing but the OS's own default ACL, typically readable by any local
 * user; see `docs/security.md`'s own note on why this is now fail-closed
 * rather than a logged-and-ignored warning. See {@link ensureSecureDir}'s
 * own doc comment for how each caller (`DeviceStore.save`,
 * `control-server.ts`'s `startControlServer`) reacts to this.
 */
export class SecureDirHardeningError extends Error {
  constructor(
    public readonly dir: string,
    reason: string,
  ) {
    super(
      `failed to apply a restrictive Windows ACL to "${dir}": ${reason} — refusing to leave this directory unprotected (it holds device credentials and/or the control-socket token, otherwise readable by any other local user); see docs/security.md`,
    );
    this.name = 'SecureDirHardeningError';
  }
}

/** An owned directory whose mode is not 0700 and cannot be set to it; `cause` is the chmod error when chmod failed. */
export class SecureDirModeError extends Error {
  readonly code = 'secure_dir_mode';
  constructor(
    public readonly dir: string,
    cause?: unknown,
  ) {
    super(`refusing directory "${dir}": its mode is not 0700 and could not be set to 0700`, cause === undefined ? undefined : { cause });
    this.name = 'SecureDirModeError';
  }
}

export class SecureFileHardeningError extends Error {
  constructor(
    public readonly filePath: string,
    reason: string,
  ) {
    super(`failed to apply a restrictive Windows ACL to "${filePath}": ${reason}`);
    this.name = 'SecureFileHardeningError';
  }
}

/**
 * Creates (if needed) and secures `dir`: POSIX `{mode: 0o700}` plus a
 * best-effort `chmod` re-assertion on every platform (unchanged from
 * before this fix — this is what actually restricts access on
 * darwin/linux), PLUS — win32 only — a restrictive DACL via `icacls` (see
 * `buildIcaclsArgs`'s own doc comment for exactly what it grants/removes).
 *
 * Finding R4 (cross-model re-review): the win32 `icacls` step is now
 * FAIL-CLOSED — it used to be best-effort (logged via `console.warn`,
 * never thrown), which meant a host where `icacls` genuinely can't run
 * (missing binary, a locked-down service account) would silently create
 * `storeDir` with NO Windows-side ACL protection at all and carry on as if
 * nothing were wrong. Now it THROWS {@link SecureDirHardeningError}
 * instead, on both failure shapes (the spawn itself failing, or `icacls`
 * running and exiting non-zero). Each real caller already has (or gets,
 * via this fix) an appropriate reaction:
 *
 * - `control-server.ts`'s `startControlServer` calls this as the very
 *   FIRST thing, before any socket/pipe exists — a thrown error here
 *   propagates out of `startControlServer` with nothing to clean up (no
 *   F9-style orphan-listener risk), straight into `create-daemon.ts`'s
 *   `start()`'s EXISTING "any non-`AnotherControlServerRunningError` bind
 *   failure degrades non-fatally" catch block: logs a loud
 *   `console.warn` naming the reason (this error's own message) and
 *   continues the rest of the daemon WITHOUT a control socket — the
 *   correct "graceful path" for a control-IPC-layer failure, unchanged
 *   code, already exactly right once this function starts throwing.
 * - `DeviceStore.save()` calls this before ever writing `device.json` —
 *   a thrown error here propagates directly out of `AuthManager.pair()`
 *   (called during `pair()`, before any credential is persisted) as a
 *   clear, typed, actionable rejection — pairing simply fails rather than
 *   silently leaving an unprotected device keypair/access token on disk.
 *
 * On POSIX the directory is created 0700, and an existing one whose mode is
 * not 0700 is chmod'ed to it; a failed chmod or a mode that is still wrong
 * throws {@link SecureDirModeError}. A directory that is already 0700 is not
 * chmod'ed, so a sandbox that denies chmod does not refuse it. Use
 * {@link ensureSecureStoreRoot} for the store root, which may be foreign-owned.
 */
export async function ensureSecureDir(dir: string, opts: EnsureSecureDirOptions = {}): Promise<void> {
  await secureDir(dir, buildIcaclsArgs, opts, 'owned');
}

/**
 * {@link ensureSecureDir} for the store root. A root owned by another user
 * keeps the mode its owner set (no chmod, no refusal); one the process owns
 * follows the {@link ensureSecureDir} rule. The role is the caller's choice,
 * never inferred from the path.
 */
export async function ensureSecureStoreRoot(dir: string, opts: EnsureSecureDirOptions = {}): Promise<void> {
  await secureDir(dir, buildIcaclsArgs, opts, 'store-root');
}

/**
 * The keys Pi projection DACL: {@link buildIcaclsArgs} plus OWNER RIGHTS
 * (S-1-3-4) with READ_CONTROL only and no inheritance flags. That ACE takes
 * away the owner's implicit WRITE_DAC, so the keys launcher can accept the
 * directory without reading its owner (#1373). Only the projection directory
 * gets it.
 */
export function buildProjectionIcaclsArgs(dir: string, username: string): string[] {
  return [...buildIcaclsArgs(dir, username), '/grant', `${OWNER_RIGHTS_SID}:(RC)`];
}

/** {@link ensureSecureDir} for the keys Pi projection directory, with {@link buildProjectionIcaclsArgs}. */
export async function ensurePiProjectionDir(dir: string, opts: EnsureSecureDirOptions = {}): Promise<void> {
  await secureDir(dir, buildProjectionIcaclsArgs, opts, 'owned');
}

async function secureDir(dir: string, buildArgs: (dir: string, username: string) => string[], opts: EnsureSecureDirOptions, role: 'owned' | 'store-root'): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runIcacls;

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // No chmod on win32: the icacls DACL below is the authority there.
  if (platform !== 'win32') {
    await requireMode0700(dir, role);
    return;
  }

  const { username } = os.userInfo();
  let result: Awaited<ReturnType<Runner>>;
  try {
    result = await run('icacls', buildArgs(dir, username));
  } catch (err) {
    if (err instanceof PlatformCommandTimeoutError) throw err;
    throw new SecureDirHardeningError(dir, `could not run icacls: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.code !== 0) {
    throw new SecureDirHardeningError(dir, `icacls exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
  }
}

/**
 * Whether `dir` breaks the POSIX 0700 rule for `role`, without changing it.
 * Nothing to report on a platform without getuid, or for a store root another
 * user owns. stat, not lstat: a symlinked directory root stays supported, and
 * its target's mode is the one that matters.
 */
export async function isModeNot0700(dir: string, role: 'owned' | 'store-root'): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const stat = await fs.stat(dir);
  if (role === 'store-root' && stat.uid !== uid) return false;
  return (stat.mode & 0o777) !== 0o700;
}

async function requireMode0700(dir: string, role: 'owned' | 'store-root'): Promise<void> {
  if (!(await isModeNot0700(dir, role))) return;
  await fs.chmod(dir, 0o700).catch((error: unknown) => {
    throw new SecureDirModeError(dir, error);
  });
  if (((await fs.stat(dir)).mode & 0o777) !== 0o700) throw new SecureDirModeError(dir);
}

/** Re-asserts 0600 on POSIX and a non-inherited owner/SYSTEM/Admin DACL on Windows. */
export async function ensureSecureFile(filePath: string, opts: EnsureSecureDirOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runIcacls;
  await fs.chmod(filePath, 0o600);
  if (platform !== 'win32') return;
  const { username } = os.userInfo();
  let result: Awaited<ReturnType<Runner>>;
  try {
    result = await run('icacls', buildIcaclsFileArgs(filePath, username));
  } catch (err) {
    if (err instanceof PlatformCommandTimeoutError) throw err;
    throw new SecureFileHardeningError(filePath, `could not run icacls: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.code !== 0) {
    throw new SecureFileHardeningError(filePath, `icacls exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
  }
}

const TEMP_NAME_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Creates `<parent>/<prefix>` plus six random letters and digits (the name
 * mkdtemp would give, which the retention sweep matches) with one exclusive
 * mkdir, mode 0700; on Windows it inherits the parent's ACL. It replaces
 * fs.mkdtemp, which on Windows fails with ENOENT once the path passes
 * MAX_PATH while mkdir does not (#1097). An existing name throws EEXIST.
 */
export async function createPrivateTempDir(parent: string, prefix: string): Promise<string> {
  const suffix = Array.from(randomBytes(6), (byte) => TEMP_NAME_ALPHABET[byte % TEMP_NAME_ALPHABET.length]).join('');
  const directory = path.join(parent, `${prefix}${suffix}`);
  await fs.mkdir(directory, { mode: 0o700 });
  return directory;
}

/**
 * A private scratch directory directly under the canonical OS temp root, for
 * a tool whose own path limit is shorter than the store's, so its length
 * cannot depend on where the store lives. The leaf is created by an exclusive mkdir under the real path of the
 * temp root, so a pre-planted symlink or junction is never followed, and
 * {@link ensureSecureDir} applies the same owner-only restriction every other
 * scratch root gets. The caller removes it.
 */
export async function createPrivateSystemTempDir(prefix: string): Promise<string> {
  const directory = await createPrivateTempDir(await fs.realpath(os.tmpdir()), prefix);
  try {
    await ensureSecureDir(directory);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return directory;
}
