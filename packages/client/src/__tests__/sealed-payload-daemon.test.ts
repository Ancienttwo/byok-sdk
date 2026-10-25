/**
 * #654 E3c, E2d-3, E2d-4: a daemon that is a verified E2EE member opens a sealed
 * task's input and seals its output with the keys of its member keyring.
 * The test plays the Host and the web client member: it pairs the device
 * with `pv`, creates the device scope with its key packages, seals the input
 * and opens the output with the same scope key.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMemberKeyBundle,
  generateMemberKeyRecord,
  openMemberKeyRecord,
  openSealedContent,
  sealContent,
  type SealedBinding,
  type SealedCategory,
} from '@byok-sdk/core/sealed-payload';
import {
  EnvelopeSchema,
  HOST_MCP_TASK_CONTEXT_CAPABILITY,
  PROTOCOL_VERSION,
  SEALED_INLINE_MAX_PADDED_LENGTH,
  SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  SEALED_SPLIT_TABLE,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  isSealedTaskPlainOutput,
  type Envelope,
  type MessageType,
  type SealedMessageType,
  type TaskSealing,
} from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { journalHash } from '../daemon/journal/journal';
import { DEFAULT_JOURNAL_BUSY_TIMEOUT_MS, JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { openJournalDatabase } from '../daemon/journal/sqlite-support';
import { DeviceMemberKeyring } from '../daemon/e2ee-keyring';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { E2eeWebClient } from './fixtures/e2ee-web-client';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const BUDGET_MS = 4_000;
const TENANT = 'tenant-test';
const SCOPE = 'scope-a';
const EPOCH = 1;
const BOTH: TaskSealing = { scopeId: SCOPE, epoch: EPOCH, categories: ['task-input', 'task-output'] };
const OUTPUT_ONLY: TaskSealing = { scopeId: SCOPE, epoch: EPOCH, categories: ['task-output'] };

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; payload: Record<string, unknown> });

/** The web client member and the scope key of the device scope it created. */
interface ScopeMember {
  readonly web: E2eeWebClient;
  readonly scopeKey: Uint8Array;
}

/** The Host declares the E2EE member routes, so a verified member advertises sealed-payload-v1. */
const E2EE_DECLARATION = { schema: 'byok-capabilities-v1', version: 1, capabilities: [HOST_MCP_TASK_CONTEXT_CAPABILITY, 'e2ee.member'] };
/** A Host without the E2EE member routes: a verified member never advertises sealed-payload-v1 to it. */
const NO_E2EE_DECLARATION = { ...E2EE_DECLARATION, capabilities: [HOST_MCP_TASK_CONTEXT_CAPABILITY] };

function advertised(envelope: Envelope): boolean {
  return envelope.type === 'conn.hello' && (envelope.payload as { capabilities: string[] }).capabilities.includes('sealed-payload-v1');
}

const dirs: string[] = [];
let daemon: Daemon | undefined;
let server: TestServer | undefined;

afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function start(options: {
  serverFlag?: boolean;
  /** The server also holds sealed output blobs (`sealed-output-ciphertext-ref`). */
  ciphertextRef?: boolean;
  /** The server also takes a failed task's runtime failure class (`runtime-failure-class`). */
  failureClass?: boolean;
  /** A short shutdown: the grace deadline, and how long a task's interrupt may take. */
  shutdown?: { readonly graceMs: number; readonly taskInterruptTimeoutMs: number };
  /** The categories of the device scope's policy. */
  policy?: readonly SealedCategory[];
  /** `false`: the Host does not declare `e2ee.member`, and start waits for the first hello only. */
  e2ee?: false;
  beforeStart?: (storeDir: string, deviceId: string, member: ScopeMember, device: { readonly memberId: string }) => Promise<void>;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-daemon-'));
  dirs.push(root);
  server ??= await TestServer.start();
  if (options.serverFlag !== false) {
    server.setAckCapabilities(['sealed-payload-v1', ...(options.ciphertextRef === true ? ['sealed-output-ciphertext-ref'] : []), ...(options.failureClass === true ? ['runtime-failure-class'] : [])]);
  }
  const adapter = new StubRuntimeAdapter('pi');
  const storeDir = path.join(root, 'store');
  const config = {
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Sealed daemon test', productId: 'sealed-daemon-test',
    serverUrl: server.url, storeDir, workspaceRoot: path.join(root, 'workspace'),
    ...(options.shutdown === undefined ? {} : { shutdownGraceMs: options.shutdown.graceMs }),
  };
  server.setCapabilityDeclaration(options.e2ee === false ? NO_E2EE_DECLARATION : E2EE_DECLARATION);
  daemon = createDaemonWithAdapters(config, [adapter],
    options.shutdown === undefined ? {} : { shutdown: { taskInterruptTimeoutMs: options.shutdown.taskInterruptTimeoutMs } });
  const web = await E2eeWebClient.create(server.e2ee);
  const { deviceId } = await daemon.pair('pair-code', { verificationSecret: web.verificationSecret });
  const device = await web.approve(deviceId);
  const member: ScopeMember = { web, scopeKey: await web.putScope(SCOPE, [device], { categories: options.policy ?? BOTH.categories }) };
  await options.beforeStart?.(storeDir, deviceId, member, device);
  await daemon.start();
  await server.waitFor(options.e2ee === false ? (envelope) => envelope.type === 'conn.hello' : advertised, BUDGET_MS);
  return { server, adapter, deviceId, storeDir, member, device, cursor: () => new CursorStore(storeDir).load(server!.url, deviceId) };
}

/** A policy that drops the web client, and a notice that makes the device catch up: the epoch is stale now. */
async function makeStale(member: ScopeMember, device: { readonly memberId: string }, cursor: () => Promise<number | undefined>): Promise<void> {
  await member.web.append('scope-policy', { scopeId: SCOPE, categories: BOTH.categories, members: [device.memberId] });
  const notice = createEnvelope('e2ee.key_package.available', { scopeId: SCOPE, epoch: EPOCH }, { seq: server!.nextSeq() });
  server!.send(notice);
  await vi.waitFor(async () => expect(await cursor()).toBe(notice.seq), BUDGET_MS);
}

/** A member bundle of another device, added to the chain by the web client. */
async function otherDevice(member: ScopeMember) {
  const keys = (await openMemberKeyRecord(await generateMemberKeyRecord({ tenantId: TENANT, deviceId: 'device-other' })))!;
  const bundle = await createMemberKeyBundle({
    signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey, kemPublicJwk: keys.kem.publicJwk, kemEpoch: keys.kem.epoch, deviceId: 'device-other',
  });
  await member.web.append('add', { member: bundle });
  return bundle;
}

function binding(family: MessageType, direction: SealedBinding['direction'], identity: SealedBinding['identity'], deviceId: string, sealing: TaskSealing): SealedBinding {
  return { tenantId: TENANT, family, direction, identity, deviceId, agentRef: null, categories: sealing.categories, notAfter: null };
}

async function sealedMember(member: ScopeMember, plaintext: Record<string, unknown>, bound: SealedBinding, category: 'task-input' | 'task-output' = 'task-input') {
  const { header, ciphertext } = await sealContent({
    scopeKey: member.scopeKey, scope: { id: SCOPE, epoch: EPOCH }, chainHead: member.web.head!, sender: member.web.member.memberId,
    category, binding: bound, plaintext: plaintext as never, maxContentLength: SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  });
  return { header, ciphertext };
}

async function sealedOffer(
  member: ScopeMember, taskId: string, seq: number, deviceId: string, instruction: unknown, sealing = BOTH,
  options: { plain?: Record<string, unknown>; boundSealing?: TaskSealing } = {},
): Promise<Envelope> {
  const plain = options.plain ?? {};
  if (!sealing.categories.includes('task-input')) {
    return createEnvelope('task.offer_sealed', { ...plain, instruction, sealing } as never, { taskId, seq });
  }
  const bound = binding('task.offer', 'server-to-daemon', { taskId }, deviceId, options.boundSealing ?? sealing);
  const { header, ciphertext } = await sealedMember(member, { instruction }, bound);
  return createEnvelope('task.offer_sealed', { ...plain, sealing, sealed: { ...header, ciphertext: Buffer.from(ciphertext).toString('base64url') } } as never, { taskId, seq });
}

/** Opens a sealed output as a member would, with the binding the receiver builds, under `scopeKey` (the scope key by default). */
async function openOutput(member: ScopeMember, envelope: Envelope, deviceId: string, sealing = BOTH, scopeKey = member.scopeKey) {
  const entry = SEALED_SPLIT_TABLE[envelope.type as SealedMessageType];
  const { sealed, ...kept } = envelope.payload as Record<string, unknown> & { sealed: Record<string, unknown> & { ciphertext?: string; ciphertextRef?: { blobId: string } } };
  const { ciphertext, ciphertextRef, ...header } = sealed;
  const identity = { taskId: envelope.task_id!, ...Object.fromEntries(entry.identity.map((field) => [field, kept[field] as string | number])) };
  const opened = await openSealedContent({
    header,
    ciphertext: ciphertext !== undefined ? Buffer.from(ciphertext, 'base64url') : server!.blobContent(ciphertextRef!.blobId)!,
    scopeKey,
    binding: binding(entry.plainType, 'daemon-to-server', identity, deviceId, sealing),
    sealing: { scopeId: SCOPE, epoch: EPOCH },
    maxContentLength: SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  });
  if (!opened.ok) throw new Error(`member could not open ${envelope.type}: ${opened.reason}`);
  return opened.plaintext;
}

function taskEnvelopes(taskId: string): Envelope[] {
  return server!.received.filter((envelope) => envelope.task_id === taskId);
}

describe('sealed payload v1 on the daemon (#654 E3c)', () => {
  it('advertises sealed-payload-v1 only for a verified member on a Host that declares e2ee.member', async () => {
    // No member: a daemon paired without pv never advertises.
    server = await TestServer.start();
    server.setCapabilityDeclaration(E2EE_DECLARATION);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-daemon-'));
    dirs.push(root);
    daemon = createDaemonWithAdapters({
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Sealed daemon test', productId: 'sealed-daemon-test',
      serverUrl: server.url, storeDir: path.join(root, 'store'), workspaceRoot: path.join(root, 'workspace'),
    }, [new StubRuntimeAdapter('pi')]);
    await daemon.pair('pair-code');
    await daemon.start();
    await server.waitFor((envelope) => envelope.type === 'conn.hello', BUDGET_MS);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.received.filter(advertised)).toEqual([]);
    await daemon.stop(); daemon = undefined;
    await server.close(); server = undefined;

    // A verified member: the first hello has no flag; a refreshed hello adds it.
    const { server: sealed } = await start();
    const hellos = sealed.received.filter((envelope) => envelope.type === 'conn.hello');
    expect((hellos[0]!.payload as { capabilities: string[] }).capabilities).not.toContain('sealed-payload-v1');
    expect(hellos.some(advertised)).toBe(true);
  });

  it('does not advertise sealed-payload-v1 for a verified member on a Host that does not declare e2ee.member', async () => {
    const info = vi.spyOn(console, 'info');
    const { server, adapter, deviceId, member } = await start({ e2ee: false });
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\[byok\/client\] E2EE member \S+ verified/u)), BUDGET_MS);
    // The verified member opens a sealed offer and runs it, and still no hello carries the flag.
    server.send(await sealedOffer(member, 'undeclared', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    expect(server.received.filter(advertised)).toEqual([]);
  });

  it('withdraws sealed-payload-v1 when the chain removes the device', async () => {
    const { server, member, device, cursor } = await start();
    const hellosBefore = server.received.filter((envelope) => envelope.type === 'conn.hello').length;
    await member.web.append('remove', { memberId: device.memberId });
    const notice = createEnvelope('e2ee.key_package.available', { scopeId: SCOPE, epoch: EPOCH }, { seq: server.nextSeq() });
    server.send(notice);
    await vi.waitFor(async () => expect(await cursor()).toBe(notice.seq), BUDGET_MS);
    const last = await vi.waitFor(() => {
      const hellos = server.received.filter((envelope) => envelope.type === 'conn.hello');
      expect(hellos.length).toBeGreaterThan(hellosBefore);
      return hellos.at(-1)!;
    }, BUDGET_MS);
    expect(advertised(last)).toBe(false);
  });

  it('opens a sealed offer, runs it, and seals every output', async () => {
    const { server, adapter, deviceId, storeDir, member } = await start();
    const instruction = `secret instruction ${randomUUID()}`;
    // No notice reached the device: the first open fetches the package on its miss (E2d-e3).
    expect(server.e2ee.packageReads).toBe(0);
    server.send(await sealedOffer(member, 'sealed-task', server.nextSeq(), deviceId, instruction));

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    expect(server.e2ee.packageReads).toBe(1);
    expect(adapter.startCalls[0]!.task.instruction).toBe(instruction);
    adapter.sessions[0]!.emit({ type: 'progress', text: 'secret progress' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed', BUDGET_MS);
    expect(await openOutput(member, complete, deviceId)).toMatchObject({ summary: 'secret progress' });
    const progress = taskEnvelopes('sealed-task').filter((envelope) => envelope.type === 'task.progress_sealed');
    expect(progress.length).toBeGreaterThan(0);
    expect(JSON.stringify((await openOutput(member, progress[0]!, deviceId)).events)).toContain('secret progress');

    const types = taskEnvelopes('sealed-task').map((envelope) => envelope.type);
    expect(types).not.toContain('task.progress');
    expect(types).not.toContain('task.complete');
    const wire = JSON.stringify(taskEnvelopes('sealed-task'));
    expect(wire).not.toContain('secret instruction');
    expect(wire).not.toContain('secret progress');
    // Sealed once: the journal holds the bytes that went on the wire.
    const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
    try {
      expect(db.prepare("SELECT bytes FROM journal_terminal WHERE task_id = 'sealed-task'").all()).toEqual([{ bytes: encodeEnvelope(complete) }]);
    } finally { db.close(); }
  });

  it('seals a first output-only task at a new epoch it rotates to, for every scope member (E2d-4)', async () => {
    const { server, adapter, deviceId, member, device } = await start({ policy: ['task-output'] });
    server.send(await sealedOffer(member, 'output-only', server.nextSeq(), deviceId, 'plain instruction', OUTPUT_ONLY));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    expect(server.e2ee.devicePuts.map((put) => put.map((pkg) => pkg.recipient).sort())).toEqual([[device.memberId, member.web.member.memberId].sort()]);
    adapter.sessions[0]!.emit({ type: 'progress', text: 'rotated answer' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'output-only', BUDGET_MS);
    expect((complete.payload as { sealed: { scope: { epoch: number } } }).sealed.scope.epoch).toBe(EPOCH + 1);
    const rotated = await member.web.openPackage(SCOPE, EPOCH + 1, device);
    expect(await openOutput(member, complete, deviceId, OUTPUT_ONLY, rotated)).toMatchObject({ summary: 'rotated answer' });
    expect(JSON.stringify(taskEnvelopes('output-only'))).not.toContain('rotated answer');
    expect(server.e2ee.devicePuts).toHaveLength(1);
  });

  it('seals the output of a task whose instruction is plaintext, once sealed input made the epoch fresh', async () => {
    const { server, adapter, deviceId, member } = await start({ policy: ['task-output'] });
    server.send(await sealedOffer(member, 'fresh', server.nextSeq(), deviceId, 'run fresh'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.send(await sealedOffer(member, 'output-only', server.nextSeq(), deviceId, 'plain instruction', OUTPUT_ONLY));

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2), BUDGET_MS);
    adapter.sessions[1]!.emit({ type: 'progress', text: 'sealed answer' });
    adapter.sessions[1]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'output-only', BUDGET_MS);
    expect(await openOutput(member, complete, deviceId, OUTPUT_ONLY)).toMatchObject({ summary: 'sealed answer' });
    expect(JSON.stringify(taskEnvelopes('output-only'))).not.toContain('sealed answer');
  });

  it('declines an offer whose categories do not cover the scope policy with sealing_policy_mismatch (§6.2)', async () => {
    const { server, adapter, deviceId, member } = await start();
    const inputOnly: TaskSealing = { scopeId: SCOPE, epoch: EPOCH, categories: ['task-input'] };
    server.send(await sealedOffer(member, 'below-policy', server.nextSeq(), deviceId, 'never runs', inputOnly));
    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'below-policy', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealing_policy_mismatch', code: 'sealing_policy_mismatch', retryable: false });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('checks the policy floor again after the open moved the chain view', async () => {
    const { server, adapter, deviceId, member } = await start();
    // The view before the open still had an input-only policy; the open caught up to the policy with task-output.
    const scopeCategories = DeviceMemberKeyring.prototype.scopeCategories;
    vi.spyOn(DeviceMemberKeyring.prototype, 'scopeCategories')
      .mockImplementationOnce(async () => ['task-input'])
      .mockImplementation(function (this: DeviceMemberKeyring, scopeId: string) { return scopeCategories.call(this, scopeId); });
    const inputOnly: TaskSealing = { scopeId: SCOPE, epoch: EPOCH, categories: ['task-input'] };
    server.send(await sealedOffer(member, 'policy-moved', server.nextSeq(), deviceId, 'never runs', inputOnly));
    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'policy-moved', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealing_policy_mismatch', code: 'sealing_policy_mismatch', retryable: false });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('declines content whose sender view is not on the verified chain with sealed_open_failed', async () => {
    const { server, adapter, deviceId, member } = await start();
    const bound = binding('task.offer', 'server-to-daemon', { taskId: 'foreign-head' }, deviceId, BOTH);
    const { header, ciphertext } = await sealContent({
      scopeKey: member.scopeKey, scope: { id: SCOPE, epoch: EPOCH }, chainHead: { seq: member.web.head!.seq, hash: `sha256:${'0'.repeat(64)}` },
      sender: member.web.member.memberId, category: 'task-input', binding: bound, plaintext: { instruction: 'never runs' } as never,
      maxContentLength: SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
    });
    server.send(createEnvelope('task.offer_sealed', { sealing: BOTH, sealed: { ...header, ciphertext: Buffer.from(ciphertext).toString('base64url') } } as never,
      { taskId: 'foreign-head', seq: server.nextSeq() }));
    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'foreign-head', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealed_open_failed', code: 'sealed_open_failed', retryable: false });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it.each([
    ['sealed_key_unavailable', 'no key package for the scope', async (host: TestServer, offer: Envelope) => {
      host.e2ee.packages.splice(0);
      return offer;
    }],
    ['sealed_key_unavailable', 'a failed Host chain read', async (host: TestServer, offer: Envelope) => {
      host.e2ee.failChainReads = Number.MAX_SAFE_INTEGER;
      return offer;
    }],
    ['sealed_open_failed', 'a tampered ciphertext', async (_host: TestServer, offer: Envelope) => {
      const sealed = (offer.payload as { sealed: { ciphertext: string } }).sealed;
      const bytes = Buffer.from(sealed.ciphertext, 'base64url');
      bytes[0] = bytes[0]! ^ 1;
      return { ...offer, payload: { ...offer.payload, sealed: { ...sealed, ciphertext: bytes.toString('base64url') } } } as Envelope;
    }],
  ] as const)('declines with %s once, non-retryably, before a claim, for %s', async (code, _label, alter) => {
    const { server, adapter, deviceId, cursor, member } = await start();
    const offer = await alter(server, await sealedOffer(member, 'declined', server.nextSeq(), deviceId, 'never runs'));
    server.send(offer);

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'declined', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: code, code, retryable: false });
    await vi.waitFor(async () => expect(await cursor()).toBe(offer.seq), BUDGET_MS);
    server.send({ ...offer, id: randomUUID(), seq: server.nextSeq() });
    await vi.waitFor(async () => expect(await cursor()).toBe(offer.seq! + 1), BUDGET_MS);
    expect(taskEnvelopes('declined').map((envelope) => envelope.type)).toEqual(['task.decline']);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('declines a sealed instruction that names a blob with sealing_policy_mismatch', async () => {
    const { server, deviceId, member } = await start();
    const blobRef = { blobId: 'b1', contentHash: `sha256:${'1'.repeat(64)}`, size: 1, contentType: 'text/plain' };
    server.send(await sealedOffer(member, 'blob-instruction', server.nextSeq(), deviceId, blobRef));

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'blob-instruction', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealing_policy_mismatch', code: 'sealing_policy_mismatch', retryable: false });
  });

  it('declines in plaintext, without a code, when the server does not accept sealed output', async () => {
    const { server, adapter, deviceId, member } = await start({ serverFlag: false });
    server.send(await sealedOffer(member, 'no-flag', server.nextSeq(), deviceId, 'never runs'));

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'no-flag', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealed_payload_unsupported: the server does not accept sealed task output', retryable: false });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('declines a sealing policy that drops task-output after the Host sealed it, with sealed_open_failed', async () => {
    // The scope policy asks only for task-input, so the open itself sees the downgrade.
    const { server, adapter, deviceId, member } = await start({ policy: ['task-input'] });
    const inputOnly: TaskSealing = { scopeId: SCOPE, epoch: EPOCH, categories: ['task-input'] };
    server.send(await sealedOffer(member, 'downgraded', server.nextSeq(), deviceId, 'never runs', inputOnly, { boundSealing: BOTH }));

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'downgraded', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealed_open_failed', code: 'sealed_open_failed', retryable: false });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('seals the decline of a plain gate after the open', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'gated', server.nextSeq(), deviceId, 'never runs', BOTH, { plain: { harnessId: 'acme-harness' } }));

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline_sealed' && envelope.task_id === 'gated', BUDGET_MS);
    expect(await openOutput(member, decline, deviceId)).toEqual({ reason: expect.any(String) });
    expect(taskEnvelopes('gated').map((envelope) => envelope.type)).toEqual(['task.decline_sealed']);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('drops a plaintext steer to a task that seals its input, and applies one to an output-only task', async () => {
    const { server, adapter, deviceId, member } = await start({ policy: ['task-output'] });
    // The sealed input comes first: it makes the epoch fresh for the output-only task.
    server.send(await sealedOffer(member, 'sealed-input', server.nextSeq(), deviceId, 'run sealed-input'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.send(await sealedOffer(member, 'output-only-steer', server.nextSeq(), deviceId, 'run output-only-steer', OUTPUT_ONLY));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2), BUDGET_MS);
    // The two offers may start in either order; each start call records its instruction.
    const sessionOf = (taskId: string) => adapter.sessions[adapter.startCalls.findIndex((call) => call.task.instruction === `run ${taskId}`)]!;
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.send(createEnvelope('task.steer', { text: 'host injected' }, { taskId: 'sealed-input', seq: server.nextSeq() }));
      server.send(createEnvelope('task.steer', { text: 'go left' }, { taskId: 'output-only-steer', seq: server.nextSeq() }));
      await vi.waitFor(() => expect(sessionOf('output-only-steer')!.steerCalls).toEqual(['go left']), BUDGET_MS);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('plaintext task.steer for task sealed-input dropped'));
      expect(sessionOf('sealed-input')!.steerCalls).toEqual([]);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('drops a sealed steer to an output-only task', async () => {
    const { server, adapter, deviceId, member } = await start({ policy: ['task-output'] });
    server.send(await sealedOffer(member, 'fresh', server.nextSeq(), deviceId, 'run fresh'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.send(await sealedOffer(member, 'output-only-sealed-steer', server.nextSeq(), deviceId, 'run', OUTPUT_ONLY));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2), BUDGET_MS);
    const steerId = randomUUID();
    const { header, ciphertext } = await sealedMember(member, { text: 'go left' },
      binding('task.steer', 'server-to-daemon', { taskId: 'output-only-sealed-steer', steerId }, deviceId, BOTH));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.send(createEnvelope('task.steer_sealed', { steerId, sealed: { ...header, ciphertext: Buffer.from(ciphertext).toString('base64url') } } as never,
        { taskId: 'output-only-sealed-steer', seq: server.nextSeq() }));
      await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('the task does not seal task input')), BUDGET_MS);
      expect(adapter.sessions[1]!.steerCalls).toEqual([]);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('applies a sealed steer once per steerId', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'steered', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);

    const steerId = randomUUID();
    const { header, ciphertext } = await sealedMember(member, { text: 'go left' }, binding('task.steer', 'server-to-daemon', { taskId: 'steered', steerId }, deviceId, BOTH));
    const steer = createEnvelope('task.steer_sealed', { steerId, sealed: { ...header, ciphertext: Buffer.from(ciphertext).toString('base64url') } } as never, { taskId: 'steered', seq: server.nextSeq() });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.send(steer);
      await vi.waitFor(() => expect(adapter.sessions[0]!.steerCalls).toEqual(['go left']), BUDGET_MS);
      server.send({ ...steer, id: randomUUID(), seq: server.nextSeq() });
      await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(`steer ${steerId} was already applied`)), BUDGET_MS);
      expect(adapter.sessions[0]!.steerCalls).toEqual(['go left']);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('applies the redelivery of a sealed steer whose first apply failed', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'steer-retry', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const session = adapter.sessions[0]!;

    const steerId = randomUUID();
    const { header, ciphertext } = await sealedMember(member, { text: 'go right' }, binding('task.steer', 'server-to-daemon', { taskId: 'steer-retry', steerId }, deviceId, BOTH));
    const steer = createEnvelope('task.steer_sealed', { steerId, sealed: { ...header, ciphertext: Buffer.from(ciphertext).toString('base64url') } } as never, { taskId: 'steer-retry', seq: server.nextSeq() });
    session.steerError = new Error('transient steer failure');
    server.send(steer);
    await vi.waitFor(() => expect(session.steerError).toBeUndefined(), BUDGET_MS);
    expect(session.steerCalls).toEqual([]);

    server.send({ ...steer, id: randomUUID(), seq: server.nextSeq() });
    await vi.waitFor(() => expect(session.steerCalls).toEqual(['go right']), BUDGET_MS);
  });

  it('applies a sealed steer past a harmless chain advance, and drops one after a scope policy adds another device', async () => {
    const { server, adapter, deviceId, member, device } = await start();
    server.send(await sealedOffer(member, 'steer-shared', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const session = adapter.sessions[0]!;
    const steer = async (text: string) => {
      const steerId = randomUUID();
      const { header, ciphertext } = await sealedMember(member, { text }, binding('task.steer', 'server-to-daemon', { taskId: 'steer-shared', steerId }, deviceId, BOTH));
      return createEnvelope('task.steer_sealed', { steerId, sealed: { ...header, ciphertext: Buffer.from(ciphertext).toString('base64url') } } as never,
        { taskId: 'steer-shared', seq: server.nextSeq() });
    };
    // No notice reaches the device: each steer's header names a chain head it has not seen, so the open catches up.
    await member.web.append('scope-policy', { scopeId: 'scope-b', categories: BOTH.categories, members: [member.web.member.memberId, device.memberId].sort() });
    server.send(await steer('go left'));
    await vi.waitFor(() => expect(session.steerCalls).toEqual(['go left']), BUDGET_MS);

    const other = await otherDevice(member);
    await member.web.append('scope-policy', {
      scopeId: SCOPE, categories: BOTH.categories, members: [member.web.member.memberId, device.memberId, other.memberId].sort(),
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.send(await steer('go right'));
      await vi.waitFor(() => {
        const dropped = diagnostic.mock.calls.some(([line]) => String(line).includes('sealed task.steer for task steer-shared dropped'));
        expect(dropped || session.steerCalls.length > 1).toBe(true);
      }, BUDGET_MS);
      expect(session.steerCalls).toEqual(['go left']);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('seals an approval request, a cancel and a runtime failure', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'approval', server.nextSeq(), deviceId, 'run'));
    server.send(await sealedOffer(member, 'failing', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2), BUDGET_MS);
    const session = (taskIndex: number) => adapter.sessions[taskIndex]!;

    session(0).emit({ type: 'needs_approval', summary: 'secret approval summary' });
    const approval = await server.waitFor((envelope) => envelope.type === 'task.await_approval_sealed', BUDGET_MS);
    expect(approval.payload).toMatchObject({ approvalId: expect.any(String) });
    expect(await openOutput(member, approval, deviceId)).toEqual({ summary: 'secret approval summary' });
    server.send(createEnvelope('task.cancel', { reason: 'user stopped it' }, { taskId: approval.task_id!, seq: server.nextSeq() }));
    const cancelled = await server.waitFor((envelope) => envelope.type === 'task.cancelled_sealed', BUDGET_MS);
    expect(cancelled.task_id).toBe(approval.task_id);
    expect(await openOutput(member, cancelled, deviceId)).toEqual({ reason: expect.any(String) });

    session(1).fail(new Error('secret runtime failure'));
    const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed', BUDGET_MS);
    expect(await openOutput(member, failed, deviceId)).toEqual({ reason: expect.any(String) });

    const wire = JSON.stringify(server.received);
    expect(wire).not.toContain('secret approval summary');
    expect(server.received.map((envelope) => envelope.type)).not.toEqual(expect.arrayContaining(['task.await_approval']));
  });

  it('settles a terminal over the sealed plaintext limit with a small sealed failure', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'huge', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'progress', text: 'p'.repeat(SEALED_PAYLOAD_MAX_CONTENT_LENGTH + 1024) });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'huge', 15_000);
      expect(await openOutput(member, failed, deviceId)).toEqual({ reason: 'terminal_result_unsealable' });
      // The local observer sees the failure that was sent, not the completion it replaced.
      await vi.waitFor(() => expect(daemon!.tasks().find((task) => task.taskId === 'huge')).toMatchObject({ state: 'Failed', summary: 'terminal_result_unsealable' }), BUDGET_MS);
    } finally {
      diagnostic.mockRestore();
    }
  }, 30_000);

  it('replaces the runtime failure class of an unsealable failure with unknown (#869)', async () => {
    const { server, adapter, deviceId, member } = await start({ failureClass: true });
    server.send(await sealedOffer(member, 'huge-classed', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.fail(new RuntimeExecutionFailure({
        phase: 'run', category: 'semantic', retry: 'non-retryable', failure: { class: 'auth' },
        reason: 'r'.repeat(SEALED_PAYLOAD_MAX_CONTENT_LENGTH + 1024),
      }));
      const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'huge-classed', 15_000);
      expect(await openOutput(member, failed, deviceId)).toEqual({ reason: 'terminal_result_unsealable' });
      // The replacement is the daemon's own failure: it names no runtime class.
      expect(failed.payload).toMatchObject({ failure: { class: 'unknown' } });
    } finally {
      diagnostic.mockRestore();
    }
  }, 30_000);

  it.each([
    [true, { failure: { class: 'unknown' } }],
    [false, undefined],
  ])('gives a task.complete over the sealed plaintext limit its replacement failure class by the live flag (#869, flag %s)', async (failureClass, expected) => {
    const { server, adapter, deviceId, member } = await start({ failureClass });
    server.send(await sealedOffer(member, 'huge-complete', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'progress', text: 'p'.repeat(SEALED_PAYLOAD_MAX_CONTENT_LENGTH + 1024) });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'huge-complete', 15_000);
      expect(await openOutput(member, failed, deviceId)).toEqual({ reason: 'terminal_result_unsealable' });
      if (expected === undefined) expect(failed.payload).not.toHaveProperty('failure');
      else expect(failed.payload).toMatchObject(expected);
    } finally {
      diagnostic.mockRestore();
    }
  }, 30_000);

  it('reports sealed_key_unavailable in plaintext when the sealing key is gone at the terminal', async () => {
    const { server, adapter, deviceId, member, device, cursor } = await start();
    server.send(await sealedOffer(member, 'key-lost', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    await makeStale(member, device, cursor);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'progress', text: 'lost output' });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      const fail = await server.waitFor((envelope) => envelope.type === 'task.fail' && envelope.task_id === 'key-lost', BUDGET_MS);
      expect(fail.payload).toMatchObject({ reason: 'sealed_key_unavailable', retryable: false });
    } finally {
      diagnostic.mockRestore();
    }
    const types = taskEnvelopes('key-lost').map((envelope) => envelope.type);
    expect(types).not.toContain('task.progress');
    expect(JSON.stringify(taskEnvelopes('key-lost'))).not.toContain('lost output');
  });

  it('denies locally an approval request it cannot send, so the task goes on', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'unsent-approval', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Its sealed frame is over the inline maximum, so the Host never sees it.
      adapter.sessions[0]!.emit({ type: 'needs_approval', summary: `approve ${'a'.repeat(300 * 1024)}` });
      await vi.waitFor(() => expect(adapter.sessions[0]!.resolveApprovalCalls).toEqual([{ approved: false, reason: expect.any(String) }]), BUDGET_MS);
    } finally {
      diagnostic.mockRestore();
    }
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'unsent-approval', BUDGET_MS);
    const types = taskEnvelopes('unsent-approval').map((envelope) => envelope.type);
    expect(types).not.toContain('task.await_approval_sealed');
    expect(types).not.toContain('task.await_approval');
  });

  it('denies locally an approval request it has no sealing key for', async () => {
    const { server, adapter, deviceId, member, device, cursor } = await start();
    server.send(await sealedOffer(member, 'keyless-approval', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    await makeStale(member, device, cursor);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'needs_approval', summary: 'secret approval summary' });
      await vi.waitFor(() => expect(adapter.sessions[0]!.resolveApprovalCalls).toEqual([{ approved: false, reason: expect.any(String) }]), BUDGET_MS);
    } finally {
      diagnostic.mockRestore();
    }
    expect(JSON.stringify(taskEnvelopes('keyless-approval'))).not.toContain('secret approval summary');
  });

  it('settles a terminal whose sealed frame is over the inline maximum with a small sealed failure', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'over-inline', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Under the 2 MiB plaintext limit, over the 256 KiB inline frame.
      adapter.sessions[0]!.emit({ type: 'progress', text: `large summary ${'s'.repeat(300 * 1024)}` });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'over-inline', BUDGET_MS);
      expect(await openOutput(member, failed, deviceId)).toEqual({ reason: 'terminal_result_unsealable' });
    } finally {
      diagnostic.mockRestore();
    }
    expect(taskEnvelopes('over-inline').map((envelope) => envelope.type)).not.toContain('task.complete_sealed');
    expect(JSON.stringify(server.received)).not.toContain('ciphertextRef');
  });

  it('sends a sealed terminal made at shutdown before the connection closes', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'stop-sealed', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sealingKey = DeviceMemberKeyring.prototype.sealingKey;
    vi.spyOn(DeviceMemberKeyring.prototype, 'sealingKey').mockImplementation(async function (this: DeviceMemberKeyring, ...args) {
      await gate;
      return sealingKey.apply(this, args);
    });

    // The shutdown failure waits for its sealing key past the empty-outbox drain.
    const stopped = daemon!.stop();
    daemon = undefined;
    setTimeout(release, 200);
    await stopped;
    const fail = taskEnvelopes('stop-sealed').find((envelope) => envelope.type === 'task.fail_sealed');
    expect(fail).toBeDefined();
    expect(taskEnvelopes('stop-sealed').map((envelope) => envelope.type)).not.toContain('task.fail');
  });

  it('reports an interrupted sealed task with the plaintext daemon_interrupted terminal', async () => {
    let offer: Envelope | undefined;
    await start({
      // A crash image: the sealed offer was admitted, and the process died before any terminal.
      beforeStart: async (storeDir, deviceId, member) => {
        offer = await sealedOffer(member, 'interrupted', 1, deviceId, 'run');
        const journal = new SqliteLocalTaskJournal({ storeDir });
        const bytes = encodeEnvelope(offer);
        await journal.appendEnvelope({ identity: { tenantId: TENANT, productId: 'sealed-daemon-test', deviceId },
          taskId: 'interrupted', envelopeId: offer.id, seq: 1, bytes, bytesHash: journalHash(bytes),
          opensTask: true, receivedAt: new Date().toISOString() });
        await journal.recordAdmission({ taskId: 'interrupted', admitted: true, claimedRuntime: 'pi', decidedAt: new Date().toISOString() });
        await journal.close();
      },
    });
    const fail = await server!.waitFor((envelope) => envelope.type === 'task.fail' && envelope.task_id === 'interrupted', BUDGET_MS);
    expect(fail.payload).toMatchObject({ reason: 'daemon_interrupted', retryable: false, recovery: { kind: 'daemon_interrupted', offerId: offer!.id } });
  });

  it('reports a recovered result-reply failure of a sealed task only in a closed plaintext form (decision 74e)', async () => {
    const taskId = 'result-reply-recovered';
    const golden = corpus.find((line) => line.type === 'task.offer_for_agent_with_egress_sealed'
      && (line.payload.terminalProjection as { mode?: string } | undefined)?.mode === 'result-document')!;
    const plain = Object.fromEntries(Object.entries(golden.payload).filter(([field]) => field !== 'sealed'));
    await start({
      // A crash image: the turn ended without the required result, after the Host accepted the Agent message.
      // The restart replays this terminal before the member is verified.
      beforeStart: async (storeDir, deviceId) => {
        const offer = createEnvelope('task.offer_for_agent_with_egress_sealed', { ...plain, instruction: 'run', sealing: OUTPUT_ONLY } as never, { taskId, seq: 1 });
        const journal = new SqliteLocalTaskJournal({ storeDir });
        const bytes = encodeEnvelope(offer);
        await journal.appendEnvelope({ identity: { tenantId: TENANT, productId: 'sealed-daemon-test', deviceId },
          taskId, envelopeId: offer.id, seq: 1, bytes, bytesHash: journalHash(bytes),
          opensTask: true, receivedAt: new Date().toISOString() });
        await journal.recordAdmission({ taskId, admitted: true, claimedRuntime: 'pi', decidedAt: new Date().toISOString() });
        await journal.recordTransition({ transitionId: randomUUID(), taskId, to: 'required-reply-result-missing-accepted', occurredAt: new Date().toISOString() });
        await journal.close();
      },
    });
    const fail = await server!.waitFor((envelope) => envelope.type === 'task.fail' && envelope.task_id === taskId, BUDGET_MS);
    expect(fail.payload).toMatchObject({ reason: 'sealed_key_unavailable', retryable: false });
    expect(isSealedTaskPlainOutput(fail.type, fail.payload)).toBe(true);
    expect(JSON.stringify(taskEnvelopes(taskId))).not.toContain('result_not_submitted');
  });

  it('sends a sealed artifact inline with a fresh artifactId, above the plaintext 64 KB limit', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'artifact', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const content = randomBytes(100 * 1024);
    await fs.writeFile(path.join(adapter.startCalls[0]!.ctx.workspaceDir, 'out.bin'), content);
    adapter.sessions[0]!.emit({ type: 'artifact', name: 'out.bin', contentType: 'application/octet-stream' });

    const artifact = await server.waitFor((envelope) => envelope.type === 'task.artifact_sealed', BUDGET_MS);
    expect(artifact.payload).toMatchObject({ name: 'out.bin', contentType: 'application/octet-stream', artifactId: expect.any(String) });
    expect(await openOutput(member, artifact, deviceId)).toEqual({ inline: content.toString('base64') });
    expect(taskEnvelopes('artifact').map((envelope) => envelope.type)).not.toContain('task.artifact');
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((envelope) => envelope.type === 'task.complete_sealed', BUDGET_MS);
  });

  it('reports an artifact above the sealed inline limit as a sealed error and sends no artifact', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'too-big', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    await fs.writeFile(path.join(adapter.startCalls[0]!.ctx.workspaceDir, 'huge.bin'), randomBytes(1600 * 1024));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'artifact', name: 'huge.bin', contentType: 'application/octet-stream' });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'too-big', BUDGET_MS);
    } finally {
      diagnostic.mockRestore();
    }
    const types = taskEnvelopes('too-big').map((envelope) => envelope.type);
    expect(types).not.toContain('task.artifact_sealed');
    expect(types).not.toContain('task.artifact');
    const events = await Promise.all(taskEnvelopes('too-big').filter((envelope) => envelope.type === 'task.progress_sealed')
      .map(async (envelope) => JSON.stringify((await openOutput(member, envelope, deviceId)).events)));
    expect(events.join('')).toContain('over the sealed inline limit');
  });

  it('reports an artifact whose sealed frame is over the inline maximum as a sealed error, and uploads nothing', async () => {
    const { server, adapter, deviceId, member } = await start();
    server.send(await sealedOffer(member, 'large', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    await fs.writeFile(path.join(adapter.startCalls[0]!.ctx.workspaceDir, 'large.bin'), randomBytes(220 * 1024));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'artifact', name: 'large.bin', contentType: 'application/octet-stream' });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'large', BUDGET_MS);
    } finally {
      diagnostic.mockRestore();
    }
    const types = taskEnvelopes('large').map((envelope) => envelope.type);
    expect(types).not.toContain('task.artifact_sealed');
    expect(types).not.toContain('task.artifact');
    const events = await Promise.all(taskEnvelopes('large').filter((envelope) => envelope.type === 'task.progress_sealed')
      .map(async (envelope) => JSON.stringify((await openOutput(member, envelope, deviceId)).events)));
    expect(events.join('')).toContain('over the inline maximum');
    expect(JSON.stringify(server.received)).not.toContain('ciphertextRef');
  });

  it('opens a sealed offer whose ciphertext is a blob, after the hash check', async () => {
    const { server, adapter, deviceId, member } = await start();
    const instruction = 'i'.repeat(300 * 1024);
    const offerOf = async (taskId: string, corrupt: boolean): Promise<Envelope> => {
      const { header, ciphertext } = await sealedMember(member, { instruction }, binding('task.offer', 'server-to-daemon', { taskId }, deviceId, BOTH));
      const bytes = Buffer.from(ciphertext);
      const blobId = `blob-${taskId}`;
      server.seedBlob(blobId, bytes, 'application/octet-stream');
      const contentHash = `sha256:${createHash('sha256').update(corrupt ? Buffer.from('other') : bytes).digest('hex')}`;
      return createEnvelope('task.offer_sealed', {
        sealing: BOTH,
        sealed: { ...header, ciphertextRef: { blobId, contentHash, size: bytes.length, contentType: 'application/octet-stream' } },
      } as never, { taskId, seq: server.nextSeq() });
    };

    server.send(await offerOf('bad-hash', true));
    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'bad-hash', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealed_open_failed', code: 'sealed_open_failed', retryable: false });

    server.send(await offerOf('blob-offer', false));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    expect(adapter.startCalls[0]!.task.instruction).toBe(instruction);
  });

  it('declines an over-bound sealed offer with sealed_open_failed', async () => {
    const { server, cursor } = await start();
    const line = corpus.find((candidate) => candidate.type === 'task.offer_sealed' && (candidate.payload.sealed as { ciphertext?: string } | undefined)?.ciphertext !== undefined)!;
    const big = EnvelopeSchema.parse({
      v: PROTOCOL_VERSION, id: randomUUID(), ts: new Date().toISOString(), type: 'task.offer_sealed', task_id: 'big-sealed', seq: server.nextSeq(),
      payload: {
        ...line.payload,
        workspaceHint: 'w'.repeat(100 * 1024),
        sealed: {
          ...(line.payload.sealed as Record<string, unknown>),
          paddedLength: SEALED_INLINE_MAX_PADDED_LENGTH,
          ciphertext: randomBytes(SEALED_INLINE_MAX_PADDED_LENGTH + 16).toString('base64url'),
        },
      },
    });
    server.send(big);

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'big-sealed', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealed_open_failed', code: 'sealed_open_failed', retryable: false });
    await vi.waitFor(async () => expect(await cursor()).toBe(big.seq), BUDGET_MS);
  });
});

