/**
 * The runtime subpath's shape, pinned at three layers.
 *
 * `./runtime` is the Worker-loadable online surface, and its whole value is
 * what it does NOT carry: the Node-only migrate/migrations-dir/cleanup
 * operations stay on the package root. A symbol leaking either way — an
 * online export missing from the subpath, or an operations export appearing
 * on it — would silently re-split the surface between two authorities, so the
 * module namespace is asserted by name rather than by sampling.
 *
 * The second layer is the source graph: importing `../runtime` under Node
 * proves the online subgraph loads at all. The third is the projection:
 * `dist/runtime.js` must exist and must not name a node builtin, because that
 * file is what a Worker bundler pulls in. This follows the same convention as
 * `migrations-dir.test.ts`: a missing build is a hard failure, not a skip —
 * `bun run build` runs before `bun run test` in CI for exactly this reason,
 * and a silently skipped projection check is the hole this file exists to
 * close.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as index from '../index';
import * as runtime from '../runtime';

const DIST_RUNTIME = new URL('../../dist/runtime.js', import.meta.url);
const DIST_RUNTIME_TYPES = new URL('../../dist/runtime.d.ts', import.meta.url);

if (!existsSync(DIST_RUNTIME)) {
  throw new Error(
    `build this package before running its tests: ${fileURLToPath(DIST_RUNTIME)} is missing`,
  );
}

/** Every online symbol the subpath must carry, by name. */
const ONLINE_EXPORTS = [
  // pool
  'createByokPool',
  // cloud-local stores
  'PostgresDeviceDirectory',
  'PostgresInboundDedupStore',
  'PostgresNonceStore',
  'PostgresPairingCodeStore',
  'PostgresProofRequestReceiptStore',
  'PostgresRequestReceiptStore',
  'PostgresTaskAttemptStore',
  'createPostgresCloudStores',
  // R2 blobs
  'DEFAULT_MAX_ATTEMPTS',
  'DEFAULT_PRESIGN_TTL_SECONDS',
  'DEFAULT_RETRY_DELAY_MS',
  'MAX_PRESIGN_TTL_SECONDS',
  'MIN_PRESIGN_TTL_SECONDS',
  'ObjectStoreRequestError',
  'R2_BLOB_ERROR_CODES',
  'R2BlobStoreError',
  'R2CloudBlobStore',
  'R2ObjectMaintenanceStore',
  // core stores
  'PostgresActivityStore',
  'PostgresApprovalTimelineStore',
  'PostgresBoardStore',
  'PostgresMailboxStore',
  'PostgresObjectStore',
  'PostgresPresenceStore',
  'PostgresQuotaStore',
  'PostgresSkillPackStore',
  'PostgresTruthStore',
  'createPostgresCoreStores',
  // truth
  'PostgresTruthCommitter',
];

/** Operations that belong to the root entry and must never reach the subpath. */
const NODE_ONLY_EXPORTS = [
  'migrate',
  'migrationsDir',
  'readMigrationFiles',
  'MigrationChecksumMismatchError',
  'MigrationFilenameError',
  'PostgresCloudCleanup',
  'createPostgresCloudMaintenance',
];

const runtimeNamespace = runtime as unknown as Record<string, unknown>;
const indexNamespace = index as unknown as Record<string, unknown>;
const runtimeKeys = Object.keys(runtime);
const indexKeys = new Set(Object.keys(index));

describe('the runtime subpath', () => {
  it('exports the online surface', () => {
    expect(runtimeKeys.sort()).toEqual([...ONLINE_EXPORTS].sort());
    for (const name of ONLINE_EXPORTS) {
      expect(runtimeNamespace[name], name).toBeDefined();
    }
  });

  it('carries none of the Node-only operations', () => {
    for (const name of NODE_ONLY_EXPORTS) {
      expect(runtimeKeys, name).not.toContain(name);
    }
  });

  it('is a strict subset of the root entry, by the same names', () => {
    // The root re-exports `./runtime` wholesale; this pins that the two can
    // never drift apart, in either direction.
    for (const key of runtimeKeys) {
      expect(indexKeys.has(key), `root entry is missing runtime export ${key}`).toBe(true);
    }
  });

  it('is what the package manifest exposes as ./runtime', async () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, { types?: string; import?: string }> };
    expect(manifest.exports['./runtime']).toEqual({
      types: './dist/runtime.d.ts',
      import: './dist/runtime.js',
    });
    expect(existsSync(DIST_RUNTIME_TYPES)).toBe(true);
  });

  it('projects to a bundle with no node builtin in it', () => {
    // `pg` is external to this build, so a node specifier here can only come
    // from this package's own online subgraph reaching a Node module.
    const bundle = readFileSync(DIST_RUNTIME, 'utf8');
    for (const forbidden of [
      'node:fs',
      'node:path',
      'node:url',
      'node:crypto',
      'fs/promises',
    ]) {
      expect(bundle, `dist/runtime.js references ${forbidden}`).not.toContain(forbidden);
    }
  });
});
