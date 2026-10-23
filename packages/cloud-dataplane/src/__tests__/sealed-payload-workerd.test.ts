/**
 * Runs the sealed-payload v1 vectors on local workerd (#654 E1b), the runtime
 * of the hosted Host. The Node and Bun legs live in core; this leg lives here
 * because this package already pins wrangler.
 *
 * The gate is the live Worker gate of this package: `BYOK_TEST_WORKER_DATAPLANE=1`
 * opts in, and `BYOK_REQUIRE_WORKER_DATAPLANE=1` (set by the CI dataplane job)
 * makes a skip a hard failure. The Worker needs no Postgres or object store.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkSealedPayloadVectors,
  type SealedPayloadVectors,
  type VectorCheckCounts,
} from '../../../core/src/__tests__/support/sealed-payload-vectors';
import { PACKAGE_DIR, startWranglerDev, type WranglerDev } from './support/wrangler';

const OPT_IN_ENV = 'BYOK_TEST_WORKER_DATAPLANE';
const REQUIRE_ENV = 'BYOK_REQUIRE_WORKER_DATAPLANE';
const RUN = process.env[OPT_IN_ENV] === '1';

if (process.env[REQUIRE_ENV] === '1' && !RUN) {
  throw new Error(`${REQUIRE_ENV}=1 but ${OPT_IN_ENV} is not 1, so the workerd vector leg would skip.`);
}

const WORKER_DIR = path.join(PACKAGE_DIR, 'src', '__tests__', 'fixtures', 'sealed-payload-worker');
const golden = JSON.parse(
  readFileSync(new URL('../../../core/src/__tests__/golden/sealed-payload-v1.json', import.meta.url), 'utf8'),
) as SealedPayloadVectors;

describe.skipIf(!RUN)('sealed-payload v1 vectors on workerd', () => {
  let worker: WranglerDev;

  beforeAll(async () => {
    worker = await startWranglerDev(WORKER_DIR, []);
  }, 180_000);

  afterAll(async () => {
    await worker?.stop();
  }, 60_000);

  it('run every check that the Node leg runs', async () => {
    const response = await fetch(`${worker.base}/vectors`);
    const report = await response.json() as { ok: boolean; counts?: VectorCheckCounts; error?: string };
    expect(report, worker.output()).toEqual({ ok: true, counts: await checkSealedPayloadVectors(golden) });
  }, 120_000);
});
