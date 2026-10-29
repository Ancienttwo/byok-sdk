/**
 * `createByokPool`'s two non-negotiables, asserted without a database.
 *
 * A `pg.Pool` emits `'error'` when an IDLE pooled client's backend is reset
 * (failover, `pg_terminate_backend`, an idle proxy timeout). Node rethrows an
 * `'error'` that has no listener as an uncaught exception, which kills the host
 * process — so the one property that matters here is that the pool this factory
 * returns already carries a listener, and the reset is routed, not swallowed.
 *
 * None of this needs a live server: the `'error'` path is an `EventEmitter`
 * event and the int8 wiring is a config the pool holds before it ever connects.
 * Emitting the event and reading `pool.options` exercises both without opening a
 * socket, which is why this suite runs everywhere and not only where the
 * dataplane substrate exists.
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createWebCrypto } from '@byok-sdk/cloud';
import { PostgresCloudCleanup } from '../cleanup';
import { createByokPool, type ByokPool } from '../pool';
import { createPostgresCloudStores, PostgresAgentMemoryProjectionStore, PostgresTaskRedactionStore,
  R2ObjectMaintenanceStore, type PostgresAgentMemoryProjectionStoreOptions,
  type PostgresTaskRedactionStoreOptions } from '../stores/index';
import { createPostgresCoreStores } from '../stores/core/index';
import { PostgresTenantErasure } from '../tenant-erasure';
import { PostgresTruthCommitter, type PostgresTruthCommitterOptions } from '../truth-committer';

/** The pool's frozen construction options — where `types` lives and where `onPoolError` must NOT. */
type PoolInternals = { readonly options: { readonly types?: NonNullable<pg.PoolConfig['types']>; readonly onPoolError?: unknown } };

/** A connection string that never gets dialled: every assertion here stays off the wire. */
const OFFLINE_URL = 'postgres://byok:byok@127.0.0.1:1/never_connected';

describe('createByokPool pool error handling', () => {
  it('routes an idle-client error to onPoolError instead of crashing', async () => {
    const seen: Array<{ err: Error; client: unknown }> = [];
    const pool = createByokPool({
      connectionString: OFFLINE_URL,
      onPoolError: (err, client) => seen.push({ err, client }),
    });

    try {
      const reset = new Error('Connection terminated unexpectedly');
      // Without the listener the factory installs, this re-throws as an uncaught
      // exception and takes the process down. With it, it is a handled event.
      expect(() => pool.emit('error', reset)).not.toThrow();
      expect(seen).toHaveLength(1);
      expect(seen[0]!.err).toBe(reset);
    } finally {
      await pool.end();
    }
  });

  it('installs an observable default listener when no onPoolError is given', async () => {
    const pool = createByokPool({ connectionString: OFFLINE_URL });

    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      // The pool has a listener even with no callback wired, so this is handled
      // rather than fatal — the default is loud, not silent.
      expect(pool.listenerCount('error')).toBe(1);
      expect(() => pool.emit('error', new Error('reset'))).not.toThrow();
      expect(calls).toHaveLength(1);
      expect(String(calls[0]![0])).toContain('[byok-sdk] idle pg pool client error (handled, not fatal)');
    } finally {
      console.error = original;
      await pool.end();
    }
  });

  it('strips onPoolError from the config handed to pg.Pool', async () => {
    const pool = createByokPool({
      connectionString: OFFLINE_URL,
      onPoolError: () => undefined,
    }) as unknown as PoolInternals;

    // `onPoolError` is ours, not a `PoolConfig` field: it must never reach the
    // driver's construction options, the same discipline `types` keeps.
    expect(pool.options.onPoolError).toBeUndefined();
    await (pool as unknown as pg.Pool).end();
  });

  it('keeps decoding int8 as bigint and defers every other oid to the default', async () => {
    const pool = createByokPool({ connectionString: OFFLINE_URL }) as unknown as PoolInternals;
    const types = pool.options.types;
    expect(types).toBeDefined();

    // The whole reason the parser is injected: a 64-bit column that does not fit
    // a JS number must arrive as a bigint, or every byte-count comparison in
    // core silently becomes a string compare.
    const int8 = types!.getTypeParser(pg.types.builtins.INT8, 'text') as (value: string) => unknown;
    expect(int8('9007199254740993')).toBe(9007199254740993n);

    // A non-int8 oid still goes through pg's own parser — this ADDS one rule, it
    // does not replace the table.
    const text = types!.getTypeParser(pg.types.builtins.TEXT, 'text') as (value: string) => unknown;
    expect(text('hello')).toBe('hello');

    await (pool as unknown as pg.Pool).end();
  });
});

describe('store compositions refuse a pool createByokPool did not build (#1040)', () => {
  const clock = { now: () => new Date() };
  const objectStorage = {
    endpoint: 'http://127.0.0.1:1', bucket: 'never-used', accessKeyId: 'key', secretAccessKey: 'secret',
    region: 'auto', signingClock: clock,
  };
  const entries: Record<string, (pool: ByokPool) => unknown> = {
    createPostgresCoreStores: (pool) => createPostgresCoreStores({ pool, clock, objectStorage }),
    createPostgresCloudStores: (pool) => createPostgresCloudStores({ rateLimit: { tokensPerSecond: 1_000, burst: 1_000 }, pool, clock, crypto: createWebCrypto(), objectStorage }),
    PostgresTruthCommitter: (pool) => new PostgresTruthCommitter({ pool } as PostgresTruthCommitterOptions),
    PostgresCloudCleanup: (pool) => new PostgresCloudCleanup({ pool, clock, objectStorage: new R2ObjectMaintenanceStore(objectStorage) }),
    PostgresTenantErasure: (pool) => new PostgresTenantErasure({ pool, clock, objectStorage: new R2ObjectMaintenanceStore(objectStorage) }),
    PostgresAgentMemoryProjectionStore: (pool) => new PostgresAgentMemoryProjectionStore({ pool } as PostgresAgentMemoryProjectionStoreOptions),
    PostgresTaskRedactionStore: (pool) => new PostgresTaskRedactionStore({ pool } as PostgresTaskRedactionStoreOptions),
  };

  for (const [name, compose] of Object.entries(entries)) {
    it(`${name} throws at composition for a bare pg.Pool, naming createByokPool`, async () => {
      // A bare pool reads `bigint` columns as strings: a reservation's 573456
      // bytes arrive as "573456", and finalize then refuses its own upload.
      const bare = new pg.Pool({ connectionString: OFFLINE_URL });
      try {
        const refusal = await Promise.resolve().then(() => compose(bare as unknown as ByokPool)).then(() => undefined, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(TypeError);
        expect((refusal as TypeError).message).toContain(`${name} needs a pool from createByokPool`);
      } finally {
        await bare.end();
      }
    });
  }

  it('accepts a pool from createByokPool', async () => {
    const pool = createByokPool({ connectionString: OFFLINE_URL });
    try {
      expect(() => createPostgresCoreStores({ pool, clock, objectStorage })).not.toThrow();
    } finally {
      await pool.end();
    }
  });
});
