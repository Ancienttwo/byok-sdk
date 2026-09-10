import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const hostRoot = process.env.SALESKO_TEST_ROOT;
if (!hostRoot) throw new Error('Set SALESKO_TEST_ROOT to the isolated pinned Salesko checkout.');
const hostSha = Bun.spawnSync(['git', '-C', hostRoot, 'rev-parse', 'HEAD']);
if (hostSha.exitCode !== 0 || hostSha.stdout.toString().trim() !== 'fe922d86cb1f0681c26b4bb661b55060cfd50e87') throw new Error('Salesko test subject mismatch');
const installed = (name: string) => import(pathToFileURL(Bun.resolveSync(name, hostRoot)).href);
const load = (name: string) => import(pathToFileURL(resolve(hostRoot, name)).href);
const { Client } = (await installed('pg')).default;
const { Hono } = await installed('hono');
const { createInMemoryByokCloud } = await installed('@byok-sdk/cloud');
const { tenantId: sdkTenantId } = await installed('@byok-sdk/core');
const C = await load('packages/contracts/src/index.ts');
const { PlanetScalePrivateAgentChatRepository } = await load('apps/api/src/private-agent-chat-repository.ts');
const { submitAndPrepare } = await load('apps/api/src/private-agent-chat-test-helpers.ts');
const { dispatchAndReconcile } = await load('apps/api/src/private-agent-chat-routes.ts');
const { byokTenantRef } = await load('apps/api/src/byok-tenant-ref.ts');
const { ByokPrivateAgentChatDispatcher } = await load('apps/api/src/private-agent-chat-dispatch.ts');
const { privateAgentChatCloud, createPrivateAgentChatRouter } = await load('apps/byok-control/src/main.ts');

