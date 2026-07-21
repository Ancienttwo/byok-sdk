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
