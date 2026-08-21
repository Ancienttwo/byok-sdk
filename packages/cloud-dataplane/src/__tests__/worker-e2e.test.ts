/**
 * The live Worker E2E: `wrangler dev` (local workerd) over the worker-smoke
 * fixture, against the same compose Postgres the rest of these suites use.
 *
 * This is the composition the runtime subpath exists for, run for real: the
 * database is migrated from Node (`migrate` + `deploy/sql` — the root entry's
 * job), and the Worker serves over Hyperdrive's local connection string using
 * only `@byok-sdk/cloud-dataplane/runtime`. Each probe asserts a full SQL
 * round trip, not a status code: pairing mints AND consumes, the mailbox
 * enqueues AND acks, truth commits AND reads back. The blob probe additionally
 * runs the aws4fetch signing and S3 HTTP path inside workerd — presign and
 * verify on the Worker side, the device-side PUT from this process, exactly
 * the split the real topology has — with MinIO as the independent SigV4
 * adjudicator, same as the Node object suite.
 *
 * Gating follows the substrate law (support/dataplane.ts):
 *
 * - `BYOK_TEST_WORKER_DATAPLANE=1` opts in. It is separate from the
 *   substrate env because this suite spawns `wrangler dev` — heavier than a
 *   suite, and pointless without a database — so it is not something every
 *   local `bun run test` should pay for. Absent env → skip, with a signpost
 *   that names the exact commands.
 * - `BYOK_REQUIRE_WORKER_DATAPLANE=1` turns an unmet gate into a hard
 *   failure. Exactly one CI job sets it, and
 *   `constraints.test.ts` pins that job — the skip path can never be how CI
 *   stays green. `process.env.CI` is deliberately NOT the gate, for the same
 *   reason as the substrate env.
 * - The blob test additionally needs the S3 half of the substrate, coupled
 *   the same way `SKIP_DATAPLANE` couples it: Postgres alone cannot serve the
 *   object probe, so a Postgres-only environment skips the blob test rather
 *   than half-passing it.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { createByokPool } from '../pool';
import {
  COMPOSE_COMMAND,
  COMPOSE_POSTGRES_URL,
  OBJECT_STORE_ACCESS_KEY_ID,
  OBJECT_STORE_REGION,
  OBJECT_STORE_SECRET_ACCESS_KEY,
  POSTGRES_URL,
  POSTGRES_URL_ENV,
  S3_ENDPOINT,
  S3_ENDPOINT_ENV,
  WORKER_E2E_POSTGRES_URL,
  WORKER_E2E_ROLE,
  WORKER_E2E_SCHEMA,
  createObjectStorageScope,
  type ObjectStorageScope,
} from './support/dataplane';
import { WORKER_SMOKE_DIR, wranglerEntry, wranglerEnv } from './support/wrangler';

const OPT_IN_ENV = 'BYOK_TEST_WORKER_DATAPLANE';
const REQUIRE_ENV = 'BYOK_REQUIRE_WORKER_DATAPLANE';

const SKIP_REASON =
  `${OPT_IN_ENV} is not set (or ${POSTGRES_URL_ENV} is unset), so the live Worker E2E is skipped. To run it:\n` +
  `  export ${OPT_IN_ENV}=1\n` +
  `  ${COMPOSE_COMMAND}\n` +
  `  export ${POSTGRES_URL_ENV}=${COMPOSE_POSTGRES_URL}\n` +
  `  export ${S3_ENDPOINT_ENV}=http://127.0.0.1:9100`;

const optIn = process.env[OPT_IN_ENV] === '1';
const required = process.env[REQUIRE_ENV] === '1';
// One substrate, both halves: the require flag may only be set where the full
// compose stack is up, mirroring support/dataplane.ts's coupled gate.
const gateMet = optIn && POSTGRES_URL !== undefined && S3_ENDPOINT !== undefined;

if (required && !gateMet) {
  // Thrown at import time, for the same reason support/dataplane.ts throws
  // there: a skipped suite reports a pass, and the one job that sets this flag
  // exists to make that impossible.
  throw new Error(`${REQUIRE_ENV}=1 but the worker E2E gate is unmet.\n${SKIP_REASON}`);
}

const RUN = optIn && POSTGRES_URL !== undefined;
const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

/** Reserves an ephemeral 127.0.0.1 port and gives it back. */
function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port to probe'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

interface ProbeResult {
  readonly ok: boolean;
  readonly probe?: Record<string, unknown>;
  readonly error?: string;
}

async function schemaTables(connectionString: string, schema: string): Promise<string[]> {
  const pool = createByokPool({ connectionString, max: 1 });
  try {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [schema],
    );
    return tables.rows.map((row) => row.table_name);
  } finally {
    await pool.end();
  }
}

