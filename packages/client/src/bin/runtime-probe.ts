import { observeRuntimeDetection, projectRuntimeObservation, type RuntimeObservation } from '../runtime-detection';
import { PiAdapter, ClaudeAdapter, CodexAdapter, type DaemonConfig, type RuntimeAdapter } from '../index';

/**
 * Mirrors `create-daemon.ts`'s own `buildDefaultAdapters`/`buildAdapter`/
 * `ALL_RUNTIME_IDS` (the bundled pi/claude/codex set, filtered by
 * `DaemonConfig.runtimeAllowlist`) — NOT a call into that file, which isn't
 * exported and is out of this change's scope to edit. Small enough (3 ids)
 * that duplicating it here beats reaching into `create-daemon.ts`'s
 * internals; if the two ever drift, `create-daemon-white-label.test.ts`'s
 * own allowlist coverage is the tell.
 */
const ALL_RUNTIME_IDS = ['pi', 'claude', 'codex'] as const;
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

/** The bundled adapter set explicit runtimes and offline diagnostics probe by default — same unset-vs-set allowlist contract, and the same runtime environment policy, as `createDaemon` itself. */
export function defaultRuntimeAdapters(config: Pick<DaemonConfig, 'runtimeAllowlist' | 'runtimeEnvironment'>): RuntimeAdapter[] {
  const { runtimeAllowlist } = config;
  const options = config.runtimeEnvironment === undefined ? {} : { runtimeEnvironment: config.runtimeEnvironment };
  const ids = runtimeAllowlist ? ALL_RUNTIME_IDS.filter((id) => runtimeAllowlist.includes(id)) : ALL_RUNTIME_IDS;
  return ids.map((id) => {
    switch (id) {
      case 'pi':
        return new PiAdapter(options);
      case 'claude':
        return new ClaudeAdapter(options);
      case 'codex':
        return new CodexAdapter(options);
    }
  });
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
