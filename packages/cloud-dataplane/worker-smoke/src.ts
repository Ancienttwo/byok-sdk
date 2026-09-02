/**
 * The worker-smoke probe entry. Thin on purpose: one route per real data-path
 * family, each driving one store composition the way a host Worker would.
 *
 * The dataplane surface under test is imported ONLY as
 * `@byok-sdk/cloud-dataplane/runtime` — the subpath that must stay free of
 * node builtins. The two `import type` lines below are erased at bundle time;
 * they exist so the fixture typechecks against the same branded contracts the
 * runtime exports, without pulling `@byok-sdk/core` into the runtime graph
 * (which would be harmless — core is Workers-clean — but would blur what this
 * probe is isolating).
 *
 * Migrations are NOT this fixture's business. The database it talks to is
 * expected to already carry `deploy/sql`; the E2E test migrates it from Node
 * before starting `wrangler dev`, which is exactly the composition the README
 * documents: Workers serve, Node migrates.
 */
import {
  createByokPool,
  createPostgresCoreStores,
  PostgresDeviceDirectory,
  PostgresObjectStore,
  PostgresPairingCodeStore,
  PostgresTruthCommitter,
  R2CloudBlobStore,
} from '@byok-sdk/cloud-dataplane/runtime';
import type { PreparedTruthWrite, TruthCommitInput } from '@byok-sdk/cloud';
import type { Clock, ContentHash, StorageReservation, TenantId } from '@byok-sdk/core';

interface Env {
  BYOK_PG: { connectionString: string };
  /**
   * The S3 half of the substrate, passed as wrangler vars by the E2E
   * (vars are the clean runtime path; the Hyperdrive localConnectionString is
   * the one literal wrangler cannot interpolate). Missing vars fail the blob
   * probe with a signpost rather than guessing an endpoint.
   */
  BYOK_S3_ENDPOINT?: string;
  BYOK_S3_BUCKET?: string;
  BYOK_S3_ACCESS_KEY_ID?: string;
  BYOK_S3_SECRET_ACCESS_KEY?: string;
  BYOK_S3_REGION?: string;
}

/** The clock port, read through wall time: this probe asserts storage, not TTLs. */
const clock: Clock = { now: () => new Date() };

