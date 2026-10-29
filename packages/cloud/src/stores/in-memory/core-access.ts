/**
 * The Host task archive's access to the in-memory core stores (#1120).
 *
 * `@byok-sdk/core` registers each in-memory mailbox and object store here by
 * instance, under a well-known global symbol, so neither package adds a method
 * to a port class or a function to its API. The shapes below mirror core's
 * `archive-access.ts`; the key must stay identical.
 */
import type { MailboxBody, MailboxMessage, TenantId } from '@byok-sdk/core';

export interface InMemoryMailboxArchiveAccess {
  messagesOf(tenant: TenantId, deviceId: string): readonly MailboxMessage[];
  replaceBody(tenant: TenantId, deviceId: string, seq: number, body: MailboxBody): void;
}

export interface InMemoryObjectArchiveAccess {
  releaseReferences(tenant: TenantId, refKind: string, refId: string): number;
}

const REGISTRY_KEY = Symbol.for('@byok-sdk/in-memory-archive-access');

/** Throws when `store` is not an in-memory core store: the archive has no other way to rewrite it. */
export function archiveAccessOf<T extends InMemoryMailboxArchiveAccess | InMemoryObjectArchiveAccess>(
  store: object,
  kind: 'mailbox' | 'object',
): T {
  const registry = (globalThis as unknown as Record<symbol, WeakMap<object, unknown> | undefined>)[REGISTRY_KEY];
  const access = registry?.get(store);
  if (access === undefined) {
    throw new TypeError(`The in-memory task archive needs the in-memory core ${kind} store; pass an archive for another core.`);
  }
  return access as T;
}
