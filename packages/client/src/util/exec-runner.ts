import { spawn } from 'node:child_process';
import path from 'node:path';
import { systemExecutable } from '@byok-sdk/core/system-tool';
import { disposeOwnedProcessTree, withOwnedProcessTree } from '../adapters/process-tree.js';

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
 * at all, e.g. `ENOENT`), and for a command that outlives its bound
 * ({@link PlatformCommandTimeoutError}, #1971). A timeout is never a
 * {@link RunResult}, so {@link runIdempotent} cannot read it as absence and a
 * best-effort caller that ignores the exit code still fails on it. Callers
 * that need "ran and returned 0 or throw" wrap this with {@link runOrThrow}.
 *
 * The DI seam every one of `launchd.ts`/`systemd.ts`/`winsw.ts` accepts
 * (`LaunchdDeps.run`/`SystemdDeps.run`/`WinswDeps.run`) — this is what lets
 * the install/uninstall/start/stop/status logic for all three platforms be
 * unit-tested from any single host OS with a plain mock, per M3-4's own
 * verification requirement, without ever shelling out for real in tests.
 */
export type Runner = (command: string, args: string[]) => Promise<RunResult>;

/** The bound on one service-manager query or change (`launchctl`, `systemctl`, `sc.exe`, PowerShell, `icacls`) (#1971). */
export const PLATFORM_COMMAND_TIMEOUT_MS = 30_000;

/** Captured stdout or stderr above this fails the run, as `execFile`'s default `maxBuffer` did. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * A platform command did not exit within its bound, and its process tree was
 * terminated (SIGTERM, then SIGKILL; `taskkill /T /F` on Windows). Its effect
 * is UNKNOWN: the command may have completed its change before it was stopped
 * (a job bootstrapped, a service registered), done part of it, or nothing. It
 * is never evidence that the change did not happen, and never an idempotent
 * "already absent". The next install or uninstall starts again from the
 * service manager's own state. `cause` is set when the tree could not be
 * proved gone within the disposal grace.
 */
export class PlatformCommandTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number, options?: ErrorOptions) {
    super(`${command} did not finish within ${timeoutMs} ms and was stopped; whether it took effect is unknown`, options);
    this.name = 'PlatformCommandTimeoutError';
  }
}

/** {@link runBounded}'s result: `code` is `null` when the process ended on a signal. */
export interface BoundedRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `executable` directly (never a shell) as the root of an owned process
 * tree and resolves with its exit code and output, whatever the code. It
 * rejects when the executable cannot be started, when its output exceeds
 * 1 MiB, or, after `timeoutMs`, with {@link PlatformCommandTimeoutError} once
 * the tree has been terminated and waited for (bounded by the disposal grace
 * of `adapters/process-tree.ts`), so no timed-out command is left running.
 */
