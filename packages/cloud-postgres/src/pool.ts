/**
 * The `pg` Pool factory.
 *
 * One thing here is load-bearing and easy to get wrong: **int8 parsing**.
 * `pg` decodes `bigint` columns as strings by default, because a 64-bit value
 * does not fit a JS `number`. Every byte-count contract in `@byok/core` is
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
import type { Pool, PoolConfig } from 'pg';

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
}

/**
 * Creates a pool wired with the int8 parser above.
 *
 * The caller owns the pool's lifetime: this package never holds a module-level
 * pool, because a process that composes two deployments (a migration runner and
 * a serving path, say) has to be able to close one without breaking the other.
 */
export function createByokPool(options: ByokPoolOptions): Pool {
  return new pg.Pool({ ...options, types: int8Parsers });
}
