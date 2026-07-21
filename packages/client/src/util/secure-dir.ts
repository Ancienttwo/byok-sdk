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
 *   querying the OS directly cannot be.
 * - `SYSTEM` and `Administrators` — both needed for a Windows-SERVICE
 *   topology, where the daemon runs as `SYSTEM` (a WinSW-installed
 *   service's default account) while an operator's interactive CLI
 *   invocation runs as a normal user against the SAME `storeDir` — see
 *   `control-protocol.ts`'s `controlPipeName` doc comment for the
 *   identical service-account rationale on the pipe-naming side.
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
  return [dir, '/inheritance:r', '/grant:r', `${username}:(OI)(CI)F`, '/grant', 'SYSTEM:(OI)(CI)F', '/grant', 'Administrators:(OI)(CI)F'];
}

export interface EnsureSecureDirOptions {
  /** DI for tests — see `lifecycle/exec-runner.ts`'s identical `Runner` seam. Defaults to `defaultRunner` (real `execFile`, never a shell). */
  run?: Runner;
  /** DI for tests — lets the win32 branch below be exercised (with a fake `run`) from any host OS, mirroring `control-protocol.ts`'s `controlEndpointPath` platform-override convention. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Creates (if needed) and secures `dir`: POSIX `{mode: 0o700}` plus a
 * best-effort `chmod` re-assertion on every platform (unchanged from
 * before this fix — this is what actually restricts access on
 * darwin/linux), PLUS — win32 only — a restrictive DACL via `icacls` (see
 * `buildIcaclsArgs`'s own doc comment for exactly what it grants/removes).
 *
 * The `icacls` step is deliberately best-effort but LOUDLY so: a failure is
 * logged via `console.warn` (never silently swallowed the way the POSIX
 * `chmod` fallback right above it is — that one is genuinely benign in the
 * common case, an `EPERM` against a directory this process doesn't own;
 * an `icacls` failure means this directory's Windows-side secrecy is NOT
 * enforced by an ACL at all, which is a real, actionable gap an operator
 * should know about — see `docs/security.md`). Never throws on the icacls
 * step's own failure — the caller (`DeviceStore.save()`/
 * `startControlServer`) must still be able to create/use the directory
 * even on a locked-down host where spawning `icacls` itself fails (e.g. a
 * restricted service account with no permission to run it).
 */
export async function ensureSecureDir(dir: string, opts: EnsureSecureDirOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});

  if (platform !== 'win32') return;

  try {
    const { username } = os.userInfo();
    const result = await run('icacls', buildIcaclsArgs(dir, username));
    if (result.code !== 0) {
      console.warn(
        `[byok/client] icacls failed to restrict "${dir}" (exit ${result.code}): ${(result.stderr || result.stdout).trim()} — this directory's contents (device credentials / the control-socket token) are NOT protected by a Windows ACL; see docs/security.md`,
      );
    }
  } catch (err) {
    console.warn(
      `[byok/client] could not run icacls to restrict "${dir}": ${err instanceof Error ? err.message : String(err)} — this directory's contents (device credentials / the control-socket token) are NOT protected by a Windows ACL; see docs/security.md`,
    );
  }
}
