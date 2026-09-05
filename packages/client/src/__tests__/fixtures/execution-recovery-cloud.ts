import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import {
  createByokCloud,
  createHmacTokenSigner,
  createWebCrypto,
  fullCapabilityDeclaration,
  tenantId,
  type DeviceDirectory,
  type DeviceRecord,
  type DeviceRegistration,
  type InboundDedupStore,
  type RequestReceipt,
  type RequestReceiptStore,
} from '../../../../cloud/src/index';
import { InMemoryPairingCodeStore } from '../../../../cloud/src/stores/in-memory/pairing-codes';
import { createSqliteEmbeddedStores } from '../../../../server/src/stores/sqlite/index';
import { PRESENCE_LEVELS, type PresenceStore, type TenantId, type TenantReadiness } from '@byok-sdk/core';
import type { AgentRef } from '@byok-sdk/protocol';

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
const embedded = createSqliteEmbeddedStores({ path: config.dbPath }, { clock, crypto });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
db.exec(`
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
`);

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
    return (await this.get(owner, input.deviceId))!;
  }

  async get(owner: TenantId, deviceId: string): Promise<DeviceRecord | undefined> {
    return deviceFromRow(
      db.prepare('SELECT * FROM fixture_device WHERE tenant_id = ? AND device_id = ?').get(owner, deviceId) as
        | Record<string, unknown>
        | undefined,
    );
  }

  async resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    return deviceFromRow(
      db.prepare('SELECT * FROM fixture_device WHERE device_id = ?').get(deviceId) as Record<string, unknown> | undefined,
    );
  }

  async revoke(owner: TenantId, deviceId: string): Promise<void> {
    db.prepare('DELETE FROM fixture_device WHERE tenant_id = ? AND device_id = ?').run(owner, deviceId);
  }

  async list(owner: TenantId): Promise<readonly DeviceRecord[]> {
    return (db.prepare('SELECT * FROM fixture_device WHERE tenant_id = ? ORDER BY device_id').all(owner) as Record<string, unknown>[])
      .map((row) => deviceFromRow(row)!);
  }

  async recordCapabilities(
    owner: TenantId,
    input: { readonly deviceId: string; readonly capabilities: readonly string[] },
  ): Promise<DeviceRecord | undefined> {
    db.prepare('UPDATE fixture_device SET capabilities_json = ? WHERE tenant_id = ? AND device_id = ?')
      .run(JSON.stringify([...input.capabilities]), owner, input.deviceId);
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
  async record(owner: TenantId, input: { readonly key: string; readonly body: string }): Promise<{ receipt: RequestReceipt; created: boolean }> {
    const recordedAt = clock.now().toISOString();
    const result = db.prepare(
      'INSERT OR IGNORE INTO fixture_receipt (tenant_id, receipt_key, body, recorded_at) VALUES (?, ?, ?, ?)',
    ).run(owner, input.key, input.body, recordedAt);
    if (Number(result.changes) === 1 && input.key.endsWith(':terminal') && existsSync(config.receiptFaultFile)) {
      unlinkSync(config.receiptFaultFile);
      writeFileSync(config.receiptFaultReachedFile, 'terminal-receipt-row-committed\n');
      process.kill(process.pid, 'SIGKILL');
    }
    return { receipt: (await this.get(owner, input.key))!, created: Number(result.changes) === 1 };
  }

  async get(owner: TenantId, key: string): Promise<RequestReceipt | undefined> {
    const row = db.prepare('SELECT * FROM fixture_receipt WHERE tenant_id = ? AND receipt_key = ?').get(owner, key) as
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

  private record(scope: string, envelopeId: string): boolean {
    const result = db.prepare('INSERT OR IGNORE INTO fixture_inbound_dedup (scope, envelope_id) VALUES (?, ?)')
      .run(scope, envelopeId);
    return Number(result.changes) === 0;
  }
}

const devices = new SqliteFixtureDevices();
const pairing = new InMemoryPairingCodeStore(clock, devices);
const stores = {
  ...embedded.cloud,
  devices,
  pairingCodes: { issue: pairing.issue.bind(pairing) },
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
  longPollHoldMs: 100,
  longPollIntervalMs: 10,
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
    const response = await cloud.fetch(request);
    if (response.ok && hasTerminal(faultCandidate) && existsSync(config.faultFile)) {
      unlinkSync(config.faultFile);
      writeFileSync(config.faultReachedFile, 'cloud-receipt-committed\n');
      process.kill(process.pid, 'SIGKILL');
    }
    return response;
  },
});

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
      case 'enqueueOffer':
        return cloud.enqueueOffer(tenant, String(params.deviceId), {
          ...(params.taskId === undefined ? {} : { taskId: String(params.taskId) }),
          payload: { instruction: String(params.instruction), policy: { mode: 'auto' }, ...(params.agentRef === undefined ? {} : { agentRef: params.agentRef }) },
        });
      case 'enqueueAgentOffer':
        return cloud.enqueueAgentOffer(tenant, String(params.deviceId), {
          payload: {
            instruction: String(params.instruction),
            policy: { mode: 'auto' },
            agentRef: params.agentRef as { agentId: string; profileRevision: string },
          },
        });
      case 'cancelTask':
        return cloud.cancelTask(tenant, String(params.taskId), params.reason === undefined ? undefined : String(params.reason));
      case 'readTaskAttempt':
        return cloud.readTaskAttempt(tenant, String(params.taskId));
      case 'readTerminalBody':
        return (await cloud.readTerminalReceipt(tenant, String(params.taskId)))?.body;
      case 'readCursor':
        return embedded.core.mailbox.readCursor(tenant, String(params.deviceId));
      case 'close':
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await embedded.close();
        db.close();
        return 'closed';
      default:
        throw new Error(`unknown fixture RPC method ${request.method}`);
    }
  })().then((result) => respond((JSON.parse(line) as RpcRequest).id, result), (error) => respond((JSON.parse(line) as RpcRequest).id, undefined, error));
});

process.stdout.write(`${JSON.stringify({ ready: true, url: `http://127.0.0.1:${config.port}`, tenant })}\n`);
