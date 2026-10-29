import { createInProcessMailboxWake } from '../../../../cloud/src/index';
import { appendFileSync, existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../../daemon/agent-egress-policy';
import { createInterface } from 'node:readline';
import type { Server as HttpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import {
  AgentExecutionInputSchema,
  createByokCloud,
  createHmacTokenSigner,
  createWebCrypto,
  fullCapabilityDeclaration,
  REQUEST_RECEIPT_PREFIXES,
  tenantId,
  type DeviceDirectory,
  type DeviceRecord,
  type DeviceRegistration,
  type InboundDedupStore,
  type ReceiptCollectExpiredInput,
  type RequestReceipt,
  type RequestReceiptStore,
} from '../../../../cloud/src/index';
import { InMemoryPairingCodeStore } from '../../../../cloud/src/stores/in-memory/pairing-codes';
import { createSqliteEmbeddedStores } from '../../../../server/src/stores/sqlite/index';
import { assertCanonicalTimestamp, assertCollectExpiredInput, PRESENCE_LEVELS, type CollectExpiredResult, type PresenceStore, type TenantId, type TenantReadiness } from '@byok-sdk/core';
import { AGENT_EGRESS_FRESH_SESSION_CAPABILITY, type AgentRef } from '@byok-sdk/protocol';

interface Config {
  readonly dbPath: string;
  readonly port: number;
  readonly productId: string;
  readonly tokenSecret: string;
  readonly faultFile: string;
  readonly faultReachedFile: string;
  readonly receiptFaultFile: string;
  readonly receiptFaultReachedFile: string;
}

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Config;
const clock = { now: () => new Date() };
const crypto = createWebCrypto();
const tenant = tenantId('tenant-execution-recovery');
// Capture the actual owner only during synchronous construction. A second
// connection cannot inspect or write this EXCLUSIVE database while it is live.
async function createFixtureStores() {
  const prepare = DatabaseSync.prototype.prepare;
  const handles = new Set<DatabaseSync>();
  let stores;
  try {
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      handles.add(this);
      return prepare.call(this, sql);
    };
    stores = createSqliteEmbeddedStores({ path: config.dbPath }, { clock, crypto });
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  try {
    const expected = realpathSync(config.dbPath);
    const matches = [...handles].filter((handle) => {
      if (handle.isTransaction !== false) throw new Error('fixture capture observed an open transaction');
      const main = prepare.call(handle, 'PRAGMA database_list').all().find((row) => row.name === 'main');
      return main?.file && realpathSync(String(main.file)) === expected;
    });
    if (matches.length !== 1) throw new Error(`fixture requires exactly one SQLite owner; captured ${matches.length}`);
    return { embedded: stores, db: matches[0]! };
  } catch (error) {
    await stores.close();
    throw error;
  }
}

const { embedded, db } = await createFixtureStores();

// The coordinator awaits inside transactions, even for synchronous callbacks.
// Wait outside that transaction, then do the entire fixture operation without
// yielding so a bare INSERT really autocommits before a receipt SIGKILL.
// Reads use the same guard to observe committed state and leave no iterator open.
async function ownerWrite<T>(operation: () => T): Promise<T> {
  const deadline = performance.now() + 2_000;
  for (;;) {
    if (!db.isOpen) throw new Error('fixture SQLite owner is closed');
    if (typeof db.isTransaction !== 'boolean') throw new Error('fixture SQLite transaction state is unavailable');
    if (!db.isTransaction) return operation();
    if (performance.now() >= deadline) throw new Error('fixture SQLite owner transaction did not finish within 2 seconds');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

await ownerWrite(() => db.exec(`
  CREATE TABLE IF NOT EXISTS fixture_message (task_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS fixture_wire (body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS fixture_device (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    device_public_key TEXT NOT NULL,
    proof_key_id TEXT NOT NULL,
    proof_key_epoch INTEGER NOT NULL,
    machine_id TEXT,
    capabilities_json TEXT,
    PRIMARY KEY (tenant_id, device_id),
    UNIQUE (device_id)
  );
  CREATE TABLE IF NOT EXISTS fixture_receipt (
    tenant_id TEXT NOT NULL,
    receipt_key TEXT NOT NULL,
    body TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, receipt_key)
  );
  CREATE TABLE IF NOT EXISTS fixture_inbound_dedup (
    scope TEXT NOT NULL,
    envelope_id TEXT NOT NULL,
    PRIMARY KEY (scope, envelope_id)
  );
`));

function deviceFromRow(row: Record<string, unknown> | undefined): DeviceRecord | undefined {
  if (row === undefined) return undefined;
  const capabilities = row.capabilities_json === null ? undefined : JSON.parse(String(row.capabilities_json));
  return {
    tenantId: String(row.tenant_id) as TenantId,
    productId: String(row.product_id),
    deviceId: String(row.device_id),
    deviceName: String(row.device_name),
    devicePublicKey: String(row.device_public_key),
    proofKeyId: String(row.proof_key_id),
    proofKeyEpoch: Number(row.proof_key_epoch),
    revoked: false,
    ...(row.machine_id === null ? {} : { machineId: String(row.machine_id) }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

class SqliteFixtureDevices implements DeviceDirectory {
  async register(owner: TenantId, input: DeviceRegistration): Promise<DeviceRecord> {
    await ownerWrite(() => {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (input.machineId !== undefined) {
          db.prepare(
            'DELETE FROM fixture_device WHERE tenant_id = ? AND product_id = ? AND machine_id = ? AND device_id <> ?',
          ).run(owner, input.productId, input.machineId, input.deviceId);
        }
        db.prepare(
          `INSERT INTO fixture_device
             (tenant_id, product_id, device_id, device_name, device_public_key, proof_key_id, proof_key_epoch, machine_id, capabilities_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (tenant_id, device_id) DO UPDATE SET
             product_id = excluded.product_id, device_name = excluded.device_name,
             device_public_key = excluded.device_public_key, proof_key_id = excluded.proof_key_id,
             proof_key_epoch = excluded.proof_key_epoch, machine_id = excluded.machine_id,
             capabilities_json = NULL`,
        ).run(
          owner,
          input.productId,
          input.deviceId,
          input.deviceName,
          input.devicePublicKey,
          input.proofKeyId,
          input.proofKeyEpoch,
          input.machineId ?? null,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    return (await this.get(owner, input.deviceId))!;
  }

  async get(owner: TenantId, deviceId: string): Promise<DeviceRecord | undefined> {
    return ownerWrite(() => deviceFromRow(
      db.prepare('SELECT * FROM fixture_device WHERE tenant_id = ? AND device_id = ?').get(owner, deviceId) as
        | Record<string, unknown>
        | undefined,
    ));
  }

  async resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    return ownerWrite(() => deviceFromRow(
      db.prepare('SELECT * FROM fixture_device WHERE device_id = ?').get(deviceId) as Record<string, unknown> | undefined,
    ));
  }

  async revoke(owner: TenantId, deviceId: string): Promise<void> {
    await ownerWrite(() => db.prepare('DELETE FROM fixture_device WHERE tenant_id = ? AND device_id = ?').run(owner, deviceId));
  }

  async list(owner: TenantId): Promise<readonly DeviceRecord[]> {
    return ownerWrite(() => (db.prepare('SELECT * FROM fixture_device WHERE tenant_id = ? ORDER BY device_id').all(owner) as Record<string, unknown>[])
      .map((row) => deviceFromRow(row)!));
  }

  async recordCapabilities(
    owner: TenantId,
    input: { readonly deviceId: string; readonly capabilities: readonly string[] },
  ): Promise<DeviceRecord | undefined> {
    await ownerWrite(() => db.prepare('UPDATE fixture_device SET capabilities_json = ? WHERE tenant_id = ? AND device_id = ?')
      .run(JSON.stringify([...input.capabilities]), owner, input.deviceId));
    return this.get(owner, input.deviceId);
  }

  async readiness(owner: TenantId, presence: PresenceStore): Promise<TenantReadiness> {
    const devices = await this.list(owner);
    const hints = await presence.list(owner);
    const live = new Map(hints.map((hint) => [hint.deviceId, hint]));
    const observedPresenceByLevel = Object.fromEntries(PRESENCE_LEVELS.map((level) => [level, 0])) as Record<
      (typeof PRESENCE_LEVELS)[number],
      number
    >;
    for (const hint of hints) observedPresenceByLevel[hint.level] += 1;
    return {
      tenantId: owner,
      activePairedDeviceCount: devices.length,
      revokedDeviceCount: 0,
      observedPresenceCount: hints.length,
      observedPresenceByLevel,
      devices: devices.map((device) => {
        const hint = live.get(device.deviceId);
        return {
          deviceId: device.deviceId,
          productId: device.productId,
          deviceName: device.deviceName,
          revoked: false,
          ...(hint === undefined
            ? {}
            : {
                presence: {
                  level: hint.level,
                  ...(hint.detail === undefined ? {} : { detail: hint.detail }),
                  observedAt: hint.observedAt,
                  expiresAt: hint.expiresAt,
                },
              }),
        };
      }),
    };
  }
}

class SqliteFixtureReceipts implements RequestReceiptStore {
  async collectExpired(owner: TenantId, input: ReceiptCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.requestBefore, 'requestBefore');
    return ownerWrite(() => {
      if (REQUEST_RECEIPT_PREFIXES.length === 0) return { removed: 0, expired: 0, releasedBytes: 0n, more: false };
      const predicate = REQUEST_RECEIPT_PREFIXES.map(() => 'substr(receipt_key, 1, length(?)) = ?').join(' OR ');
      const parameters = REQUEST_RECEIPT_PREFIXES.flatMap(prefix => [prefix, prefix]);
      db.exec('BEGIN IMMEDIATE');
      try {
        const removed = Number(db.prepare(`DELETE FROM fixture_receipt WHERE rowid IN
          (SELECT rowid FROM fixture_receipt WHERE tenant_id = ? AND recorded_at < ? AND (${predicate}) ORDER BY recorded_at, receipt_key LIMIT ?)`)
          .run(owner, input.requestBefore, ...parameters, input.limit).changes);
        const more = db.prepare(`SELECT 1 FROM fixture_receipt WHERE tenant_id = ? AND recorded_at < ? AND (${predicate}) LIMIT 1`)
          .get(owner, input.requestBefore, ...parameters) !== undefined;
        db.exec('COMMIT');
        return { removed, expired: 0, releasedBytes: 0n, more };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async record(owner: TenantId, input: { readonly key: string; readonly body: string }): Promise<{ receipt: RequestReceipt; created: boolean }> {
    const recordedAt = clock.now().toISOString();
    const result = await ownerWrite(() => {
      const inserted = db.prepare(
        'INSERT OR IGNORE INTO fixture_receipt (tenant_id, receipt_key, body, recorded_at) VALUES (?, ?, ?, ?)',
      ).run(owner, input.key, input.body, recordedAt);
      if (Number(inserted.changes) === 1 && input.key.endsWith(':terminal') && existsSync(config.receiptFaultFile)) {
        unlinkSync(config.receiptFaultFile);
        writeFileSync(config.receiptFaultReachedFile, 'terminal-receipt-row-committed\n');
        process.kill(process.pid, 'SIGKILL');
      }
      return inserted;
    });
    return { receipt: (await this.get(owner, input.key))!, created: Number(result.changes) === 1 };
  }

  async get(owner: TenantId, key: string): Promise<RequestReceipt | undefined> {
    const row = await ownerWrite(() => db.prepare('SELECT * FROM fixture_receipt WHERE tenant_id = ? AND receipt_key = ?').get(owner, key)) as
      | Record<string, unknown>
      | undefined;
    return row === undefined
      ? undefined
      : { tenantId: owner, key, body: String(row.body), recordedAt: String(row.recorded_at) };
  }
}

class SqliteFixtureDedup implements InboundDedupStore {
  async checkAndRecord(owner: TenantId, deviceId: string, envelopeId: string): Promise<boolean> {
    return this.record(`${owner}\0${deviceId}`, envelopeId);
  }

  async checkAndRecordAgent(owner: TenantId, deviceId: string, ref: AgentRef, envelopeId: string): Promise<boolean> {
    return this.record(`${owner}\0${deviceId}\0${ref.agentId}\0${ref.profileRevision}`, envelopeId);
  }

  private record(scope: string, envelopeId: string): Promise<boolean> {
    return ownerWrite(() => {
      const result = db.prepare('INSERT OR IGNORE INTO fixture_inbound_dedup (scope, envelope_id) VALUES (?, ?)')
        .run(scope, envelopeId);
      return Number(result.changes) === 0;
    });
  }
}

const devices = new SqliteFixtureDevices();
const pairing = new InMemoryPairingCodeStore(clock, devices);
const stores = {
  ...embedded.cloud,
  devices,
  pairingCodes: { issue: pairing.issue.bind(pairing), collectExpired: pairing.collectExpired.bind(pairing) },
  pairing: { redeemAndRegister: pairing.redeemAndRegister.bind(pairing) },
  receipts: new SqliteFixtureReceipts(),
  dedup: new SqliteFixtureDedup(),
};
const tokenSecret = new TextEncoder().encode(config.tokenSecret);
if (tokenSecret.byteLength !== 32) throw new Error('fixture tokenSecret must encode to exactly 32 bytes');
const cloud = createByokCloud({
  core: embedded.core,
  cloud: stores,
  blobContentProxy: embedded.blobContentProxy,
  crypto,
  tokenSigner: createHmacTokenSigner(tokenSecret, clock),
  clock,
  capabilities: fullCapabilityDeclaration(),
  instanceProductId: config.productId,
  agentMessage: { consume: async ({ taskId, payload }) => {
    await ownerWrite(() => db.prepare('INSERT OR IGNORE INTO fixture_message (task_id, payload) VALUES (?, ?)').run(taskId, JSON.stringify(payload)));
    return { outcome: 'accepted' };
  } },
  longPollHoldMs: 100,
  mailboxWake: createInProcessMailboxWake({ fallbackMs: 10 }),
});
await embedded.core.quota.writeEntitlement(tenant, {
  version: 1n,
  hardLimitBytes: 1_000_000_000n,
  maxObjectBytes: 100_000_000n,
  maxInlineBytes: 1_000_000n,
  mailboxLimitBytes: 100_000_000n,
  retentionPolicyId: 'fixture',
});

function hasTerminal(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.some((message) => {
    if (typeof message !== 'object' || message === null) return false;
    return ['task.complete', 'task.fail', 'task.cancelled', 'task.decline'].includes(String((message as { type?: unknown }).type));
  });
}

const httpServer = serve({
  hostname: '127.0.0.1',
  port: config.port,
  fetch: async (request: Request) => {
    const faultCandidate = request.method === 'POST' && new URL(request.url).pathname === '/byok/messages'
      ? await request.clone().json().catch(() => undefined)
      : undefined;
    if (faultCandidate !== undefined) {
      const messages = (faultCandidate as { messages?: Array<{ type: string; payload: unknown }> }).messages ?? [];
      const publishAt = messages.findIndex((message) => message.type === 'agent.message.publish');
      if (publishAt >= 0 && existsSync(`${config.dbPath}.message-outage`)) {
        appendFileSync(`${config.dbPath}.message-blocked-batches`, `${JSON.stringify(messages.map((message) => message.type))}\n`);
        // The cloud applies a batch in order and never rolls back (handlers/messages.ts),
        // so an outage at the publish leaves the envelopes before it committed.
        // No test arms the terminal fault below together with this outage.
        if (publishAt > 0) {
          const prefix = messages.slice(0, publishAt);
          const headers = new Headers(request.headers);
          headers.delete('content-length');
          await ownerWrite(() => db.prepare('INSERT INTO fixture_wire (body) VALUES (?)').run(JSON.stringify(prefix)));
          const committed = await cloud.fetch(new Request(request.url, {
            method: 'POST', headers, body: JSON.stringify({ ...(faultCandidate as object), messages: prefix }),
          }));
          if (!committed.ok) return committed;
        }
        writeFileSync(`${config.dbPath}.message-blocked`, JSON.stringify(messages[publishAt]!.payload));
        return new Response('message admission unavailable', { status: 503 });
      }
      await ownerWrite(() => db.prepare('INSERT INTO fixture_wire (body) VALUES (?)').run(JSON.stringify(messages)));
      // A slow claim reply lets the envelopes queued behind it leave together.
      if (messages.some((message) => message.type === 'task.claim') && existsSync(`${config.dbPath}.claim-delay`)) {
        await new Promise((resolve) => setTimeout(resolve, Number(readFileSync(`${config.dbPath}.claim-delay`, 'utf8'))));
      }
    }
    const response = await cloud.fetch(request);
    if (response.ok && hasTerminal(faultCandidate) && existsSync(config.faultFile)) {
      unlinkSync(config.faultFile);
      writeFileSync(config.faultReachedFile, 'cloud-receipt-committed\n');
      process.kill(process.pid, 'SIGKILL');
    }
    return response;
  },
}, (info) => {
  process.stdout.write(`${JSON.stringify({ ready: true, url: `http://127.0.0.1:${info.port}`, tenant })}\n`);
}) as HttpServer;

/** Fresh Agent admission reads the capability snapshot the daemon's long-poll `conn.hello` records. */
async function waitForAgentEgressCapabilities(deviceId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const device = (await cloud.listDevices(tenant)).find((candidate) => candidate.deviceId === deviceId);
    if (device?.capabilities?.includes(AGENT_EGRESS_FRESH_SESSION_CAPABILITY)) return;
    if (Date.now() >= deadline) throw new Error(`device ${deviceId} never advertised ${AGENT_EGRESS_FRESH_SESSION_CAPABILITY}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function respond(id: number, result?: unknown, error?: unknown): void {
  process.stdout.write(`${JSON.stringify(error === undefined ? { id, result } : { id, error: String(error) })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  void (async () => {
    const request = JSON.parse(line) as RpcRequest;
    const params = request.params ?? {};
    switch (request.method) {
      case 'createPairingCode':
        return cloud.createPairingCode(tenant, { productId: config.productId });
      case 'enqueueFreshOffer':
        // Fresh Agent execution has one entry (#470/#484): submitAgentExecution.
        // Without an agentRef each offer runs as its own Agent, so no two tasks share a home.
        await waitForAgentEgressCapabilities(String(params.deviceId));
        return cloud.submitAgentExecution(tenant, AgentExecutionInputSchema.parse({
          taskId: params.taskId ?? globalThis.crypto.randomUUID(),
          deviceId: params.deviceId,
          payload: {
            instruction: String(params.instruction), runtime: 'pi',
            agentRef: params.agentRef ?? { agentId: `recovery-${globalThis.crypto.randomUUID()}`, profileRevision: '1' },
            session: { mode: 'fresh' },
            egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
            terminalProjection: { mode: 'none' },
          },
        }));
      case 'enqueueMessageOffer':
        return cloud.submitAgentExecution(tenant, AgentExecutionInputSchema.parse({
          taskId: params.taskId,
          deviceId: params.deviceId,
          agentMessageContext: { destinationBinding: 'fixture-conversation', freshnessCursor: 'fixture-turn' },
          payload: {
            instruction: 'publish durable reply', runtime: 'pi',
            agentRef: { agentId: 'agent-message', profileRevision: 'profile-v1' },
            session: { mode: 'fresh' },
            egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
            messageEgress: { mode: 'required', contract: 'fixture.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
            terminalProjection: { mode: 'none' },
          },
        }));
      case 'enqueueResultOffer':
        // Wire v3 result-document offer: the frozen schema rides in the offer.
        return cloud.submitAgentExecution(tenant, AgentExecutionInputSchema.parse({
          taskId: params.taskId,
          deviceId: params.deviceId,
          payload: {
            instruction: 'submit one structured result', runtime: 'pi',
            agentRef: { agentId: 'agent-result', profileRevision: 'profile-v1' },
            session: { mode: 'fresh' },
            egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
            terminalProjection: { mode: 'result-document', contract: 'fixture.result.v1', schema: {
              type: 'object', additionalProperties: false, required: ['verdict'],
              properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, score: { type: 'integer', minimum: 0 } },
            } },
          },
        }));
      case 'readMessages':
        return ownerWrite(() => db.prepare('SELECT * FROM fixture_message').all());
      case 'readWire':
        return ownerWrite(() => db.prepare('SELECT body FROM fixture_wire').all().flatMap((row) => JSON.parse(String(row.body))));
      case 'cancelTask':
        return cloud.cancelTask(tenant, String(params.taskId), params.reason === undefined ? undefined : String(params.reason));
      case 'readTaskAttempt':
        return cloud.readTaskAttempt(tenant, String(params.taskId));
      case 'readTerminalBody':
        return (await cloud.readTerminalReceipt(tenant, String(params.taskId)))?.body;
      case 'readCursor':
        return embedded.core.mailbox.readCursor(tenant, String(params.deviceId));
      case 'close':
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          // The live daemon can keep a polling connection open after listener shutdown.
          httpServer.closeAllConnections();
        });
        await embedded.close();
        lines.close();
        return 'closed';
      default:
        throw new Error(`unknown fixture RPC method ${request.method}`);
    }
  })().then((result) => respond((JSON.parse(line) as RpcRequest).id, result), (error) => respond((JSON.parse(line) as RpcRequest).id, undefined, error));
});
