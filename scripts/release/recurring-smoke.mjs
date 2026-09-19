/**
 * Recurring packed smoke, run against INSTALLED tarballs from an isolated npm
 * install (see pack-and-smoke.mjs, which copies this file next to
 * `node_modules`). Two legs, and neither is allowed to silently stand in for
 * the other (issue #196):
 *
 * - **In-memory leg (always runs).** Strict fresh-submission admission, offer
 *   read-back, duplicate rejection, cancel-vs-device-terminal separation —
 *   plus, since #196, REAL message resolution through the supported
 *   authenticated inbound path: a paired device publishes
 *   `agent.message.publish` over `POST /byok/messages`, a product consumer
 *   decides, and the public read-back surfaces
 *   (`readAgentMessageDisposition`, `readTaskAgentMessage`) must return the
 *   non-empty payload, the frozen context, and the exact disposition — for an
 *   accepted AND a non-accepted outcome, after a finalize outage the product
 *   already committed through, after cancellation, and never across a
 *   different tenant/device/task/AgentRef/body. The same accepted/held
 *   scenarios also run end-to-end through the EMBEDDED public façade
 *   (`createByokServer`: pairing, `conn.hello` capability declaration,
 *   `recurring.submit`, `POST /byok/messages` over `server.hono`, read-back
 *   through `tasks.messageDisposition`/`tasks.agentMessage`), and the
 *   embedded read-back must match the cloud projection exactly.
 * - **Durable restart leg (only when the dataplane substrate is configured).**
 *   The standard env pair (`BYOK_TEST_POSTGRES_URL` + `BYOK_TEST_S3_ENDPOINT`,
 *   the same one `packages/cloud-dataplane`'s suites use) selects a real
 *   Postgres composition built from the installed `@byok-sdk/cloud-dataplane`
 *   tarball. Process A commits a consumer transaction and its terminal; an
 *   INDEPENDENT process then reopens the same composition on the SAME store
 *   and proves public read-back with no live TaskHandle, and that an exact
 *   replay invokes the product consumer ZERO times (byte identical
 *   disposition, attempt unchanged) — the observable this smoke has for "no
 *   new model Execution": it counts consumer callbacks, not executions the
 *   product then runs on its own. The Host body-transaction crash window is
 *   orchestrated on the same substrate: one fresh process commits the
 *   persistent product ledger's entry and dies abruptly BEFORE SDK finalize
 *   (a finalize probe proves it never ran); a second fresh process replays
 *   the exact identity against the SAME ledger and store — one committed
 *   body, identical outcome, reconciled disposition. `BYOK_REQUIRE_DATAPLANE=1`
 *   turns a missing substrate into a hard failure — the same law as
 *   `packages/cloud-dataplane/src/__tests__/support/dataplane.ts`, because a
 *   leg that skipped would still print success. Where the substrate is
 *   structurally absent (the 3-OS release-pack legs) the leg is absent, never
 *   skipped-while-counting-as-covered.
 *
 * The peer/runtime fixture is deterministic and synthetic: the product
 * consumer is a plain function over an in-memory ledger and nothing here calls
 * a real model. A green run is installed-artifact evidence, not provider
 * acceptance.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tenantId } from '@byok-sdk/core';
import {
  CLOUD_CAPABILITIES, createByokCloud, createHmacTokenSigner, createWebCrypto,
  fullCapabilityDeclaration, createInMemoryByokCloud, RecurringExecutionInputSchema,
} from '@byok-sdk/cloud';
import { createEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { createByokServer } from '@byok-sdk/server';

const CLOUD_ORIGIN = 'http://cloud.test';
const AGENT_MESSAGE_CAPABILITIES = [
  'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'agent-message-egress', 'terminal-projection-selection',
];
const MESSAGE_CONTEXT = { destinationBinding: 'conversation', freshnessCursor: 'turn' };

// ---------------------------------------------------------------------------
// Deterministic product-side fixture. The consumer IS the product's execution
// trigger in this smoke: it is called on the admission path, never by recovery
// alone, so `calls.length` is the honest consumer-invocation counter — the
// trigger a product starts a model Execution from. The smoke counts callbacks;
// it does not observe executions the product then runs on its own.
// Its ledger is the product-owned durable dedup the consumer contract requires:
// at-least-once delivery must still produce ONE logical effect per exact
// message identity — which is why a second consume invocation is expected and
// asserted in the finalize-outage scenario, never hidden.
// ---------------------------------------------------------------------------
function createProductConsumer(outcomesByTask) {
  const calls = [];
  const committed = new Map();
  const consume = async ({ taskId, payload }) => {
    calls.push({ taskId, messageId: payload.messageId });
    if (!committed.has(payload.messageId)) {
      committed.set(payload.messageId, outcomesByTask[taskId] ?? { outcome: 'accepted' });
    }
    return committed.get(payload.messageId);
  };
  return { calls, committed, consume };
}

// ---------------------------------------------------------------------------
// Bounded PERSISTENT product ledger (fixture only): the stand-in for the
// product-owned durable dedup a real host commits its body transaction into.
// A JSON file keyed by full scoped identity (tenant, device, task, AgentRef,
// messageId), write-once — a second commit under the same identity is a bug
// and throws, so "the body is persisted exactly once" is enforced by the
// fixture itself, not only by post-hoc assertion. It survives process death
// by construction, which is the whole point of the crash-window leg.
// ---------------------------------------------------------------------------
function createPersistentProductLedger(filePath) {
  const read = () => (existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : {});
  const scopeKey = ({ tenant, deviceId, taskId, agentRef, messageId }) =>
    [`${tenant}`, deviceId, taskId, `${agentRef.agentId}@${agentRef.profileRevision}`, messageId].join('|');
  return {
    scopeKey,
    lookup(identity) { return read()[scopeKey(identity)]; },
    size() { return Object.keys(read()).length; },
    commit(identity, body, context, outcome) {
      const entries = read();
      const key = scopeKey(identity);
      if (entries[key] !== undefined) throw new Error(`product ledger double commit for identity ${key}`);
      entries[key] = { body, context, outcome };
      writeFileSync(filePath, JSON.stringify(entries));
      return entries[key];
    },
  };
}

async function pairCapableDevice(composition, tenant, deviceName) {
  // The pairing route is the supported way to mint a device bearer token; the
  // harness idiom (packages/cloud/src/__tests__/support/harness.ts) needs a
  // quota entitlement first. The ed25519 keypair plays the device role.
  await composition.core.quota.writeEntitlement(tenant, {
    version: 1n,
    hardLimitBytes: 1_000_000_000n,
    maxObjectBytes: 100_000_000n,
    maxInlineBytes: 1_000_000n,
    mailboxLimitBytes: 100_000_000n,
    retentionPolicyId: 'packed',
  });
  const { publicKey } = generateKeyPairSync('ed25519');
  const devicePublicKey = publicKey.export({ format: 'jwk' }).x;
  if (typeof devicePublicKey !== 'string') throw new Error('ed25519 public key has no JWK x coordinate');
  const pairing = await composition.cloud.createPairingCode(tenant, { productId: 'packed-recurring' });
  const response = await composition.cloud.fetch(new Request(`${CLOUD_ORIGIN}/byok/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: pairing.code, deviceName, devicePublicKey }),
  }));
  assert.equal(response.status, 200, `pairing failed: HTTP ${response.status}`);
  const paired = await response.json();
  assert.equal(typeof paired.deviceId, 'string');
  assert.equal(typeof paired.accessToken, 'string');
  await composition.stores.devices.recordCapabilities(tenant, { deviceId: paired.deviceId, capabilities: AGENT_MESSAGE_CAPABILITIES });
  return { deviceId: paired.deviceId, authorization: { authorization: `Bearer ${paired.accessToken}` } };
}

function recurringInput(taskId, deviceId, instruction, agentRef = { agentId: 'packed-agent', profileRevision: 'profile' }) {
  return RecurringExecutionInputSchema.parse({
    taskId, deviceId,
    payload: { instruction, runtime: 'codex', policy: { mode: 'auto' },
      agentRef,
      egressPolicy: { policyRevision: 'policy', activity: { mode: 'metadata-status', delivery: 'latest-value' },
        reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
        transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' } },
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
      terminalProjection: { mode: 'none' } },
    agentMessageContext: MESSAGE_CONTEXT,
  });
}

const MESSAGE_BODY = 'packed persisted reply body — read back through the installed tarball, not a stub';
const messagePayload = (agentRef) => ({
  agentRef,
  sessionRef: 'packed-session-1',
  contract: 'conversation-turn/v1',
  messageId: randomUUID(),
  cursor: 1,
  contentType: 'text/markdown',
  body: MESSAGE_BODY,
  contentHash: `sha256:${createHash('sha256').update(MESSAGE_BODY).digest('hex')}`,
  byteCount: Buffer.byteLength(MESSAGE_BODY, 'utf8'),
});

/**
 * The one supported authenticated inbound path: `POST /byok/messages` over the
 * cloud's fetch handler. The envelope is built by the caller and reused
 * verbatim for every replay, because "exact replay" means the same envelope
 * identity, not a re-minted one.
 */
