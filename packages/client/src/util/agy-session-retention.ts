import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RuntimeSessionLease } from '../types.js';

// A registered symbol: the daemon and a Host-built adapter can come from different bundles, so neither class identity nor a WeakMap crosses.
const AGY_SESSION_STORE = Symbol.for('byok.adapters.agy-session-store');

/** Brands an adapter with the agy state its SDK-owned home holds, for the daemon to expire. Not on the public type. */
export function brandAgySessionStore(adapter: object, store: string): void {
  Object.defineProperty(adapter, AGY_SESSION_STORE, { value: store });
}

export function agySessionStoreOf(adapter: object): string | undefined {
  return (adapter as Record<symbol, string | undefined>)[AGY_SESSION_STORE];
}

const CONVERSATION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/u;

/** agy's own session id is the file stem; `conversation_summaries.db` is the shared index, never a session. */
export function isAgyConversationFileName(name: string): boolean {
  return CONVERSATION_FILE.test(name);
}

/** Everything agy keeps per session, below `<home>/.gemini/antigravity-cli`. */
export function agySessionPaths(store: string, sessionRef: string): readonly string[] {
  const conversation = path.join(store, 'conversations', `${sessionRef}.db`);
  return [conversation, `${conversation}-wal`, `${conversation}-shm`, path.join(store, 'brain', sessionRef), path.join(store, 'annotations', `${sessionRef}.pbtxt`)];
}

/** A resume holds this across admission and the session; a sweep that cannot take it keeps the session. */
export async function acquireAgySessionRetention(store: string, sessionRef: string): Promise<RuntimeSessionLease> {
  if (typeof sessionRef !== 'string' || sessionRef.length === 0) throw new Error('agy session retention requires an authoritative session id');
  const { acquirePathMutationGate } = await import('./path-mutation-gate.js');
  const digest = createHash('sha256').update(sessionRef).digest('hex');
  const gate = await acquirePathMutationGate({ scope: `agy-session:${digest}`, targetPath: store });
  return Object.freeze({ sessionRef, release: () => gate.release() });
}
