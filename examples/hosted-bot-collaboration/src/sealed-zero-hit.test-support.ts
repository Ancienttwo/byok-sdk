/**
 * The sealed zero-hit run (#654 E6) on the hosted SDK: `createByokCloud` over the Postgres and S3 stores, one real
 * daemon paired with `pv`, and a web client member that created a scope of task input and task output with it.
 *
 * Two tasks of the same shape run on the device: a sealed one, whose texts carry the sealed canary, and its plaintext
 * twin, whose texts carry the plain canary. Each goes through the offer, a steer, progress, an approval request, an
 * artifact and the result return (summary, final message and result document). The sealed closing reply is large, so the
 * sealed terminal goes above the inline frame and names its ciphertext object. The device name carries the plain
 * canary too. Then the test reads every column of every row in every tenant table (the S0 scanner, which takes its
 * table list from the tenant erasure query), every object in the bucket and the console output of the run.
 *
 * Three checks make a zero hit mean something:
 * 1. The sealed canary is in no location. Each location that holds the sealed task's ciphertext also holds the plain
 *    canary, so the scanner did read the column where the sealed content went.
 * 2. The locations that hold the sealed task's ciphertext equal the `hosted-sealed-inventory` table in
 *    `docs/security.md`.
 * 3. The member opens the ciphertext that the Host read interfaces return and gets the sealed canary back, and the
 *    device received the sealed instruction and steer in plaintext. A store that dropped the content fails here.
 *    The terminal's ciphertext object is read from the bucket, because no Host method returns object bytes.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AgentRef } from '@byok-sdk/cloud';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { createObjectStorageScope, type ObjectStorageScope } from '../../../packages/cloud-dataplane/src/__tests__/support/dataplane';
import { canaryNeedles, objectLocation, readObjects, record, scanPostgres, type Hits, type Needle }
  from '../../../packages/cloud-dataplane/src/__tests__/support/plaintext-scan';
import { waitForTaskCleanup } from '../../basic/goal-btw.test-support';
import type { SealedMember, TaskSealing } from './e2ee-member.test-support';
import type { HostedCloudOptions, HostedCloud } from './hosted-cloud.test-support';
import type { CanaryCloud } from './canary-cloud.test-support';
import { ZeroHitAdapter, type ZeroHitSession } from './zero-hit-runtime.test-support';

const SECURITY_DOC = fileURLToPath(new URL('../../../docs/security.md', import.meta.url));
const INVENTORY_START = '<!-- hosted-sealed-inventory:start -->';
const INVENTORY_END = '<!-- hosted-sealed-inventory:end -->';
const SCOPE = 'scope-zero-hit';
const SEALING: TaskSealing = { scopeId: SCOPE, epoch: 1, categories: ['task-input', 'task-output'] };
const BUDGET = { timeout: 10_000, interval: 50 };

/** No character of a core needs JSON escaping. The prefixes differ, so neither core is a substring of the other. */
const S_CORE = `byok654sealed${randomUUID().replaceAll('-', '')}`;
const P_CORE = `byok654plain${randomUUID().replaceAll('-', '')}`;
/** The tail makes the JSON-escaped form of a text differ from its UTF-8 form. */
const tail = ' "quoted" back\\slash ✓';
const S = `${S_CORE}${tail}`;
/** Filler of a large closing reply. */
const FILLER = '.'.repeat(140_000);
const P = `${P_CORE}${tail}`;

/** The first backticked cell of each row between the sealed inventory markers in `docs/security.md`. */
async function documentedCiphertext(): Promise<string[]> {
  const doc = await readFile(SECURITY_DOC, 'utf8');
  const start = doc.indexOf(INVENTORY_START);
  const end = doc.indexOf(INVENTORY_END, start);
  if (start < 0 || end < 0) throw new Error(`docs/security.md has no ${INVENTORY_START} … ${INVENTORY_END} block`);
  return doc.slice(start, end).split('\n').filter((line) => line.startsWith('| `')).map((line) => line.split('`')[1]!);
}

/**
 * A wire `sealed` member as its header, its ciphertext bytes and a needle of the ciphertext. An inline member's needle
 * is a slice of its base64url text, which a JSON column keeps as it is. A member by reference names an object, and
 * its needle is a slice of the object's bytes.
 */