// Same production runner and installed daemon as the preceding focused lanes;
// this fixture adds real Host PostgreSQL and independently killed Host workers.
for (const cut of ['held', 'cancel', 'partial_admission'] as const) test(`A29 joint Host/daemon recovery: ${cut}`, async () => {
  const localRoot = await mkdtemp(join(tmpdir(), 'byok-a29-'));
  const socket = join(localRoot, 'socket'), data = join(localRoot, 'pg');
  const children: { process: ReturnType<typeof Bun.spawn>; exited: boolean; kind: string }[] = [];
  const command = (name: string, args: string[]) => {
    const result = Bun.spawnSync([name, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`${name}: ${result.stderr.toString()}`);
  };
  const spawn = (kind: string, args: string[], options: Record<string, unknown> = {}) => {
    const child = { process: Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', ...options }), exited: false, kind };
    children.push(child); void child.process.exited.then(() => { child.exited = true; }); return child;
  };
  const until = async (condition: () => boolean | Promise<boolean>, label: string) => {
    const end = Date.now() + 12000;
    while (!await condition()) {
      if (Date.now() > end) throw new Error(`Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  const kill = async (child: typeof children[number]) => {
    child.process.kill('SIGKILL'); await child.process.exited;
    expect(child.process.signalCode).toBe('SIGKILL');
  };
  let pgStarted = false, db: any, http: ReturnType<typeof Bun.serve> | undefined;
  let tick = 0;
  const baseTime = Date.now() + 300000;
  const now = () => new Date(baseTime + tick++ * 120000).toISOString();
  const owner = { tenantId: 'a29-tenant', userId: 'a29-user', conversationId: `a29-${cut}`, turnId: 'T1' };
  const config = { connectionString: 'postgres://unused.invalid/test', datasetScope: 'salesko',
    conversationsTable: 'salesko_private_agent_chat_conversations', turnsTable: 'salesko_private_agent_chat_turns',
    messagesTable: 'salesko_private_agent_chat_messages', eventsTable: 'salesko_private_agent_chat_events',
    executionsTable: 'salesko_private_agent_chat_executions', outboxTable: 'salesko_private_agent_chat_outbox',
    turnEntitiesTable: 'salesko_private_agent_chat_turn_entities' };
  const connect = { host: socket, user: 'postgres', database: 'postgres', statement_timeout: 5000 };
  const repository = () => new PlanetScalePrivateAgentChatRepository(config, { createClient: () => {
    const client = new Client(connect);
    return { connect: () => client.connect(), end: () => client.end(), async query(sql: string, values?: unknown[]) {
      const result = await client.query(sql, values); return { rows: result.rows };
    } };
  } });
  const productId = 'a29-daemon-fixture', controlToken = crypto.randomUUID();
  const tenant = sdkTenantId(await byokTenantRef('salesko', owner.tenantId));
  let submissions = 0, readFault = false, appendFault = cut === 'partial_admission';
  const publications: any[] = [];
  const sdk = createInMemoryByokCloud({ longPollHoldMs: 50, agentMessage: { consume: async (input: any) => {
    publications.push(input.payload);
    if (cut === 'held') return { outcome: 'held', reasonCode: 'synthetic_held_fixture' };
    return repository().recordAgentMessage({ now: now(), message: { schemaVersion: C.PrivateAgentChatMessageConsumeSchemaVersion,
      tenantRef: input.tenant, deviceId: input.deviceId, taskId: input.taskId, context: input.context, payload: input.payload } });
  } } });
  const submit = sdk.cloud.submitRecurringExecution.bind(sdk.cloud);
  sdk.cloud.submitRecurringExecution = (...args: Parameters<typeof submit>) => { submissions++; return submit(...args); };
  const readMessage = sdk.cloud.readTaskAgentMessage.bind(sdk.cloud);
  sdk.cloud.readTaskAgentMessage = (...args: Parameters<typeof readMessage>) => {
    if (readFault) throw new Error('Synthetic A29 read outage'); return readMessage(...args);
  };
  const append = sdk.core.mailbox.append.bind(sdk.core.mailbox);
  sdk.core.mailbox.append = (...args: Parameters<typeof append>) => {
    if (appendFault) throw new Error('Synthetic A29 before mailbox append'); return append(...args);
  };
  let endpoint = '';
  const daemonStart = async (pairingCode?: string) => {
    const index = children.length, readyPath = join(localRoot, `daemon-${index}.ready.json`);
    const inputPath = join(localRoot, `daemon-${index}.json`), stderrPath = join(localRoot, `daemon-${index}.stderr`);
    await writeFile(inputPath, JSON.stringify({ installRoot: hostRoot, localRoot, serverUrl: endpoint, productId,
      controlToken, readyPath, pairingCode, egressPolicy: C.PrivateAgentEgressPolicy }));
    const child = spawn('daemon', [Bun.which('bun')!, resolve(import.meta.dir, 'fixtures/salesko-recurring-daemon.ts'), inputPath],
      { stdout: Bun.file(join(localRoot, `daemon-${index}.stdout`)), stderr: Bun.file(stderrPath), cwd: localRoot });
    let ready: any;
    await until(async () => {
      if (child.exited) throw new Error(`Daemon exited: ${await readFile(stderrPath, 'utf8')}`);
      try { ready = JSON.parse(await readFile(readyPath, 'utf8')); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }, 'daemon ready');
    expect(ready.pid).toBe(child.process.pid); return { ...ready, child };
  };
  const daemonCall = async (daemon: any, path: string, method = 'GET') => {
    const response = await fetch(daemon.url + path, { method, headers: { 'x-test-control': controlToken }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Daemon control failed: ${response.status}`); return response.json() as Promise<any>;
  };
  const facts = async () => (await db.query('SELECT task_id,generation,snapshot_json,message_context_json FROM salesko_private_agent_chat_executions ORDER BY task_id')).rows;
  const view = () => repository().readFullConversation(owner);
  try {
    await mkdir(socket);
    command('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8']);
    command('pg_ctl', ['-D', data, '-l', join(localRoot, 'postgres.log'), '-o', `-k ${socket} -h ''`, '-w', 'start']); pgStarted = true;
    db = new Client(connect); await db.connect();
    await db.query(`CREATE ROLE service_role NOLOGIN;
      CREATE TABLE salesko_tenants(dataset_scope text,id text,PRIMARY KEY(dataset_scope,id));
      CREATE TABLE salesko_private_agent_profiles(id text);
      CREATE FUNCTION salesko_touch_tenant_rbac_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;`);
    for (const path of ['0069_private_agent_chat.sql', '0074_private_agent_chat_turn_entities.sql']) await db.query(await readFile(join(hostRoot, 'deploy/sql', path), 'utf8'));
    await db.query("SET salesko.private_chat_execution_cutover='legacy_v5_quiesced'");
    await db.query(await readFile(join(hostRoot, 'deploy/sql/0075_private_agent_chat_executions.sql'), 'utf8'));
    await db.query("INSERT INTO salesko_tenants VALUES('salesko',$1)", [owner.tenantId]);
    const token = 'disposable-a29-control';
    const app = new Hono().route('/internal/private-agent-chat', createPrivateAgentChatRouter(privateAgentChatCloud(sdk.cloud), {
      auth: { researchToken: token, adminToken: 'disposable-admin', privateAgentChatCallbackToken: 'disposable-chat',
        privateAgentToolsCallbackToken: 'disposable-tools', profileProjectionToken: 'disposable-profile', tokenSigningSecret: new Uint8Array(32) },
    }));
    http = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname.startsWith('/internal/') ? app.fetch(request) : sdk.cloud.fetch(request) });
    endpoint = `http://127.0.0.1:${http.port}`;
    const control = { baseUrl: endpoint, datasetScope: 'salesko', researchToken: token };
    const dispatcher = new ByokPrivateAgentChatDispatcher(control);
    await sdk.core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
      maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'a29-test' });
    // Pairing is unaffected by the task mailbox append cut.
    const pairing = await sdk.cloud.createPairingCode(tenant, { productId });
    const first = await daemonStart(pairing.code);
    await until(async () => (await sdk.cloud.listDevices(tenant))[0]?.capabilities?.includes('agent-message-egress') === true, 'device capabilities');
    const binding = { agentRef: { agentId: '7bf9cf51-8c51-4a67-b8f3-4f11de2cecb1', profileRevision: '1' }, deviceId: first.deviceId,
      placementRevision: '3', runtime: 'claude', cwd: 'byok-agent-home', egressPolicy: C.PrivateAgentEgressPolicy, tools: C.PrivateAgentChatToolBinding };
    await repository().createConversation({ ...owner, agentId: binding.agentRef.agentId, title: cut, continuity: { mode: 'fresh', version: 1 }, execution: { epoch: 1 }, now: now() });
    await submitAndPrepare(repository(), { ...owner, binding, expectedExecution: { epoch: 1 }, clientRequestId: 'T1', message: 'U1', now: now() });
    await dispatchAndReconcile(repository(), dispatcher, owner.tenantId, owner.turnId, now());
    const originalFacts = await facts(); expect(originalFacts).toHaveLength(1);
    const taskId = originalFacts[0].task_id;
    const initialOffer = await sdk.cloud.readTaskOffer(tenant, taskId);
    expect(initialOffer).toMatchObject({ taskId, deviceId: first.deviceId, delivered: cut !== 'partial_admission' });
    const firstExpectedStarts = cut === 'partial_admission' ? 0 : 1;
    if (firstExpectedStarts) await until(async () => (await sdk.cloud.readTaskAttempt(tenant, taskId))?.status === 'running', 'claimed running task');
    expect((await daemonCall(first, '/status')).starts).toBe(firstExpectedStarts);
    if (cut === 'held') {
      await daemonCall(first, '/emit', 'POST');
      const state = await daemonCall(first, '/status');
      const outbox = join(state.sessions[0].workspaceDir, '.byok/messages/outbox-v1.jsonl');
      await until(async () => (await readFile(outbox, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
        .some(entry => entry.kind === 'disposition' && entry.disposition.outcome === 'held'), 'durable held');
    } else if (cut === 'cancel') {
      expect((await repository().requestCancelExact({ ...owner, execution: { taskId, generation: 1 }, now: now() })).status).toBe('recorded');
      expect((await sdk.cloud.readTaskAttempt(tenant, taskId))?.cancellation).toBeUndefined();
    }
    const worker = async (reserve = false) => {
      const at = now(), options = { now: at, nextCheckAt: new Date(Date.parse(at) + 60000).toISOString(), limit: 25 };
      const inputPath = join(localRoot, `host-${children.length}.json`);
      await writeFile(inputPath, JSON.stringify({ socket, config, database: 'postgres', control,
        submission: owner, preparation: { binding }, reserve: options, resume: options }));
      const child = spawn('host', [Bun.which('bun')!, join(hostRoot, 'scripts/private-agent-chat-recovery-process.ts'), reserve ? 'reserve' : 'dispatch-recovery', inputPath]);
      const timer = setTimeout(() => { if (!child.exited) child.process.kill('SIGKILL'); }, 15000);
      try {
        if (reserve) {
          const reader = (child.process.stdout as ReadableStream<Uint8Array>).getReader(); let output = '';
          while (!output.includes('\n')) { const next = await reader.read(); if (next.done) throw new Error('Host exited before reserved barrier'); output += new TextDecoder().decode(next.value); }
          const result = JSON.parse(output.split('\n')[0]!); reader.releaseLock();
          expect(result).toMatchObject({ stage: 'reserved', pid: child.process.pid, count: 1 }); await kill(child); return result;
        }
        const [output, errors, code] = await Promise.all([new Response(child.process.stdout).text(), new Response(child.process.stderr).text(), child.process.exited]);
        expect(code).toBe(0); if (code !== 0) throw new Error(errors);
        const result = JSON.parse(output); expect(result.pid).toBe(child.process.pid); return result;
      } finally { clearTimeout(timer); }
    };
    await worker(true); await kill(first.child);
    readFault = true;
    const failedRead = await worker();
    expect(failedRead.result).toMatchObject({ selected: 1, failures: [{ turnId: 'T1', code: 'chat_recovery_failed' }] });
    expect(failedRead.prepareCalls).toBe(0); expect(await facts()).toEqual(originalFacts);
    expect((await view()).messages.map((message: any) => message.content)).toEqual(['U1']);
    expect(await sdk.cloud.readDeviceTerminal(tenant, taskId)).toBeUndefined();
    readFault = false;
    if (cut === 'cancel') {
      expect((await sdk.cloud.readTaskAttempt(tenant, taskId))?.cancellation).toBeDefined();
      const cancelled = await worker(); expect(cancelled.prepareCalls).toBe(0); expect(cancelled.result.failures).toEqual([]);
      expect(await repository().reconcileDispatch({ ...owner, now: now() })).not.toBeNull();
    } else if (cut === 'partial_admission') {
      const admitted = await worker(); expect(admitted.prepareCalls).toBe(0); expect(admitted.result.reconciled).toBe(1);
      expect((await sdk.cloud.readTaskOffer(tenant, taskId)).delivered).toBe(false);
      expect((await view()).turns[0].status).toBe('queued');
      appendFault = false;
      const recovered = await worker(); expect(recovered.prepareCalls).toBe(1); expect(recovered.result.dispatchChecks).toBe(1);
      expect(await sdk.cloud.readTaskOffer(tenant, taskId)).toEqual({ ...initialOffer, delivered: true });
      expect(await facts()).toEqual(originalFacts); expect(submissions).toBe(2);
    } else {
      const held = await worker(); expect(held.prepareCalls).toBe(0); expect(held.result.reconciled).toBe(1);
      expect((await view()).recovery.turns[0]).toMatchObject({ messageDisposition: 'held', actions: { retry: false } });
    }
    const second = await daemonStart(); expect(second.deviceId).toBe(first.deviceId);
    if (cut === 'partial_admission') {
      await until(async () => (await sdk.cloud.readTaskAttempt(tenant, taskId))?.status === 'running', 'recovered admission actually starts');
      expect((await daemonCall(second, '/status')).starts).toBe(1); await daemonCall(second, '/emit', 'POST');
    }
    await until(async () => (await sdk.cloud.readDeviceTerminal(tenant, taskId)) !== undefined, 'actual device terminal after restart');
    await until(async () => (await daemonCall(second, '/status')).status.agentHomeExecution.activeAttempts === 0, 'actual local close');
    const finalWorker = await worker(); expect(finalWorker.prepareCalls).toBe(0); expect(finalWorker.result.failures).toEqual([]);
    const full = await view();
    expect(full.messages.map((message: any) => message.content)).toEqual(cut === 'partial_admission' ? ['U1', 'A1'] : ['U1']);
    expect(full.turns[0].execution).toMatchObject({ taskId, generation: 1 });
    expect(full.recovery.turns[0]).toMatchObject({ executionObservation: 'terminal', resourceObservation: 'unknown',
      ...(cut === 'held' ? { messageDisposition: 'held', settlement: null, actions: { retry: false, end: true } }
        : { settlement: { reason: cut === 'cancel' ? 'cancelled_before_accept' : 'answered' } }) });
    expect(await repository().reconcileDispatch({ ...owner, now: now() })).toBeNull();
    expect(await facts()).toEqual(originalFacts);
    const beforeIdle = await facts(), count = publications.length;
    const idle = await worker(); expect(idle.result).toMatchObject({ selected: 0, failures: [] }); expect(idle.prepareCalls).toBe(0);
    expect(await facts()).toEqual(beforeIdle); expect(publications).toHaveLength(count);
    expect(submissions).toBe(cut === 'partial_admission' ? 2 : 1);
    expect((await daemonCall(second, '/status')).starts).toBe(cut === 'partial_admission' ? 1 : 0);
    await daemonCall(second, '/stop', 'POST'); await second.child.process.exited;
    const hostPids = children.filter(child => child.kind === 'host').map(child => child.process.pid);
    expect(new Set(hostPids).size).toBe(hostPids.length); expect(hostPids.length).toBeGreaterThanOrEqual(5);
    console.log(`A29 ${cut}=PASS; host_pids=${hostPids.length}; daemon_pids=2; executions=1; submissions=${submissions}; synthetic_starts=${firstExpectedStarts}+${cut === 'partial_admission' ? 1 : 0}; native_starts=0`);
  } finally {
    for (const child of children) { if (!child.exited) child.process.kill('SIGKILL'); await child.process.exited; }
    http?.stop(true); await db?.end();
    if (pgStarted) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    await rm(localRoot, { recursive: true, force: true });
  }
}, 90000);
