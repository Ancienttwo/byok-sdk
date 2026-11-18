// This private entry bundles the two implementations from workspace source.
// At runtime the server uses it only through its own package imports map.
import { createEmbeddedBlobAccess, createInMemoryBlobBytes } from '../../cloud/src/stores/in-memory/blobs.js';
import { bindRefreshCommitted, type InMemoryObjectBytes } from '../../core/src/in-memory/blob.js';
import { composeInMemoryCore } from '../../core/src/in-memory/index.js';
import type * as Contract from './embedded-blob-storage-contract.js';

export { BLOB_RESERVATION_TTL_MS } from '../../cloud/src/blob-reservation.js';

export const composeEmbeddedMemory: typeof Contract.composeEmbeddedMemory = (clock, crypto) => {
  const objectBytes = createInMemoryBlobBytes(clock, crypto);
  // SAFETY: source and generated core declarations brand the same runtime strings.
  const { stores: core } = composeInMemoryCore({ clock, objectBytes: objectBytes as unknown as InMemoryObjectBytes });
  type Composition = ReturnType<typeof Contract.composeEmbeddedMemory>;
  // SAFETY: core's source and generated declarations use separate nominal
  // identities for the same tenant and hash brands. Both describe these ports.
  const publishedCore = core as unknown as Composition['core'];
  // SAFETY: the grace refresh uses the same tenant and hash brands at runtime.
  const refresh = bindRefreshCommitted(core.objects) as unknown as Parameters<typeof createEmbeddedBlobAccess>[2];
  const embeddedBlobs = createEmbeddedBlobAccess(objectBytes, publishedCore.objects, refresh);
  // SAFETY: the bundled and published blob classes share the same source.
  // Cloud composition calls bind() on this instance.
  return { core: publishedCore, objectBytes: objectBytes as unknown as Composition['objectBytes'], embeddedBlobs };
};