async function ciphertextOf(storage: ObjectStorageScope, tenant: string, sealed: unknown): Promise<SealedMember & { readonly needle: Needle }> {
  const { ciphertext, ciphertextRef, ...header } = sealed as { ciphertext?: string; ciphertextRef?: { contentHash: string } } & Record<string, unknown>;
  if (ciphertext !== undefined) {
    const slice = ciphertext.slice(8, 72);
    return { header, ciphertext: Buffer.from(ciphertext, 'base64url'), needle: { form: 'ciphertext', text: slice, bytes: Buffer.from(slice, 'utf8') } };
  }
  // ByokCloud has no method that returns object bytes (#654 Q10), so the test reads the ciphertext from the bucket.
  const key = `tenants/${tenant}/objects/sha256/${ciphertextRef!.contentHash.slice('sha256:'.length)}`;
  const object = await storage.client.fetch(`${storage.config.endpoint}/${storage.bucket}/${key}`);
  if (!object.ok) throw new Error(`GET ${key} failed: HTTP ${object.status}`);
  const bytes = Buffer.from(await object.arrayBuffer());
  const slice = bytes.subarray(16, 64);
  return { header, ciphertext: bytes, needle: { form: 'ciphertext', text: slice.toString('base64url'), bytes: slice } };
}

export type ZeroHitHost = Omit<HostedCloud, 'cloud'> & { readonly cloud: CanaryCloud;
  readonly readObserved?: () => Promise<{ envelope: { type: string; task_id?: string; payload: unknown } }[]>;
  readonly logs?: () => string;
  readonly stopRuntime?: () => Promise<void> };

