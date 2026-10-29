/**
 * Archive access to the in-memory core stores (#1120).
 *
 * The Host task archive in `@byok-sdk/cloud` rewrites acked and expired mailbox
 * bodies and removes object references in one synchronous step, which the
 * async ports cannot express. Adding methods to the port classes would put
 * them in the port inventory, and exporting functions would put them in this
 * package's API. Each in-memory store instead registers its access here, keyed
 * by the store instance, in a registry under a well-known global symbol. The
 * cloud package reads the same registry by the same key. Nothing here is
 * exported from the package entry.
 */
import type { MailboxBody, MailboxMessage } from '../mailbox';
import type { TenantId } from '../tenant';

export interface InMemoryMailboxArchiveAccess {
  /** The retained rows of one device. */
  messagesOf(tenant: TenantId, deviceId: string): readonly MailboxMessage[];
  /** Replaces one retained row's body. The row, its seq and its state stay. */
  replaceBody(tenant: TenantId, deviceId: string, seq: number, body: MailboxBody): void;
}

export interface InMemoryObjectArchiveAccess {
  /** Removes every reference `(refKind, refId)` holds and returns how many went. */
  releaseReferences(tenant: TenantId, refKind: string, refId: string): number;
}

/** Keep identical to the key `@byok-sdk/cloud` reads. */
const REGISTRY_KEY = Symbol.for('@byok-sdk/in-memory-archive-access');

function registry(): WeakMap<object, unknown> {
  const holder = globalThis as unknown as Record<symbol, WeakMap<object, unknown> | undefined>;
  return (holder[REGISTRY_KEY] ??= new WeakMap<object, unknown>());
}

export function registerArchiveAccess(store: object, access: InMemoryMailboxArchiveAccess | InMemoryObjectArchiveAccess): void {
  registry().set(store, access);
}
