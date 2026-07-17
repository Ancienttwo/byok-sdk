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
export async function probeRuntimes(adapters: readonly RuntimeAdapter[]): Promise<ProbedRuntime[]> {
  return Promise.all(
    adapters.map(async (adapter): Promise<ProbedRuntime> => {
      const caps = adapter.capabilities();
      try {
        const detected = await adapter.detect();
        return {
          id: adapter.id,
          present: detected.present,
          version: detected.version,
          authPresent: detected.authPresent,
          steer: caps.steer,
          resume: caps.resume,
          permissionModes: caps.permissionModes,
        };
      } catch {
        return { id: adapter.id, present: false, steer: caps.steer, resume: caps.resume, permissionModes: caps.permissionModes };
      }
    }),
  );
}
