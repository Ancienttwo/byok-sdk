// Executable acceptance consumer, not AiphaBee production wiring.
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { createByokServer, createHmacTokenSigner } from '@byok-sdk/server';
import { createEnvelope } from '@byok-sdk/protocol';

// One immutable host binding per authenticated scope + external request + execution branch.
// This fixture uses an explicit legacy readonly operation; it grants no message tools.
function openHost(path, scope) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS request_binding (
      scope TEXT NOT NULL, request_id TEXT NOT NULL, operation_key TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL,
      PRIMARY KEY(scope, request_id, operation_key));`);
  return {
    bind(requestId, operationKey, input) {
      assert.equal(input.taskId, undefined);
      assert.equal(typeof input.deviceId, 'string');
      const body = JSON.stringify(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO request_binding VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope,request_id,operation_key) DO NOTHING')
          .run(scope, requestId, operationKey, randomUUID(), body);
        const row = db.prepare('SELECT task_id, input_json FROM request_binding WHERE scope=? AND request_id=? AND operation_key=?')
          .get(scope, requestId, operationKey);
        assert.equal(row.input_json, body, 'host request identity conflicts with immutable input');
        db.exec('COMMIT');
        return { taskId: row.task_id, ...JSON.parse(row.input_json) };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}

async function recoverOrDispatch(byok, binding) {
  function verify(offer) {
    assert.equal(offer.taskId, binding.taskId);
    assert.equal(offer.deviceId, binding.deviceId);
    assert.equal(offer.type, 'task.offer');
    assert.deepEqual(offer.payload, { instruction: binding.instruction, policy: binding.policy, runtime: binding.runtime });
    return offer.delivered;
  }
  const existing = await byok.tasks.offer(binding.taskId);
  if (existing && verify(existing)) return existing;
  try { await byok.dispatch(binding); }
  catch (error) {
    const recorded = await byok.tasks.offer(binding.taskId);
    if (!recorded || !verify(recorded) || !recorded.delivered) throw error;
    return recorded;
  }
  const recorded = await byok.tasks.offer(binding.taskId);
  assert.ok(recorded && verify(recorded) && recorded.delivered);
  return recorded;
}

const root = mkdtempSync(join(tmpdir(), 'byok-public-request-'));
const productId = 'public-request-probe';
const serverOptions = { productId, storage: { kind: 'sqlite', path: join(root, 'server.sqlite') },
  tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(9), { now: () => new Date() }), longPollHoldMs: 5 };
const scope = 'fixture-authenticated-account/workspace';
const hostPath = join(root, 'host.sqlite');
let host = openHost(hostPath, scope);
let byok;
let http;
let port = 0;
let url;
let token;
let cursor = 0;
const starts = [];
async function openServer() {
  byok = createByokServer(serverOptions);
  http = await new Promise(resolve => {
    const instance = serve({ fetch: byok.hono.fetch, port, hostname: '127.0.0.1' }, info => {
      port = info.port; url = `http://127.0.0.1:${port}`; resolve(instance);
    });
  });
}
async function closeServer() {
  if (http) { const instance = http; http = undefined; await new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }); }
  if (byok) { await byok.close(); byok = undefined; }
}
async function json(path, body) {
  const response = await fetch(`${url}${path}`, { method: body === undefined ? 'GET' : 'POST',
    // Each request closes its socket so intentional server reopen cannot reuse a stale client pool connection.
    headers: { connection: 'close', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, 200);
  return response.json();
}
async function send(type, payload, taskId) {
  const result = await json('/byok/messages', { messages: [createEnvelope(type, payload, taskId ? { taskId } : undefined)] });
  assert.equal(result.accepted, 1); assert.equal(result.rejected ?? 0, 0);
}
async function poll() {
  const result = await json(`/byok/events?cursor=${cursor}`); cursor = result.cursor; return result.events;
}
async function restart() {
  host.close(); await closeServer(); host = openHost(hostPath, scope); await openServer();
}
try {
  await openServer();
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  const code = await byok.pairing.createPairingCode({ productId });
  const enrollment = await json('/byok/pair', { pairingCode: code.code, deviceName: 'fixture', devicePublicKey: publicKey });
  token = enrollment.accessToken;
  const deviceId = enrollment.deviceId;
  async function announce() {
    await send('conn.hello', { protocolVersions: [1], capabilities: [], deviceId, productId });
    await poll();
  }
  await announce();
  const input = { deviceId, instruction: 'sealed fixture input', runtime: 'claude', policy: { mode: 'readonly' } };
  const requestId = randomUUID();
  const first = host.bind(requestId, 'cycle-1/support', input);
  // Interruption after host commit but before enqueue: no SDK task exists yet.
  assert.equal(await byok.tasks.get(first.taskId), undefined);
  await restart(); await announce();
  const recoveredBinding = host.bind(requestId, 'cycle-1/support', input);
  assert.deepEqual(recoveredBinding, first);
  // SDK enqueue succeeds; simulate lost host response by discarding the handle,
  // then reopening both stores before any host acceptance is recorded.
  await byok.dispatch(recoveredBinding);
  await restart();
  const offer = await recoverOrDispatch(byok, host.bind(requestId, 'cycle-1/support', input));
  assert.equal(offer.taskId, first.taskId);
  // Existing durable delivery can be read while the device is offline after restart.
  assert.equal((await byok.machines.list())[0].connected, false);
  const events = await poll();
  const offers = events.filter(event => event.type === 'task.offer');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].task_id, first.taskId);
  const sessionRef = randomUUID();
  starts.push({ taskId: first.taskId, offerId: offers[0].id, seq: offers[0].seq, sessionRef });
  await send('task.claim', { deviceId, runtime: 'claude' }, first.taskId);
  await send('task.started', {}, first.taskId);
  await send('task.complete', { summary: 'fixture complete', sessionRef }, first.taskId);
  await poll(); // Sends the cursor that ACKs the original offer.
  await byok.mailbox.collectRetired({ deviceId, ackedBefore: '2999-01-01T00:00:00.000Z', expireUnackedBefore: '2999-01-01T00:00:00.000Z' });
  await restart();
  assert.deepEqual(await recoverOrDispatch(byok, host.bind(requestId, 'cycle-1/support', input)), offer);
  assert.equal((await byok.tasks.get(first.taskId)).result.summary, 'fixture complete');
  assert.equal((await poll()).filter(event => event.type === 'task.offer').length, 0);
  assert.throws(() => host.bind(requestId, 'cycle-1/support', { ...input, instruction: 'changed' }), /conflicts/);
  await assert.rejects(recoverOrDispatch(byok, { ...first, instruction: 'changed' }));
  const second = host.bind(requestId, 'cycle-2/support', input);
  assert.notEqual(second.taskId, first.taskId);
  await announce(); await recoverOrDispatch(byok, second);
  await byok.tasks.cancel(second.taskId, 'fixture cancellation');
  await restart();
  assert.equal((await byok.tasks.get(second.taskId)).result.state, 'Cancelled');
  const otherHost = openHost(hostPath, 'other-account/workspace');
  try { assert.notEqual(otherHost.bind(requestId, 'cycle-1/support', input).taskId, first.taskId); }
  finally { otherHost.close(); }
  console.log(JSON.stringify({ passed: true, failureDomain: 'host and server close/reopen at selected commit boundaries',
    publicImportsOnly: true, fixedServerUrl: true, preEnqueueBindingSurvived: true,
    postEnqueueResponseLossRecovered: true, completedIdentitySurvivesRetention: true,
    hostAndSdkPayloadConflictsRejected: true, cycleIdentityDistinct: true, scopeBindingDistinct: true,
    cancellationReadAfterRestart: true, simulatedDeviceStarts: starts,
    limitations: 'Manual task.started from a fake device; no RuntimeAdapter.start, SIGKILL, real provider, product wiring or consumer ACK.' }, null, 2));
} finally { host.close(); await closeServer(); rmSync(root, { recursive: true, force: true }); }
