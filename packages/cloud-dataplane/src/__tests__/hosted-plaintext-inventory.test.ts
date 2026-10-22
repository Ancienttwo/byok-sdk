/**
 * The hosted plaintext inventory (#654 S0-b).
 *
 * One canary text runs through the hosted wire on the real Postgres and S3
 * substrate: pairing (in the device name), task dispatch, progress, an Agent
 * message, a memory projection and result return (with a result document and
 * an artifact blob). Then the test reads every column of every row in every
 * tenant table, every object in the bucket and the console output of the run,
 * and records each place that holds the canary.
 *
 * The table list comes from `pg_class` with the query that tenant erasure
 * runs (`PostgresTenantErasure#assertSchemaInventory` in `tenant-erasure.ts`),
 * not from a constant. A new table is scanned as soon as a migration adds it.
 *
 * The hits must equal `EXPECTED_PLAINTEXT`, and the inventory table in
 * `docs/security.md` must list the same set. A new column that stores content
 * fails this test until both lists name it. When #654 seals a category, its
 * rows leave both lists and the scan stays as it is.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import {
  CLOUD_CAPABILITIES,
  InMemoryAgentMemoryProjectionAuthorizer,
  createByokCloud,
  createHmacTokenSigner,
  createInProcessMailboxWake,
  createWebCrypto,
  fullCapabilityDeclaration,
} from '@byok-sdk/cloud';
import {
  BYOK_AGENT_MEMORY_PROJECTIONS_PATH,
  BYOK_BLOBS_PATH,
  BYOK_EVENTS_PATH,
  BYOK_MESSAGES_PATH,
  EventsPollResponseSchema,
  PROTOCOL_VERSION,
  byokBlobFinalizePath,
  createEnvelope,
  type AgentEgressPolicy,
  type AgentRef,
  type BlobRef,
  type Envelope,
} from '@byok-sdk/protocol';
import { createDeviceSimulator } from '../../../testkit/src/index';
import { migrate } from '../migrate';
import { createPostgresCloudStores } from '../stores';
import { PostgresAgentMemoryProjectionStore } from '../stores/agent-memory-projection';
import { createPostgresCoreStores } from '../stores/core';
import {
  createDataplaneScope,
  createObjectStorageScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
  type ObjectStorageScope,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const SECURITY_DOC = fileURLToPath(new URL('../../../../docs/security.md', import.meta.url));
const INVENTORY_START = '<!-- hosted-plaintext-inventory:start -->';
const INVENTORY_END = '<!-- hosted-plaintext-inventory:end -->';

/**
 * Where the canary lands today: `table.column` for Postgres, `r2:<key pattern>`
 * for an object. The inventory table in `docs/security.md` lists the same set.
 */
const EXPECTED_PLAINTEXT = [
  'activity_tail.entries',
  'agent_memory_projection_head.redacted_snapshot',
  'agent_message_admission.payload_body',
  'agent_message_admission.terminal_body',
  'device.device_name',
  'device_request_receipts.body',
  'outbox.body',
  'r2:tenants/<tenant>/objects/sha256/<hex>',
];

/** The query tenant erasure runs to find every tenant table (`tenant-erasure.ts`). */
const TENANT_TABLES_SQL = `SELECT t.relname
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relkind = 'r'
          AND t.relname NOT IN ('byok_schema_migration', 'tenant_erasure_operation')
        ORDER BY t.relname`;

const TENANT = tenantId('tenant-plaintext-inventory');
const PRODUCT_ID = 'plaintext-inventory';
const ORIGIN = 'https://host.invalid';
const MESSAGE_CONTRACT = 'plaintext-inventory.turn.v1';
const SESSION_REF = 'session-plaintext-inventory';
/** What a daemon that can run fresh, message-egress Agent executions advertises. */
const DEVICE_CAPABILITIES = [
  'agent-home-contract',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-egress-fresh-session',
  'agent-message-egress',
  'terminal-projection-selection',
];
const EGRESS_POLICY: AgentEgressPolicy = {
  policyRevision: 'inventory-policy-1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262_144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4_096, maxPendingBytesPerTenant: 8_192 },
  transfers: {
    workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] },
    transcript: 'disabled',
    artifact: 'disabled',
  },
};

