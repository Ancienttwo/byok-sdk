import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { createByokPool, migrate, migrationsDir } from '@byok-sdk/cloud-dataplane';
import { createDataplaneScope, createObjectStorageScope } from '../../../packages/cloud-dataplane/src/__tests__/support/dataplane';
import { remoteCanaryConfig, runDeployedCanary, type CanaryConfig } from './deployed-canary.test-support';
import { sealedZeroHitSuite } from '../../hosted-bot-collaboration/src/sealed-zero-hit.test-support';
import { openWorkerCanary } from './sealed-zero-hit.test-support';
import { RUN } from './worker.test-support';

// E2EE needs OS credential custody. Enabling this in CI also needs a reviewed Secret Service wrapper.
const RUN_CANARY = RUN && process.env.BYOK_TEST_WORKER_SEALED_CANARY === '1';
if (process.env.BYOK_REQUIRE_WORKER_SEALED_CANARY === '1' && !RUN_CANARY) {
  throw new Error('BYOK_REQUIRE_WORKER_SEALED_CANARY=1 requires BYOK_TEST_WORKER_SEALED_CANARY=1 and the Worker dataplane substrate');
}
sealedZeroHitSuite('sealed zero-hit on local workerd + Hyperdrive (#654 d)', !RUN_CANARY, openWorkerCanary);

const remote = remoteCanaryConfig();
it.skipIf(!remote)('runs the owner-configured HTTPS canary against existing Postgres/R2', { timeout: 240_000 }, async () => {
  const lines: string[] = [];
  const spies = (['debug', 'info', 'log', 'warn', 'error'] as const)
    .map(level => vi.spyOn(console, level).mockImplementation((...args) => { lines.push(format(...args)); }));
  let result: Awaited<ReturnType<typeof runDeployedCanary>>;
  try { result = await runDeployedCanary(remote!, () => lines.join('\n')); }
  catch { throw new Error('Deployed canary failed; inspect the private operator capture (no credentials are printed)'); }
  finally { spies.forEach(spy => spy.mockRestore()); }
  console.info('deployed canary counts', JSON.stringify(result));
});

describe.skipIf(!RUN)('deployable canary on local workerd', () => {
  const workers: Unstable_DevWorker[] = [];
  const adminToken = randomBytes(24).toString('hex');
  const tokenKey = randomBytes(32).toString('hex');
  const fixture = fileURLToPath(new URL('./fixtures/sealed-canary/', import.meta.url));
  const priorHyperdrive = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG;
  afterAll(async () => {
    for (const worker of workers) await worker.stop();
    if (priorHyperdrive === undefined) delete process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG;
    else process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG = priorHyperdrive;
  });
  async function start(tokenSecret: string | null = tokenKey, adminSecret: string | null = adminToken,
    connectionString = process.env.BYOK_TEST_POSTGRES_URL!, storage?: CanaryConfig['storage']) {
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG = connectionString;
    const worker = await unstable_dev(`${fixture}deployable-worker.ts`, { config: `${fixture}wrangler.json`, local: true,
      ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false,
      vars: { ...(adminSecret === null ? {} : { HOST_ADMIN_TOKEN: adminSecret }),
        ...(tokenSecret === null ? {} : { BYOK_TOKEN_SECRET: tokenSecret }),
        ...(storage === undefined ? {} : { BYOK_CANARY_STORAGE: JSON.stringify(storage) }) },
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true } });
    workers.push(worker);
    return worker;
  }
  it('rejects a missing operator bearer on every non-device route', async () => {
    const worker = await start();
    for (const route of ['/', '/probe/call', '/probe/observed', '/unknown']) expect((await worker.fetch(route)).status).toBe(401);
  });
  it('rejects a wrong operator bearer', async () => {
    const worker = await start();
    expect((await worker.fetch('/probe/call', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });
  it('fails closed without the operator secret', async () => {
    const worker = await start(tokenKey, null);
    expect((await worker.fetch('/probe/call')).status).toBe(503);
  });
  it.each([null, 'ab'.repeat(31), 'ab'.repeat(33), 'z'.repeat(64)])('fails closed for missing or invalid token key (%#)', async key => {
    const worker = await start(key);
    expect((await worker.fetch('/byok/capabilities')).status).toBe(503);
    expect((await worker.fetch('/probe/call', { headers: { authorization: `Bearer ${adminToken}` } })).status).toBe(503);
  });
  it.skipIf(!RUN_CANARY)('logs observer digests to console and runs sealed/plain probes without logging content', async () => {
    const scope = await createDataplaneScope();
    const pool = createByokPool({ connectionString: scope.connectionString, max: 2 });
    const storage = await createObjectStorageScope();
    const lines: string[] = [];
    const spies = (['debug', 'info', 'log', 'warn', 'error'] as const)
      .map(level => vi.spyOn(console, level).mockImplementation((...args) => { lines.push(format(...args)); }));
    try {
      await migrate(pool, migrationsDir());
      const configured = await start(tokenKey, adminToken, scope.connectionString, storage.config);
      const result = await runDeployedCanary({ base: `http://${configured.address}:${configured.port}`, postgresUrl: scope.connectionString,
        adminToken, storage: storage.config, logs: async () => JSON.stringify({ logs: [{ message: [lines.join('\n')] }] }) }, () => lines.join('\n'));
      expect(result.sealedHits).toBe(0);
      expect(lines.join('\n')).toContain('canary observer');
      expect(lines.join('\n')).not.toMatch(/byok654sealed|byok654plain/u);
      expect(lines.join('\n')).not.toContain(adminToken);
      expect(lines.join('\n')).not.toContain(tokenKey);
    } finally {
      spies.forEach(spy => spy.mockRestore());
      for (const worker of workers.splice(0)) await worker.stop();
      await pool.end(); await scope.dispose();
    }
  });
});
