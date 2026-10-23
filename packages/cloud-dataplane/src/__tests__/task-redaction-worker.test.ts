/**
 * Scoped row-delete on Workers (#654 E5a): `redactTasks` runs inside local
 * workerd over Hyperdrive and the `./runtime` stores. Node writes the tasks
 * and scans the result, as in `task-redaction.test.ts`.
 *
 * The gate is the live Worker gate of this package: `BYOK_TEST_WORKER_DATAPLANE=1`
 * opts in, and `BYOK_REQUIRE_WORKER_DATAPLANE=1` (set by the CI dataplane job)
 * makes a skip a hard failure. The Worker deletes an object, so the S3 half of
 * the substrate is required as well.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { tenantId } from '@byok-sdk/core';
import { migrate } from '../migrate';
import {
  COMPOSE_COMMAND,
  POSTGRES_URL_ENV,
  S3_ENDPOINT_ENV,
  SKIP_DATAPLANE,
  createDataplaneScope,
  createObjectStorageScope,
} from './support/dataplane';
import { readObjects, readTenantRows, scanObjects, scanPostgres, type Hits } from './support/plaintext-scan';
import { composeRedactionHost, createCanary, pairDevice, runTask } from './support/redaction-flow';
import { PACKAGE_DIR, startWranglerDev } from './support/wrangler';

const OPT_IN_ENV = 'BYOK_TEST_WORKER_DATAPLANE';
const REQUIRE_ENV = 'BYOK_REQUIRE_WORKER_DATAPLANE';
const RUN = process.env[OPT_IN_ENV] === '1' && !SKIP_DATAPLANE;
const SKIP_REASON =
  `${OPT_IN_ENV} is not set (or ${POSTGRES_URL_ENV} / ${S3_ENDPOINT_ENV} is unset), so the redaction Worker test is skipped. To run it:\n` +
  `  export ${OPT_IN_ENV}=1\n  ${COMPOSE_COMMAND}`;

if (process.env[REQUIRE_ENV] === '1' && !RUN) {
  // Thrown at import time, as worker-e2e does: a skipped suite reports a pass.
  throw new Error(`${REQUIRE_ENV}=1 but the redaction Worker gate is unmet.\n${SKIP_REASON}`);
}

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const WORKER_DIR = path.join(PACKAGE_DIR, 'src', '__tests__', 'fixtures', 'redaction-worker');
const TENANT = tenantId('tenant-redaction-worker');

async function rowsMarkedBy(pool: Pool, marks: readonly string[]): Promise<string[]> {
  const { rows } = await readTenantRows(pool);
  return rows
    .map((row) => `${row.table}:${JSON.stringify(row.values.map((value) => (Buffer.isBuffer(value) ? value.toString('hex') : value)))}`)
    .filter((text) => marks.some((mark) => text.includes(mark)))
    .sort();
}

describe.skipIf(!RUN)(`task redaction on workerd — ${SKIP_REASON}`, () => {
  it('redacts through ./runtime and Hyperdrive with zero canary hits and no change to another task', async () => {
    const scope = await createDataplaneScope(2);
    const storage = await createObjectStorageScope();
    await migrate(scope.pool, DEPLOY_SQL);
    const worker = await startWranglerDev(
      WORKER_DIR,
      [
        `BYOK_S3_ENDPOINT:${storage.config.endpoint}`,
        `BYOK_S3_BUCKET:${storage.config.bucket}`,
        `BYOK_S3_ACCESS_KEY_ID:${storage.config.accessKeyId}`,
        `BYOK_S3_SECRET_ACCESS_KEY:${storage.config.secretAccessKey}`,
        `BYOK_S3_REGION:${storage.config.region}`,
      ],
      // The fixture's config has no `localConnectionString`; wrangler dev
      // reads the Hyperdrive string for binding BYOK_PG from this variable.
      { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG: scope.connectionString },
    );
    try {
      const host = await composeRedactionHost(scope.pool, storage);
      const device = await pairDevice(host, TENANT);
      const canaryA = createCanary('wa');
      const canaryB = createCanary('wb');
      const runA = await runTask(host, device, `task-a-${randomUUID()}`, canaryA);
      const runB = await runTask(host, device, `task-b-${randomUUID()}`, canaryB);
      const offerB = await host.cloud.readTaskOffer(TENANT, runB.taskId);
      const marksB = [canaryB.core, runB.taskId, offerB!.messageId, runB.artifactHex, runB.messageId];
      const rowsB = await rowsMarkedBy(scope.pool, marksB);
      const objectsBefore = await readObjects(storage);

      const response = await fetch(`${worker.base}/redact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant: TENANT, taskIds: [runA.taskId] }),
      });
      expect(response.status, worker.output()).toBe(200);
      expect(await response.json()).toEqual({
        tasks: [{
          taskId: runA.taskId,
          outcome: 'redacted',
          counts: { receiptsRedacted: 3, admissionsRedacted: 1, outboxRedacted: 2, ephemeralRowsDeleted: 1, objectsDeleted: 1 },
        }],
      });

      const hits: Hits = new Map();
      await scanPostgres(scope.pool, canaryA.needles, hits);
      await scanObjects(storage, TENANT, canaryA.needles, hits);
      expect(Object.fromEntries(hits)).toEqual({});
      expect(await rowsMarkedBy(scope.pool, marksB)).toEqual(rowsB);
      const objectsAfter = await readObjects(storage);
      expect([...objectsBefore.keys()].filter((key) => !objectsAfter.has(key)))
        .toEqual([`tenants/${TENANT}/objects/sha256/${runA.artifactHex}`]);
      expect(objectsAfter.get(`tenants/${TENANT}/objects/sha256/${runB.artifactHex}`)
        ?.equals(objectsBefore.get(`tenants/${TENANT}/objects/sha256/${runB.artifactHex}`)!)).toBe(true);
    } finally {
      // workerd's connections close with it, before the scope drops its role.
      await worker.stop();
      await scope.dispose();
    }
  }, 240_000);
});