/** No character here needs JSON escaping, so the core survives any number of JSON layers. */
const CANARY_CORE = `byok654canary${randomUUID().replaceAll('-', '')}`;
/** The text each flow carries. The tail makes its JSON-escaped form differ from its UTF-8 form. */
const CANARY = `${CANARY_CORE} "quoted" back\\slash ✓`;

interface Needle {
  readonly form: string;
  readonly text: string;
  readonly bytes: Buffer;
}

/**
 * The base64 text that every encoding of `bytes` contains when they start
 * `offset` bytes after a 3-byte boundary. The characters that also encode a
 * neighbouring byte are dropped at both ends.
 */
function alignedBase64(bytes: Buffer, offset: number, encoding: 'base64' | 'base64url'): string {
  const shifted = Buffer.concat([Buffer.alloc(offset), bytes]);
  return shifted.toString(encoding).slice(offset === 0 ? 0 : 4, Math.floor(shifted.length / 3) * 4);
}

/**
 * The forms the scan looks for. The text forms show how a column keeps the
 * canary. The core and its binary forms also find a copy that was escaped
 * before it was hex- or base64-encoded.
 */
function canaryNeedles(): readonly Needle[] {
  const core = Buffer.from(CANARY_CORE, 'utf8');
  const forms: (readonly [string, string])[] = [
    ['utf-8', CANARY],
    ['json-escaped', JSON.stringify(CANARY).slice(1, -1)],
    ['core', CANARY_CORE],
    ['hex', core.toString('hex')],
  ];
  for (const offset of [0, 1, 2]) {
    forms.push([`base64+${offset}`, alignedBase64(core, offset, 'base64')]);
    forms.push([`base64url+${offset}`, alignedBase64(core, offset, 'base64url')]);
  }
  return forms.map(([form, text]) => ({ form, text, bytes: Buffer.from(text, 'utf8') }));
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

type Hits = Map<string, Set<string>>;

function record(hits: Hits, location: string, value: unknown, needles: readonly Needle[]): void {
  for (const needle of needles) {
    const found = Buffer.isBuffer(value)
      ? value.includes(needle.bytes)
      : typeof value === 'string' && value.includes(needle.text);
    if (!found) continue;
    const forms = hits.get(location) ?? new Set<string>();
    forms.add(needle.form);
    hits.set(location, forms);
  }
}

/** Every column of every tenant table. A `bytea` value is searched as bytes, any other value as its text form. */
async function scanPostgres(pool: Pool, needles: readonly Needle[], hits: Hits): Promise<number> {
  const tables = await pool.query<{ readonly relname: string }>(TENANT_TABLES_SQL);
  for (const { relname: table } of tables.rows) {
    const columns = await pool.query<{ readonly name: string; readonly bytes: boolean }>(
      `SELECT a.attname AS name, a.atttypid = 'bytea'::regtype AS bytes
         FROM pg_attribute a
         JOIN pg_class t ON t.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema() AND t.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [table],
    );
    const select = columns.rows
      .map((column, index) => `${quoteIdent(column.name)}${column.bytes ? '' : '::text'} AS c${index}`)
      .join(', ');
    const rows = await pool.query<Record<string, unknown>>(`SELECT ${select} FROM ${quoteIdent(table)}`);
    for (const row of rows.rows) {
      columns.rows.forEach((column, index) => record(hits, `${table}.${column.name}`, row[`c${index}`], needles));
    }
  }
  return tables.rows.length;
}

/** The key with this run's tenant and the content hash replaced by placeholders. */
function objectLocation(key: string): string {
  const parts = key.split('/');
  if (parts.length === 5 && parts[0] === 'tenants' && parts[1] === TENANT && /^[0-9a-f]{64}$/u.test(parts[4] ?? '')) {
    return `r2:tenants/<tenant>/${parts[2]}/${parts[3]}/<hex>`;
  }
  return `r2:${key}`;
}

/** Every object in the bucket, listed with ListObjectsV2. The bucket is this test's own. */
async function scanObjects(storage: ObjectStorageScope, needles: readonly Needle[], hits: Hits): Promise<number> {
  const bucketUrl = `${storage.config.endpoint}/${storage.bucket}`;
  const keys: string[] = [];
  let continuation: string | undefined;
  do {
    const query = new URLSearchParams({ 'list-type': '2' });
    if (continuation !== undefined) query.set('continuation-token', continuation);
    const listed = await storage.client.fetch(`${bucketUrl}?${query.toString()}`);
    const xml = await listed.text();
    if (!listed.ok) throw new Error(`ListObjectsV2 failed: HTTP ${listed.status} ${xml}`);
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/gu)].map((match) => match[1]!));
    continuation = /<IsTruncated>true<\/IsTruncated>/u.test(xml)
      ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u.exec(xml)?.[1]
      : undefined;
  } while (continuation !== undefined);
  for (const key of keys) {
    const object = await storage.client.fetch(`${bucketUrl}/${key}`);
    if (!object.ok) throw new Error(`GET ${key} failed: HTTP ${object.status}`);
    record(hits, objectLocation(key), Buffer.from(await object.arrayBuffer()), needles);
  }
  return keys.length;
}

/** The first backticked cell of each row between the inventory markers in `docs/security.md`. */
async function documentedPlaintext(): Promise<string[]> {
  const doc = await readFile(SECURITY_DOC, 'utf8');
  const start = doc.indexOf(INVENTORY_START);
  const end = doc.indexOf(INVENTORY_END, start);
  if (start < 0 || end < 0) throw new Error(`docs/security.md has no ${INVENTORY_START} … ${INVENTORY_END} block`);
  return doc
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('`')[1]!);
}

describe.skipIf(SKIP_DATAPLANE)(`hosted plaintext inventory — ${SKIP_REASON}`, () => {
  it('finds the canary in exactly the locations docs/security.md lists', async () => {
    const scope = await createDataplaneScope();
    // What the flow writes to the console is scanned as well.
    const consoleSpies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level));
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const objectStorage = await createObjectStorageScope();
      const clock = createMutableClock();
      const crypto = createWebCrypto();
      const core = createPostgresCoreStores({ pool: scope.pool, clock, objectStorage: objectStorage.config });
      const stores = await createPostgresCloudStores({
        pool: scope.pool,
        clock,
        crypto,
        objectStorage: objectStorage.config,
      });
      const authorizer = new InMemoryAgentMemoryProjectionAuthorizer();
      const consumed: string[] = [];
      const full = fullCapabilityDeclaration(undefined, { includeAgentMemoryProjection: true });
      const cloud = createByokCloud({
        mailboxWake: createInProcessMailboxWake(),
        core,
        cloud: stores,
        crypto,
        tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(7), clock),
        clock,
        capabilities: {
          ...full,
          capabilities: full.capabilities.filter((capability) => capability !== CLOUD_CAPABILITIES.blobsContentProxy),
        },
        agentMessage: {
          consume: async (input) => {
            consumed.push(input.payload.body);
            return { outcome: 'accepted' };
          },
        },
        agentMemoryProjectionAuthorizer: authorizer,
        agentMemoryProjectionStore: new PostgresAgentMemoryProjectionStore({ pool: scope.pool, clock, crypto }),
      });
      await core.quota.writeEntitlement(TENANT, {
        version: 1n,
        hardLimitBytes: 1_000_000_000n,
        maxObjectBytes: 100_000_000n,
        maxInlineBytes: 1_000_000n,
        mailboxLimitBytes: 100_000_000n,
        retentionPolicyId: 'test',
      });

      // Pairing: a real code, redeemed on the device route.
      const sim = await createDeviceSimulator({
        baseUrl: ORIGIN,
        fetch: async (input, init) => cloud.fetch(new Request(input, init)),
        deviceName: `device ${CANARY}`,
      });
      const { code } = await cloud.createPairingCode(TENANT, { productId: PRODUCT_ID });
      const { deviceId, accessToken } = await sim.pair(code);
      const agentRef: AgentRef = { agentId: 'inventory-agent', profileRevision: '1' };
      const taskId = `inventory-task-${randomUUID()}`;
      let cursor = 0;

      async function send(...messages: Envelope[]): Promise<void> {
        const response = await sim.request({ method: 'POST', path: BYOK_MESSAGES_PATH, body: { messages } });
        expect(response.status, response.text).toBe(200);
        expect(response.body, response.text).toMatchObject({ accepted: messages.length });
      }

      async function poll(): Promise<readonly Envelope[]> {
        const response = await sim.request({ method: 'GET', path: `${BYOK_EVENTS_PATH}?cursor=${cursor}` });
        expect(response.status, response.text).toBe(200);
        const page = EventsPollResponseSchema.parse(response.body);
        if (page.events.length > 0) cursor = page.cursor;
        return page.events as Envelope[];
      }

      /** A device route that needs a header the simulator does not send. */
      async function deviceFetch(path: string, init: RequestInit): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${accessToken}`);
        return cloud.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
      }

      await send(
        createEnvelope('conn.hello', {
          protocolVersions: [PROTOCOL_VERSION],
          capabilities: DEVICE_CAPABILITIES,
          deviceId,
          productId: PRODUCT_ID,
        }),
      );

      // Task dispatch: the canary is in the instruction.
      await cloud.submitAgentExecution(TENANT, {
        taskId,
        deviceId,
        payload: {
          instruction: `instruction ${CANARY}`,
          runtime: 'codex',
          agentRef,
          egressPolicy: EGRESS_POLICY,
          terminalProjection: { mode: 'none' },
          messageEgress: { mode: 'required', contract: MESSAGE_CONTRACT, contentType: 'text/markdown', maxBytes: 4_096 },
        },
        agentMessageContext: { destinationBinding: 'conversation/inventory', freshnessCursor: 'turn-1' },
      });
      expect((await poll()).map((event) => [event.type, event.task_id])).toEqual([
        ['task.offer_for_agent_with_egress_fresh', taskId],
      ]);
      await send(createEnvelope('task.claim', { deviceId, agentRef, runtime: 'codex' }, { taskId }));
      await send(createEnvelope('task.started', {}, { taskId }));

      // Progress: the canary is in a progress text and a tool result.
      await send(
        createEnvelope(
          'task.progress',
          {
            seq: 1,
            events: [
              { type: 'progress', text: `progress ${CANARY}` },
              { type: 'tool_result', tool: 'read_file', output: `tool output ${CANARY}` },
            ],
          },
          { taskId },
        ),
      );

      // Agent message: the canary is in the message body.
      const messageBody = `message ${CANARY}`;
      await send(
        createEnvelope(
          'agent.message.publish',
          {
            agentRef,
            sessionRef: SESSION_REF,
            contract: MESSAGE_CONTRACT,
            messageId: randomUUID(),
            cursor: 1,
            contentType: 'text/markdown',
            body: messageBody,
            contentHash: await crypto.sha256(Buffer.from(messageBody, 'utf8')),
            byteCount: Buffer.byteLength(messageBody, 'utf8'),
          },
          { taskId },
        ),
      );
      expect(consumed).toEqual([messageBody]);
      expect((await poll()).map((event) => event.type)).toEqual(['agent.message.disposition']);

      // Memory projection: the canary is in the redacted snapshot.
      const snapshot = Buffer.from(`# Memory\n\n- ${CANARY}\n`, 'utf8');
      const mutation = {
        taskId,
        agentRef,
        sessionRef: SESSION_REF,
        runtimeId: 'codex',
        grantRef: 'grant-inventory',
        writerEpoch: 1,
        policyRevision: EGRESS_POLICY.policyRevision,
      } as const;
      authorizer.grant({ tenantId: TENANT, deviceId, ...mutation });
      const projected = await deviceFetch(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...mutation,
          sourceSeq: 1,
          mutationId: randomUUID(),
          snapshot: {
            redactedHash: await crypto.sha256(snapshot),
            redactedByteCount: snapshot.byteLength,
            redactedBytes: snapshot.toString('base64url'),
          },
        }),
      });
      expect(projected.status, await projected.clone().text()).toBe(200);

      // Result return: an artifact blob, then the terminal with a summary, a
      // final message and a result document. Each carries the canary.
      const artifact = Buffer.from(`artifact ${CANARY}\n`, 'utf8');
      const artifactHash = await crypto.sha256(artifact);
      const reservation = randomUUID();
      const created = await deviceFetch(BYOK_BLOBS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': reservation },
        body: JSON.stringify({ size: artifact.byteLength, contentType: 'text/plain', contentHash: artifactHash }),
      });
      expect(created.status, await created.clone().text()).toBe(200);
      const { blobId, uploadUrl } = (await created.json()) as { blobId: string; uploadUrl: string };
      // The presigned PUT goes straight to the object store, as a device sends it.
      const uploaded = await globalThis.fetch(uploadUrl, {
        method: 'PUT',
        body: artifact,
        headers: { 'content-type': 'text/plain' },
      });
      expect(uploaded.ok, await uploaded.text()).toBe(true);
      const finalized = await deviceFetch(byokBlobFinalizePath(blobId), {
        method: 'POST',
        headers: { 'idempotency-key': reservation },
      });
      expect(finalized.status, await finalized.text()).toBe(204);
      const artifactRef: BlobRef = {
        blobId,
        contentHash: artifactHash,
        size: artifact.byteLength,
        contentType: 'text/plain',
      };

      await send(
        createEnvelope(
          'task.complete',
          {
            agentRef,
            sessionRef: SESSION_REF,
            summary: `summary ${CANARY}`,
            finalMessage: `final ${CANARY}`,
            document: { note: `document ${CANARY}` },
            artifactRefs: [artifactRef],
          },
          { taskId },
        ),
      );
      await expect(cloud.readTaskAttempt(TENANT, taskId)).resolves.toMatchObject({ status: 'complete' });

      const needles = canaryNeedles();
      const hits: Hits = new Map();
      for (const spy of consoleSpies) {
        for (const args of spy.mock.calls) record(hits, 'log:console', format(...args), needles);
      }
      const tables = await scanPostgres(scope.pool, needles, hits);
      const objects = await scanObjects(objectStorage, needles, hits);
      expect(tables).toBeGreaterThan(0);
      expect(objects).toBeGreaterThan(0);

      const found = Object.fromEntries([...hits].map(([location, forms]) => [location, [...forms].sort()]));
      const expected = [...EXPECTED_PLAINTEXT].sort();
      expect(Object.keys(found).sort(), `canary hits and their forms: ${JSON.stringify(found, null, 2)}`)
        .toEqual(expected);
      expect((await documentedPlaintext()).sort(), 'the docs/security.md inventory table').toEqual(expected);
    } finally {
      vi.restoreAllMocks();
      await scope.dispose();
    }
  }, 60_000);
});

describe('canary needles', () => {
  it('find the canary hex-, base64- and base64url-encoded at each byte offset', () => {
    const needles = canaryNeedles();
    for (const offset of [0, 1, 2]) {
      // The core starts `offset` bytes after a 3-byte boundary of the encoded stream.
      const stream = Buffer.concat([randomBytes(3 + offset), Buffer.from(CANARY, 'utf8'), randomBytes(2)]);
      for (const [form, encoded] of [
        ['hex', stream.toString('hex')],
        [`base64+${offset}`, stream.toString('base64')],
        [`base64url+${offset}`, stream.toString('base64url')],
      ] as const) {
        const hits: Hits = new Map();
        record(hits, 'probe', encoded, needles);
        expect([...(hits.get('probe') ?? [])], `${form} at offset ${offset}`).toContain(form);
      }
    }
  });
});