describe('sealed output by ciphertextRef on a server that holds the blob (#654 §58a)', () => {
  it('uploads a terminal over the inline frame as an octet-stream blob, and keeps the upload alive through the shutdown commit barrier', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'upload-at-stop', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const release = server.holdBlobUploads();
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(server.blobUploadsHeld).toBeGreaterThan(0), BUDGET_MS);

    // Shutdown starts while the upload is held, and the upload ends after that.
    const stopped = daemon!.stop();
    daemon = undefined;
    setTimeout(release, 100);
    await stopped;
    const complete = taskEnvelopes('upload-at-stop').find((envelope) => envelope.type === 'task.complete_sealed');
    const sealed = (complete?.payload as { sealed: { paddedLength: number; ciphertextRef?: { contentType: string } } } | undefined)?.sealed;
    expect(sealed?.paddedLength).toBeGreaterThan(SEALED_INLINE_MAX_PADDED_LENGTH);
    expect(sealed?.ciphertextRef?.contentType).toBe('application/octet-stream');
    expect(await openOutput(member, complete!, deviceId)).toMatchObject({ summary });
  });

  it('retries a failed terminal upload, and never replaces the result with a sealed failure', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'upload-retry', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.setFailBlobUploads(true);
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(server.blobUploadsFailed).toBeGreaterThan(0), BUDGET_MS);
    server.setFailBlobUploads(false);

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'upload-retry', BUDGET_MS);
    expect((complete.payload as { sealed: { ciphertextRef?: unknown } }).sealed.ciphertextRef).toBeDefined();
    expect(await openOutput(member, complete, deviceId)).toMatchObject({ summary });
    expect(taskEnvelopes('upload-retry').map((envelope) => envelope.type)).not.toContain('task.fail_sealed');
  });

  it.each([409, 413, 422])('settles a terminal with a small sealed failure, without a retry, when the server refuses its ciphertext blob for good with %i', async (status) => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'upload-refused', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.refuseBlobCreates(status);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'progress', text: `large summary ${'s'.repeat(300 * 1024)}` });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'upload-refused', BUDGET_MS);
      expect(await openOutput(member, failed, deviceId)).toEqual({ reason: 'terminal_result_unsealable' });
    } finally {
      diagnostic.mockRestore();
    }
    expect(server.blobCreatesRefused).toBe(1);
    expect(taskEnvelopes('upload-refused').map((envelope) => envelope.type)).not.toContain('task.complete_sealed');
  });

  it.each([
    { step: 'create', status: 408 },
    { step: 'create', status: 429 },
    { step: 'create', status: 503 },
    // The signed content URL answers 401 once its `sig`/`exp` pair expired.
    { step: 'content', status: 401 },
    { step: 'content', status: 403 },
  ] as const)('retries a terminal whose ciphertext blob $step answers $status, and never replaces the result with a sealed failure', async ({ step, status }) => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'upload-refused-retry', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const refuse = (value: number | undefined): void => (step === 'create' ? server.refuseBlobCreates(value) : server.refuseBlobUploads(value));
    const refused = (): number => (step === 'create' ? server.blobCreatesRefused : server.blobUploadsRefused);
    refuse(status);
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(refused()).toBeGreaterThan(1), BUDGET_MS);
    expect(taskEnvelopes('upload-refused-retry').map((envelope) => envelope.type)).not.toContain('task.fail_sealed');
    refuse(undefined);

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'upload-refused-retry', BUDGET_MS);
    expect((complete.payload as { sealed: { ciphertextRef?: unknown } }).sealed.ciphertextRef).toBeDefined();
    expect(await openOutput(member, complete, deviceId)).toMatchObject({ summary });
    expect(taskEnvelopes('upload-refused-retry').map((envelope) => envelope.type)).not.toContain('task.fail_sealed');
  });

  it('waits for the next session to read the server flags before it seals a large terminal', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'between-sessions', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    // A route failure withdraws the server flags until the next session advertises them.
    server.setFailMessagesSends(true);
    server.setFailEventsPolls(true);
    await vi.waitFor(() => expect(daemon!.status().lifecycle).toMatchObject({ connection: 'connecting' }), BUDGET_MS);
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    server.setFailMessagesSends(false);
    server.setFailEventsPolls(false);

    const terminal = await server.waitFor((envelope) => (envelope.type === 'task.complete_sealed' || envelope.type === 'task.fail_sealed') && envelope.task_id === 'between-sessions', BUDGET_MS);
    expect(terminal.type).toBe('task.complete_sealed');
    expect((terminal.payload as { sealed: { ciphertextRef?: unknown } }).sealed.ciphertextRef).toBeDefined();
    expect(await openOutput(member, terminal, deviceId)).toMatchObject({ summary });
  });

  it('settles a terminal that a failed shutdown left queued in the closed form on the next stop', async () => {
    const { server, adapter, deviceId, storeDir, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'upload-stop-retry', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.setFailBlobUploads(true);
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(server.blobUploadsFailed).toBeGreaterThan(0), BUDGET_MS);

    const stopErrors = (): Promise<string[]> => daemon!.stop().then(() => [], (error: unknown) => (error instanceof AggregateError ? error.errors : [error]).map(String));
    expect(await stopErrors()).toContainEqual(expect.stringContaining('ciphertext upload failed'));
    // The run is stopped and its keyring retired, so the queued terminal
    // settles in the closed form and the barrier completes. The stub runtime
    // still reports its disposal failure.
    expect((await stopErrors()).filter((error) => !error.startsWith('RuntimeDisposalFailure'))).toEqual([]);
    daemon = undefined;
    const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
    let rows: Array<{ bytes: Parameters<typeof decodeEnvelope>[0] }>;
    try {
      rows = db.prepare("SELECT bytes FROM journal_terminal WHERE task_id = 'upload-stop-retry'").all() as typeof rows;
    } finally { db.close(); }
    expect(rows).toHaveLength(1);
    const settled = decodeEnvelope(rows[0]!.bytes);
    expect(settled.type).toBe('task.fail');
    expect(settled.payload).toMatchObject({ reason: 'sealed_key_unavailable', retryable: false });
    expect(settled.payload).not.toHaveProperty('sealed');
    expect(JSON.stringify(settled)).not.toContain(summary);
  });

  it('uploads a terminal that a failed shutdown left queued through the next run\'s blob client', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'upload-restart', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.setFailBlobUploads(true);
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(server.blobUploadsFailed).toBeGreaterThan(0), BUDGET_MS);

    const stopErrors = await daemon!.stop().then(() => [], (error: unknown) => (error instanceof AggregateError ? error.errors : [error]).map(String));
    expect(stopErrors).toContainEqual(expect.stringContaining('ciphertext upload failed'));
    const failedBeforeRestart = server.blobUploadsFailed;

    // The queued upload reaches the server again: it does not keep the
    // stopped run's aborted blob client.
    await daemon!.start();
    await vi.waitFor(() => expect(server.blobUploadsFailed).toBeGreaterThan(failedBeforeRestart), BUDGET_MS);
    server.setFailBlobUploads(false);
    await vi.waitFor(() => expect(daemon!.status().pendingTerminalCommits).toBe(0), BUDGET_MS);
    const terminal = await server.waitFor((envelope) => envelope.task_id === 'upload-restart'
      && ['task.complete_sealed', 'task.fail_sealed', 'task.fail'].includes(envelope.type), BUDGET_MS);
    expect(terminal.type).toBe('task.complete_sealed');
    expect((terminal.payload as { sealed: { ciphertextRef?: unknown } }).sealed.ciphertextRef).toBeDefined();
    expect(await openOutput(member, terminal, deviceId)).toMatchObject({ summary });
    expect(taskEnvelopes('upload-restart').map((envelope) => envelope.type)).not.toContain('task.fail_sealed');
  });

  it('keeps a terminal that a failed shutdown left queued until the next start reaches its session', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'upload-slow-restart', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.setFailBlobUploads(true);
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(server.blobUploadsFailed).toBeGreaterThan(0), BUDGET_MS);
    const stopErrors = await daemon!.stop().then(() => [], (error: unknown) => (error instanceof AggregateError ? error.errors : [error]).map(String));
    expect(stopErrors).toContainEqual(expect.stringContaining('ciphertext upload failed'));
    server.setFailBlobUploads(false);

    // Runtime detection runs before the connection starts. Holding it keeps
    // the restart short of a session for longer than the 1 s commit retry.
    let releaseDetect!: () => void;
    const detectHeld = new Promise<void>((resolve) => { releaseDetect = resolve; });
    const detect = adapter.detect.bind(adapter);
    vi.spyOn(adapter, 'detect').mockImplementation(async () => { await detectHeld; return detect(); });
    const started = daemon!.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(daemon!.status().lifecycle).toMatchObject({ phase: 'stopped' });
    } finally {
      releaseDetect();
    }
    await started;

    const terminal = await server.waitFor((envelope) => (envelope.type === 'task.complete_sealed' || envelope.type === 'task.fail_sealed')
      && envelope.task_id === 'upload-slow-restart', BUDGET_MS);
    expect(terminal.type).toBe('task.complete_sealed');
    expect((terminal.payload as { sealed: { ciphertextRef?: unknown } }).sealed.ciphertextRef).toBeDefined();
    expect(await openOutput(member, terminal, deviceId)).toMatchObject({ summary });
    expect(taskEnvelopes('upload-slow-restart').map((envelope) => envelope.type)).not.toContain('task.fail_sealed');
  }, 15_000);

  it('seals a terminal that a failed shutdown left queued with the next run\'s member, at that run\'s chain head', async () => {
    const { server, adapter, deviceId, member, device } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'restart-member', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.setFailBlobUploads(true);
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(server.blobUploadsFailed).toBeGreaterThan(0), BUDGET_MS);
    const stopErrors = await daemon!.stop().then(() => [], (error: unknown) => (error instanceof AggregateError ? error.errors : [error]).map(String));
    expect(stopErrors).toContainEqual(expect.stringContaining('ciphertext upload failed'));

    // The chain moves between the runs, and the epoch stays fresh: the policy keeps its members.
    const stoppedHead = member.web.head!;
    await member.web.append('scope-policy', { scopeId: SCOPE, categories: BOTH.categories, members: [member.web.member.memberId, device.memberId].sort() });
    expect(member.web.head!.seq).toBeGreaterThan(stoppedHead.seq);
    server.setFailBlobUploads(false);
    await daemon!.start();

    const terminal = await server.waitFor((envelope) => ['task.complete_sealed', 'task.fail_sealed', 'task.fail', 'task.complete'].includes(envelope.type)
      && envelope.task_id === 'restart-member', BUDGET_MS);
    expect(terminal.type).toBe('task.complete_sealed');
    const sealed = (terminal.payload as { sealed: { chainHead: { seq: number; hash: string }; ciphertextRef?: unknown } }).sealed;
    expect(sealed.chainHead).toEqual(member.web.head);
    expect(sealed.ciphertextRef).toBeDefined();
    expect(await openOutput(member, terminal, deviceId)).toMatchObject({ summary });
    await vi.waitFor(() => expect(daemon!.status().pendingTerminalCommits).toBe(0), BUDGET_MS);
    const sent = taskEnvelopes('restart-member');
    expect(sent.map((envelope) => envelope.type)).not.toEqual(expect.arrayContaining(['task.complete']));
    expect(sent.map((envelope) => envelope.type)).not.toEqual(expect.arrayContaining(['task.fail']));
    expect(JSON.stringify(sent)).not.toContain('sealed_key_unavailable');
    expect(JSON.stringify(sent)).not.toContain('large summary');
  }, 15_000);

  it('settles a terminal that a failed shutdown left queued in the closed form when the next run has another member', async () => {
    const { server, adapter, deviceId, member, device } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'restart-other-member', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    server.setFailBlobUploads(true);
    const summary = `large summary ${'s'.repeat(300 * 1024)}`;
    adapter.sessions[0]!.emit({ type: 'progress', text: summary });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(server.blobUploadsFailed).toBeGreaterThan(0), BUDGET_MS);
    const stopErrors = await daemon!.stop().then(() => [], (error: unknown) => (error instanceof AggregateError ? error.errors : [error]).map(String));
    expect(stopErrors).toContainEqual(expect.stringContaining('ciphertext upload failed'));

    // The chain removes the device's member between the runs, so the next run
    // is not the owner run's (tenant, device, member).
    await member.web.append('remove', { memberId: device.memberId });
    server.setFailBlobUploads(false);
    await daemon!.start();

    const terminal = await server.waitFor((envelope) => envelope.task_id === 'restart-other-member'
      && ['task.complete_sealed', 'task.fail_sealed', 'task.fail', 'task.complete'].includes(envelope.type), BUDGET_MS);
    expect(terminal.type).toBe('task.fail');
    expect(terminal.payload).toMatchObject({ reason: 'sealed_key_unavailable', retryable: false });
    expect(isSealedTaskPlainOutput(terminal.type, terminal.payload)).toBe(true);
    await vi.waitFor(() => expect(daemon!.status().pendingTerminalCommits).toBe(0), BUDGET_MS);
    expect(JSON.stringify(taskEnvelopes('restart-other-member'))).not.toContain('large summary');
    expect(taskEnvelopes('restart-other-member').map((envelope) => envelope.type)).not.toContain('task.complete_sealed');
  }, 15_000);

  it('seals a terminal made after the owner run retired its member with the next run\'s same member', async () => {
    // The stop's grace deadline passes while the task's interrupt hangs, so
    // the run retires its member before the task's failure is made.
    const { server, adapter, deviceId, member } = await start({ shutdown: { graceMs: 50, taskInterruptTimeoutMs: 10_000 } });
    server.send(await sealedOffer(member, 'after-retire', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    let releaseInterrupt!: () => void;
    vi.spyOn(adapter.sessions[0]!, 'interrupt').mockImplementation(() => new Promise<void>((resolve) => { releaseInterrupt = resolve; }));
    const stopErrors = await daemon!.stop().then(() => [], (error: unknown) => (error instanceof AggregateError ? error.errors : [error]).map(String));
    expect(stopErrors).toContainEqual(expect.stringContaining('active task teardown did not settle'));

    // The failure is made once the next start is under way, before its
    // recovery step (which follows the cursor read), so the commit queue
    // holds it and recovery leaves the task to it.
    const load = CursorStore.prototype.load;
    let released = false;
    vi.spyOn(CursorStore.prototype, 'load').mockImplementation(async function (this: CursorStore, ...args: Parameters<CursorStore['load']>) {
      if (!released) {
        released = true;
        releaseInterrupt();
        await vi.waitFor(() => expect(daemon!.status().pendingTerminalCommits).toBe(1), BUDGET_MS);
      }
      return load.apply(this, args);
    });
    await daemon!.start();

    const terminal = await server.waitFor((envelope) => envelope.task_id === 'after-retire'
      && ['task.fail_sealed', 'task.fail'].includes(envelope.type), BUDGET_MS);
    expect(terminal.type).toBe('task.fail_sealed');
    await vi.waitFor(() => expect(daemon!.status().pendingTerminalCommits).toBe(0), BUDGET_MS);
    expect(taskEnvelopes('after-retire').map((envelope) => envelope.type)).not.toContain('task.fail');
  }, 20_000);

  it('uploads an artifact over the inline frame as an octet-stream ciphertext blob', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'large', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const content = randomBytes(220 * 1024);
    await fs.writeFile(path.join(adapter.startCalls[0]!.ctx.workspaceDir, 'large.bin'), content);
    adapter.sessions[0]!.emit({ type: 'artifact', name: 'large.bin', contentType: 'application/octet-stream' });

    const artifact = await server.waitFor((envelope) => envelope.type === 'task.artifact_sealed', BUDGET_MS);
    const ref = (artifact.payload as { sealed: { paddedLength: number; ciphertextRef?: { blobId: string; contentType: string } } }).sealed;
    expect(ref.paddedLength).toBeGreaterThan(SEALED_INLINE_MAX_PADDED_LENGTH);
    expect(ref.ciphertextRef?.contentType).toBe('application/octet-stream');
    expect(await openOutput(member, artifact, deviceId)).toEqual({ inline: content.toString('base64') });
  });

  it('commits another task\'s terminal while one terminal upload is held', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'held-upload', server.nextSeq(), deviceId, 'run the large task'));
    server.send(await sealedOffer(member, 'small-terminal', server.nextSeq(), deviceId, 'run the small task'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2), BUDGET_MS);
    const session = (instruction: string) => adapter.sessions[adapter.startCalls.findIndex((call) => call.task.instruction === instruction)]!;
    const held = session('run the large task');
    const small = session('run the small task');
    const release = server.holdBlobUploads();
    try {
      held.emit({ type: 'progress', text: `large summary ${'s'.repeat(300 * 1024)}` });
      held.emit({ type: 'turn_end' });
      await vi.waitFor(() => expect(server.blobUploadsHeld).toBeGreaterThan(0), BUDGET_MS);

      small.emit({ type: 'progress', text: 'small summary' });
      small.emit({ type: 'turn_end' });
      await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'small-terminal', BUDGET_MS);
      expect(taskEnvelopes('held-upload').map((envelope) => envelope.type)).not.toContain('task.complete_sealed');
    } finally {
      release();
    }
    await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'held-upload', BUDGET_MS);
  });

  it('keeps an approval request inline only, and denies it locally over the inline frame without an upload', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    server.send(await sealedOffer(member, 'inline-only-approval', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const release = server.holdBlobUploads();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'needs_approval', summary: `approve ${'a'.repeat(300 * 1024)}` });
      await vi.waitFor(() => expect(adapter.sessions[0]!.resolveApprovalCalls).toEqual([{ approved: false, reason: expect.any(String) }]), BUDGET_MS);
    } finally {
      diagnostic.mockRestore();
      release();
    }
    expect(server.blobUploadsHeld).toBe(0);
    expect(taskEnvelopes('inline-only-approval').map((envelope) => envelope.type)).not.toContain('task.await_approval_sealed');
  });
});

