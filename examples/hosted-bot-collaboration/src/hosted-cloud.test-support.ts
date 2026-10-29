import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createByokCloud, createHmacTokenSigner, createInProcessMailboxWake, createWebCrypto, fullCapabilityDeclaration, tenantId,
  type ByokCloud, type ByokCloudObserver } from '@byok-sdk/cloud';
import { createPostgresCloudStores, createPostgresCoreStores, migrate, migrationsDir } from '@byok-sdk/cloud-dataplane';
import { createByokPool, PostgresE2eeMemberStore } from '@byok-sdk/cloud-dataplane/runtime';
import type { BotStubAdapter } from '../../basic/goal-btw.test-support';
import type { TaskSealing } from './e2ee-member.test-support';
import { openHostedDevice } from './hosted-device.test-support';
import { POSTGRES_URL } from './postgres.test-support';

// The dataplane gate: the hosted SDK composition needs Postgres and the object store endpoint.
export const S3_ENDPOINT = process.env.BYOK_TEST_S3_ENDPOINT || undefined;
if (process.env.BYOK_REQUIRE_DATAPLANE === '1' && S3_ENDPOINT === undefined) {
  throw new Error('BYOK_REQUIRE_DATAPLANE=1 but BYOK_TEST_S3_ENDPOINT is unset. Start the substrate with:\n'
    + '  docker compose -f docker-compose.test.yml up -d --wait\n'
    + '  export BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100');
}
export const SKIP_HOSTED_CLOUD = POSTGRES_URL === undefined || S3_ENDPOINT === undefined;

export interface HostedCloudOptions {
  /**
   * An E2EE pairing (#654): the Host declares `e2ee.member` over the Postgres member store, a web client member pairs
   * the daemon with `pv`, and creates one scope of `categories` with the device. The daemon then keeps its enrollment
   * and member keys in the OS credential custody (a test keychain on macOS, the Secret Service on Linux), because an
   * injected enrollment backend refuses an E2EE pairing.
   */
  readonly e2ee?: { readonly scopeId: string; readonly categories: TaskSealing['categories'] };
  readonly deviceName?: string;
  readonly adapter?: BotStubAdapter;
  /** The product's observer of committed device envelopes. */
  readonly observer?: ByokCloudObserver;
  /** The object store of a caller that reads the bucket itself. */
  readonly objectStorage?: ObjectStorageConfig;
}
type ObjectStorageConfig = Parameters<typeof createPostgresCoreStores>[0]['objectStorage'] & object;

/**
 * The hosted SDK, as an H deployment composes it: `createByokCloud` over `createPostgresCloudStores`, with the SDK
 * migrations in a new schema, served over loopback HTTP. One real daemon is paired through the public pairing route.
 */
export async function openHostedCloud(options: HostedCloudOptions = {}) {
  const schema = `hosted_sdk_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: POSTGRES_URL, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // The stores read int8 columns as bigint, which only the pool from createByokPool parses.
  const pool = createByokPool({ connectionString: POSTGRES_URL!, max: 8, options: `-c search_path=${schema}` });
  const close: (() => Promise<unknown>)[] = [];
  try {
    await migrate(pool, migrationsDir());
    const clock = { now: () => new Date() };
    const crypto = createWebCrypto();
    const objectStorage = options.objectStorage ?? { endpoint: S3_ENDPOINT!, bucket: `hosted-${randomBytes(6).toString('hex')}`,
      accessKeyId: 'byokminio', secretAccessKey: 'byokminio', region: 'us-east-1', signingClock: clock };
    const core = createPostgresCoreStores({ pool, clock, objectStorage });
    const stores = await createPostgresCloudStores({ pool, clock, crypto, objectStorage });
    const declared = fullCapabilityDeclaration(undefined, { includeE2eeMember: options.e2ee !== undefined });
    const cloud: ByokCloud = createByokCloud({ core, cloud: stores, mailboxWake: createInProcessMailboxWake(), clock, crypto,
      ...(options.e2ee === undefined ? {} : { e2eeMemberStore: new PostgresE2eeMemberStore(pool, clock) }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(3), clock),
      capabilities: { ...declared, capabilities: declared.capabilities.filter(capability => capability !== 'blobs.contentproxy') } });
    const tenant = tenantId('hosted-collaboration-tenant');
    // Host provisioning through the store port: the tenant's storage entitlement, which a mailbox append needs.
    await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
      maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });

    const http = serve({ fetch: request => cloud.fetch(request), port: 0, hostname: '127.0.0.1' });
    close.unshift(() => new Promise<void>((resolve, reject) => {
      http.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in http) http.closeAllConnections();
    }));
    if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const device = await openHostedDevice(cloud, tenant, `http://127.0.0.1:${address.port}`, options);
    close.unshift(() => device.close());

    /** Read only: the SDK mailbox rows of one offer message. One offer is one row, however many submits resolved. */
    const mailboxRows = async (messageId: string) =>
      Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE message_id = $1', [messageId])).rows[0]!.n);
    return { cloud, tenant, ...device, mailboxRows, pool, async close() { await shutdown(); } };
  } catch (error) {
    await shutdown();
    throw error;
  }
  async function shutdown() {
    for (const step of close.splice(0)) await step().catch(() => {});
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).finally(() => admin.end());
  }
}
export type HostedCloud = Awaited<ReturnType<typeof openHostedCloud>>;
