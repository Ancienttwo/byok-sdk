/**
 * The redaction probe Worker (#654 E5a): `ByokCloud.redactTasks` under local
 * workerd, over Hyperdrive and the `@byok-sdk/cloud-dataplane/runtime` stores.
 *
 * Node writes the tasks and scans the result; this Worker only redacts. Each
 * invocation composes its own pool, as the package README prescribes for
 * Workers, and ends it before it returns.
 */
import {
  CLOUD_CAPABILITIES,
  createByokCloud,
  createHmacTokenSigner,
  createInProcessMailboxWake,
  createWebCrypto,
  fullCapabilityDeclaration,
  tenantId,
} from '@byok-sdk/cloud';
import {
  createByokPool,
  createPostgresCloudStores,
  createPostgresCoreStores,
  createPostgresTaskRedactionStore,
} from '@byok-sdk/cloud-dataplane/runtime';
import type { Clock } from '@byok-sdk/core';

interface Env {
  readonly BYOK_PG: { readonly connectionString: string };
  readonly BYOK_S3_ENDPOINT: string;
  readonly BYOK_S3_BUCKET: string;
  readonly BYOK_S3_ACCESS_KEY_ID: string;
  readonly BYOK_S3_SECRET_ACCESS_KEY: string;
  readonly BYOK_S3_REGION: string;
}

const clock: Clock = { now: () => new Date() };
const crypto = createWebCrypto();

async function redact(env: Env, body: { readonly tenant: string; readonly taskIds: readonly string[] }): Promise<Response> {
  const pool = createByokPool({ connectionString: env.BYOK_PG.connectionString });
  try {
    const objectStorage = {
      endpoint: env.BYOK_S3_ENDPOINT,
      bucket: env.BYOK_S3_BUCKET,
      accessKeyId: env.BYOK_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BYOK_S3_SECRET_ACCESS_KEY,
      region: env.BYOK_S3_REGION,
      signingClock: clock,
    };
    const full = fullCapabilityDeclaration();
    const cloud = createByokCloud({
      mailboxWake: createInProcessMailboxWake({ fallbackMs: 1_000 }),
      core: createPostgresCoreStores({ pool, clock, objectStorage }),
      cloud: await createPostgresCloudStores({ rateLimit: { tokensPerSecond: 1_000, burst: 1_000 }, pool, clock, crypto, objectStorage }),
      crypto,
      // No route here verifies a token; a fixed key is enough.
      tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(1), clock),
      clock,
      capabilities: {
        ...full,
        capabilities: full.capabilities.filter((capability) => capability !== CLOUD_CAPABILITIES.blobsContentProxy),
      },
      taskRedactionStore: createPostgresTaskRedactionStore({ pool, clock, objectStorage }),
    });
    return Response.json(await cloud.redactTasks(tenantId(body.tenant), { taskIds: body.taskIds }));
  } finally {
    await pool.end();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/redact' && request.method === 'POST') {
      try {
        return await redact(env, (await request.json()) as { tenant: string; taskIds: string[] });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }
    return new Response('routes: POST /redact {tenant, taskIds}\n', { status: 404 });
  },
} satisfies { fetch(request: Request, env: Env): Promise<Response> };