const TERMINAL_OUTPUTS = ['task.complete', 'task.fail', 'task.cancelled', 'task.decline', 'task.complete_sealed', 'task.fail_sealed', 'task.cancelled_sealed', 'task.decline_sealed'];

function terminalTypes(taskId: string): string[] {
  return taskEnvelopes(taskId).filter((envelope) => TERMINAL_OUTPUTS.includes(envelope.type)).map((envelope) => envelope.type);
}

function byReference(envelope: Envelope): boolean {
  return (envelope.payload as { sealed?: { ciphertextRef?: unknown } }).sealed?.ciphertextRef !== undefined;
}

function journalTerminal(storeDir: string, taskId: string): { bytes: string; truth_state: string } | undefined {
  const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
  try {
    return db.prepare('SELECT bytes, truth_state FROM journal_terminal WHERE task_id = ?').get(taskId) as { bytes: string; truth_state: string } | undefined;
  } finally { db.close(); }
}

/** Runs a sealed task whose result seals above the inline frame, so the daemon sends it by `ciphertextRef`. */
async function runLargeResult(adapter: StubRuntimeAdapter, member: ScopeMember, deviceId: string, taskId: string): Promise<void> {
  server!.send(await sealedOffer(member, taskId, server!.nextSeq(), deviceId, 'run'));
  await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
  adapter.sessions[0]!.emit({ type: 'progress', text: `large summary ${'s'.repeat(300 * 1024)}` });
  adapter.sessions[0]!.emit({ type: 'turn_end' });
}

