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
import { AwsClient } from 'aws4fetch';
import type { Pool } from 'pg';
import { createByokPool } from '../../pool';

export const POSTGRES_URL_ENV = 'BYOK_TEST_POSTGRES_URL';
export const S3_ENDPOINT_ENV = 'BYOK_TEST_S3_ENDPOINT';
export const REQUIRE_DATAPLANE_ENV = 'BYOK_REQUIRE_DATAPLANE';

export const COMPOSE_COMMAND = 'docker compose -f docker-compose.test.yml up -d --wait';

export const SKIP_REASON =
  `${POSTGRES_URL_ENV} and ${S3_ENDPOINT_ENV} are not both set, so the dataplane suites cannot run. Start the substrate with:\n` +
  `  ${COMPOSE_COMMAND}\n` +
  `  export ${POSTGRES_URL_ENV}=postgres://byok:byok@127.0.0.1:5433/byok_test\n` +
  `  export ${S3_ENDPOINT_ENV}=http://127.0.0.1:9100`;

function configured(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

const dataplaneRequired = process.env[REQUIRE_DATAPLANE_ENV] === '1';
const missing = [POSTGRES_URL_ENV, S3_ENDPOINT_ENV].filter((name) => configured(name) === undefined);

if (dataplaneRequired && missing.length > 0) {
  // Thrown at import time on purpose: a suite that skipped here would report a
  // pass, and the one job that sets this flag exists to make that impossible.
  throw new Error(
    `${REQUIRE_DATAPLANE_ENV}=1 but ${missing.join(' and ')} unset. The dataplane job must run against a real substrate.\n${SKIP_REASON}`,
  );
}

/** `undefined` when no substrate is configured. */
export const POSTGRES_URL: string | undefined = configured(POSTGRES_URL_ENV);

/**
 * The S3-compatible endpoint, `undefined` when unconfigured.
 *
 * One gate for both services rather than two, because there is one substrate:
 * the compose file starts Postgres and MinIO together, and the object suites
 * need a manifest row and an object in the same breath. Two gates would let a
 * half-configured environment report a pass on the half it could reach.
 */
export const S3_ENDPOINT: string | undefined = configured(S3_ENDPOINT_ENV);

/**
 * MinIO's root credentials, verbatim from `docker-compose.test.yml`.
 *
 * Fixed, weak, and public on purpose — the same reason they are hardcoded in
 * the compose file. This substrate is throwaway and must never be reachable
 * from anything holding real data, so nothing here is a secret and nothing here
 * belongs in a secret store. A deployment's real credentials come from the
 * environment (`deploy/env/hosted.env.example`), never from a test file.
 */
export const OBJECT_STORE_ACCESS_KEY_ID = 'byokminio';
export const OBJECT_STORE_SECRET_ACCESS_KEY = 'byokminio';

/**
 * MinIO answers to `us-east-1`; R2's own region is `auto` (which R2 also
 * aliases `us-east-1` to). The adapter takes it as a required option precisely
 * so this difference is configuration rather than a guess.
 */
export const OBJECT_STORE_REGION = 'us-east-1';

/** `describe.skipIf(SKIP_DATAPLANE)` — true when there is nothing to run against. */
export const SKIP_DATAPLANE = POSTGRES_URL === undefined || S3_ENDPOINT === undefined;

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

/**
 * A fresh bucket plus the adapter config pointed at it.
 *
 * Per-scope rather than shared, for the same reason the Postgres schema is:
 * MinIO's `/data` is a tmpfs the compose stack wipes, but WITHIN one run a
 * leftover object at a key a later test declares would make a `pending`
 * manifest look uploaded. Object keys embed the tenant, and tenants repeat
 * across tests, so the bucket is where the isolation has to live.
 *
 * Nothing deletes the bucket afterwards. Reclaiming one means listing and
 * deleting its contents, which is `ListObjectsV2` — S4B's XML-paging cost
 * (design §3) — and the tmpfs already reclaims everything on `down`.
 */
export interface ObjectStorageScope {
  readonly bucket: string;
  readonly config: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly region: string;
    /**
     * Wall time. MinIO adjudicates a signature's freshness against its OWN
     * clock, so the composition's frozen logical clock — 2026-01-01, months
     * away from whenever this actually runs — would make every signed request
     * a skew rejection. A suite that needs an expired grant backdates a clock
     * of its own instead of using this one.
     */
    readonly signingClock: { now(): Date };
  };
  /** The signer the scope's own probes use. Tests reach for it to plant or read bytes out of band. */
  readonly client: AwsClient;
}

function requireEndpoint(): string {
  if (S3_ENDPOINT === undefined) throw new Error(SKIP_REASON);
  return S3_ENDPOINT.replace(/\/+$/, '');
}

export async function createObjectStorageScope(): Promise<ObjectStorageScope> {
  const endpoint = requireEndpoint();
  // Bucket naming is stricter than a schema name: lowercase, 3-63 chars, no
  // underscores. The hex form of a UUID satisfies all three.
  const bucket = `byok-test-${randomUUID().replaceAll('-', '')}`;

  const client = new AwsClient({
    accessKeyId: OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: OBJECT_STORE_SECRET_ACCESS_KEY,
    service: 's3',
    region: OBJECT_STORE_REGION,
    retries: 0,
  });

  const created = await client.fetch(`${endpoint}/${bucket}`, { method: 'PUT' });
  if (!created.ok) {
    throw new Error(`Could not create the test bucket ${bucket}: HTTP ${created.status} ${await created.text()}`);
  }

  return {
    bucket,
    client,
    config: {
      endpoint,
      bucket,
      accessKeyId: OBJECT_STORE_ACCESS_KEY_ID,
      secretAccessKey: OBJECT_STORE_SECRET_ACCESS_KEY,
      region: OBJECT_STORE_REGION,
      signingClock: { now: () => new Date() },
    },
  };
}
