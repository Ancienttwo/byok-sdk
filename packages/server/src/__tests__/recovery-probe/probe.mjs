import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { createByokServer, createHmacTokenSigner } from '@byok-sdk/server';
import { createDaemonWithAdapters, freezeRuntimeAdapterDescriptor, readDeviceEnrollmentStatus } from '@byok-sdk/client';
import { encodeEnvelope } from '@byok-sdk/protocol';
import { validateStarts, hasAcknowledgedOffer } from './evidence.mjs';

process.umask(0o077);
const hash = value => createHash('sha256').update(value).digest('hex');
const terminal = event => ['task.complete', 'task.fail', 'task.cancelled'].includes(event.type);
const scenarios = [
  { name: 'fixed-no-journal-acked', journal: false, changeUrl: false, barrier: 'acked', dispatchB: false, expectedA: 1 },
  { name: 'fixed-no-journal-pending', journal: false, changeUrl: false, barrier: 'pending-ack', dispatchB: false, expectedA: 1 },
  { name: 'fixed-journal-pending-terminal', journal: true, changeUrl: false, barrier: 'pending-terminal', dispatchB: false, expectedA: 1 },
  { name: 'fixed-journal-terminal-response-held', journal: true, changeUrl: false, barrier: 'pending-terminal-response', dispatchB: false, expectedA: 1 },
  { name: 'fixed-journal-then-dispatch-B', journal: true, changeUrl: false, barrier: 'pending-terminal', dispatchB: true, expectedA: 1 },
  { name: 'changed-url-no-journal-pending', journal: false, changeUrl: true, barrier: 'pending-ack', dispatchB: false, expectedA: 2 },
  { name: 'changed-url-no-journal-pending-then-B', journal: false, changeUrl: true, barrier: 'pending-ack', dispatchB: true, expectedA: 2 },
  { name: 'changed-url-no-journal-acked', journal: false, changeUrl: true, barrier: 'acked', dispatchB: false, expectedA: 1 },
];
async function until(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`barrier timeout: ${label}`);
}
async function readEvents(root) {
  try { return (await fs.readFile(path.join(root, 'audit.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function select(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
async function observation(root, config, serverUrl, deviceId) {
  const namespace = hash(`${serverUrl}::${deviceId}`).slice(0, 32);
  let cursor = null;
  try {
    cursor = JSON.parse(await fs.readFile(path.join(root, 'device', `cursor-${namespace}.json`), 'utf8')).cursor;
    assert.ok(Number.isSafeInteger(cursor) && cursor >= 0, 'invalid observed cursor');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const serverPath = path.join(root, 'server.sqlite');
  const mailbox = select(serverPath, 'SELECT seq, message_id, state, body FROM mailbox_message ORDER BY seq')
    .map(row => { const envelope = JSON.parse(row.body); return {
      seq: row.seq, offerId: row.message_id, state: row.state, type: envelope.type,
      taskId: envelope.task_id ?? null, envelopeId: envelope.id,
    }; });
  const journalPath = path.join(root, 'device', 'daemon.db');
  let journal = { enabled: config.journal, exists: existsSync(journalPath) };
  if (journal.exists) journal = { ...journal,
    envelopes: select(journalPath, 'SELECT envelope_id, task_id, seq, acked_at FROM journal_envelope ORDER BY seq'),
    tasks: select(journalPath, 'SELECT task_id, envelope_id, seq, admitted, claimed_runtime, local_state, recovery_marker FROM journal_task ORDER BY task_id'),
    terminals: select(journalPath, 'SELECT task_id, terminal_type, payload_hash, truth_state, attempt FROM journal_terminal ORDER BY task_id'),
  };
  return { serverUrl, deviceId, cursorNamespace: namespace, localCursor: cursor,
    mailbox, serverCursors: select(serverPath, 'SELECT device_id, delivered_seq, acked_seq FROM mailbox_cursor'),
    serverTasks: select(serverPath, 'SELECT task_id, status FROM task_attempt ORDER BY task_id'), journal };
}

async function child(stage, root) {
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  const serverUrl = stage === 'first' ? config.firstUrl : config.recoverUrl;
  let order = 0; let tail = Promise.resolve(); let fatal;
  const seenOffers = new Map(); let taskA = config.taskA; let blockedAck = false; let blockedTerminal = false;
  let completedPolls = 0; let emptyPolls = 0;
  const log = event => {
    const row = { stage, pid: process.pid, order: ++order, at: new Date().toISOString(), ...event };
    tail = tail.then(async () => { const file = await fs.open(path.join(root, 'audit.jsonl'), 'a', 0o600);
      try { await file.write(JSON.stringify(row) + '\n'); await file.sync(); } finally { await file.close(); } });
    return tail;
  };
  const adapter = {
    descriptor: freezeRuntimeAdapterDescriptor({ id: 'pi', supportsDispatchSelection: true, requiresMcpToolsetToolObservation: false,
      capabilities: { steer: false, resume: false, approvalInteractive: false, mcpToolsets: false, permissionModes: ['auto'] },
      environmentRequirements: { credentialNames: [] } }),
    async detect() { return { kind: 'available', version: 'attribution-fixture-1' }; },
    async prepare() { return { kind: 'prepared', operation: { async start(input) {
      const taskId = input.manifest.taskId;
      assert.equal(typeof taskId, 'string', 'manifest taskId absent');
      const offers = seenOffers.get(taskId) ?? [];
      const identities = new Map(offers.map(offer => [`${offer.offerId}/${offer.seq}`, offer]));
      assert.equal(identities.size, 1, 'start must map to exactly one observed offer identity');
      const offer = [...identities.values()][0]; const sessionRef = randomUUID();
      await log({ kind: 'start', taskId, runtimeId: input.manifest.runtimeId,
        agentRef: input.manifest.agentRef ?? null, sessionRef, offerId: offer.offerId, seq: offer.seq });
      return { sessionRef, events: (async function* () { yield { type: 'turn_end' }; })(),
        async close() {}, async interrupt() {}, async steer() { throw new Error('unsupported'); },
        async followUp() { throw new Error('unsupported'); }, async resolveApproval() { throw new Error('unsupported'); } };
    } } }; },
  };
  const daemonConfig = { productId: config.productId, productName: 'BYOK attribution probe',
    localAgentRelease: { version: '0.0.0-attribution' }, serverUrl,
    storeDir: path.join(root, 'device'), workspaceRoot: path.join(root, 'workspace'),
    allowedRuntimes: ['pi'], permissionDefaults: { mode: 'auto' },
    ...(config.journal ? { hostedJournal: { mode: 'sqlite' } } : {}) };
  let byok, http, daemon, diagnosticDeviceId;
  try {
    daemon = createDaemonWithAdapters(daemonConfig, [adapter]);
    if (stage === 'cleanup') { await daemon.unpair(); return { kind: 'cleaned' }; }
    byok = createByokServer({ productId: config.productId,
      storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') }, longPollHoldMs: 100,
      tokenSigner: createHmacTokenSigner(await fs.readFile(path.join(root, 'signer.key')), { now: () => new Date() }) });
    const fetch = async request => {
      try {
        const url = new URL(request.url);
        if (url.pathname === '/byok/events') {
          const requestedCursor = Number(url.searchParams.get('cursor') ?? 0);
          if (stage === 'first' && config.barrier === 'pending-ack' && taskA) {
            const offer = seenOffers.get(taskA)?.[0];
            if (offer && requestedCursor >= offer.seq) {
              if (!blockedAck) { blockedAck = true; await log({ kind: 'ack-request-held', taskId: taskA, cursor: requestedCursor }); }
              return new Promise(() => {}); // Fault injection before server-side ACK; process is SIGKILLed.
            }
          }
          const response = await byok.hono.fetch(request);
          if (response.status === 200) {
            const body = await response.clone().json();
            for (const envelope of body.events) {
              if (!envelope.type.startsWith('task.offer')) continue;
              const offer = { taskId: envelope.task_id, offerId: envelope.id, seq: envelope.seq, type: envelope.type };
              const entries = seenOffers.get(offer.taskId) ?? []; entries.push(offer); seenOffers.set(offer.taskId, entries);
              await log({ kind: 'offer', ...offer });
            }
            completedPolls++; if (body.events.length === 0) emptyPolls++;
            await log({ kind: 'poll-response', requestedCursor, responseCursor: body.cursor, count: body.events.length });
          }
          return response;
        }
        if (url.pathname === '/byok/messages' && request.method === 'POST') {
          const messages = (await request.clone().json()).messages;
          const terminals = messages.filter(terminal);
          for (const envelope of terminals) await log({ kind: 'terminal-send', taskId: envelope.task_id,
            envelopeId: envelope.id, type: envelope.type, payloadHash: `sha256:${hash(encodeEnvelope(envelope))}` });
          if (stage === 'first' && config.barrier === 'pending-terminal' && terminals.length > 0) {
            blockedTerminal = true;
            await log({ kind: 'terminal-request-held', taskId: terminals[0].task_id });
            return new Promise(() => {}); // Journal terminal is committed; server has not consumed this request.
          }
          const response = await byok.hono.fetch(request);
          const disposition = await response.clone().json();
          if (stage === 'first' && config.barrier === 'pending-terminal-response' && terminals.length > 0) {
            blockedTerminal = true;
            for (const envelope of terminals) await log({ kind: 'terminal-response-held', taskId: envelope.task_id,
              envelopeId: envelope.id, status: response.status, batchAccepted: disposition.accepted ?? null,
              batchRejected: disposition.rejected ?? 0, payloadHash: `sha256:${hash(encodeEnvelope(envelope))}` });
            return new Promise(() => {}); // Server consumed terminal; daemon has not received confirmation.
          }
          for (const envelope of terminals) await log({ kind: 'terminal-response', taskId: envelope.task_id,
            envelopeId: envelope.id, status: response.status, batchAccepted: disposition.accepted ?? null, batchRejected: disposition.rejected ?? 0, payloadHash: `sha256:${hash(encodeEnvelope(envelope))}` });
          return response;
        }
        return byok.hono.fetch(request);
      } catch (error) { fatal = error; throw error; }
    };
    http = await new Promise((resolve, reject) => {
      const listener = serve({ fetch, hostname: '127.0.0.1', port: Number(new URL(serverUrl).port) }, () => resolve(listener));
      listener.once('error', reject);
    });
    let enrollment = await readDeviceEnrollmentStatus(daemonConfig);
    if (stage === 'first') {
      const code = await byok.pairing.createPairingCode({ productId: config.productId });
      enrollment = { state: 'paired', ...await daemon.pair(code.code) };
    }
    assert.equal(enrollment.state, 'paired'); diagnosticDeviceId = enrollment.deviceId;
    await log({ kind: 'phase-start', serverUrl, deviceId: enrollment.deviceId, journal: config.journal,
      hostRequestId: config.hostRequestId });
    const preStart = await observation(root, config, serverUrl, enrollment.deviceId);
    await daemon.start();
    const checked = async predicate => { if (fatal) throw fatal; return predicate(); };
    await until(() => checked(async () => (await byok.machines.list()).some(machine => machine.deviceId === enrollment.deviceId && machine.connected)), 'connected (not recovery barrier)');
    const snap = () => observation(root, config, serverUrl, enrollment.deviceId);
    if (stage === 'first') {
      const handle = await byok.dispatch({ deviceId: enrollment.deviceId, instruction: 'attribution fixture', runtime: 'pi', policy: { mode: 'auto' } });
      taskA = handle.taskId;
      await log({ kind: 'dispatch', taskId: taskA, hostRequestId: config.hostRequestId, submission: 'A' });
      await until(() => checked(async () => {
        const state = await snap(); const offer = state.mailbox.find(row => row.taskId === taskA && row.type.startsWith('task.offer'));
        if (!offer || !state.localCursor || state.localCursor < offer.seq) return false;
        const curs = state.serverCursors.find(row => row.device_id === enrollment.deviceId);
        if (config.barrier.startsWith('pending-terminal')) {
          const terminalRow = state.journal.terminals?.find(row => row.task_id === taskA);
          const serverComplete = (await byok.tasks.get(taskA))?.state === 'Complete';
          return blockedTerminal && terminalRow?.truth_state === 'pending' &&
            serverComplete === (config.barrier === 'pending-terminal-response') &&
            state.journal.tasks.some(row => row.task_id === taskA && row.admitted === 1);
        }
        if ((await byok.tasks.get(taskA))?.state !== 'Complete') return false;
        return config.barrier === 'acked' ? curs?.acked_seq >= offer.seq && offer.state === 'acked' : blockedAck && curs?.acked_seq < offer.seq && offer.state === 'pending';
      }), `first:${config.barrier}`);
      const state = await snap(); await log({ kind: 'crash-barrier', barrier: config.barrier, taskId: taskA });
      await tail;
      process.send({ kind: 'crash-ready', taskA, deviceId: enrollment.deviceId, preStart, state });
      await new Promise(() => {}); // Parent kills this combined server + daemon process.
    }
    const emptyAtStart = emptyPolls;
    await until(() => checked(async () => {
      const state = await snap();
      // A new URL with an already-ACKed offer receives no envelope to advance
      // its local cursor. Server ACK + subsequent empty responses are authority.
      const allowAbsentCursor = config.changeUrl && config.barrier === 'acked' && !seenOffers.has(taskA);
      if (!hasAcknowledgedOffer(state, enrollment.deviceId, taskA, { allowAbsentCursor }) || emptyPolls < emptyAtStart + 2) return false;
      if ((await byok.tasks.get(taskA))?.state !== 'Complete') return false;
      if (config.journal && !state.journal.terminals.some(row => row.task_id === taskA && row.truth_state === 'confirmed')) return false;
      return true;
    }), 'recovery: durable offer ACK, terminal disposition, two subsequent empty polls');
    const recoveryBarrier = await snap();
    await log({ kind: 'recovery-barrier', taskId: taskA, completedPolls, emptyPolls });
    let taskB;
    if (config.dispatchB) {
      const handle = await byok.dispatch({ deviceId: enrollment.deviceId, instruction: 'attribution fixture', runtime: 'pi', policy: { mode: 'auto' } });
      taskB = handle.taskId;
      await log({ kind: 'dispatch', taskId: taskB, hostRequestId: config.hostRequestId, submission: 'B' });
      assert.notEqual(taskB, taskA);
      await until(() => checked(async () => {
        const state = await snap(); const offer = state.mailbox.find(row => row.taskId === taskB && row.type.startsWith('task.offer'));
        return hasAcknowledgedOffer(state, enrollment.deviceId, taskB) && (!config.journal || state.journal.terminals.some(row => row.task_id === taskB && row.truth_state === 'confirmed')) && (await byok.tasks.get(taskB))?.state === 'Complete';
      }), 'B: ACK and confirmed terminal');
    }
    const finalState = await snap(); await tail;
    return { kind: 'recovered', taskA, taskB: taskB ?? null, preStart, recoveryBarrier, finalState };
  } catch (error) {
    if (byok && diagnosticDeviceId) await log({ kind: 'failure-observation', state: await observation(root, config, serverUrl, diagnosticDeviceId) });
    throw error;
  } finally {
    await daemon?.stop();
    await byok?.close();
    if (http) await new Promise(resolve => { http.close(resolve); http.closeAllConnections?.(); });
    await tail;
  }
}

async function allocateUrls() {
  const servers = [net.createServer(), net.createServer()];
  try {
    for (const server of servers) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return servers.map(server => `http://127.0.0.1:${server.address().port}`);
  } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
}
function launch(stage, root) {
  const processChild = fork(import.meta.filename, ['--child', stage, root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exit = once(processChild, 'exit');
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { processChild.kill('SIGKILL'); reject(new Error(`child timeout: ${stage}`)); }, 35_000);
    processChild.once('message', message => { clearTimeout(timeout); message.kind === 'error' ? reject(new Error(message.message)) : resolve(message); });
    processChild.once('error', error => { clearTimeout(timeout); reject(error); });
    exit.then(([code, signal]) => { clearTimeout(timeout); if (code !== 0) reject(new Error(`child exit: ${stage}, code=${code}, signal=${signal}`)); });
  });
  return { process: processChild, response, exit };
}
async function runScenario(scenario, outDir) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-attribution-')); await fs.chmod(root, 0o700);
  const [firstUrl, alternateUrl] = await allocateUrls();
  const config = { ...scenario, productId: `probe-${randomUUID()}`, hostRequestId: randomUUID(), firstUrl,
    recoverUrl: scenario.changeUrl ? alternateUrl : firstUrl };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'signer.key'), randomBytes(32), { mode: 0o600 });
  const report = { scenario, startedAt: new Date().toISOString(), failureDomain: 'combined server + daemon child process', result: 'failed' };
  let active;
  try {
    active = launch('first', root); report.first = await active.response;
    active.process.kill('SIGKILL'); const [, signal] = await active.exit; assert.equal(signal, 'SIGKILL');
    config.taskA = report.first.taskA; // Diagnostic identity receipt, never supplied as dispatch identity.
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    active = launch('recover', root); report.recovery = await active.response; assert.deepEqual(await active.exit, [0, null]);
    report.events = await readEvents(root);
    assert.equal(report.first.deviceId, report.recovery.preStart.deviceId);
    assert.equal(report.first.state.serverUrl === report.recovery.preStart.serverUrl, !scenario.changeUrl);
    assert.equal(report.first.state.cursorNamespace === report.recovery.preStart.cursorNamespace, !scenario.changeUrl);
    if (scenario.changeUrl) assert.equal(report.recovery.preStart.localCursor, null);
    else assert.equal(report.recovery.preStart.localCursor, report.first.state.localCursor);
    const A = report.first.taskA; const B = report.recovery.taskB;
    report.counts = validateStarts(report.events, B ? [A, B] : [A], { [A]: scenario.expectedA, ...(B ? { [B]: 1 } : {}) });
    if (scenario.journal) {
      const before = report.first.state.journal.terminals.find(row => row.task_id === A);
      const after = report.recovery.recoveryBarrier.journal.terminals.find(row => row.task_id === A);
      assert.equal(before.payload_hash, after.payload_hash); assert.equal(after.truth_state, 'confirmed');
      assert.ok(report.events.some(event => event.stage === 'recover' && event.kind === 'terminal-send' && event.taskId === A && event.payloadHash === before.payload_hash));
    }
    report.result = 'passed';
  } catch (error) { report.error = String(error.message).replaceAll(root, '<test-root>'); }
  finally {
    if (active && active.process.exitCode === null && active.process.signalCode === null) { active.process.kill('SIGKILL'); await active.exit; }
    report.events ??= await readEvents(root);
    try {
      const cleanup = launch('cleanup', root); report.cleanup = await cleanup.response; assert.deepEqual(await cleanup.exit, [0, null]);
      await fs.rm(root, { recursive: true, force: true }); report.testStateRemoved = true;
    } catch (error) { report.cleanupError = String(error.message).replaceAll(root, '<test-root>'); report.result = 'failed'; }
    await fs.writeFile(path.join(outDir, `${scenario.name}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ scenario: scenario.name, result: report.result, counts: report.counts, error: report.error, testStateRemoved: report.testStateRemoved }));
  return report;
}
if (process.argv[2] === '--child') {
  try { const result = await child(process.argv[3], process.argv[4]); process.send?.(result); }
  catch (error) { process.send?.({ kind: 'error', message: String(error.message).replaceAll(process.argv[4], '<test-root>') }); process.exitCode = 1; }
  finally { process.disconnect?.(); }
} else {
  assert.equal(process.env.BYOK_TEST_DEVICE_CREDENTIAL_STORE, undefined, 'probe requires actual OS test enrollment');
  const outAt = process.argv.indexOf('--out'); assert.ok(outAt >= 0 && process.argv[outAt + 1], '--out <new evidence directory> required');
  const outDir = path.resolve(process.argv[outAt + 1]); await fs.mkdir(outDir, { recursive: false, mode: 0o700 });
  const onlyAt = process.argv.indexOf('--scenario'); const chosen = onlyAt < 0 ? scenarios : scenarios.filter(scenario => scenario.name === process.argv[onlyAt + 1]);
  assert.ok(chosen.length > 0, 'unknown scenario');
  for (const scenario of chosen) { const result = await runScenario(scenario, outDir); if (result.result !== 'passed') { process.exitCode = 1; break; } }
}
