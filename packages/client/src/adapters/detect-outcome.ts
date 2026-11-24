import { execFile } from 'node:child_process';
import { RuntimeEnvironmentUnavailableError } from '../runtime/environment.js';
import type { RuntimeAdapter, RuntimeDetectResult } from '../types.js';

type ProbeFailure = Exclude<RuntimeDetectResult, { kind: 'available' }>;
type VersionProbeResult = ProbeFailure | { kind: 'available'; stdout: string; stderr: string };

/**
 * OS/process codes only. Arbitrary messages, streams and resolver paths never
 * escape. A runtime environment that cannot be built is a refusal (#1095).
 */
export function classifyDetectError(error: unknown): ProbeFailure {
  if (error instanceof RuntimeEnvironmentUnavailableError) return { kind: 'refused', reason: 'runtime_environment_unavailable', code: error.reason };
  const code = error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'ENOENT') return { kind: 'not-found' };
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOEXEC') return { kind: 'not-executable' };
  return { kind: 'probe-failed' };
}

/** The end of one bounded detect sub-command. `nonzero` keeps the streams: some CLIs answer on exit 1 (`claude auth status --json` when logged out). */
export type DetectCommandOutcome =
  | { readonly kind: 'ok'; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'nonzero'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'failed'; readonly error: unknown };

export interface DetectCommandOptions {
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

/**
 * Runs one detect sub-command under a deadline this probe owns. A killed child
 * is not by itself timeout evidence (execFile also kills on output overflow),
 * so the deadline and the caller's abort each record why they stopped it.
 * Resolve only at execFile completion; SIGKILL bounds a TERM-ignoring child.
 */
export function runDetectCommand(command: string, args: readonly string[], options: DetectCommandOptions): Promise<DetectCommandOutcome> {
  const { timeoutMs, env, cwd, signal } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('invalid runtime probe timeout');
  if (signal?.aborted) return Promise.resolve({ kind: 'aborted', reason: signal.reason });
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let stopped: 'timeout' | 'aborted' | undefined;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    };
    try {
      const child = execFile(command, [...args], { encoding: 'utf8', env, cwd }, (error, stdout, stderr) => {
        cleanup();
        // Output overflow is already a known failure even if the deadline's
        // SIGKILL had to finish the child's cleanup.
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ kind: 'failed', error });
        else if (stopped === 'timeout') resolve({ kind: 'timeout' });
        else if (stopped === 'aborted') resolve({ kind: 'aborted', reason: signal?.reason });
        else if (!error) resolve({ kind: 'ok', stdout, stderr });
        else if (typeof error.code === 'number') resolve({ kind: 'nonzero', exitCode: error.code, stdout, stderr });
        else resolve({ kind: 'failed', error });
      });
      const stop = (why: 'timeout' | 'aborted') => {
        if (stopped !== undefined) return;
        stopped = why;
        // A wrapper's descendant may still hold a pipe after the child exits.
        // Stop consuming those pipes so completion does not wait on it.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.kill('SIGKILL');
      };
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      timer.unref?.();
      if (signal) {
        onAbort = () => stop('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      }
    } catch (error) {
      cleanup();
      resolve({ kind: 'failed', error });
    }
  });
}

/**
 * The probe gets `env`: the environment a task child gets
 * (`RuntimeAdapter.runtimeEnvironment`). A caller abort rethrows its reason.
 */
export async function probeRuntimeVersion(command: string, timeoutMs: number, env: Readonly<Record<string, string>>, prefixArgs: readonly string[] = [], signal?: AbortSignal): Promise<VersionProbeResult> {
  const outcome = await runDetectCommand(command, [...prefixArgs, '--version'], { timeoutMs, env, signal });
  switch (outcome.kind) {
    case 'ok': return { kind: 'available', stdout: outcome.stdout, stderr: outcome.stderr };
    case 'timeout': return { kind: 'timeout' };
    case 'failed': return classifyDetectError(outcome.error);
    case 'nonzero': return { kind: 'probe-failed' };
    case 'aborted': throw outcome.reason;
  }
}

type AdmissionDetect = (signal?: AbortSignal) => Promise<RuntimeDetectResult>;
const admissionDetects = new WeakMap<RuntimeAdapter, { readonly protoDetect: RuntimeAdapter['detect']; readonly detect: AdmissionDetect }>();

/**
 * A built-in adapter's detection for task admission, which never reads
 * `authPresent` (#2468): it skips the login probe, so one offer runs the slow
 * login read only once, at launch. `protoDetect` is the class's own `detect`;
 * admission uses this entry only while the instance still has it, so a spy,
 * an assigned `detect` or a subclass override keeps its own path.
 */
export function registerAdmissionDetect(adapter: RuntimeAdapter, protoDetect: RuntimeAdapter['detect'], detect: AdmissionDetect): void {
  admissionDetects.set(adapter, { protoDetect, detect });
}

export function admissionDetect(adapter: RuntimeAdapter): AdmissionDetect | undefined {
  const entry = admissionDetects.get(adapter);
  return entry !== undefined && adapter.detect === entry.protoDetect ? entry.detect : undefined;
}

/**
 * Per-adapter probe deadlines. `override` is a test seam for one adapter
 * instance; no package entry exports it.
 */
export function probeTimeouts<T extends Readonly<Record<string, number>>>(defaults: T): {
  of(owner: object): T;
  override(owner: object, timeouts: Partial<T>): void;
} {
  const overrides = new WeakMap<object, Partial<T>>();
  return {
    of: owner => ({ ...defaults, ...overrides.get(owner) }),
    override: (owner, timeouts) => { overrides.set(owner, timeouts); },
  };
}
