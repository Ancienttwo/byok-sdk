import { execFile } from 'node:child_process';
import type { RuntimeDetectResult } from '../types';

type ProbeFailure = Exclude<RuntimeDetectResult, { kind: 'available' }>;
type VersionProbeResult = ProbeFailure | { kind: 'available'; stdout: string; stderr: string };

/** OS/process codes only. Arbitrary messages, streams and resolver paths never escape. */
export function classifyDetectError(error: unknown): ProbeFailure {
  const code = error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'ENOENT') return { kind: 'not-found' };
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOEXEC') return { kind: 'not-executable' };
  return { kind: 'probe-failed' };
}

/**
 * This probe owns both the deadline and the version child. A killed child is
 * not by itself timeout evidence (execFile also kills on output overflow).
 * Resolve only at execFile completion; SIGKILL bounds a TERM-ignoring probe.
 */
export async function probeRuntimeVersion(command: string, timeoutMs: number, prefixArgs: readonly string[] = []): Promise<VersionProbeResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('invalid runtime probe timeout');
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      const child = execFile(command, [...prefixArgs, '--version'], { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        // Output overflow is already a known failure even if a TERM-ignoring
        // child requires the deadline's SIGKILL to finish cleanup.
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ kind: 'probe-failed' });
        else if (timedOut) resolve({ kind: 'timeout' });
        else if (error) resolve(classifyDetectError(error));
        else resolve({ kind: 'available', stdout, stderr });
      });
      timer = setTimeout(() => {
        timedOut = true;
        // A wrapper's descendant may still hold a pipe after the version child
        // exits. Stop consuming those pipes at this probe's own deadline.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
    } catch (error) {
      if (timer) clearTimeout(timer);
      resolve(classifyDetectError(error));
    }
  });
}
