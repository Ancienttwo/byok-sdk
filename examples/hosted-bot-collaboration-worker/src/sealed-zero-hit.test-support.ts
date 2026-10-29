/** Node provisions an isolated schema; every Host call then runs on workerd through local Hyperdrive. */
import { fileURLToPath } from 'node:url';
import { tenantId } from '@byok-sdk/cloud';
import { createByokPool, createPostgresCoreStores, migrate, migrationsDir } from '@byok-sdk/cloud-dataplane';
import { createDataplaneScope } from '../../../packages/cloud-dataplane/src/__tests__/support/dataplane';
import { startWranglerDev } from '../../../packages/cloud-dataplane/src/__tests__/support/wrangler';
import { CANARY_METHODS, decodeCanaryRpc, encodeCanaryRpc, type CanaryCloud } from '../../hosted-bot-collaboration/src/canary-cloud.test-support';
import { openHostedDevice } from '../../hosted-bot-collaboration/src/hosted-device.test-support';
import type { HostedCloudOptions } from '../../hosted-bot-collaboration/src/hosted-cloud.test-support';
import type { ZeroHitHost } from '../../hosted-bot-collaboration/src/sealed-zero-hit.test-support';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/sealed-canary', import.meta.url));

export async function openWorkerCanary(options: HostedCloudOptions): Promise<ZeroHitHost> {
  if (!options.objectStorage || !options.e2ee) throw new Error('the workerd canary requires object storage and E2EE');
  // Fail before starting wrangler if this is not the local zero-cost substrate.
  for (const value of [process.env.BYOK_TEST_POSTGRES_URL!, options.objectStorage.endpoint]) {
    if (new URL(value).hostname !== '127.0.0.1') throw new Error('the canary substrate must use 127.0.0.1');
  }
  const scope = await createDataplaneScope();
  const pool = createByokPool({ connectionString: scope.connectionString, max: 4 });
  const close: (() => Promise<unknown>)[] = [() => pool.end(), () => scope.dispose()];
  try {
    await migrate(pool, migrationsDir());
    const tenant = tenantId('hosted-collaboration-tenant');
    const core = createPostgresCoreStores({ pool: pool, clock: { now: () => new Date() }, objectStorage: options.objectStorage });
    await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
      maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
    const { signingClock: _clock, ...storage } = options.objectStorage;
    const worker = await startWranglerDev(FIXTURE_DIR, [`BYOK_CANARY_STORAGE:${JSON.stringify(storage)}`], {
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG: scope.connectionString,
    });
    close.unshift(() => worker.stop());
    async function probe(route: string, body?: unknown): Promise<unknown> {
      const response = await fetch(`${worker.base}/probe/${route}`, { method: 'POST',
        ...(body === undefined ? {} : { body: encodeCanaryRpc(body) }) });
      const text = await response.text();
      if (!response.ok) throw new Error(`workerd ${route}: HTTP ${response.status}: ${text}\n${worker.output()}`);
      return (decodeCanaryRpc(text) as { value: unknown }).value;
    }
    const cloud = Object.fromEntries(CANARY_METHODS.map(method => [method, (...args: unknown[]) => probe('call', { method, args })])) as CanaryCloud;
    const device = await openHostedDevice(cloud, tenant, worker.base, options);
    close.unshift(() => device.close());
    let stopped: Promise<void> | undefined;
    const stopRuntime = () => stopped ??= device.close().then(() => worker.stop());
    return { stopRuntime, cloud, tenant, ...device, pool: pool, logs: worker.output,
      readObserved: async () => await probe('observed') as Awaited<ReturnType<NonNullable<ZeroHitHost['readObserved']>>>,
      mailboxRows: async messageId => Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE message_id = $1', [messageId])).rows[0]!.n),
      close: shutdown };
  } catch (error) {
    await shutdown();
    throw error;
  }
  async function shutdown() {
    for (const step of close.splice(0)) await step();
  }
}