async function publishAgentMessage(cloud, authorization, envelope) {
  return cloud.fetch(new Request(`${CLOUD_ORIGIN}/byok/messages`, {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [envelope] }),
  }));
}

const publishEnvelope = (taskId, payload) => createEnvelope('agent.message.publish', payload, { taskId });

function assertExactDisposition(receipt, payload, outcome, reasonCode) {
  assert.equal(receipt.outcome, outcome);
  if (reasonCode === undefined) assert.equal(receipt.reasonCode, undefined);
  else assert.equal(receipt.reasonCode, reasonCode);
  assert.deepEqual(
    { ...receipt, receiptId: undefined },
    { agentRef: payload.agentRef, sessionRef: payload.sessionRef, contract: payload.contract,
      messageId: payload.messageId, cursor: payload.cursor, contentHash: payload.contentHash,
      outcome, receiptId: undefined, ...(reasonCode === undefined ? {} : { reasonCode }) },
  );
  assert.match(receipt.receiptId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
}

/**
 * The disposition minus the two minted UUIDs — the per-message `messageId`
 * (already tied to its own payload by `assertExactDisposition`) and the
 * per-composition `receiptId`. Everything else must match EXACTLY across the
 * cloud and embedded read-back surfaces for the same scenario.
 */
const decisionProjection = (receipt) => ({
  agentRef: receipt.agentRef,
  sessionRef: receipt.sessionRef,
  contract: receipt.contract,
  cursor: receipt.cursor,
  contentHash: receipt.contentHash,
  outcome: receipt.outcome,
  ...(receipt.reasonCode === undefined ? {} : { reasonCode: receipt.reasonCode }),
});

// ---------------------------------------------------------------------------
// Child-process branches. Each runs INSTEAD of the legs below, is handed its
// state through a handoff file, and composes a fresh durable composition over
// the SAME database (`composeReopened`).
// ---------------------------------------------------------------------------
const childArg = (flag) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};

/**
 * One fresh durable composition over a handoff's database — the recipe every
 * child process (reopen, crash-commit, crash-replay) shares. When
 * `finalizeProbePath` is given, the composition's store records the first SDK
 * finalize call into that file, so a parent can prove a crashed child died
 * BEFORE finalize (file absent) and a replaying child finalized (file present).
 */