/**
 * A crash image of a journal: a sealed task whose result the daemon sent by
 * `ciphertextRef` under `sender`, and that the Host refused. A 0.30.1 daemon
 * leaves the same rows.
 */
async function seedRefusedResult(storeDir: string, deviceId: string, member: ScopeMember, taskId: string, sender: string): Promise<Envelope> {
  const offer = await sealedOffer(member, taskId, 1, deviceId, 'run');
  const { header, ciphertext } = await sealContent({
    scopeKey: member.scopeKey, scope: { id: SCOPE, epoch: EPOCH }, chainHead: member.web.head!, sender, category: 'task-output',
    binding: binding('task.complete', 'daemon-to-server', { taskId }, deviceId, BOTH),
    plaintext: { summary: `large summary ${'s'.repeat(300 * 1024)}` } as never, maxContentLength: SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  });
  const contentHash = `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`;
  const refused = createEnvelope('task.complete_sealed', {
    sessionRef: 'sess-refused',
    sealed: { ...header, ciphertextRef: { blobId: `collected-${taskId}`, contentHash, size: ciphertext.length, contentType: 'application/octet-stream' } },
  } as never, { taskId });
  const journal = new SqliteLocalTaskJournal({ storeDir });
  try {
    const offerBytes = encodeEnvelope(offer);
    await journal.appendEnvelope({ identity: { tenantId: TENANT, productId: 'sealed-daemon-test', deviceId },
      taskId, envelopeId: offer.id, seq: 1, bytes: offerBytes, bytesHash: journalHash(offerBytes),
      opensTask: true, receivedAt: new Date().toISOString() });
    await journal.recordAdmission({ taskId, admitted: true, claimedRuntime: 'pi', decidedAt: new Date().toISOString() });
    const bytes = encodeEnvelope(refused);
    await journal.recordTerminal({ taskId, terminalType: 'complete', bytes, payloadHash: journalHash(bytes), truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
    await journal.rejectTerminal(taskId, journalHash(bytes), 'payload_invalid');
  } finally { await journal.close(); }
  return refused;
}

/** Opens a sealed output at whichever epoch the device sealed it, rotated or not. */
async function openAtEpoch(member: ScopeMember, envelope: Envelope, deviceId: string, device: { readonly memberId: string }) {
  const epoch = (envelope.payload as { sealed: { scope: { epoch: number } } }).sealed.scope.epoch;
  const key = epoch === EPOCH ? member.scopeKey : await member.web.openPackage(SCOPE, epoch, device as never);
  return openOutput(member, envelope, deviceId, BOTH, key);
}

describe('a refused terminal sent by ciphertextRef (#654 §77b)', () => {
  it.each(['payload_invalid', 'unsupported'])('replaces a result the Host refuses with %s by one sealed failure, in the journal too', async (reason) => {
    const { server, adapter, deviceId, storeDir, member } = await start({ ciphertextRef: true });
    server.setOutboundRefusal((envelope) => (envelope.type === 'task.complete_sealed' && byReference(envelope) ? reason : undefined));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runLargeResult(adapter, member, deviceId, 'refused-ref');

    const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'refused-ref', BUDGET_MS);
    expect(await openOutput(member, failed, deviceId)).toEqual({ reason: 'terminal_result_unsealable' });
    expect(failed.payload).not.toHaveProperty('sealed.ciphertextRef');
    await vi.waitFor(() => expect(journalTerminal(storeDir, 'refused-ref')).toEqual({ bytes: encodeEnvelope(failed), truth_state: 'confirmed' }), BUDGET_MS);
    await vi.waitFor(() => expect(daemon!.tasks().find((task) => task.taskId === 'refused-ref')).toMatchObject({ state: 'Failed', summary: 'terminal_result_unsealable' }), BUDGET_MS);
    expect(terminalTypes('refused-ref')).toEqual(['task.complete_sealed', 'task.fail_sealed']);
    expect(daemon!.status().pendingTerminalCommits).toBe(0);
  });

  it('settles a refused replacement once, with no third terminal', async () => {
    const { server, adapter, deviceId, storeDir, member } = await start({ ciphertextRef: true });
    server.setOutboundRefusal((envelope) => {
      if (envelope.type === 'task.complete_sealed' && byReference(envelope)) return 'payload_invalid';
      return envelope.type === 'task.fail_sealed' ? 'not_permitted' : undefined;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runLargeResult(adapter, member, deviceId, 'refused-twice');

    const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'refused-twice', BUDGET_MS);
    await vi.waitFor(() => expect(journalTerminal(storeDir, 'refused-twice')).toEqual({ bytes: encodeEnvelope(failed), truth_state: 'failed' }), BUDGET_MS);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(terminalTypes('refused-twice')).toEqual(['task.complete_sealed', 'task.fail_sealed']);
    expect(daemon!.status().pendingTerminalCommits).toBe(0);
  });

  it('does not replace a refused inline terminal', async () => {
    const { server, adapter, deviceId, storeDir, member } = await start({ ciphertextRef: true });
    server.setOutboundRefusal((envelope) => (envelope.type === 'task.complete_sealed' ? 'payload_invalid' : undefined));
    server.send(await sealedOffer(member, 'refused-inline', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    adapter.sessions[0]!.emit({ type: 'progress', text: 'small answer' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'refused-inline', BUDGET_MS);
    expect(byReference(complete)).toBe(false);
    await vi.waitFor(() => expect(journalTerminal(storeDir, 'refused-inline')).toEqual({ bytes: encodeEnvelope(complete), truth_state: 'failed' }), BUDGET_MS);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(terminalTypes('refused-inline')).toEqual(['task.complete_sealed']);
  });

  it('keeps a result whose sends fail on the route, and replaces nothing', async () => {
    const { server, adapter, deviceId, member } = await start({ ciphertextRef: true });
    const release = server.holdBlobUploads();
    await runLargeResult(adapter, member, deviceId, 'route-retry');
    await vi.waitFor(() => expect(server.blobUploadsHeld).toBeGreaterThan(0), BUDGET_MS);
    server.setFailMessagesSends(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    server.setFailMessagesSends(false);

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed' && envelope.task_id === 'route-retry', BUDGET_MS);
    expect(byReference(complete)).toBe(true);
    await vi.waitFor(() => expect(daemon!.status().pendingTerminalCommits).toBe(0), BUDGET_MS);
    expect(terminalTypes('route-retry')).toEqual(['task.complete_sealed']);
  });

  it('replaces a refusal journaled before a restart (or by 0.30.1) with a sealed failure, once the member resumes', async () => {
    let refused: Envelope | undefined;
    const { server, deviceId, storeDir, member, device } = await start({
      ciphertextRef: true,
      beforeStart: async (storeDir, deviceId, member, device) => { refused = await seedRefusedResult(storeDir, deviceId, member, 'refused-before-restart', device.memberId); },
    });
    const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'refused-before-restart', BUDGET_MS);
    expect(await openAtEpoch(member, failed, deviceId, device)).toEqual({ reason: 'terminal_result_unsealable' });
    await vi.waitFor(() => expect(journalTerminal(storeDir, 'refused-before-restart')).toEqual({ bytes: encodeEnvelope(failed), truth_state: 'confirmed' }), BUDGET_MS);
    expect(terminalTypes('refused-before-restart')).toEqual(['task.fail_sealed']);
    expect(server.received.map((envelope) => envelope.id)).not.toContain(refused!.id);
  });

  it('replaces a refusal that another member sealed with the closed plaintext form', async () => {
    const { server, storeDir } = await start({
      ciphertextRef: true,
      beforeStart: async (storeDir, deviceId, member) => { await seedRefusedResult(storeDir, deviceId, member, 'refused-other-member', member.web.member.memberId); },
    });
    const failed = await server.waitFor((envelope) => envelope.type === 'task.fail' && envelope.task_id === 'refused-other-member', BUDGET_MS);
    expect(failed.payload).toMatchObject({ reason: 'sealed_key_unavailable', retryable: false });
    expect(isSealedTaskPlainOutput(failed.type, failed.payload)).toBe(true);
    await vi.waitFor(() => expect(journalTerminal(storeDir, 'refused-other-member')?.truth_state).toBe('confirmed'), BUDGET_MS);
    expect(terminalTypes('refused-other-member')).toEqual(['task.fail']);
  });

  it('sends a replacement journaled before a restart with its exact bytes', async () => {
    let replacement: Envelope | undefined;
    const { server, storeDir } = await start({
      ciphertextRef: true,
      beforeStart: async (storeDir, deviceId, member, device) => {
        const refused = await seedRefusedResult(storeDir, deviceId, member, 'replaced-before-restart', device.memberId);
        replacement = createEnvelope('task.fail', { reason: 'sealed_key_unavailable', retryable: false }, { taskId: 'replaced-before-restart' });
        const bytes = encodeEnvelope(replacement);
        const journal = new SqliteLocalTaskJournal({ storeDir });
        try {
          await journal.replaceRefusedTerminal('replaced-before-restart', journalHash(encodeEnvelope(refused)), {
            taskId: 'replaced-before-restart', terminalType: 'failed', bytes, payloadHash: journalHash(bytes), truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString(),
          });
        } finally { await journal.close(); }
      },
    });
    const failed = await server.waitFor((envelope) => envelope.type === 'task.fail' && envelope.task_id === 'replaced-before-restart', BUDGET_MS);
    expect(encodeEnvelope(failed)).toBe(encodeEnvelope(replacement!));
    await vi.waitFor(() => expect(journalTerminal(storeDir, 'replaced-before-restart')?.truth_state).toBe('confirmed'), BUDGET_MS);
    expect(terminalTypes('replaced-before-restart')).toEqual(['task.fail']);
  });
});
