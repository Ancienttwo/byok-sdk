/**
 * The local substrate of the Worker Host suites: Postgres and the S3 endpoint of `docker-compose.test.yml`, `wrangler dev`
 * (local workerd) serving `src/worker.ts`, and device processes.
 *
 * Node migrates and provisions; the Worker serves. Each run gets its own Postgres role, whose `search_path` is the run's SDK
 * schema, plus the H schema and the `host_scope` schema, all owned by that role. The Worker reaches Postgres through the
 * Hyperdrive binding's local connection string, as that role.
 */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPostgresCoreStores, createByokPool, migrate, migrationsDir } from '@byok-sdk/cloud-dataplane';
import { tenantId } from '@byok-sdk/cloud';
import { HostedCollaborationStore, type HostConfig } from '@byok-sdk/example-hosted-bot-collaboration/src/index';
import type { Principal } from '@byok-sdk/example-bot-collaboration/channel';
import { seedCollaboration } from '@byok-sdk/example-bot-collaboration/test-support';
import { taskId } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { storedKey } from '@byok-sdk/example-hosted-bot-collaboration/src/layout';
import { hostScopeDdl, sha256Hex, writeHostScope } from './host-scopes';
import type { ChildMessage, ParentMessage } from './device.child';
import type { PassReport } from './worker';

const OPT_IN_ENV = 'BYOK_TEST_WORKER_DATAPLANE';
const REQUIRE_ENV = 'BYOK_REQUIRE_WORKER_DATAPLANE';
export const POSTGRES_URL = process.env.BYOK_TEST_POSTGRES_URL || undefined;
export const S3_ENDPOINT = process.env.BYOK_TEST_S3_ENDPOINT || undefined;
/** The suites run only when opted in with the substrate up. CI's dataplane job sets the REQUIRE flag, so a skip fails there. */
export const RUN = process.env[OPT_IN_ENV] === '1' && POSTGRES_URL !== undefined && S3_ENDPOINT !== undefined;
if (process.env[REQUIRE_ENV] === '1' && !RUN) {
  throw new Error(`${REQUIRE_ENV}=1 but the Worker Host gate is unmet. To run it:\n`
    + `  export ${OPT_IN_ENV}=1\n  docker compose -f docker-compose.test.yml up -d --wait\n`
    + '  export BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test\n  export BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100');
}

const EXAMPLE_DIR = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_CONFIG = fileURLToPath(new URL('./wrangler.json', import.meta.url));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The run's database objects: one role and three schemas. `pool` is the role's own pool, for Node-side reads and writes. */
export interface Substrate {
  readonly connectionString: string;
  readonly pool: pg.Pool;
  readonly sdkSchema: string;
  readonly hSchema: string;
  readonly hostSchema: string;
  readonly store: HostedCollaborationStore;
  /** Scope rows, as the Host config reader sees them. */
  readonly configs: Map<string, HostConfig>;
  provision(scope: string, owner: Principal, config: HostConfig): Promise<string>;
  dispose(): Promise<void>;
}

