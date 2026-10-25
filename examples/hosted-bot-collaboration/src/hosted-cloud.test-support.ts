import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createByokCloud, createHmacTokenSigner, createInProcessMailboxWake, createWebCrypto, fullCapabilityDeclaration, tenantId,
  type ByokCloud } from '@byok-sdk/cloud';
import { createPostgresCloudStores, createPostgresCoreStores, migrate, migrationsDir } from '@byok-sdk/cloud-dataplane';
import { createAgentHomeProjectionConsumer, createDaemonWithAdapters } from '@byok-sdk/client';
import type { FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';
import { POSTGRES_URL } from './postgres.test-support';
import type { HostedTaskPort } from './reconcile';

// The dataplane gate: the hosted SDK composition needs Postgres and the object store endpoint.
export const S3_ENDPOINT = process.env.BYOK_TEST_S3_ENDPOINT || undefined;
if (process.env.BYOK_REQUIRE_DATAPLANE === '1' && S3_ENDPOINT === undefined) {
  throw new Error('BYOK_REQUIRE_DATAPLANE=1 but BYOK_TEST_S3_ENDPOINT is unset. Start the substrate with:\n'
    + '  docker compose -f docker-compose.test.yml up -d --wait\n'
    + '  export BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100');
}
export const SKIP_HOSTED_CLOUD = POSTGRES_URL === undefined || S3_ENDPOINT === undefined;

const PRODUCT_ID = 'hosted-collaboration-test';

/**
 * The hosted SDK, as an H deployment composes it: `createByokCloud` over `createPostgresCloudStores`, with the SDK
 * migrations in a new schema, served over loopback HTTP. One real daemon is paired through the public pairing route.
 */
export async function openHostedCloud() {
  const schema = `hosted_sdk_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: POSTGRES_URL, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 8, options: `-c search_path=${schema}` });
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-cloud-'));
  const close: (() => Promise<unknown>)[] = [];
  try {
    await migrate(pool, migrationsDir());
    const clock = { now: () => new Date() };
    const crypto = createWebCrypto();
    const objectStorage = { endpoint: S3_ENDPOINT!, bucket: `hosted-${randomBytes(6).toString('hex')}`, accessKeyId: 'byokminio',
      secretAccessKey: 'byokminio', region: 'us-east-1', signingClock: clock };
    const core = createPostgresCoreStores({ pool, clock, objectStorage });
    const stores = await createPostgresCloudStores({ pool, clock, crypto, objectStorage });
    const declared = fullCapabilityDeclaration();
    const cloud: ByokCloud = createByokCloud({ core, cloud: stores, mailboxWake: createInProcessMailboxWake(), clock, crypto,
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
    const adapter = new BotStubAdapter();
    const daemon = createDaemonWithAdapters({ productId: PRODUCT_ID, productName: 'Hosted collaboration', localAgentRelease: { version: '0.0.0-test' },
      serverUrl: `http://127.0.0.1:${address.port}`, workspaceRoot: path.join(root, 'workspace'), storeDir: path.join(root, 'sdk'),
      // The Host's persona hook (#793 S13): it writes the Bot persona of a home projection, so the device applies a task-free
      // projection and advertises `agent-home-projection`.
      agentHome: { hostStorageRoot: path.join(root, 'homes'), projection: createAgentHomeProjectionConsumer(async ({ projection, writeHomeFile }) => {
        await writeHomeFile('AGENTS.md', String((projection as { persona?: unknown }).persona ?? ''));
      }) },
      agentEgress: { policy },
    }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
    const { code } = await cloud.createPairingCode(tenant, { productId: PRODUCT_ID });
    const { deviceId } = await daemon.pair(code);
    await daemon.start();
    close.unshift(() => daemon.stop());
    await waitForReady(daemon);

    /** The SDK calls of the tenant, as H binds them. */
    const port: FrozenSubmitPort & HostedTaskPort = {
      submit: input => cloud.submitAgentExecution(tenant, input),
      offer: taskId => cloud.readTaskOffer(tenant, taskId),
      attempt: taskId => cloud.readTaskAttempt(tenant, taskId),
      deviceTerminal: taskId => cloud.readDeviceTerminal(tenant, taskId),
      cancel: (taskId, reason) => cloud.cancelTask(tenant, taskId, reason),
    };
    /** Read only: the SDK mailbox rows of one offer message. One offer is one row, however many submits resolved. */
    const mailboxRows = async (messageId: string) =>
      Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE message_id = $1', [messageId])).rows[0]!.n);
    return { cloud, tenant, deviceId, adapter, daemon, port, mailboxRows, async close() { await shutdown(); } };
  } catch (error) {
    await shutdown();
    throw error;
  }
  async function shutdown() {
    for (const step of close.splice(0)) await step().catch(() => {});
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).finally(() => admin.end());
    await rm(root, { recursive: true, force: true });
  }
}
export type HostedCloud = Awaited<ReturnType<typeof openHostedCloud>>;
