import { observeRuntimeDetection, projectRuntimeObservation, type RuntimeObservation } from '../runtime-detection';
import type { RuntimeAdapter } from '../types';

export const RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const MAX_RUNTIME_ID_CHARS = 128;

function boundedSingleLine(value: string, maxChars: number): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, maxChars);
}

class RuntimeProbeTimeout extends Error {}

async function detectWithTimeout(adapter: RuntimeAdapter, timeoutMs: number): ReturnType<RuntimeAdapter['detect']> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      observeRuntimeDetection(adapter),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RuntimeProbeTimeout()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fresh, parallel local observations. A custom adapter timeout is an observation
 * deadline only: detect() has no cancellation contract. Never expose arbitrary
 * adapter errors or interpret an old/malformed result as available.
 */
export async function probeRuntimes(
  adapters: readonly RuntimeAdapter[],
  options: { timeoutMs?: number } = {},
): Promise<RuntimeObservation[]> {
  const timeoutMs = options.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('runtime probe timeout must be a positive integer');
  return Promise.all(
    adapters.map(async (adapter): Promise<RuntimeObservation> => {
      let id = 'unavailable';
      let steer = false;
      let resume = false;
      try {
        id = boundedSingleLine(adapter.descriptor.id, MAX_RUNTIME_ID_CHARS);
        const caps = adapter.descriptor.capabilities;
        steer = caps.steer === true;
        resume = caps.resume === true;
        const detected = await detectWithTimeout(adapter, timeoutMs);
        return projectRuntimeObservation(adapter.descriptor, detected);
      } catch (error) {
        return { id, present: false, outcome: error instanceof RuntimeProbeTimeout ? 'timeout' : 'probe-failed', steer, resume };
      }
    }),
  );
}