export async function openSubstrate(): Promise<Substrate> {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 20);
  const role = `hw_role_${nonce}`, sdkSchema = `hw_sdk_${nonce}`, hSchema = `hw_h_${nonce}`, hostSchema = `hw_host_${nonce}`;
  const admin = new pg.Pool({ connectionString: POSTGRES_URL, max: 1 });
  const url = new URL(POSTGRES_URL!);
  const database = url.pathname.slice(1);
  await admin.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${role}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  for (const schema of [sdkSchema, hSchema, hostSchema]) await admin.query(`CREATE SCHEMA ${quote(schema)} AUTHORIZATION ${quote(role)}`);
  await admin.query(`ALTER ROLE ${quote(role)} IN DATABASE ${quote(database)} SET search_path TO ${quote(sdkSchema)}, public`);
  // H's migrate runs `CREATE SCHEMA IF NOT EXISTS`, which needs the database CREATE privilege even when the schema exists.
  await admin.query(`GRANT CREATE ON DATABASE ${quote(database)} TO ${quote(role)}`);
  url.username = role; url.password = role;
  const connectionString = url.toString();
  const sdkPool = createByokPool({ connectionString, max: 2 });
  const pool = new pg.Pool({ connectionString, max: 4 });
  const configs = new Map<string, HostConfig>(), entitled = new Set<string>();
  const store = new HostedCollaborationStore(pool, hSchema, { host: scope => configs.get(scope)! });
  try {
    await migrate(sdkPool, migrationsDir());
    await store.migrate();
    await pool.query(hostScopeDdl(hostSchema));
  } catch (error) {
    await dispose();
    throw error;
  }
  async function dispose() {
    await sdkPool.end().catch(() => {});
    await pool.end().catch(() => {});
    for (const schema of [sdkSchema, hSchema, hostSchema]) await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await admin.query(`REVOKE CREATE ON DATABASE ${quote(database)} FROM ${quote(role)}`);
    await admin.query(`ALTER ROLE ${quote(role)} IN DATABASE ${quote(database)} RESET ALL`);
    await admin.query(`DROP ROLE IF EXISTS ${quote(role)}`);
    await admin.end();
  }
  return {
    connectionString, pool, sdkSchema, hSchema, hostSchema, store, configs, dispose,
    /**
     * Host provisioning, from Node: the scope's storage entitlement (once) and its product row. Returns a new owner session
     * token; the row keeps only its hash, so each call replaces the earlier token.
     */
    async provision(scope, owner, config) {
      if (!entitled.has(scope)) await entitle(scope);
      entitled.add(scope);
      const token = randomBytes(24).toString('hex');
      configs.set(scope, config);
      await writeHostScope(pool, hostSchema, { scope, ownerTokenSha256: await sha256Hex(token), owner, config });
      return token;
    },
  };
  async function entitle(scope: string) {
      const core = createPostgresCoreStores({ pool: sdkPool, clock: { now: () => new Date() }, objectStorage: s3(sdkSchema) });
      await core.quota.writeEntitlement(tenantId(scope), { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
        maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
  }
}

/** The S3 half of the substrate: the compose SeaweedFS, standing in for R2's S3 endpoint (README, R2). */
function s3(bucketSeed: string) {
  return { endpoint: S3_ENDPOINT!, bucket: `hw-${createHash('sha256').update(bucketSeed).digest('hex').slice(0, 20)}`, accessKeyId: 'byokminio',
    secretAccessKey: 'byokminio', region: 'us-east-1', signingClock: { now: () => new Date() } };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}
function wranglerEntry(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('wrangler/package.json', { paths: [EXAMPLE_DIR] });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: Record<string, string> };
  return path.join(path.dirname(manifestPath), manifest.bin['wrangler']!);
}

/** One local workerd instance of the Worker. The devices reconnect to the same port after a restart. */
export interface WorkerInstance {
  readonly base: string;
  output(): string;
  /** The lines that the instance printed with `marker`. */
  lines(marker: string): string[];
  /** Resolves once the instance printed a line with `marker`. */
  waitForOutput(marker: string, timeoutMs?: number): Promise<void>;
  /** The instance is destroyed: SIGKILL to wrangler and workerd, with no grace and no cleanup in the Worker. */
  kill(): Promise<void>;
  passes(): Promise<PassReport>;
  /** Fires the cron trigger through wrangler's `--test-scheduled` route: it arms the clock and runs no pass. */
  armClock(): Promise<void>;
  admin<T>(route: string, body: unknown): Promise<T>;
  input(token: string, botId: string, key: string, request: string): Promise<Response>;
}

export interface WorkerOptions {
  port?: number;
  fault?: string;
  vars?: Record<string, string>;
  /**
   * The local storage dir of an earlier instance, which the caller removes. The clock's Durable Object storage, and so its
   * next alarm, survives the restart, as it does on Cloudflare. Without it the instance gets a new dir and removes it.
   */
  persist?: string;
}