async function composeReopened(handoff, consume, finalizeProbePath) {
  const { createByokPool, createPostgresCloudStores, createPostgresCoreStores } = await import('@byok-sdk/cloud-dataplane');
  const clock = { now: () => new Date() };
  const crypto = createWebCrypto();
  const tokenSecret = new Uint8Array(Buffer.from(handoff.tokenSecretB64, 'base64'));
  // A NEW pool and NEW store objects over the SAME database.
  const pool = createByokPool({ connectionString: handoff.databaseUrl });
  const cloudStores = createPostgresCloudStores({ pool, clock, crypto, objectStorage: handoff.objectStorage });
  if (finalizeProbePath !== undefined) {
    const realFinalize = cloudStores.tasks.finalizeAgentMessage.bind(cloudStores.tasks);
    cloudStores.tasks.finalizeAgentMessage = async (...args) => {
      writeFileSync(finalizeProbePath, `finalize observed in pid ${process.pid}\n`);
      return realFinalize(...args);
    };
  }
  const full = fullCapabilityDeclaration();
  const cloud = createByokCloud({
    core: createPostgresCoreStores({ pool, clock }),
    cloud: cloudStores,
    crypto,
    tokenSigner: createHmacTokenSigner(tokenSecret, clock),
    clock,
    capabilities: { ...full, capabilities: full.capabilities.filter((capability) => capability !== CLOUD_CAPABILITIES.blobsContentProxy) },
    agentMessage: { consume },
  });
  return { cloud, pool };
}

// Reopen branch: prove recovery from durable state alone — this process never
// dispatched the task, so no TaskHandle exists here.
const reopenHandoffPath = childArg('--recurring-reopen');
if (reopenHandoffPath !== undefined) {
  const handoff = JSON.parse(readFileSync(reopenHandoffPath, 'utf8'));
  const consumer = createProductConsumer({});
  const { cloud: reopened, pool } = await composeReopened(handoff, consumer.consume);
  try {
    const reopenTenant = tenantId(handoff.tenant);
    const message = await reopened.readTaskAgentMessage(reopenTenant, handoff.deviceId, handoff.taskId, handoff.agentRef);
    assert.equal(message.payload.body.length > 0, true);
    assert.deepEqual(message.payload, handoff.payload);
    assert.deepEqual(message.context, handoff.context);
    assert.deepEqual(message.disposition, handoff.expectedDisposition);
    assert.deepEqual(
      await reopened.readAgentMessageDisposition(reopenTenant, handoff.deviceId, handoff.taskId, handoff.payload),
      handoff.expectedDisposition,
    );
    const attemptBefore = await reopened.readTaskAttempt(reopenTenant, handoff.taskId);
    // Exact replay (same envelope identity) on the REOPENED composition:
    // wire-level success, byte identical disposition (same receiptId — no new
    // decision), and the consumer is never invoked — ZERO consumer-callback
    // invocations on recovery, the observable this smoke has for a started
    // model Execution (it counts callbacks, not executions the product runs).
    const replay = await publishAgentMessage(reopened, { authorization: `Bearer ${handoff.accessToken}` }, handoff.envelope);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { accepted: 1 });
    assert.equal(consumer.calls.length, 0);
    assert.deepEqual(await reopened.readTaskAttempt(reopenTenant, handoff.taskId), attemptBefore);
    assert.deepEqual(
      await reopened.readAgentMessageDisposition(reopenTenant, handoff.deviceId, handoff.taskId, handoff.payload),
      handoff.expectedDisposition,
    );
    console.log('[release-pack] recurring durable restart: reopened-process public read-back with no TaskHandle and zero-consumer-invocation replay passed');
  } finally {
    await pool.end();
  }
  process.exit(0);
}

// Crash-commit branch (Host body transaction, then abrupt death): the
// consumer writes the persistent product ledger — the Host's own durable
// commit — and exits the process BEFORE the consume promise resolves, so the
// SDK finalize provably never runs (the probe file stays absent).
const ledgerIdentityOf = (input) => ({
  tenant: input.tenant,
  deviceId: input.deviceId,
  taskId: input.taskId,
  agentRef: input.payload.agentRef,
  messageId: input.payload.messageId,
});

const crashCommitHandoffPath = childArg('--recurring-crash-commit');
if (crashCommitHandoffPath !== undefined) {
  const handoff = JSON.parse(readFileSync(crashCommitHandoffPath, 'utf8'));
  const ledger = createPersistentProductLedger(handoff.ledgerPath);
  const consume = async (input) => {
    // Host body transaction: the synchronous ledger write IS the commit.
    ledger.commit(ledgerIdentityOf(input), input.payload.body, input.context, { outcome: 'accepted' });
    process.exit(86); // simulated crash: no consume return, no SDK finalize
  };
  const { cloud, pool } = await composeReopened(handoff, consume, handoff.finalizeProbePath);
  try {
    await cloud.submitRecurringExecution(tenantId(handoff.tenant), recurringInput(handoff.taskId, handoff.deviceId, 'crash window host commit', handoff.agentRef));
    const response = await publishAgentMessage(cloud, { authorization: `Bearer ${handoff.accessToken}` }, handoff.envelope);
    // Unreachable on the intended path: consume exits the process first.
    throw new Error(`crash-commit child survived publish (HTTP ${response.status}) — the abrupt exit never happened`);
  } finally {
    await pool.end();
  }
}