export function runBounded(executable: string, args: readonly string[], options: { timeoutMs: number; cwd?: string }): Promise<BoundedRunResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, withOwnedProcessTree({ cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] as const, windowsHide: true }));
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let closed = false;
    let failure: Error | undefined;
    const closedPromise = new Promise<void>((settle) => child.once('close', () => settle()));
    const label = path.basename(executable);
    const stop = (error: Error): void => {
      if (failure !== undefined || closed) return;
      failure = error;
      clearTimeout(timer);
      disposeOwnedProcessTree({ child, label, isClosed: () => closed, waitClosed: () => closedPromise }).then(
        () => reject(error),
        (disposal: unknown) => reject(error instanceof PlatformCommandTimeoutError ? new PlatformCommandTimeoutError(label, options.timeoutMs, { cause: disposal }) : error),
      );
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop(new Error(`${label} printed more than ${MAX_OUTPUT_BYTES} bytes`));
      else into.push(chunk);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    const timer = setTimeout(() => stop(new PlatformCommandTimeoutError(label, options.timeoutMs)), options.timeoutMs);
    child.once('error', (error) => {
      // A spawn failure (`ENOENT`) has no process to stop.
      if (failure !== undefined) return;
      failure = error;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      closed = true;
      if (failure !== undefined) return;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

/**
 * A {@link Runner} over {@link runBounded} with bound `timeoutMs`. A bare
 * `command` is a system tool and starts from its trusted location, never from
 * `PATH`; one that has none rejects with `SystemToolUnavailableError`
 * (`@byok-sdk/core/system-tool`, #1304). A process that ends on a signal
 * rejects: it has no exit code to report.
 */
export function boundedRunner(timeoutMs: number): Runner {
  return async (command, args) => {
    const result = await runBounded(systemExecutable(command), args, { timeoutMs });
    if (result.code === null) throw new Error(`${command} ended on a signal`);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}

/**
 * The real {@link Runner}: {@link boundedRunner} at
 * {@link PLATFORM_COMMAND_TIMEOUT_MS}. Never a shell, so a service name,
 * config path or install directory with spaces or special characters needs
 * no quoting; every command it runs is a native executable, never a
 * `.cmd`/`.bat` script, which Windows cannot start without a shell.
 */
export const defaultRunner: Runner = boundedRunner(PLATFORM_COMMAND_TIMEOUT_MS);

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
 * failure (permission denied, service busy, a manager fault, the manager
 * itself unreachable) that must NOT be treated the same way. See
 * {@link isIdempotentAbsence}.
 */
export interface IdempotentAbsence {
  /** Exit codes that ALONE mean "already absent", independent of any stdout/stderr text (e.g. Windows's `ERROR_SERVICE_DOES_NOT_EXIST`, 1060). */
  codes?: readonly number[];
  /** Case-insensitive patterns checked against `stdout + "\n" + stderr`; a match means "already absent/not loaded/does not exist" for this platform's tool. */
  patterns: readonly RegExp[];
  /**
   * Case-insensitive patterns checked against the SAME `stdout + "\n" +
   * stderr` text, and consulted BEFORE `codes`/`patterns`: a match here
   * means "this is a genuine failure", full stop, even if `codes`/`patterns`
   * would otherwise call the result idempotent absence. Exists because a
   * connectivity/permission/manager-unreachable error can be textually
   * indistinguishable from — or reuse the very same generic OS errno string
   * as — a genuine "not loaded"/"does not exist" message. Concretely: on a
   * headless host with no reachable `systemd --user` D-Bus session (common
   * for exactly the SSH/no-lingering boxes this daemon runs on),
   * `systemctl --user disable --now` fails with `Failed to connect to bus:
   * No such file or directory` — the SAME "No such file or directory" text
   * a genuinely-absent unit can also produce, but here it means "we could
   * not even ask the manager", not "the manager confirms it's gone".
   * Conflating the two previously let this REAL failure look identical to
   * idempotent absence and then delete the still-relevant plist/unit/exe
   * (cross-model-review P1 #7, round 2 — the same re-orphan shape the
   * original `codes`/`patterns` split was meant to fix in round 1). Each
   * platform module supplies its own `neverAbsence` for the same reason it
   * supplies its own `patterns`/`codes`: the actual wording is tool-specific
   * — see `launchd.ts`/`systemd.ts`/`winsw.ts`'s own constants.
   */
  neverAbsence?: readonly RegExp[];
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
 *
 * `absence.neverAbsence` is checked FIRST (right after the unambiguous
 * `code === 0` success case) and, on a match, wins outright over any
 * `codes`/`patterns` match — see {@link IdempotentAbsence.neverAbsence}'s
 * own doc comment for why a connectivity/permission/manager-unreachable
 * signal must never be reclassified as absence no matter what else matches
 * (cross-model-review P1 #7, round 2).
 */
export function isIdempotentAbsence(result: RunResult, absence: IdempotentAbsence): boolean {
  if (result.code === 0) return true;
  const detail = `${result.stdout}\n${result.stderr}`;
  if (absence.neverAbsence?.some((pattern) => pattern.test(detail))) return false;
  if (absence.codes?.includes(result.code)) return true;
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
 * `uninstall()`). Each platform's standalone `stop()` uses the same
 * function for the same reason: tolerate "already stopped/not loaded", but
 * surface — rather than silently swallow — a genuine failure (permission
 * denied, manager unreachable) instead of misreporting it as "stopped"
 * (cross-model-review P1 #7, round 2, second half).
 */
export async function runIdempotent(run: Runner, command: string, args: string[], label: string, absence: IdempotentAbsence): Promise<RunResult> {
  const result = await run(command, args);
  if (!isIdempotentAbsence(result, absence)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${label} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}