/** The one crypto capability the truth committer needs, over WebCrypto. */
const crypto = {
  async sha256(data: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
    return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}` as ContentHash;
  },
};

function tenant(): TenantId {
  // Unique per run: the fixture may run many times against one substrate, and
  // tenant uniqueness is the cheapest full isolation there is.
  return `worker-smoke-${globalThis.crypto.randomUUID()}` as TenantId;
}

/**
 * Reads the identity PostgreSQL assigned to one brand-new Worker pool. The
 * caller closes that pool before responding, so repeated requests prove fresh
 * Hyperdrive sessions rather than one checked-out connection.
 */
async function schemaProbe(connectionString: string) {
  const pool = createByokPool({ connectionString });
  try {
    const result = await pool.query<{
      currentSchema: string;
      currentUser: string;
    }>('SELECT current_schema() AS "currentSchema", current_user AS "currentUser"');
    const row = result.rows[0];
    if (row === undefined) throw new Error('schema probe returned no row');
    return row;
  } finally {
    await pool.end();
  }
}

async function pairingProbe(connectionString: string) {
  const pool = createByokPool({ connectionString });
  try {
    const store = new PostgresPairingCodeStore(pool, clock);
    const devices = new PostgresDeviceDirectory(pool, clock);
    const who = tenant();
    const code = `smoke-${globalThis.crypto.randomUUID()}`;
    await store.issue(who, {
      code,
      productId: 'byok-worker-smoke',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const device = await store.redeemAndRegister({
      pairingCode: code,
      deviceId: `device-${globalThis.crypto.randomUUID()}`,
      deviceName: 'worker pairing probe',
      devicePublicKey: 'worker-pairing-probe-key',
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
    if (device === undefined) throw new Error('pairing enrollment returned no device');
    if ((await devices.get(who, device.deviceId)) === undefined) {
      throw new Error('pairing enrollment did not persist its device');
    }
    return { minted: true, redeemed: device.tenantId === who, productId: device.productId };
  } finally {
    await pool.end();
  }
}

async function mailboxProbe(connectionString: string) {
  const pool = createByokPool({ connectionString });
  try {
    const who = tenant();
    const deviceId = `device-${globalThis.crypto.randomUUID()}`;
    const stores = createPostgresCoreStores({ pool, clock });
    const body = 'worker-smoke-mailbox';
    const appended = await stores.mailbox.append(who, {
      deviceId,
      messageId: `msg-${globalThis.crypto.randomUUID()}`,
      materialize: async () => ({
        body,
        bodyHash: (await crypto.sha256(new TextEncoder().encode(body))) as ContentHash,
        byteSize: BigInt(new TextEncoder().encode(body).byteLength),
      }),
    });
    const page = await stores.mailbox.readAfter(who, { deviceId, afterSeq: 0 });
    await stores.mailbox.recordDelivery(who, {
      deviceId,
      deliveredSeq: page.nextSeq,
    });
    const cursor = await stores.mailbox.advanceCursor(who, {
      deviceId,
      ackedSeq: appended.seq,
    });
    const drained = await stores.mailbox.readAfter(who, { deviceId, afterSeq: 0 });
    return {
      enqueued: appended.seq === page.messages[0]?.seq,
      message: page.messages[0]?.body ?? null,
      acked: cursor.ackedSeq === appended.seq,
      emptyAfterAck: drained.messages.length === 0,
    };
  } finally {
    await pool.end();
  }
}

async function truthProbe(connectionString: string) {
  const pool = createByokPool({ connectionString });
  try {
    const who = tenant();
    const committer = new PostgresTruthCommitter({ pool, clock, crypto });
    // The committer's inline accounting reads the tenant's entitlement, so the
    // probe seeds one through the same core-store composition a host would.
    const stores = createPostgresCoreStores({ pool, clock });
    await stores.quota.writeEntitlement(who, {
      version: 1n,
      hardLimitBytes: 10_000n,
      maxObjectBytes: 5_000n,
      maxInlineBytes: 1_000n,
      mailboxLimitBytes: 1_000n,
      retentionPolicyId: 'default',
    });

    const terminal = 'worker-smoke-terminal';
    const bytes = new TextEncoder().encode(terminal);
    const write: PreparedTruthWrite = {
      kind: 'task.terminal',
      recordKey: `task-${globalThis.crypto.randomUUID()}`,
      contentHash: (await crypto.sha256(bytes)) as ContentHash,
      byteSize: BigInt(bytes.byteLength),
      body: { kind: 'inline', body: terminal },
    };
    const input: TruthCommitInput = {
      deviceId: 'device-smoke',
      requestId: `req-${globalThis.crypto.randomUUID()}`,
      operation: 'truth.write',
      resource: `task.terminal/${write.recordKey}`,
      proofBodySha256: (await crypto.sha256(bytes)) as ContentHash,
      proofBodySize: 100n,
      writes: [write],
    };
    const committed = await committer.commit(who, input);
    const record = await committer.getRecord(who, {
      kind: 'task.terminal',
      recordKey: write.recordKey,
    });
    return {
      replayed: committed.replayed,
      committedRev: committed.response.primary.rev,
      readBack:
        record !== undefined && record.contentHash === write.contentHash && record.rev === 1,
    };
  } finally {
    await pool.end();
  }
}

/** The S3 half of the substrate, or a signpost naming what is missing. */
function requireS3Config(env: Env) {
  const missing = [
    'BYOK_S3_ENDPOINT',
    'BYOK_S3_BUCKET',
    'BYOK_S3_ACCESS_KEY_ID',
    'BYOK_S3_SECRET_ACCESS_KEY',
    'BYOK_S3_REGION',
  ].filter((name) => {
    const value = (env as unknown as Record<string, string | undefined>)[name];
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `blob probe is missing wrangler vars: ${missing.join(', ')}. The E2E passes them from the ` +
        `substrate law (docker compose -f docker-compose.test.yml up -d --wait; ` +
        `export BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100). A Worker cannot guess where its bytes live.`,
    );
  }
  return {
    endpoint: env.BYOK_S3_ENDPOINT!,
    bucket: env.BYOK_S3_BUCKET!,
    accessKeyId: env.BYOK_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.BYOK_S3_SECRET_ACCESS_KEY!,
    region: env.BYOK_S3_REGION!,
  };
}

/**
 * The blob store wired exactly as `createPostgresCloudStores` wires it: the
 * R2 adapter over a `PostgresObjectStore` on the same pool. The manifest's
 * clock is logical like every other store's; only the signature reads wall
 * time, which is why `signingClock` gets the wall clock.
 */
function blobStore(pool: ReturnType<typeof createByokPool>, env: Env) {
  const s3 = requireS3Config(env);
  return new R2CloudBlobStore({
    ...s3,
    objects: new PostgresObjectStore(pool, clock),
    signingClock: clock,
  });
}

/**
 * Stage 1 of the blob probe: reserve a grant and presign the upload — the
 * aws4fetch signing and manifest write happen INSIDE the Worker. The PUT
 * itself belongs to the caller (that is the device-side upload in the real
 * topology); this stage hands back the exact bytes and the grant to send
 * them with.
 */
async function blobGrantProbe(env: Env) {
  const pool = createByokPool({ connectionString: env.BYOK_PG.connectionString });
  try {
    const who = tenant();
    const payload = JSON.stringify({
      probe: 'worker-smoke-blob',
      run: globalThis.crypto.randomUUID(),
    });
    const bytes = new TextEncoder().encode(payload);
    const contentType = 'application/json';
    const reservation: StorageReservation = {
      tenantId: who,
      reservationId: `worker-smoke-${globalThis.crypto.randomUUID()}`,
      state: 'reserved',
      kind: 'object',
      expectedBytes: BigInt(bytes.byteLength),
      contentHash: (await crypto.sha256(bytes)) as ContentHash,
      contentType,
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    const grant = await blobStore(pool, env).createUpload(who, reservation);
    // JSON-safe echo of the reservation (bigint cannot cross Response.json);
    // stage 2 parses `expectedBytes` back before reusing it.
    return {
      blobId: grant.blobId,
      uploadUrl: grant.uploadUrl,
      payload,
      contentType,
      byteSize: bytes.byteLength,
      reservation: { ...reservation, expectedBytes: reservation.expectedBytes.toString() },
    };
  } finally {
    await pool.end();
  }
}

/**
 * Stage 2, after the caller uploaded the exact bytes to the presigned URL:
 * observe (the Worker-side signed HEAD against the object store) and commit
 * the manifest row, then report the state the database actually holds.
 */
async function blobVerifyProbe(env: Env, stage1: { blobId: string; payload: string } & Record<string, unknown>) {
  const pool = createByokPool({ connectionString: env.BYOK_PG.connectionString });
  try {
    const reservation = {
      ...(stage1.reservation as StorageReservation & { expectedBytes: string }),
      expectedBytes: BigInt((stage1.reservation as StorageReservation & { expectedBytes: string }).expectedBytes),
    };
    const bytes = new TextEncoder().encode(stage1.payload);
    const hash = (await crypto.sha256(bytes)) as ContentHash;
    // The bytes PUT'd must be the bytes the grant signed, or the observation
    // below answers about an object this probe did not create.
    if (hash !== stage1.blobId || reservation.contentHash !== stage1.blobId) {
      throw new Error('blob verify payload does not hash to the granted blobId');
    }
    const objects = new PostgresObjectStore(pool, clock);
    const observed = await blobStore(pool, env).observeUpload(
      reservation.tenantId,
      stage1.blobId,
      reservation,
    );
    if (observed === undefined) throw new Error('observeUpload found nothing at the object key');
    await objects.commit(reservation.tenantId, { hash, ...observed });
    const entry = await objects.get(reservation.tenantId, hash);
    return {
      observedByteSize: Number(observed.observedByteSize),
      observedContentType: observed.observedContentType,
      manifestState: entry?.state ?? 'missing',
      manifestByteSize: entry === undefined ? null : Number(entry.byteSize),
    };
  } finally {
    await pool.end();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, '');
    try {
      const probe =
        route === '/probe/pairing'
          ? await pairingProbe(env.BYOK_PG.connectionString)
          : route === '/probe/mailbox'
            ? await mailboxProbe(env.BYOK_PG.connectionString)
            : route === '/probe/truth'
              ? await truthProbe(env.BYOK_PG.connectionString)
              : route === '/probe/blob' && request.method === 'POST'
                ? await blobGrantProbe(env)
                : route === '/probe/blob/verify' && request.method === 'POST'
                  ? await blobVerifyProbe(
                      env,
                      (await request.json()) as { blobId: string; payload: string } &
                        Record<string, unknown>,
                    )
                  : route === '/probe/schema'
                    ? await schemaProbe(env.BYOK_PG.connectionString)
                    : null;
      if (probe === null) {
        return new Response(
          'routes: GET /probe/schema /probe/pairing /probe/mailbox /probe/truth, POST /probe/blob /probe/blob/verify\n',
          { status: 404 },
        );
      }
      return Response.json({ ok: true, probe });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies { fetch(request: Request, env: Env): Promise<Response> };
