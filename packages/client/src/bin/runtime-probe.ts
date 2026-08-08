import { PiAdapter, ClaudeAdapter, CodexAdapter, type RuntimeAdapter } from '../index';

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
const MAX_RUNTIME_VERSION_CHARS = 256;
const MAX_PERMISSION_MODES = 32;
const MAX_PERMISSION_MODE_CHARS = 64;

function boundedSingleLine(value: string, maxChars: number): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, maxChars);
}

async function detectWithTimeout(adapter: RuntimeAdapter, timeoutMs: number): ReturnType<RuntimeAdapter['detect']> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      adapter.detect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('runtime detection timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The bundled adapter set `byok-agent status`/`byok-agent runtimes` probe by default — same unset-vs-set allowlist contract as `createDaemon` itself. */
export function defaultRuntimeAdapters(runtimeAllowlist: string[] | undefined): RuntimeAdapter[] {
  const ids = runtimeAllowlist ? ALL_RUNTIME_IDS.filter((id) => runtimeAllowlist.includes(id)) : ALL_RUNTIME_IDS;
  return ids.map((id) => {
    switch (id) {
      case 'pi':
        return new PiAdapter();
      case 'claude':
        return new ClaudeAdapter();
      case 'codex':
        return new CodexAdapter();
    }
  });
}

/**
 * What `byok-agent status`/`byok-agent runtimes` show per runtime — a
 * flattened, display-ready merge of `RuntimeDetectResult` and
 * `RuntimeCapabilities` (see `../types.ts`). Always probed fresh (this
 * module never reads from the daemon or the audit log) — see
 * `byok-agent.ts`'s header comment for why a live, standalone probe is the
 * honest choice for "what's on this machine right now" instead of a
 * historical snapshot.
 */
export interface ProbedRuntime {
  id: string;
  present: boolean;
  version?: string;
  authPresent?: boolean;
  steer: boolean;
  resume: boolean;
  permissionModes: string[];
}

/**
 * Runs `detect()`/`capabilities()` on each adapter, in parallel. Every
 * bundled adapter's own `detect()` already catches its own failures (e.g.
 * `pi-adapter.ts`'s `detect()` wraps its version probe in try/catch and
 * resolves `{present: false}` rather than rejecting) — the catch here is a
 * defensive backstop for a `RuntimeAdapter` that doesn't hold that
 * convention, not a workaround for an observed failure in the bundled
 * three.
 */
export async function probeRuntimes(
  adapters: readonly RuntimeAdapter[],
  options: { timeoutMs?: number } = {},
): Promise<ProbedRuntime[]> {
  const timeoutMs = options.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('runtime probe timeout must be a positive integer');
  return Promise.all(
    adapters.map(async (adapter): Promise<ProbedRuntime> => {
      let id = 'unavailable';
      let steer = false;
      let resume = false;
      let permissionModes: string[] = [];
      try {
        id = boundedSingleLine(adapter.id, MAX_RUNTIME_ID_CHARS);
        const caps = adapter.capabilities();
        steer = caps.steer === true;
        resume = caps.resume === true;
        permissionModes = caps.permissionModes
          .slice(0, MAX_PERMISSION_MODES)
          .map((mode) => boundedSingleLine(mode, MAX_PERMISSION_MODE_CHARS));
        const detected = await detectWithTimeout(adapter, timeoutMs);
        return {
          id,
          present: detected.present === true,
          ...(detected.version === undefined
            ? {}
            : { version: boundedSingleLine(detected.version, MAX_RUNTIME_VERSION_CHARS) }),
          ...(typeof detected.authPresent === 'boolean' ? { authPresent: detected.authPresent } : {}),
          steer,
          resume,
          permissionModes,
        };
      } catch {
        return { id, present: false, steer, resume, permissionModes };
      }
    }),
  );
}