async function fetchProbe(
  base: string,
  route: string,
  init?: RequestInit,
): Promise<ProbeResult> {
  const response = await fetch(`${base}${route}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  return (await response.json()) as ProbeResult;
}

describe.skipIf(!RUN)('the runtime subpath on a real workerd', () => {
  let child: ChildProcess | undefined;
  let base = '';
  let output = '';
  let storage: ObjectStorageScope | undefined;
  let persistDir = '';

  beforeAll(
    async () => {
      // The fixture's Hyperdrive localConnectionString is the substrate the
      // test migrates; a mismatch would have this suite green against a
      // database the Worker never touched.
      const config = readFileSync(`${WORKER_SMOKE_DIR}/wrangler.jsonc`, 'utf8');
      expect(config, 'worker-smoke/wrangler.jsonc must point at the substrate Postgres').toContain(
        WORKER_E2E_POSTGRES_URL,
      );
      expect(config, 'the application role, not a DSN option, selects the schema').not.toContain('options=');
      expect(POSTGRES_URL, 'the Worker fixture only runs against the disposable compose database').toBe(
        COMPOSE_POSTGRES_URL,
      );

      // Node migrates; the Worker serves. Both authenticate as the same
      // database-scoped application role, which owns the isolated schema.
      const pool = createByokPool({ connectionString: WORKER_E2E_POSTGRES_URL });
      try {
        await expect(
          pool.query<{ currentSchema: string; currentUser: string }>(
            'SELECT current_schema() AS "currentSchema", current_user AS "currentUser"',
          ),
        ).resolves.toMatchObject({
          rows: [{ currentSchema: WORKER_E2E_SCHEMA, currentUser: WORKER_E2E_ROLE }],
        });
        const result = await migrate(pool, DEPLOY_SQL);
        expect(result.applied.length + result.alreadyApplied.length).toBeGreaterThan(0);
      } finally {
        await pool.end();
      }

      // Read metadata with the compose administrator, not a second migration
      // path. Every SDK table (including the ledger) must be in the role-owned
      // schema and none of those table names may exist in public.
      const isolatedTables = await schemaTables(WORKER_E2E_POSTGRES_URL, WORKER_E2E_SCHEMA);
      expect(isolatedTables).toEqual(
        expect.arrayContaining(['attested_record', 'byok_schema_migration', 'outbox', 'pairing_code']),
      );
      const publicCounterparts = await schemaTables(POSTGRES_URL!, 'public');
      expect(publicCounterparts.filter((table) => isolatedTables.includes(table))).toEqual([]);

      const port = await probeFreePort();
      base = `http://127.0.0.1:${port}`;

      // The S3 half, when the substrate provides it: a fresh bucket per run,
      // exactly like the Node object suite's scope, handed to the Worker as
      // vars — the clean runtime path, since wrangler config has no env
      // interpolation. `--var` splits on the FIRST colon only, so the
      // endpoint's own colons survive intact.
      const varArgs: string[] = [];
      if (S3_ENDPOINT !== undefined) {
        storage = await createObjectStorageScope();
        varArgs.push(
          `BYOK_S3_ENDPOINT:${storage.config.endpoint}`,
          `BYOK_S3_BUCKET:${storage.config.bucket}`,
          `BYOK_S3_ACCESS_KEY_ID:${OBJECT_STORE_ACCESS_KEY_ID}`,
          `BYOK_S3_SECRET_ACCESS_KEY:${OBJECT_STORE_SECRET_ACCESS_KEY}`,
          `BYOK_S3_REGION:${OBJECT_STORE_REGION}`,
        );
      }

      // Miniflare state (sqlite etc.) goes to a scratch directory, never to a
      // `.wrangler/` inside the repository.
      persistDir = mkdtempSync(path.join(os.tmpdir(), 'byok-worker-dev-'));

      // Detached so the whole process group (wrangler + workerd) dies with
      // one kill in afterAll; wrangler's own SIGTERM handling forwards it.
      child = spawn(
        process.execPath,
        [
          wranglerEntry(),
          'dev',
          '--port',
          String(port),
          '--ip',
          '127.0.0.1',
          '--persist-to',
          persistDir,
          ...varArgs.flatMap((entry) => ['--var', entry]),
        ],
        { cwd: WORKER_SMOKE_DIR, env: wranglerEnv(), detached: true },
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });

      const deadline = Date.now() + 120_000;
      for (;;) {
        if (child.exitCode !== null) {
          throw new Error(`wrangler dev exited early (code ${child.exitCode}):\n${output}`);
        }
        try {
          const response = await fetch(base, { signal: AbortSignal.timeout(2_000) });
          // The fixture's 404 body names its routes; that IS readiness.
          if (response.status === 404) break;
        } catch {
          // Not up yet.
        }
        if (Date.now() > deadline) throw new Error(`wrangler dev never became ready:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
    180_000,
  );

  afterAll(
    () => {
      if (child === undefined || child.pid === undefined) return;
      const pid = child.pid;
      const killGroup = (signal: NodeJS.Signals) => {
        if (process.platform === 'win32') {
          try {
            child!.kill(signal);
          } catch {
            /* already gone */
          }
          return;
        }
        try {
          process.kill(-pid, signal);
        } catch {
          /* the group is already gone */
        }
      };
      // Deterministic teardown: wrangler gets a grace window to forward
      // SIGTERM to workerd, then the whole group is SIGKILLed so a wedged
      // workerd cannot outlive the test run. The persist-to scratch directory
      // goes only after the group is gone, so its sqlite files are closed.
      killGroup('SIGTERM');
      return new Promise<void>((resolve) => {
        child!.once('exit', () => resolve());
        const deadline = Date.now() + 15_000;
        const poll = () => {
          if (child!.exitCode !== null) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            killGroup('SIGKILL');
            resolve();
            return;
          }
          setTimeout(poll, 200);
        };
        poll();
      }).finally(() => {
        if (persistDir !== '') rmSync(persistDir, { recursive: true, force: true });
        // `--persist-to` carries all miniflare sqlite state away, but wrangler
        // still drops `.wrangler/cache/cf.json` (and `tmp/` scratch while
        // running) next to its config; the repository stays clean only if the
        // suite removes them once the group is dead. A killed run can leave
        // the scratch behind — the root .gitignore proposal covers that.
        rmSync(path.join(WORKER_SMOKE_DIR, '.wrangler'), { recursive: true, force: true });
      });
    },
    30_000,
  );

  it('pairs a device: mint then consume a single-use code over SQL', async () => {
    const result = await fetchProbe(base, '/probe/pairing');
    expect(result).toMatchObject({ ok: true, probe: { minted: true, redeemed: true } });
  });

  it('opens each fresh Hyperdrive session in the application role schema', async () => {
    const reports = await Promise.all(
      Array.from({ length: 3 }, () => fetchProbe(base, '/probe/schema')),
    );
    for (const report of reports) {
      expect(report).toMatchObject({
        ok: true,
        probe: { currentSchema: WORKER_E2E_SCHEMA, currentUser: WORKER_E2E_ROLE },
      });
    }
  });

  it('delivers a mailbox message: enqueue, ack, then drained read', async () => {
    const result = await fetchProbe(base, '/probe/mailbox');
    expect(result).toMatchObject({
      ok: true,
      probe: { enqueued: true, acked: true, emptyAfterAck: true, message: 'worker-smoke-mailbox' },
    });
  });

  it('commits terminal truth and reads the record back', async () => {
    const result = await fetchProbe(base, '/probe/truth');
    expect(result).toMatchObject({
      ok: true,
      probe: { replayed: false, committedRev: 1, readBack: true },
    });
  });

  // The S3 half of the substrate, coupled the same way SKIP_DATAPLANE couples
  // it: without MinIO the object probe cannot run, so it skips rather than
  // half-passing. Under the REQUIRE flag the import-time guard above already
  // made the missing endpoint a hard failure.
  it.skipIf(S3_ENDPOINT === undefined)(
    'round-trips a blob: presign in the Worker, PUT from here, verify+commit in the Worker',
    async () => {
      const stage1 = await fetchProbe(base, '/probe/blob', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      expect(stage1.error).toBeUndefined();
      expect(stage1.probe).toBeDefined();
      const grant = stage1.probe as {
        blobId: string;
        uploadUrl: string;
        payload: string;
        contentType: string;
        byteSize: number;
      };

      // The device-side upload, exactly as the Node object suite performs it:
      // the signed shape must be honored verbatim, and MinIO adjudicates the
      // signature an aws4fetch call inside workerd produced.
      const uploaded = await fetch(grant.uploadUrl, {
        method: 'PUT',
        body: new TextEncoder().encode(grant.payload),
        headers: { 'content-type': grant.contentType },
      });
      expect(uploaded.status, await uploaded.text()).toBe(200);

      const stage2 = await fetchProbe(base, '/probe/blob/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(grant),
      });
      expect(stage2).toMatchObject({
        ok: true,
        probe: {
          observedByteSize: grant.byteSize,
          observedContentType: 'application/json',
          manifestState: 'committed',
          manifestByteSize: grant.byteSize,
        },
      });
    },
  );
});
