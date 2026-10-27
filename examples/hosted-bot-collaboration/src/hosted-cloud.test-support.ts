import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createByokCloud, createHmacTokenSigner, createInProcessMailboxWake, createWebCrypto, fullCapabilityDeclaration, tenantId,
  type ByokCloud, type ByokCloudObserver } from '@byok-sdk/cloud';
import { createPostgresCloudStores, createPostgresCoreStores, migrate, migrationsDir } from '@byok-sdk/cloud-dataplane';
import { createByokPool, PostgresE2eeMemberStore } from '@byok-sdk/cloud-dataplane/runtime';
import { createAgentHomeProjectionConsumer, createDaemonWithAdapters } from '@byok-sdk/client';
import type { FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { createTestKeychain } from '../../../scripts/testing/macos-keychain.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';
import { HostedMember, type TaskSealing } from './e2ee-member.test-support';
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
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-cloud-'));
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

    // Works around #1039: the R2 store signs with aws4fetch, which accepts only the global Request class, so the server
    // must not replace it. Remove this option when #1039 is fixed.
    const http = serve({ fetch: request => cloud.fetch(request), port: 0, hostname: '127.0.0.1', overrideGlobalObjects: false });
    close.unshift(() => new Promise<void>((resolve, reject) => {
      http.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in http) http.closeAllConnections();
    }));
    if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const adapter = options.adapter ?? new BotStubAdapter();
    let deviceCredentials: { macosKeychainPath: string } | undefined;
    if (options.e2ee !== undefined && process.platform === 'darwin') {
      const keychain = await createTestKeychain();
      close.push(() => keychain.dispose());
      deviceCredentials = { macosKeychainPath: keychain.path };
    }
    const daemon = createDaemonWithAdapters({ productId: PRODUCT_ID, productName: 'Hosted collaboration', localAgentRelease: { version: '0.0.0-test' },
      serverUrl: `http://127.0.0.1:${address.port}`, storeDir: path.join(root, 'sdk'),
      ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
      ...(deviceCredentials === undefined ? {} : { deviceCredentials }),
      // The Host's persona hook (#793 S13): it writes the Bot persona of a home projection, so the device applies a task-free
      // projection and advertises `agent-home-projection`.
      agentHome: { hostStorageRoot: path.join(root, 'homes'), projection: createAgentHomeProjectionConsumer(async ({ projection, writeHomeFile }) => {
        await writeHomeFile('AGENTS.md', String((projection as { persona?: unknown }).persona ?? ''));
      }) },
      agentEgress: { policy },
    }, [adapter], options.e2ee === undefined ? { deviceCredentials: new InMemoryDeviceCredentialStore() } : {});
    const { code } = await cloud.createPairingCode(tenant, { productId: PRODUCT_ID });
    const member = options.e2ee === undefined ? undefined : await HostedMember.create(cloud, tenant);
    const { deviceId } = await daemon.pair(code, member === undefined ? undefined : { verificationSecret: member.verificationSecret });
    if (member !== undefined) await member.putScope(options.e2ee!.scopeId, await member.approve(deviceId), options.e2ee!.categories);
    await daemon.start();
    close.unshift(() => daemon.stop());
    await waitForReady(daemon);

    /** The SDK calls of the tenant, as H binds them. */
    const port: FrozenSubmitPort & HostedTaskPort = {
      submit: input => cloud.submitAgentExecution(tenant, input),
      submitSealed: input => cloud.submitSealedAgentExecution(tenant, input),
      offer: taskId => cloud.readTaskOffer(tenant, taskId),
      attempt: taskId => cloud.readTaskAttempt(tenant, taskId),
      deviceTerminal: taskId => cloud.readDeviceTerminal(tenant, taskId),
      cancel: (taskId, reason) => cloud.cancelTask(tenant, taskId, reason),
    };
    /** Read only: the SDK mailbox rows of one offer message. One offer is one row, however many submits resolved. */
    const mailboxRows = async (messageId: string) =>
      Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE message_id = $1', [messageId])).rows[0]!.n);
    return { cloud, tenant, deviceId, adapter, daemon, port, mailboxRows, member, pool, async close() { await shutdown(); } };
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
