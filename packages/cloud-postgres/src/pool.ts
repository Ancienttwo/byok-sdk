/**
 * The `pg` Pool factory.
 *
 * One thing here is load-bearing and easy to get wrong: **int8 parsing**.
 * `pg` decodes `bigint` columns as strings by default, because a 64-bit value
 * does not fit a JS `number`. Every byte-count contract in `@byok-sdk/core` is
 * declared `bigint` (`byteSize`, `releasedBytes`, the whole quota surface), so
 * a default-configured pool would hand the stores strings, and
 * `usage.reservedBytes > limit` would silently become a lexicographic string
 * comparison that answers a different question. Nothing would throw.
 *
 * The parser is injected **into the pool config**, never onto `pg.types`. That
 * registry is process-wide: mutating it would reach into every other `pg`
 * consumer in the host application, including ones that deliberately want
 * strings back. A host composing this SDK next to its own database code must
 * not have its decoding changed by one of our import side effects.
 */
import pg from 'pg';
import type { Pool, PoolClient, PoolConfig } from 'pg';

/**
 * `pg`'s default parser for every other oid, so this config ADDS one decoding
 * rule instead of replacing the table.
 */
const defaultTypeParser = pg.types.getTypeParser;

const int8Parsers: PoolConfig['types'] = {
  getTypeParser(id, format) {
    if (id === pg.types.builtins.INT8) return (value: string) => BigInt(value);
    return defaultTypeParser(id, format);
  },
};

export interface ByokPoolOptions extends Omit<PoolConfig, 'types'> {
  /** `postgres://user:password@host:port/database`. */
  readonly connectionString: string;
  /**
   * Where an IDLE client's error goes. See {@link createByokPool} — a pool
   * MUST carry an `'error'` listener or an idle-backend reset crashes the host.
   * This is where the host takes over that policy (log to its own sink, page,
   * increment a metric). It is NOT a `PoolConfig` field, so it is stripped
   * before the config reaches `pg.Pool`, exactly as `types` is kept off the
   * process-wide registry.
   *
   * Left unset, the pool still gets a listener — an observable default, not a
   * silent swallow.
   */
  readonly onPoolError?: (err: Error, client?: PoolClient) => void;
}

/**
 * Creates a pool wired with the int8 parser above.
 *
 * The caller owns the pool's lifetime: this package never holds a module-level
 * pool, because a process that composes two deployments (a migration runner and
 * a serving path, say) has to be able to close one without breaking the other.
 *
 * The `'error'` listener is MANDATORY, not defensive. A `pg.Pool` emits
 * `'error'` when a client that is sitting IDLE in the pool has its backend
 * connection reset from under it — a failover, an operator
 * `pg_terminate_backend`, an idle-timeout on a proxy, a network blip. There is
 * no `await` in flight to reject at that moment, so `pg` surfaces it on the
 * pool, and Node's rule for an `EventEmitter` `'error'` with no listener is to
 * rethrow it as an uncaught exception — which terminates the whole host
 * process. A bare `new pg.Pool(...)` therefore hands the host a latent crash on
 * an event it cannot see coming and did not cause. The listener converts that
 * into a handled, observable event: routed to the host's {@link
 * ByokPoolOptions.onPoolError} when supplied, or to a labelled `console.error`
 * so the reset is never invisible. It does not paper over live query errors —
 * those still reject their own `await`; this is only the idle-client path.
 */
export function createByokPool(options: ByokPoolOptions): Pool {
  // `onPoolError` is ours, not `pg`'s: strip it before the config reaches
  // `pg.Pool`, the same discipline `types` gets.
  const { onPoolError, ...poolConfig } = options;
  const pool = new pg.Pool({ ...poolConfig, types: int8Parsers });

  pool.on('error', (err: Error, client?: PoolClient) => {
    if (onPoolError) {
      onPoolError(err, client);
      return;
    }
    // Observable default: the host owns the policy, but the SDK never lets an
    // idle-client reset pass silently. `console.error` keeps it fail-safe (the
    // process survives) without pretending nothing happened.
    console.error('[byok-sdk] idle pg pool client error (handled, not fatal)', err);
  });

  return pool;
}
