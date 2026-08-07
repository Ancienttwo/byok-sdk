/**
 * The dataplane test gate, and the only place the substrate's env contract is
 * written down (docs/researches/s4a-dataplane-design.md §1).
 *
 * Two behaviors, and the second is what keeps the first honest:
 *
 * - `BYOK_TEST_POSTGRES_URL` absent → the suites `describe.skipIf` themselves
 *   and the skip message prints the exact command that would fix it. A
 *   developer without docker sees a signpost, not a mystery.
 * - `BYOK_REQUIRE_DATAPLANE=1` → absence is a hard failure instead. That flag
 *   is set by exactly one CI job, so the skip path can never be how CI stays
 *   green, and `packages/cloud-postgres/src/__tests__/constraints.test.ts`
 *   pins the job that sets it.
 *
 * `process.env.CI` is deliberately NOT the gate: `pnpm -r test` already runs
 * with `CI=true` inside the ordinary build-test job, where these services do
 * not exist, so keying off it would turn every unrelated CI run red.
 *
 * Isolation is per-test, by schema. Each composition gets a fresh
 * `byok_test_<n>` schema on the same server and a pool whose `search_path`
 * points at it, so unqualified DDL in `deploy/sql/` lands there and a test can
 * neither see nor clobber another's rows. That is what lets the concurrency
 * assertions use REAL connections instead of a serialized stand-in — the whole
 * reason this substrate is a Postgres container and not an embedded engine.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createByokPool } from '../../pool';

export const POSTGRES_URL_ENV = 'BYOK_TEST_POSTGRES_URL';
export const REQUIRE_DATAPLANE_ENV = 'BYOK_REQUIRE_DATAPLANE';

export const COMPOSE_COMMAND = 'docker compose -f docker-compose.test.yml up -d --wait';

export const SKIP_REASON =
  `${POSTGRES_URL_ENV} is not set, so the dataplane suites cannot run. Start the substrate with:\n` +
  `  ${COMPOSE_COMMAND}\n` +
  `  export ${POSTGRES_URL_ENV}=postgres://byok:byok@127.0.0.1:5433/byok_test`;

const rawUrl = process.env[POSTGRES_URL_ENV];
const dataplaneRequired = process.env[REQUIRE_DATAPLANE_ENV] === '1';

if (dataplaneRequired && (rawUrl === undefined || rawUrl.length === 0)) {
  // Thrown at import time on purpose: a suite that skipped here would report a
  // pass, and the one job that sets this flag exists to make that impossible.
  throw new Error(
    `${REQUIRE_DATAPLANE_ENV}=1 but ${POSTGRES_URL_ENV} is unset. The dataplane job must run against a real Postgres.\n${SKIP_REASON}`,
  );
}

/** `undefined` when no substrate is configured. */
export const POSTGRES_URL: string | undefined =
  rawUrl !== undefined && rawUrl.length > 0 ? rawUrl : undefined;

/** `describe.skipIf(SKIP_DATAPLANE)` — true when there is nothing to run against. */
export const SKIP_DATAPLANE = POSTGRES_URL === undefined;

/** A pool plus the throwaway schema it is pinned to. */
export interface DataplaneScope {
  readonly pool: Pool;
  readonly schema: string;
  /**
   * `application_name` on every connection this pool opens, equal to the
   * schema. Server-wide catalogs (`pg_locks`, `pg_stat_activity`) are NOT
   * schema-isolated, so an assertion about them has to filter to this scope's
   * own backends or it will read another concurrently running test file's
   * state.
   */
  readonly applicationName: string;
  dispose(): Promise<void>;
}

function requireUrl(): string {
  if (POSTGRES_URL === undefined) throw new Error(SKIP_REASON);
  return POSTGRES_URL;
}

/**
 * Creates an empty schema and a pool that resolves unqualified names inside it.
 *
 * `search_path` is set through the connection's `options`, so it applies to
 * every client the pool opens — including the extra ones a concurrency
 * assertion forces open. Setting it with a `SET` statement after connecting
 * would apply to one session and silently miss the others.
 */
export async function createDataplaneScope(poolSize = 8): Promise<DataplaneScope> {
  const url = requireUrl();
  const schema = `byok_test_${randomUUID().replaceAll('-', '')}`;

  const admin = createByokPool({ connectionString: url, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }

  const pool = createByokPool({
    connectionString: url,
    max: poolSize,
    options: `-c search_path=${schema}`,
    application_name: schema,
  });

  return {
    pool,
    schema,
    applicationName: schema,
    async dispose() {
      await pool.end();
      const cleanup = createByokPool({ connectionString: url, max: 1 });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