/** One set of assertions for both runtime compositions. */
export function sealedZeroHitSuite(name: string, skip: boolean, openHost: (options: HostedCloudOptions) => Promise<ZeroHitHost>) {
  let host: ZeroHitHost | undefined;
  let storage: ObjectStorageScope | undefined;
  afterAll(async () => {
    try { await host?.close(); }
    finally {
      if (storage) {
        const bucket = `${storage.config.endpoint}/${storage.bucket}`;
        for (const key of (await readObjects(storage)).keys()) {
          const removed = await storage.client.fetch(`${bucket}/${key}`, { method: 'DELETE' });
          if (!removed.ok) throw new Error(`DELETE ${key}: HTTP ${removed.status}`);
        }
        const removed = await storage.client.fetch(bucket, { method: 'DELETE' });
        if (!removed.ok) throw new Error(`DELETE bucket: HTTP ${removed.status}`);
      }
    }
  });

  describe.skipIf(skip)(name, () => {
    it('keeps the sealed canary out of every store and log, and the member opens what the Host keeps', { timeout: 120_000 }, async () => {
      const consoleSpies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level));
      const objectStorage = storage = await createObjectStorageScope();
      const adapter = new ZeroHitAdapter();
      // What the product's observer is handed is a location too: it is the only reader of a sealed task.artifact.
      const observed: { envelope: { type: string; task_id?: string; payload: unknown } }[] = [];
      host = await openHost({ e2ee: { scopeId: SCOPE, categories: SEALING.categories }, deviceName: `device ${P}`, adapter,
        objectStorage: objectStorage.config, observer: { onInboundCommitted: (input) => { observed.push(input); } } });
      const { cloud, tenant, deviceId, member, port } = host;
      // The device advertises sealed-payload-v1 once it verified its member keyring against the chain.
      await vi.waitFor(async () => expect((await cloud.listDevices(tenant)).find((device) => device.deviceId === deviceId)?.capabilities)
        .toContain('sealed-payload-v1'), BUDGET);

      /** One task through every flow, its texts carrying `text`. Returns its id, AgentRef and session. */
      async function run(sealed: boolean, text: string): Promise<{ taskId: string; agentRef: AgentRef; session: ZeroHitSession }> {
        const taskId = `task-${randomUUID()}`;
        const { payload: { instruction: _plainInstruction, ...rest } } = template(deviceId, `agent-${randomUUID()}`);
        const agentRef = rest.agentRef;
        const instruction = `Instruction ${text}`;
        if (sealed) {
          await cloud.submitSealedAgentExecution(tenant, { taskId, deviceId, payload: { ...rest, session: { mode: 'fresh' }, terminalProjection: rest.terminalProjection!,
            sealing: SEALING, sealed: await member!.seal('task.offer', { taskId }, deviceId, agentRef, { instruction }) } });
        } else {
          await port.submit({ taskId, deviceId, payload: { ...rest, instruction } });
        }
        await vi.waitFor(() => expect(adapter.sessions.has(taskId)).toBe(true), BUDGET);
        const session = adapter.sessions.get(taskId)!;
        session.emit({ type: 'progress', text: `Progress ${text}` });
        // The Host takes a steer only for a running attempt.
        await vi.waitFor(async () => expect((await port.attempt(taskId))?.status).toBe('running'), BUDGET);

        const steer = `Steer ${text}`;
        if (sealed) {
          const steerId = randomUUID();
          await cloud.steerSealedTask(tenant, taskId, { steerId, sealed: await member!.seal('task.steer', { taskId, steerId }, deviceId, agentRef, { text: steer }) });
        } else {
          await cloud.steerTask(tenant, taskId, { text: steer });
        }
        await vi.waitFor(() => expect(session.steers).toEqual([steer]), BUDGET);

        void session.start.approvalChannel!.request(`Approve ${text}`);
        const approvalId = await vi.waitFor(async () => {
          const entry = (await cloud.readApprovalTimeline(tenant, taskId))?.entries.find((observed) => observed.event.type === 'approval_requested');
          expect(entry).toBeDefined();
          return (entry!.event as { approvalId: string }).approvalId;
        }, BUDGET);
        await cloud.approveTask(tenant, taskId, { approvalId });
        // The plain twin's artifact spills to an object, providing a positive object-store control.
        await writeFile(path.join(session.workspaceDir, 'notes.txt'), `Artifact ${text}${sealed ? '' : '.'.repeat(70_000)}`);
        session.emit({ type: 'artifact', name: 'notes.txt', contentType: 'text/plain' });
        // The closing reply is the progress text after the last tool interaction. Two large parts make the sealed
        // task.complete larger than the inline frame, so the device uploads its ciphertext and the terminal names it.
        // Plain terminals have a 256 KiB journal bound; the sealed terminal instead uploads an oversized frame.
        // Keep the twin's event shape but bound its filler so both tasks actually complete.
        const filler = sealed ? FILLER : FILLER.slice(0, 60_000);
        session.emit({ type: 'progress', text: `Summary ${text} ${filler}` });
        session.emit({ type: 'progress', text: `More ${text} ${filler}` });
        await session.finish({ text: `Document ${text}` });
        await vi.waitFor(async () => expect(await port.deviceTerminal(taskId)).toBeDefined(), BUDGET);
        await waitForTaskCleanup(host!.daemon, session);
        return { taskId, agentRef, session };
      }

      const sealedRun = await run(true, S);
      const plainRun = await run(false, P);

      expect((await cloud.readDeviceTerminal(tenant, plainRun.taskId))!.envelope.type).toBe('task.complete');

      if (host.readObserved) observed.push(...await host.readObserved());

      // Liveness: the device opened the sealed task input.
      expect(sealedRun.session.instruction).toContain(S_CORE);
      expect(sealedRun.session.steers.join('\n')).toContain(S_CORE);

      // Liveness: the member opens each sealed output that the Host read interfaces return.
      const { taskId, agentRef } = sealedRun;
      const terminal = (await cloud.readDeviceTerminal(tenant, taskId))!.envelope;
      expect(terminal.type).toBe('task.complete');
      const sealedOf = (sealed: unknown) => ciphertextOf(objectStorage, tenant, sealed);
      // The large closing reply put the sealed terminal above the inline frame, so it names its ciphertext object.
      expect((terminal.payload as { sealed: { ciphertextRef?: unknown } }).sealed.ciphertextRef).toBeDefined();
      const terminalMember = await sealedOf((terminal.payload as { sealed: unknown }).sealed);
      expect(JSON.stringify(await member!.open('task.complete', { taskId }, deviceId, agentRef, terminalMember))).toContain(S_CORE);
      const batches = ((await cloud.readActivity(tenant, taskId))?.entries ?? []).filter((entry) => 'sealed' in entry);
      expect(batches.length).toBeGreaterThan(0);
      const activityMembers = await Promise.all(batches.map(async (batch) => ({ seq: (batch as { batchSeq: number }).batchSeq,
        member: await sealedOf((batch as { sealed: unknown }).sealed) })));
      const progress = await Promise.all(activityMembers.map(({ seq, member: sealed }) => member!.open('task.progress', { taskId, seq }, deviceId, agentRef, sealed)));
      expect(JSON.stringify(progress)).toContain(S_CORE);
      const requested = (await cloud.readApprovalTimeline(tenant, taskId))!.entries.map((entry) => entry.event)
        .filter((event): event is typeof event & { approvalId: string; sealed: unknown } => event.type === 'approval_requested' && 'sealed' in event);
      expect(requested).toHaveLength(1);
      const approvalMember = await sealedOf(requested[0]!.sealed);
      // No store keeps a sealed artifact, so the observer is where the test checks that the device sent and sealed it.
      const artifacts = observed.map(({ envelope }) => envelope).filter((envelope) => envelope.type === 'task.artifact' && envelope.task_id === taskId);
      expect(artifacts).toHaveLength(1);
      const { artifactId, sealed: sealedArtifact } = artifacts[0]!.payload as { artifactId: string; sealed: unknown };
      const artifact = await member!.open('task.artifact', { taskId, artifactId }, deviceId, agentRef, await sealedOf(sealedArtifact)) as { inline: string };
      expect(Buffer.from(artifact.inline, 'base64').toString('utf8')).toContain(S_CORE);
      expect(JSON.stringify(await member!.open('task.await_approval', { taskId, approvalId: requested[0]!.approvalId }, deviceId, agentRef,
        approvalMember))).toContain(S_CORE);
      const offer = await cloud.readTaskOffer(tenant, taskId);
      const steerOutbox = await host.pool.query<{ body: string }>(`SELECT body::text AS body FROM outbox WHERE body::text LIKE '%"task.steer"%'
        AND body::text LIKE $1`, [`%${taskId}%`]);
      expect(steerOutbox.rows).toHaveLength(1);
      const steerMember = await sealedOf((JSON.parse(steerOutbox.rows[0]!.body) as { payload: { sealed: unknown } }).payload.sealed);

      // The scan.
      const sealedHits: Hits = new Map(), plainHits: Hits = new Map(), ciphertextHits: Hits = new Map();
      const sealedNeedles = canaryNeedles(S_CORE, S), plainNeedles = canaryNeedles(P_CORE, P);
      const ciphertextNeedles = [
        await sealedOf((offer as unknown as { payload: { sealed: unknown } }).payload.sealed), steerMember, terminalMember, approvalMember,
        ...activityMembers.map(({ member: sealed }) => sealed),
      ].map((sealed) => sealed.needle);
      await host.stopRuntime?.();
      const tables = await scanPostgres(host.pool, [...sealedNeedles], sealedHits);
      expect(tables).toBeGreaterThan(20);
      await scanPostgres(host.pool, plainNeedles, plainHits);
      await scanPostgres(host.pool, ciphertextNeedles, ciphertextHits);
      const objects = await readObjects(objectStorage);
      expect([...objects.values()].some(bytes => bytes.includes(Buffer.from(P_CORE)))).toBe(true);
      for (const [key, bytes] of objects) {
        record(sealedHits, objectLocation(key, tenant), bytes, sealedNeedles);
        record(plainHits, objectLocation(key, tenant), bytes, plainNeedles);
        record(ciphertextHits, objectLocation(key, tenant), bytes, ciphertextNeedles);
      }
      for (const input of observed.map((committed) => JSON.stringify(committed))) {
        record(sealedHits, 'hook:observer', input, sealedNeedles);
        record(plainHits, 'hook:observer', input, plainNeedles);
      }
      for (const spy of consoleSpies) {
        for (const args of spy.mock.calls) {
          record(sealedHits, 'log:console', format(...args), sealedNeedles);
          record(plainHits, 'log:console', format(...args), plainNeedles);
        }
      }

      if (host.logs) {
        record(sealedHits, 'log:workerd', host.logs(), sealedNeedles);
        record(plainHits, 'log:workerd', host.logs(), plainNeedles);
        expect(plainHits.has('log:workerd'), host.logs()).toBe(true);
      }

      // 1. Zero hits for the sealed canary; each ciphertext location also holds the plain canary.
      expect(Object.fromEntries([...sealedHits].map(([location, forms]) => [location, [...forms]]))).toEqual({});
      const ciphertextLocations = [...ciphertextHits.keys()].sort();
      expect(ciphertextLocations.filter((location) => !plainHits.has(location))).toEqual([]);
      // The plain flows that are not sealed in v1 land where S0 says: the device name and the twin's own columns.
      expect([...plainHits.keys()]).toEqual(expect.arrayContaining(['device.device_name', 'device_request_receipts.body', 'hook:observer', 'outbox.body']));
      // The scanner's table list keeps only ordinary tables, so no other relation kind may hold rows.
      expect((await host.pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind IN ('m', 'f')`)).rows).toEqual([]);

      // 2. The ciphertext locations equal the sealed inventory in docs/security.md.
      expect(ciphertextLocations).toEqual((await documentedCiphertext()).sort());
      expect(plainRun.session.instruction).toContain(P_CORE);
    });
  });
}
