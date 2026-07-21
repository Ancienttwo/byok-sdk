import { execFile } from 'node:child_process';

/**
 * Result of running an external command, regardless of its exit code.
 * `code !== 0` is an ordinary, expected outcome for several callers in this
 * module (e.g. `launchctl bootout` on a service that isn't currently
 * loaded, `systemctl --user is-active` on an inactive unit) — it is NOT
 * treated as a thrown error. See {@link Runner}'s own doc comment for what
 * DOES reject.
 */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs an external service-manager CLI (`launchctl`, `systemctl`, a
 * WinSW-produced `.exe`, `sc.exe`) and resolves with its exit code +
 * captured stdout/stderr — it deliberately does NOT reject just because the
 * command exited non-zero (see {@link RunResult}'s doc comment: that is
 * everyday signal for several callers here, not failure). It DOES reject
 * for a genuine spawn failure (the executable itself couldn't be found/run
 * at all, e.g. `ENOENT`) — see {@link defaultRunner}'s implementation for
 * how the two are told apart. Callers that need "ran and returned 0 or
 * throw" wrap this with {@link runOrThrow}.
 *
 * The DI seam every one of `launchd.ts`/`systemd.ts`/`winsw.ts` accepts
 * (`LaunchdDeps.run`/`SystemdDeps.run`/`WinswDeps.run`) — this is what lets
 * the install/uninstall/start/stop/status logic for all three platforms be
 * unit-tested from any single host OS with a plain mock, per M3-4's own
 * verification requirement, without ever shelling out for real in tests.
 */
export type Runner = (command: string, args: string[]) => Promise<RunResult>;

/**
 * Real implementation: `child_process.execFile`, never a shell
 * (`exec`/`shell: true`) — the same reasoning as the pi adapter's own
 * `detect()` (see `templates/packaging/sea/README.md`'s "Windows note" and
 * `adapters/pi/pi-adapter.ts`): no shell-quoting hazard for a service name,
 * config path, or WinSW install directory containing spaces or special
 * characters. Every command this module ever invokes (`launchctl`,
 * `systemctl`, a WinSW-produced `.exe`, `sc.exe`) is a genuine native
 * executable, never a `.cmd`/`.bat` shell script, so the one real caveat of
 * `execFile`-without-`shell` on Windows (a `.cmd`/`.bat` target can't be
 * `CreateProcess`'d directly) never applies here.
 *
 * Node's `execFile` callback distinguishes two failure shapes on its error
 * argument: when the target process ran and merely exited non-zero, `error.code`
 * is that NUMERIC exit code; when the executable itself couldn't be spawned
 * (e.g. `ENOENT`), `error.code` is an ERRNO STRING and there is no real exit
 * code at all. This implementation resolves the first case as an ordinary
 * {@link RunResult} (letting callers decide whether a given non-zero exit
 * matters) and rejects only the second (a real inability to run the
 * command at all, which every caller should hear about).
 */
export const defaultRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
  });

/**
 * Runs `command`/`args` via `run` and throws a clear, labeled error if it
 * exits non-zero — for the subset of calls across launchd/systemd/WinSW
 * that must actually succeed for `install()`/`start()` to honestly report
 * "the service is now running" (e.g. `launchctl bootstrap`, `systemctl
 * start`, `winsw install`). Callers that instead want best-effort/tolerant
 * semantics (e.g. "stop if running, no-op if already stopped") call `run`
 * directly and ignore the result — see `launchd.ts`/`systemd.ts`/
 * `winsw.ts`'s own `uninstall()`/`stop()` implementations.
 */
export async function runOrThrow(run: Runner, command: string, args: string[], label: string): Promise<RunResult> {
  const result = await run(command, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${label} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

/**
 * Describes what a "genuinely nothing to do" outcome looks like for a
 * best-effort stop/uninstall step whose target may legitimately already be
 * absent (not currently loaded/enabled/installed) — as opposed to a genuine
 * failure (permission denied, service busy, a manager fault) that must NOT
 * be treated the same way. See {@link isIdempotentAbsence}.
 */
export interface IdempotentAbsence {
  /** Exit codes that ALONE mean "already absent", independent of any stdout/stderr text (e.g. Windows's `ERROR_SERVICE_DOES_NOT_EXIST`, 1060). */
  codes?: readonly number[];
  /** Case-insensitive patterns checked against `stdout + "\n" + stderr`; a match means "already absent/not loaded/does not exist" for this platform's tool. */
  patterns: readonly RegExp[];
}

/**
 * Distinguishes a KNOWN idempotent "already absent / not loaded / does not
 * exist" outcome (safe to still proceed with cleanup) from a genuine
 * failure. A non-zero exit is ambiguous on its own: `launchctl bootout`,
 * `systemctl disable --now`, and a WinSW `stop`+`uninstall` all use the SAME
 * non-zero exit for both "there was nothing to stop/unregister" (fine, an
 * everyday outcome — see this module's own {@link RunResult} doc comment)
 * and "I refused/failed to do it" (not fine) — conflating the two
 * previously let a real failure look identical to success and then delete
 * the plist/unit/exe out from under a still-running service
 * (cross-model-review P1 #7: an orphaned, uncontrollable process). Each
 * platform module supplies its own `patterns`/`codes` because the actual
 * wording/codes are tool-specific — see `launchd.ts`/`systemd.ts`/
 * `winsw.ts`'s own constants.
 */
export function isIdempotentAbsence(result: RunResult, absence: IdempotentAbsence): boolean {
  if (result.code === 0) return true;
  if (absence.codes?.includes(result.code)) return true;
  const detail = `${result.stdout}\n${result.stderr}`;
  return absence.patterns.some((pattern) => pattern.test(detail));
}

/**
 * Runs `command`/`args` via `run` for a best-effort stop/uninstall step and
 * throws a clear, labeled error UNLESS the result is either a genuine
 * success or a known idempotent "already absent" outcome (see
 * {@link isIdempotentAbsence}). Unlike {@link runOrThrow} (which throws on
 * ANY non-zero exit, for calls that must actually succeed), this is the
 * tolerant-but-not-blind form each platform's `uninstall()` needs: proceed
 * to delete the plist/unit/exe+xml ONLY when this resolves without
 * throwing; a thrown error here means "do NOT delete the control files —
 * surface this to the caller so they can retry" (see each platform's own
 * `uninstall()`).
 */
export async function runIdempotent(run: Runner, command: string, args: string[], label: string, absence: IdempotentAbsence): Promise<RunResult> {
  const result = await run(command, args);
  if (!isIdempotentAbsence(result, absence)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${label} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}
