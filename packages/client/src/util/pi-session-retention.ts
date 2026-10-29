import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PathMutationGate } from './path-mutation-gate';
import type { RuntimeSessionLease } from '../types';

/**
 * Only a native mutable setup callback can select an unknown session directory.
 * Hold this before invoking it; confirm its final writer before release. Sweep
 * takes it first, before any directory/session gate. Known turns never hold it.
 */
export async function acquirePiSessionRebinding(waitMs = 0): Promise<PathMutationGate> {
  const { acquirePathMutationGate } = await import('./path-mutation-gate');
  return acquirePathMutationGate({ scope: 'pi-session-rebinding' }, { waitMs });
}

/** Short-lived barrier: a fresh runtime has not reported its authoritative id yet. */
export async function acquirePiSessionDiscovery(sessionDir: string, waitMs = 0): Promise<PathMutationGate> {
  const { acquirePathMutationGate } = await import('./path-mutation-gate');
  return acquirePathMutationGate({ scope: 'pi-session-discovery', targetPath: sessionDir }, { waitMs });
}

export interface PiSessionRetentionLease extends RuntimeSessionLease {
  assertHeld(): void;
}

/** Different session ids never contend; aliases of the same physical directory do. */
export async function acquirePiSessionRetention(sessionDir: string, sessionRef: string): Promise<PiSessionRetentionLease> {
  if (typeof sessionRef !== 'string' || sessionRef.length === 0) throw new Error('Pi session retention requires an authoritative session id');
  return acquireSessionRole(sessionDir, sessionRef, 'admission');
}

/** The native file path remains authoritative when Pi replaces an empty file's header id. */
export function acquirePiSessionWriter(sessionFile: string): Promise<PiSessionRetentionLease> {
  return acquireSessionRole(path.dirname(sessionFile), path.basename(sessionFile), 'writer');
}

async function acquireSessionRole(sessionDir: string, sessionRef: string, role: 'admission' | 'writer'): Promise<PiSessionRetentionLease> {
  // Importing Pi's pure settlement path must not load socket capabilities.
  // Actual acquisition still has exactly one shared path-gate authority.
  const { acquirePathMutationGate } = await import('./path-mutation-gate');
  const digest = createHash('sha256').update(sessionRef).digest('hex');
  const gate = await acquirePathMutationGate({ scope: `pi-session-${role}:${digest}`, targetPath: sessionDir });
  let released = false;
  return Object.freeze({
    sessionRef,
    assertHeld: () => { if (released) throw new Error('Pi session retention lease was already released'); },
    release: async () => { if (released) return; await gate.release(); released = true; },
  });
}