// Crash-replay branch (second fresh process, SAME ledger, SAME store): the
// crashed admission is still pending; the exact identity replay reconciles it
// from the ledger's stored decision — no second commit, identical outcome.
const crashReplayHandoffPath = childArg('--recurring-crash-replay');
if (crashReplayHandoffPath !== undefined) {
  const handoff = JSON.parse(readFileSync(crashReplayHandoffPath, 'utf8'));
  const ledger = createPersistentProductLedger(handoff.ledgerPath);
  const replays = [];
  const consume = async (input) => {
    replays.push(ledgerIdentityOf(input));
    const entry = ledger.lookup(ledgerIdentityOf(input));
    if (entry === undefined) throw new Error('crash-replay consumer missed the ledger — the host commit did not persist across the crash');
    return entry.outcome; // the stored decision: no second commit
  };
  const { cloud: reopened, pool } = await composeReopened(handoff, consume, handoff.finalizeProbePath);
  const replayTenant = tenantId(handoff.tenant);
  try {
    // The crashed admission is still pending: no disposition yet, body visible.
    assert.equal(await reopened.readAgentMessageDisposition(replayTenant, handoff.deviceId, handoff.taskId, handoff.payload), undefined);
    assert.deepEqual(
      await reopened.readTaskAgentMessage(replayTenant, handoff.deviceId, handoff.taskId, handoff.agentRef),
      { payload: handoff.payload, context: handoff.context },
    );
    const replay = await publishAgentMessage(reopened, { authorization: `Bearer ${handoff.accessToken}` }, handoff.envelope);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { accepted: 1 });
    assert.equal(replays.length, 1); // at-least-once delivery reconciled the pending admission
    const receipt = await reopened.readAgentMessageDisposition(replayTenant, handoff.deviceId, handoff.taskId, handoff.payload);
    assertExactDisposition(receipt, handoff.payload, 'accepted');
    assert.deepEqual(
      await reopened.readTaskAgentMessage(replayTenant, handoff.deviceId, handoff.taskId, handoff.agentRef),
      { payload: handoff.payload, context: handoff.context, disposition: receipt },
    );
    assert.equal(existsSync(handoff.finalizeProbePath), true, 'SDK finalize must run in the replaying process');
    assert.equal(ledger.size(), 1); // still exactly one committed body after the replay
    console.log('[release-pack] recurring crash window: replaying process reconciled the pending admission from the persistent ledger — one committed body, identical outcome, finalize observed');
  } finally {
    await pool.end();
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// In-memory leg (always). The original strict-submission assertions stay
// verbatim; the message round-trips are appended below them.
// ---------------------------------------------------------------------------
const tenant = tenantId('packed-recurring');
const deviceId = 'packed-device';
const { cloud, stores } = createInMemoryByokCloud({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
await stores.devices.register(tenant, { deviceId, productId: 'packed', deviceName: 'fixture', devicePublicKey: 'fixture-key', proofKeyId: 'fixture-proof', proofKeyEpoch: 1 });
await stores.devices.recordCapabilities(tenant, { deviceId, capabilities: AGENT_MESSAGE_CAPABILITIES });
const input = recurringInput('packed-execution', deviceId, 'persisted current input');
const submitted = await cloud.submitRecurringExecution(tenant, JSON.parse(JSON.stringify(input)));
assert.equal(submitted.taskId, input.taskId);
assert.equal(submitted.envelope.type, 'task.offer_for_agent_with_egress_fresh');
assert.equal('sessionRef' in submitted.envelope.payload, false);
assert.deepEqual((await cloud.readTaskOffer(tenant, input.taskId)).payload, input.payload);
await assert.rejects(cloud.submitRecurringExecution(tenant, input));
assert.equal(await cloud.readDeviceTerminal(tenant, input.taskId), undefined);
await cloud.cancelTask(tenant, input.taskId, 'packed stop');
assert.equal((await cloud.readTaskResult(tenant, input.taskId)).state, 'cancelled');
assert.equal(await cloud.readDeviceTerminal(tenant, input.taskId), undefined);
assert.equal(typeof cloud.readAgentMessageDisposition, 'function');
assert.equal(typeof cloud.readTaskAgentMessage, 'function');
assert.equal(await cloud.readTaskAgentMessage(tenant, deviceId, input.taskId, input.payload.agentRef), undefined);
const server = createByokServer({ productId: 'packed-recurring' });
try {
  assert.equal(typeof server.recurring.submit, 'function');
  assert.equal(typeof server.tasks.messageDisposition, 'function');
  assert.equal(typeof server.tasks.agentMessage, 'function');
  assert.equal(await server.tasks.agentMessage('absent', deviceId, input.payload.agentRef), undefined);
  assert.equal(await server.tasks.attempt('absent'), undefined);
  assert.equal(await server.tasks.deviceTerminal('absent'), undefined);
  await assert.rejects(server.recurring.submit(input), /registered Agent message consumer/);
} finally { server.stop(); }
console.log('[release-pack] recurring public imports, strict submission and independent device observation passed');

// --- issue #196: real message resolution through the authenticated inbound path.
{
  const msgTenant = tenantId('packed-recurring-msg');
  const otherTenant = tenantId('packed-recurring-other');
  const agentRef = { agentId: 'packed-msg-agent', profileRevision: 'profile' };
  const consumer = createProductConsumer({
    'packed-held-task': { outcome: 'held', reasonCode: 'product_queue_full' },
  });
  const composition = createInMemoryByokCloud({ agentMessage: { consume: consumer.consume } });
  const device = await pairCapableDevice(composition, msgTenant, 'packed-msg-device');
  const submit = (taskId) => composition.cloud.submitRecurringExecution(msgTenant, recurringInput(taskId, device.deviceId, `resolve ${taskId}`, agentRef));
  const readDisposition = (t, taskId, payload) => composition.cloud.readAgentMessageDisposition(t, device.deviceId, taskId, payload);
  const readMessage = (t, taskId, ref) => composition.cloud.readTaskAgentMessage(t, device.deviceId, taskId, ref);

  // Accepted outcome: non-empty payload, frozen context, exact disposition.
  const acceptedTask = 'packed-accepted-task';
  await submit(acceptedTask);
  const acceptedPayload = messagePayload(agentRef);
  const acceptedEnvelope = publishEnvelope(acceptedTask, acceptedPayload);
  assert.equal(await readDisposition(msgTenant, acceptedTask, acceptedPayload), undefined);
  assert.deepEqual(await readMessage(msgTenant, acceptedTask, agentRef), undefined);
  const acceptedResponse = await publishAgentMessage(composition.cloud, device.authorization, acceptedEnvelope);
  assert.equal(acceptedResponse.status, 200);
  assert.deepEqual(await acceptedResponse.json(), { accepted: 1 });
  const receipt = await readDisposition(msgTenant, acceptedTask, acceptedPayload);
  assertExactDisposition(receipt, acceptedPayload, 'accepted');
  const acceptedMessage = await readMessage(msgTenant, acceptedTask, agentRef);
  assert.equal(acceptedMessage.payload.body.length > 0, true);
  assert.deepEqual(acceptedMessage.payload, acceptedPayload);
  assert.deepEqual(acceptedMessage.context, MESSAGE_CONTEXT);
  assert.deepEqual(acceptedMessage.disposition, receipt);

  // Non-accepted outcome: a held decision stays held on every read-back
  // surface — never re-presented as a displayable accepted body.
  const heldTask = 'packed-held-task';
  await submit(heldTask);
  const heldPayload = messagePayload(agentRef);
  const heldResponse = await publishAgentMessage(composition.cloud, device.authorization, publishEnvelope(heldTask, heldPayload));
  assert.equal(heldResponse.status, 200);
  assert.deepEqual(await heldResponse.json(), { accepted: 1 }); // transport accepted; business decision held
  const heldReceipt = await readDisposition(msgTenant, heldTask, heldPayload);
  assert.notEqual(heldReceipt, undefined);
  assertExactDisposition(heldReceipt, heldPayload, 'held', 'product_queue_full');
  const heldMessage = await readMessage(msgTenant, heldTask, agentRef);
  assert.deepEqual(heldMessage.payload, heldPayload);
  assert.deepEqual(heldMessage.disposition, heldReceipt);
  assert.notEqual(heldMessage.disposition.outcome, 'accepted');

  // Finalize outage AFTER the product transaction committed: admission stays
  // pending, the exact replay reconciles it with the same identity, the
  // consumer runs AGAIN (at-least-once delivery — never a once contract), the
  // product ledger still holds ONE logical effect, and the Host body is not
  // duplicated.
  const recoveryTask = 'packed-recovery-task';
  await submit(recoveryTask);
  const recoveryPayload = messagePayload(agentRef);
  const recoveryEnvelope = publishEnvelope(recoveryTask, recoveryPayload);
  const realFinalize = composition.stores.tasks.finalizeAgentMessage.bind(composition.stores.tasks);
  let finalizeOutageArmed = true;
  composition.stores.tasks.finalizeAgentMessage = async (...args) => {
    if (finalizeOutageArmed) {
      finalizeOutageArmed = false;
      throw new Error('injected finalize outage after the consumer committed');
    }
    return realFinalize(...args);
  };
  const outageResponse = await publishAgentMessage(composition.cloud, device.authorization, recoveryEnvelope);
  assert.equal(outageResponse.status >= 500, true, `finalize outage must surface as a failed response, got ${outageResponse.status}`);
  assert.equal(consumer.calls.length, 3); // accepted + held + recovery first attempt
  assert.equal(consumer.committed.has(recoveryPayload.messageId), true); // product transaction committed
  assert.equal(await readDisposition(msgTenant, recoveryTask, recoveryPayload), undefined); // pending has no disposition
  assert.deepEqual(await readMessage(msgTenant, recoveryTask, agentRef), { payload: recoveryPayload, context: MESSAGE_CONTEXT });
  const recoveryResponse = await publishAgentMessage(composition.cloud, device.authorization, recoveryEnvelope);
  assert.equal(recoveryResponse.status, 200);
  assert.deepEqual(await recoveryResponse.json(), { accepted: 1 });
  assert.equal(consumer.calls.length, 4); // at-least-once: the consumer reconciled the pending admission
  assert.equal(consumer.calls.filter((call) => call.messageId === recoveryPayload.messageId).length, 2);
  assert.equal(consumer.committed.get(recoveryPayload.messageId).outcome, 'accepted'); // one logical effect
  const recoveryReceipt = await readDisposition(msgTenant, recoveryTask, recoveryPayload);
  assertExactDisposition(recoveryReceipt, recoveryPayload, 'accepted');
  assert.deepEqual(await readMessage(msgTenant, recoveryTask, agentRef), { payload: recoveryPayload, context: MESSAGE_CONTEXT, disposition: recoveryReceipt });
  composition.stores.tasks.finalizeAgentMessage = realFinalize;
  // A third exact replay is a pure duplicate: no third consumer invocation.
  const duplicateResponse = await publishAgentMessage(composition.cloud, device.authorization, recoveryEnvelope);
  assert.deepEqual(await duplicateResponse.json(), { accepted: 1 });
  assert.equal(consumer.calls.length, 4);
  assert.deepEqual(await readDisposition(msgTenant, recoveryTask, recoveryPayload), recoveryReceipt);

  // Cancel after acceptance keeps the durable decision; cancel intent never
  // becomes a device terminal.
  const cancelTask = 'packed-cancel-after-accept';
  await submit(cancelTask);
  const cancelPayload = messagePayload(agentRef);
  await publishAgentMessage(composition.cloud, device.authorization, publishEnvelope(cancelTask, cancelPayload));
  const cancelReceipt = await readDisposition(msgTenant, cancelTask, cancelPayload);
  assertExactDisposition(cancelReceipt, cancelPayload, 'accepted');
  await composition.cloud.cancelTask(msgTenant, cancelTask, 'packed stop after accept');
  assert.deepEqual(await readDisposition(msgTenant, cancelTask, cancelPayload), cancelReceipt);
  assert.deepEqual((await readMessage(msgTenant, cancelTask, agentRef)).disposition, cancelReceipt);
  assert.equal(await composition.cloud.readDeviceTerminal(msgTenant, cancelTask), undefined);
  assert.equal((await composition.cloud.readTaskResult(msgTenant, cancelTask)).state, 'cancelled');

  // No identity borrowing: a different tenant/device/task/AgentRef/body reads
  // back nothing, on both public surfaces.
  assert.equal(await readDisposition(otherTenant, acceptedTask, acceptedPayload), undefined);
  assert.equal(await readDisposition(msgTenant, 'packed-other-task', acceptedPayload), undefined);
  assert.deepEqual(await readMessage(msgTenant, acceptedTask, agentRef), acceptedMessage);
  assert.equal(await composition.cloud.readTaskAgentMessage(otherTenant, device.deviceId, acceptedTask, agentRef), undefined);
  assert.equal(await composition.cloud.readTaskAgentMessage(msgTenant, 'packed-other-device', acceptedTask, agentRef), undefined);
  // A forged body keeps the payload self-consistent (the schema re-validates
  // byteCount against the body on every read), just not the stored one.
  assert.equal(await readDisposition(msgTenant, acceptedTask, { ...acceptedPayload, body: 'x'.repeat(acceptedPayload.byteCount) }), undefined);
  assert.equal(await readDisposition(msgTenant, acceptedTask, { ...acceptedPayload, messageId: randomUUID() }), undefined);
  assert.equal(await readMessage(msgTenant, acceptedTask, { ...agentRef, agentId: 'other' }), undefined);
  assert.equal(await readMessage(msgTenant, acceptedTask, { ...agentRef, profileRevision: 'other' }), undefined);
  console.log('[release-pack] recurring message round-trip: authenticated admission, accepted/held dispositions, finalize-outage recovery, cancel retention and identity isolation passed');

  // The EMBEDDED public façade carries the same accepted/held scenarios
  // end-to-end: pairing, capability declaration, submission, publish and
  // read-back all through `createByokServer`'s public surface (no store
  // handles — capabilities arrive through the supported `conn.hello`
  // envelope), and the embedded read-back matches the cloud projection
  // exactly (`decisionProjection` leaves out only the per-message messageId
  // and the per-composition receiptId, each pinned by assertExactDisposition).
  const embeddedConsumer = createProductConsumer({
    'packed-embedded-held': { outcome: 'held', reasonCode: 'product_queue_full' },
  });
  const embedded = createByokServer({ productId: 'packed-recurring', agentMessage: { consume: embeddedConsumer.consume } });
  try {
    const { publicKey } = generateKeyPairSync('ed25519');
    const devicePublicKey = publicKey.export({ format: 'jwk' }).x;
    if (typeof devicePublicKey !== 'string') throw new Error('ed25519 public key has no JWK x coordinate');
    const embeddedPairing = await embedded.pairing.createPairingCode({ productId: 'packed-recurring' });
    const embeddedPairResponse = await embedded.hono.fetch(new Request(`${CLOUD_ORIGIN}/byok/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: embeddedPairing.code, deviceName: 'packed-embedded-device', devicePublicKey }),
    }));
    assert.equal(embeddedPairResponse.status, 200, `embedded pairing failed: HTTP ${embeddedPairResponse.status}`);
    const embeddedPaired = await embeddedPairResponse.json();
    const embeddedAuthorization = { authorization: `Bearer ${embeddedPaired.accessToken}` };
    const helloEnvelope = createEnvelope('conn.hello', {
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: AGENT_MESSAGE_CAPABILITIES,
      deviceId: embeddedPaired.deviceId,
      productId: 'packed-recurring',
    });
    const helloResponse = await publishAgentMessage(embedded.hono, embeddedAuthorization, helloEnvelope);
    assert.equal(helloResponse.status, 200);
    assert.deepEqual(await helloResponse.json(), { accepted: 1 });
    const embeddedSubmit = (taskId) => embedded.recurring.submit(recurringInput(taskId, embeddedPaired.deviceId, `resolve embedded ${taskId}`, agentRef));

    // Accepted, end-to-end on the embedded surface.
    const embeddedAcceptedTask = 'packed-embedded-accepted';
    assert.equal((await embeddedSubmit(embeddedAcceptedTask)).taskId, embeddedAcceptedTask);
    const embeddedAcceptedPayload = messagePayload(agentRef);
    assert.equal(await embedded.tasks.messageDisposition(embeddedAcceptedTask, embeddedPaired.deviceId, embeddedAcceptedPayload), undefined);
    assert.equal(await embedded.tasks.agentMessage(embeddedAcceptedTask, embeddedPaired.deviceId, agentRef), undefined);
    const embeddedAcceptedResponse = await publishAgentMessage(embedded.hono, embeddedAuthorization, publishEnvelope(embeddedAcceptedTask, embeddedAcceptedPayload));
    assert.equal(embeddedAcceptedResponse.status, 200);
    assert.deepEqual(await embeddedAcceptedResponse.json(), { accepted: 1 });
    const embeddedAcceptedReceipt = await embedded.tasks.messageDisposition(embeddedAcceptedTask, embeddedPaired.deviceId, embeddedAcceptedPayload);
    assert.notEqual(embeddedAcceptedReceipt, undefined);
    assertExactDisposition(embeddedAcceptedReceipt, embeddedAcceptedPayload, 'accepted');
    assert.deepEqual(decisionProjection(embeddedAcceptedReceipt), decisionProjection(receipt)); // matches the cloud projection exactly
    const embeddedAcceptedMessage = await embedded.tasks.agentMessage(embeddedAcceptedTask, embeddedPaired.deviceId, agentRef);
    assert.equal(embeddedAcceptedMessage.payload.body.length > 0, true);
    assert.deepEqual(embeddedAcceptedMessage.payload, embeddedAcceptedPayload);
    assert.deepEqual(embeddedAcceptedMessage.context, MESSAGE_CONTEXT);
    assert.deepEqual(embeddedAcceptedMessage.disposition, embeddedAcceptedReceipt); // façade surfaces agree byte-for-byte

    // Held, end-to-end on the embedded surface — never re-presented as a
    // displayable accepted body.
    const embeddedHeldTask = 'packed-embedded-held';
    await embeddedSubmit(embeddedHeldTask);
    const embeddedHeldPayload = messagePayload(agentRef);
    const embeddedHeldResponse = await publishAgentMessage(embedded.hono, embeddedAuthorization, publishEnvelope(embeddedHeldTask, embeddedHeldPayload));
    assert.equal(embeddedHeldResponse.status, 200);
    assert.deepEqual(await embeddedHeldResponse.json(), { accepted: 1 }); // transport accepted; business decision held
    const embeddedHeldReceipt = await embedded.tasks.messageDisposition(embeddedHeldTask, embeddedPaired.deviceId, embeddedHeldPayload);
    assert.notEqual(embeddedHeldReceipt, undefined);
    assertExactDisposition(embeddedHeldReceipt, embeddedHeldPayload, 'held', 'product_queue_full');
    assert.deepEqual(decisionProjection(embeddedHeldReceipt), decisionProjection(heldReceipt)); // matches the cloud projection exactly
    const embeddedHeldMessage = await embedded.tasks.agentMessage(embeddedHeldTask, embeddedPaired.deviceId, agentRef);
    assert.deepEqual(embeddedHeldMessage.payload, embeddedHeldPayload);
    assert.deepEqual(embeddedHeldMessage.context, MESSAGE_CONTEXT);
    assert.deepEqual(embeddedHeldMessage.disposition, embeddedHeldReceipt);
    assert.notEqual(embeddedHeldMessage.disposition.outcome, 'accepted');
    assert.equal(embeddedConsumer.calls.length, 2); // accepted + held, each resolved once on the embedded surface
    console.log('[release-pack] recurring embedded façade round-trip: pairing, conn.hello capabilities, accepted/held resolved and read back matching the cloud projection passed');
  } finally {
    embedded.stop();
  }
}

// ---------------------------------------------------------------------------
// Durable restart leg — only on a configured dataplane substrate, fail-closed
// under BYOK_REQUIRE_DATAPLANE (same law as cloud-dataplane's suites).
// ---------------------------------------------------------------------------
const POSTGRES_URL_ENV = 'BYOK_TEST_POSTGRES_URL';
const S3_ENDPOINT_ENV = 'BYOK_TEST_S3_ENDPOINT';
const REQUIRE_DATAPLANE_ENV = 'BYOK_REQUIRE_DATAPLANE';
const postgresUrl = process.env[POSTGRES_URL_ENV];
const s3Endpoint = process.env[S3_ENDPOINT_ENV];
const dataplaneRequired = process.env[REQUIRE_DATAPLANE_ENV] === '1';
const substrateConfigured = Boolean(postgresUrl) && Boolean(s3Endpoint);
if (Boolean(postgresUrl) !== Boolean(s3Endpoint)) {
  throw new Error(`${POSTGRES_URL_ENV} and ${S3_ENDPOINT_ENV} are one substrate and must be configured together; a half-configured dataplane is a hard failure, not an in-memory fallback.`);
}
if (dataplaneRequired && !substrateConfigured) {
  throw new Error(
    `${REQUIRE_DATAPLANE_ENV}=1 but the substrate is missing. The durable restart leg must run against a real store; start it with:\n` +
    `  docker compose -f docker-compose.test.yml up -d --wait\n` +
    `  export ${POSTGRES_URL_ENV}=postgres://byok:byok@127.0.0.1:5433/byok_test\n` +
    `  export ${S3_ENDPOINT_ENV}=http://127.0.0.1:9100`,
  );
}

if (substrateConfigured) {
  const self = fileURLToPath(import.meta.url);
  const { createByokPool, createPostgresCloudStores, createPostgresCoreStores, migrate, migrationsDir } = await import('@byok-sdk/cloud-dataplane');
  const durableTenantName = 'packed-recurring-durable';
  const durableTenant = tenantId(durableTenantName);
  const durableRef = { agentId: 'packed-agent', profileRevision: 'profile' };
  const durableDatabase = `byok_smoke_${randomUUID().replaceAll('-', '')}`;

  // The installed composition's blob port is constructed (the store factory
  // requires the object-storage authority) but the blobs.contentproxy
  // capability stays undeclared — this leg never touches bytes, so it never
  // claims the byte plane. Credentials are the compose substrate's own public
  // throwaway pair (docker-compose.test.yml), not a secret.
  const objectStorage = {
    endpoint: s3Endpoint.replace(/\/+$/, ''),
    bucket: 'byok-smoke-bytes-never-touched',
    accessKeyId: 'byokminio',
    secretAccessKey: 'byokminio',
    region: 'us-east-1',
  };
  const clock = { now: () => new Date() };
  const crypto = createWebCrypto();
  const tokenSecret = globalThis.crypto.getRandomValues(new Uint8Array(32));

  function composeDurable(core, cloudStores, signer, consumer) {
    const full = fullCapabilityDeclaration();
    return createByokCloud({
      core,
      cloud: cloudStores,
      crypto,
      tokenSigner: signer,
      clock,
      capabilities: { ...full, capabilities: full.capabilities.filter((capability) => capability !== CLOUD_CAPABILITIES.blobsContentProxy) },
      agentMessage: { consume: consumer.consume },
    });
  }

  let pool;
  let adminPool;
  try {
    adminPool = createByokPool({ connectionString: postgresUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${durableDatabase}"`);
    const databaseUrl = new URL(postgresUrl);
    databaseUrl.pathname = `/${durableDatabase}`;
    pool = createByokPool({ connectionString: databaseUrl.toString() });
    // Migrate from the INSTALLED tarball's own migration files — a consumer
    // installing from npm has no source checkout, and neither does this smoke.
    await migrate(pool, migrationsDir());

    const coreA = createPostgresCoreStores({ pool, clock });
    const storesA = createPostgresCloudStores({ pool, clock, crypto, objectStorage });
    const consumer = createProductConsumer({});
    const cloudA = composeDurable(coreA, storesA, createHmacTokenSigner(tokenSecret, clock), consumer);
    const device = await pairCapableDevice({ core: coreA, cloud: cloudA, stores: storesA }, durableTenant, 'packed-durable-device');
    const durableTask = 'packed-durable-restart';
    await cloudA.submitRecurringExecution(durableTenant, recurringInput(durableTask, device.deviceId, 'durable round-trip'));
    const durablePayload = messagePayload(durableRef);
    const durableEnvelope = publishEnvelope(durableTask, durablePayload);
    assert.equal(await cloudA.readTaskAgentMessage(durableTenant, device.deviceId, durableTask, durableRef), undefined);
    assert.equal(await cloudA.readAgentMessageDisposition(durableTenant, device.deviceId, durableTask, durablePayload), undefined);
    const publishResponse = await publishAgentMessage(cloudA, device.authorization, durableEnvelope);
    assert.equal(publishResponse.status, 200);
    assert.deepEqual(await publishResponse.json(), { accepted: 1 });
    const durableReceipt = await cloudA.readAgentMessageDisposition(durableTenant, device.deviceId, durableTask, durablePayload);
    assertExactDisposition(durableReceipt, durablePayload, 'accepted');
    assert.equal(consumer.calls.length, 1);

    // Independent process, SAME store: fresh pool, fresh composition, shared
    // identity (signer secret + access token travel in the handoff file).
    const handoffDir = mkdtempSync(path.join(os.tmpdir(), 'byok-recurring-restart-'));
    const handoffPath = path.join(handoffDir, 'handoff.json');
    writeFileSync(handoffPath, JSON.stringify({
      databaseUrl: databaseUrl.toString(),
      objectStorage,
      tokenSecretB64: Buffer.from(tokenSecret).toString('base64'),
      accessToken: device.authorization.authorization.slice('Bearer '.length),
      tenant: durableTenantName,
      deviceId: device.deviceId,
      taskId: durableTask,
      agentRef: durableRef,
      context: MESSAGE_CONTEXT,
      envelope: durableEnvelope,
      payload: durablePayload,
      expectedDisposition: durableReceipt,
    }));
    const child = spawnSync(process.execPath, [self, '--recurring-reopen', handoffPath], {
      cwd: path.dirname(self),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rmSync(handoffDir, { recursive: true, force: true });
    if (child.status !== 0) {
      throw new Error(`reopened-process durable restart check failed (${child.status})\n${child.stdout}\n${child.stderr}`);
    }
    for (const line of child.stdout.split('\n').filter((line) => line.startsWith('[release-pack]'))) {
      console.log(line);
    }

    // Host body-transaction crash window: same store, same device, same
    // envelope identity; the persistent product ledger is the fixture's
    // product-owned state that survives the crash by design.
    const crashDir = mkdtempSync(path.join(os.tmpdir(), 'byok-recurring-crash-'));
    try {
      const ledgerPath = path.join(crashDir, 'product-ledger.json');
      const finalizeProbePath = path.join(crashDir, 'finalize-ran');
      const crashHandoffPath = path.join(crashDir, 'handoff.json');
      const crashTask = 'packed-crash-window';
      const crashPayload = messagePayload(durableRef);
      const crashIdentity = {
        tenant: durableTenant, deviceId: device.deviceId, taskId: crashTask,
        agentRef: durableRef, messageId: crashPayload.messageId,
      };
      writeFileSync(crashHandoffPath, JSON.stringify({
        databaseUrl: databaseUrl.toString(),
        objectStorage,
        tokenSecretB64: Buffer.from(tokenSecret).toString('base64'),
        accessToken: device.authorization.authorization.slice('Bearer '.length),
        tenant: durableTenantName,
        deviceId: device.deviceId,
        taskId: crashTask,
        agentRef: durableRef,
        context: MESSAGE_CONTEXT,
        envelope: publishEnvelope(crashTask, crashPayload),
        payload: crashPayload,
        ledgerPath,
        finalizeProbePath,
      }));
      const crashChild = spawnSync(process.execPath, [self, '--recurring-crash-commit', crashHandoffPath], {
        cwd: path.dirname(self),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (crashChild.status !== 86) {
        throw new Error(`crash-commit child must die by its own abrupt exit 86, got ${crashChild.status}\n${crashChild.stdout}\n${crashChild.stderr}`);
      }
      assert.equal(existsSync(finalizeProbePath), false, 'SDK finalize must NOT have run before the crash');
      const ledger = createPersistentProductLedger(ledgerPath);
      assert.equal(ledger.size(), 1); // the Host body transaction committed exactly once
      const committed = ledger.lookup(crashIdentity);
      assert.notEqual(committed, undefined);
      assert.deepEqual(committed, { body: crashPayload.body, context: MESSAGE_CONTEXT, outcome: { outcome: 'accepted' } });
      const replayChild = spawnSync(process.execPath, [self, '--recurring-crash-replay', crashHandoffPath], {
        cwd: path.dirname(self),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (replayChild.status !== 0) {
        throw new Error(`crash-replay child failed (${replayChild.status})\n${replayChild.stdout}\n${replayChild.stderr}`);
      }
      for (const line of replayChild.stdout.split('\n').filter((line) => line.startsWith('[release-pack]'))) {
        console.log(line);
      }
      assert.equal(ledger.size(), 1); // still exactly one committed body after the replay
      assert.deepEqual(ledger.lookup(crashIdentity), committed); // identical outcome, nothing re-materialized
    } finally {
      rmSync(crashDir, { recursive: true, force: true });
    }
    console.log(`[release-pack] durable substrate: postgres=${new URL(postgresUrl).host}/${durableDatabase} s3=${objectStorage.endpoint} fixture=deterministic-synthetic-consumer provider-calls=0 node=${process.version} platform=${process.platform}-${process.arch}`);
  } finally {
    if (pool !== undefined) await pool.end();
    if (adminPool !== undefined) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${durableDatabase}" WITH (FORCE)`);
      await adminPool.end();
    }
  }
}