export async function startWorker(substrate: Substrate, options: WorkerOptions = {}): Promise<WorkerInstance> {
  const port = options.port ?? await freePort();
  const base = `http://127.0.0.1:${port}`;
  const adminToken = ADMIN_TOKEN;
  const persist = options.persist ?? mkdtempSync(path.join(tmpdir(), 'hw-persist-'));
  const storage = s3(substrate.sdkSchema);
  const vars: Record<string, string> = { H_SCHEMA: substrate.hSchema, HOST_SCHEMA: substrate.hostSchema, BYOK_TOKEN_SECRET: TOKEN_SECRET,
    HOST_ADMIN_TOKEN: adminToken, BYOK_S3_ENDPOINT: storage.endpoint, BYOK_S3_BUCKET: storage.bucket, BYOK_S3_ACCESS_KEY_ID: storage.accessKeyId,
    BYOK_S3_SECRET_ACCESS_KEY: storage.secretAccessKey, BYOK_S3_REGION: storage.region,
    // Every pass reads the tried rows again: the suites drive the passes themselves and wait for the result.
    H_RECONCILE_POLL_MS: '0', ...(options.fault ? { H_FAULT: options.fault } : {}),
    ...options.vars };
  let output = '';
  const child = spawn(process.execPath, [wranglerEntry(), 'dev', '--config', WRANGLER_CONFIG, '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist,
    '--test-scheduled', '--show-interactive-dev-session=false', ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`])],
  { cwd: EXAMPLE_DIR, detached: true, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1',
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG: substrate.connectionString } });
  const waiters = new Set<() => void>();
  const onData = (chunk: Buffer) => { output += chunk.toString('utf8'); for (const wake of waiters) wake(); };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ }
      await exited;
    }
    if (options.persist === undefined) rmSync(persist, { recursive: true, force: true });
    // wrangler's bundle scratch next to the config; the next instance writes it again.
    rmSync(path.join(path.dirname(WRANGLER_CONFIG), '.wrangler'), { recursive: true, force: true });
  };
  const authorized = (body: unknown, token: string): RequestInit => ({ method: 'POST', body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const instance: WorkerInstance = {
    base, output: () => output, kill,
    lines: marker => output.split('\n').filter(line => line.includes(marker)),
    waitForOutput: (marker, timeoutMs = 60_000) => new Promise((resolve, reject) => {
      const check = () => {
        if (output.includes(marker)) { waiters.delete(check); clearTimeout(timer); resolve(); }
      };
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no "${marker}" in the Worker output:\n${output}`)); }, timeoutMs);
      waiters.add(check);
      check();
    }),
    async admin<T>(route: string, body: unknown): Promise<T> {
      const response = await fetch(`${base}${route}`, authorized(body, adminToken));
      if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${await response.text()}`);
      return await response.json() as T;
    },
    passes: () => instance.admin<PassReport>('/host/passes', {}),
    async armClock() {
      const response = await fetch(`${base}/__scheduled?cron=*+*+*+*+*`);
      if (!response.ok) throw new Error(`/__scheduled: HTTP ${response.status} ${await response.text()}\n${output}`);
      await instance.waitForOutput('[h-clock] cron');
    },
    input: (token, botId, key, request) => fetch(`${base}/host/input`, authorized({ botId, key, request }, token)),
  };
  for (const deadline = Date.now() + 120_000; ;) {
    if (child.exitCode !== null) { await kill(); throw new Error(`wrangler dev exited early (${child.exitCode}):\n${output}`); }
    try {
      if ((await fetch(base, { signal: AbortSignal.timeout(2_000) })).status === 404) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { await kill(); throw new Error(`wrangler dev never became ready:\n${output}`); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return instance;
}
/** Fixed for the run: a device bearer minted by one instance must verify in the next one. */
const TOKEN_SECRET = randomBytes(32).toString('hex');
const ADMIN_TOKEN = randomBytes(24).toString('hex');

const ALARM_PASS = '[h-clock] alarm pass ';
/** The reports of the instance's alarm passes, in the order they ended. A failed pass prints no report. */
export function alarmReports(worker: WorkerInstance): PassReport[] {
  return worker.lines(ALARM_PASS).flatMap(line => {
    const start = line.indexOf('{', line.indexOf(ALARM_PASS));
    return start < 0 ? [] : [JSON.parse(line.slice(start)) as PassReport];
  });
}

/** One device process (`device.child.ts`), driven over IPC. */
export interface DeviceProcess {
  readonly deviceId: string;
  readonly root: string;
  readonly pid: number;
  /** The task ids whose runtime session started, in order, with their Agent ids. */
  readonly started: { taskId: string; agentId: string }[];
  waitForStart(taskId: string, timeoutMs?: number): Promise<void>;
  finish(taskId: string, document: unknown): Promise<void>;
  stop(): Promise<void>;
}

export async function startDevice(serverUrl: string, code: string): Promise<DeviceProcess> {
  const root = mkdtempSync(path.join(tmpdir(), 'hw-device-'));
  const require = createRequire(import.meta.url);
  const tsx = require.resolve('tsx', { paths: [EXAMPLE_DIR] });
  const child: ChildProcess = fork(fileURLToPath(new URL('./device.child.ts', import.meta.url)), [], {
    execArgv: ['--import', tsx], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const started: { taskId: string; agentId: string }[] = [];
  const waiters = new Set<(message: ChildMessage) => void>();
  child.on('message', (message: ChildMessage) => {
    if (message.type === 'started') started.push({ taskId: message.taskId, agentId: message.agentId });
    for (const wake of waiters) wake(message);
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const next = <T extends ChildMessage['type']>(type: T, match: (message: Extract<ChildMessage, { type: T }>) => boolean, timeoutMs: number) =>
    new Promise<Extract<ChildMessage, { type: T }>>((resolve, reject) => {
      const wake = (message: ChildMessage) => {
        if (message.type === 'error') { done(); reject(new Error(`device ${root}: ${message.message}`)); return; }
        if (message.type === type && match(message as Extract<ChildMessage, { type: T }>)) { done(); resolve(message as Extract<ChildMessage, { type: T }>); }
      };
      const timer = setTimeout(() => { done(); reject(new Error(`device ${root}: no ${type} within ${timeoutMs} ms`)); }, timeoutMs);
      const done = () => { waiters.delete(wake); clearTimeout(timer); };
      waiters.add(wake);
    });
  const send = (message: ParentMessage) => { child.send(message); };
  const ready = next('ready', () => true, 60_000);
  send({ type: 'pair', serverUrl, code, root });
  const { deviceId } = await ready;
  return {
    deviceId, root, pid: child.pid!, started,
    async waitForStart(taskId, timeoutMs = 60_000) {
      if (started.some(entry => entry.taskId === taskId)) return;
      await next('started', message => message.taskId === taskId, timeoutMs);
    },
    async finish(taskId, document) {
      const finished = next('finished', message => message.taskId === taskId, 30_000);
      send({ type: 'finish', taskId, document });
      await finished;
    },
    async stop() {
      if (child.exitCode === null) { send({ type: 'stop' }); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 15_000))]); }
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Polls `check` until it returns a value that is not `undefined`, or throws its last error at the deadline. */
export async function until<T>(check: () => Promise<T | undefined>, timeoutMs = 60_000, intervalMs = 250): Promise<T> {
  let last: unknown;
  for (const deadline = Date.now() + timeoutMs; ;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) { last = error; }
    if (Date.now() > deadline) throw last instanceof Error ? last : new Error('until: timed out');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * One substrate, one paired device process, and its scope (`home`: the SDK tenant that owns the enrollment), with a Worker
 * instance that a test may kill and restart on the same port and storage dir, so the device reconnects to the new instance
 * and the clock keeps its alarm.
 */
export async function openHome(options: Omit<WorkerOptions, 'persist'> = {}) {
  const substrate = await openSubstrate();
  const home = `worker-tenant-${randomUUID()}`;
  const persist = mkdtempSync(path.join(tmpdir(), 'hw-persist-'));
  let worker: WorkerInstance | undefined, device: DeviceProcess | undefined;
  try {
    await substrate.provision(home, OWNER, { models: { default: template('pending', 'main') }, readOnlyToolsets: [] });
    worker = await startWorker(substrate, { ...options, persist });
    const { code } = await worker.admin<{ code: string }>('/host/pairing-code', { scope: home });
    device = await startDevice(worker.base, code);
  } catch (error) {
    await device?.stop(); await worker?.kill(); await substrate.dispose();
    rmSync(persist, { recursive: true, force: true });
    throw error;
  }
  const port = Number(new URL(worker.base).port);
  const h = substrate.hSchema;
  return {
    substrate, home, device,
    get worker() { return worker!; },
    /** Destroys the running instance and starts a new one on the same port, with these options (no fault by default). */
    async restart(next: Omit<WorkerOptions, 'persist' | 'port'> = {}) {
      await worker!.kill();
      worker = await startWorker(substrate, { ...next, port, persist });
      return worker;
    },
    /** A Main Bot on the device with its own Agent, bound to H. Returns a new owner session token. */
    async bot(agentId = `agent-${randomUUID()}`) {
      const execution = template(device!.deviceId, agentId);
      const token = await substrate.provision(home, OWNER, { models: { default: execution }, readOnlyToolsets: [] });
      await substrate.store.seed(home, state => {
        seedCollaboration(state);
        Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
        state.team.bots.main!.execution = execution;
      });
      await substrate.store.bindDevice(home, device!.deviceId);
      return { token, agentId };
    },
    /** The owner's input through the Worker's command entry. Returns the Turn id and its task id. */
    async input(token: string, request = 'Hello from the Worker') {
      const response = await worker!.input(token, 'main', `k-${randomUUID()}`, request);
      if (response.status !== 200) throw new Error(`input: HTTP ${response.status} ${await response.text()}`);
      const { turnId } = await response.json() as { turnId: string };
      return { turnId, task: taskId(turnId, 0) };
    },
    intent: async (turnId: string) => (await substrate.pool.query<{ tries: number; submission: string; conclusion: string | null }>(
      `SELECT tries, submission, conclusion FROM "${h}".intent WHERE scope = $1 AND key = $2`, [storedKey(home), storedKey(turnId)])).rows[0],
    /** The command record ids of the scope. A terminal's outcome commits under its task id. */
    commands: async () => (await substrate.pool.query<{ key: string }>(
      `SELECT key FROM "${h}".command WHERE scope = $1 ORDER BY key`, [storedKey(home)])).rows.map(row => JSON.parse(row.key) as string),
    /** The envelope types of the SDK mailbox rows that name `task`. One offer is one row, however many submits resolved. */
    mailbox: async (task: string) => (await substrate.pool.query<{ type: string }>(
      `SELECT body::jsonb->>'type' AS type FROM "${substrate.sdkSchema}".outbox WHERE tenant_id = $1 AND position($2 in body) > 0 ORDER BY seq`,
      [home, task])).rows.map(row => row.type),
    /** The SDK attempt status of `task`, the durable fact that a device terminal committed. */
    taskStatus: async (task: string) => (await substrate.pool.query<{ status: string }>(
      `SELECT status FROM "${substrate.sdkSchema}".task WHERE tenant_id = $1 AND task_id = $2`, [home, task])).rows[0]?.status,
    turn: async (turnId: string) => (await substrate.store.read(home)).turns[turnId],
    /** The scope's routine rows: each one's next slot. */
    routines: async () => (await substrate.pool.query<{ next_at: string | null }>(
      `SELECT next_at::text FROM "${h}".routine WHERE scope = $1 ORDER BY ordinal`, [storedKey(home)])).rows
      .map(row => ({ nextAt: row.next_at === null ? null : Number(row.next_at) })),
    /** The scope's routine occurrences, each with its trigger and the slot and record times. */
    occurrences: async () => (await substrate.pool.query<{ key: string; trigger_kind: string; planned_at: string; recorded_at: string }>(
      `SELECT key, trigger_kind, planned_at::text, recorded_at::text FROM "${h}".occurrence WHERE scope = $1 ORDER BY ordinal`, [storedKey(home)])).rows
      .map(row => ({ key: JSON.parse(row.key) as string, trigger: row.trigger_kind, plannedAt: Number(row.planned_at), recordedAt: Number(row.recorded_at) })),
    /** The frozen intents of the scope's routine Turns. */
    routineIntents: async () => (await substrate.pool.query<{ task: string; tries: number; submission: string; conclusion: string | null }>(
      `SELECT task_id AS task, tries, submission, conclusion FROM "${h}".intent WHERE scope = $1 AND source = 'routine' ORDER BY ordinal`,
      [storedKey(home)])).rows,
    async close() {
      await device?.stop(); await worker?.kill(); await substrate.dispose();
      rmSync(persist, { recursive: true, force: true });
    },
  };
}
export type Home = Awaited<ReturnType<typeof openHome>>;
const OWNER = { id: 'owner', kind: 'human' } as const;
