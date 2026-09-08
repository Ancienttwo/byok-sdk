// Internal composition diagnostic; this is not a public consumer integration.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMutableClock, tenantId } from '../../../packages/core/src/index';
import { createWebCrypto } from '../../../packages/cloud/src/index';
import { createSqliteEmbeddedStores } from '../../../packages/server/src/stores/sqlite';

const root = mkdtempSync(join(tmpdir(), 'byok-g1c-'));
const dependencies = { clock: createMutableClock(), crypto: createWebCrypto() };
const tenant = tenantId('g1c-probe');
const other = tenantId('g1c-other');
const keys = ['task-offer:probe', 'task-offer-delivered:probe', 'task:probe:terminal'];
let stores = createSqliteEmbeddedStores({ path: join(root, 'server.sqlite') }, dependencies);
try {
  await stores.cloud.tasks.open(tenant, { taskId: 'probe', deviceId: 'device-probe' });
  for (const key of keys) {
    assert.equal((await stores.cloud.receipts.record(tenant, { key, body: 'original' })).created, true);
    const collision = await stores.cloud.receipts.record(tenant, { key, body: 'changed' });
    assert.equal(collision.created, false);
    assert.equal(collision.receipt.body, 'original');
    assert.equal(await stores.cloud.receipts.get(other, key), undefined);
  }
  await stores.close();
  stores = createSqliteEmbeddedStores({ path: join(root, 'server.sqlite') }, dependencies);
  assert.equal((await stores.cloud.tasks.get(tenant, 'probe'))?.deviceId, 'device-probe');
  const observations = [];
  for (const key of keys) {
    const afterRestart = await stores.cloud.receipts.get(tenant, key);
    assert.equal(afterRestart, undefined);
    const replacement = await stores.cloud.receipts.record(tenant, { key, body: 'changed' });
    assert.equal(replacement.created, true);
    observations.push({ key, missingAfterRestart: true, changedBodyAcceptedByReceiptStore: true });
  }
  console.log(JSON.stringify({ scope: 'internal-store-characterization', taskSurvived: true,
    sameProcessFirstWriteWins: true, tenantIsolation: true, observations,
    limitations: 'No enqueue, terminal projection, SIGKILL, provider or product acceptance.' }, null, 2));
} finally {
  await stores.close();
  rmSync(root, { recursive: true, force: true });
}
