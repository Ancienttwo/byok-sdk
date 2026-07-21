import { promises as fs } from 'node:fs';
import os from 'node:os';
import { defaultRunner, type Runner } from '../lifecycle/exec-runner';

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
 * `lifecycle/exec-runner.ts`'s `defaultRunner`), which is never a shell and
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

export interface EnsureSecureDirOptions {
  /** DI for tests — see `lifecycle/exec-runner.ts`'s identical `Runner` seam. Defaults to `defaultRunner` (real `execFile`, never a shell). */
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
 * Non-win32 (darwin/linux) behavior is completely unchanged — the POSIX
 * `mkdir`/`chmod` calls above are the only enforcement there, and never
 * throw on their own best-effort `chmod` failure (that one stays
 * genuinely benign — an `EPERM` against a directory this process doesn't
 * own — see the inline comment on it).
 */
export async function ensureSecureDir(dir: string, opts: EnsureSecureDirOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});

  if (platform !== 'win32') return;

  const { username } = os.userInfo();
  let result: Awaited<ReturnType<Runner>>;
  try {
    result = await run('icacls', buildIcaclsArgs(dir, username));
  } catch (err) {
    throw new SecureDirHardeningError(dir, `could not run icacls: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.code !== 0) {
    throw new SecureDirHardeningError(dir, `icacls exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
  }
}
