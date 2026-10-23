/**
 * #654 E3c: a daemon with a scope keyring opens a sealed task's input and
 * seals its output. The keyring and the `sealed-payload-v1` advertisement
 * come only from the test seam of `buildDaemonWithAdapters`; a default
 * daemon never advertises the flag. The test plays the Host and the member:
 * it seals the input and opens the output with the same scope key.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateScopeKey, openSealedContent, sealContent, type SealedBinding } from '@byok-sdk/core/sealed-payload';
import {
  EnvelopeSchema,
  PROTOCOL_VERSION,
  SEALED_INLINE_MAX_PADDED_LENGTH,
  SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  SEALED_SPLIT_TABLE,
  createEnvelope,
  encodeEnvelope,
  type Envelope,
  type MessageType,
  type SealedMessageType,
  type TaskSealing,
} from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDaemonWithAdapters, createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { journalHash } from '../daemon/journal/journal';
import { DEFAULT_JOURNAL_BUSY_TIMEOUT_MS, JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { openJournalDatabase } from '../daemon/journal/sqlite-support';
import type { SealedScopeKeyring } from '../daemon/sealed-task';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const BUDGET_MS = 4_000;
const TENANT = 'tenant-test';
const SCOPE = 'scope-a';
const EPOCH = 1;
const SENDER = 'm'.repeat(43);
const CHAIN_HEAD = { seq: 1, hash: `sha256:${'0'.repeat(64)}` };
const BOTH: TaskSealing = { scopeId: SCOPE, epoch: EPOCH, categories: ['task-input', 'task-output'] };
const OUTPUT_ONLY: TaskSealing = { scopeId: SCOPE, epoch: EPOCH, categories: ['task-output'] };

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; payload: Record<string, unknown> });

class TestKeyring implements SealedScopeKeyring {
  readonly scopeKey = generateScopeKey();
  sealing = true;
  async openingKey(scope: { readonly id: string; readonly epoch: number }) {
    return scope.id === SCOPE && scope.epoch === EPOCH ? this.scopeKey : undefined;
  }
  async sealingKey(scopeId: string, minEpoch: number) {
    return this.sealing && scopeId === SCOPE && minEpoch <= EPOCH
      ? { scopeKey: this.scopeKey, epoch: EPOCH, sender: SENDER, chainHead: CHAIN_HEAD }
      : undefined;
  }
}

const dirs: string[] = [];
let daemon: Daemon | undefined;
let server: TestServer | undefined;

afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function start(options: {
  keyring?: TestKeyring;
  serverFlag?: boolean;
  beforeStart?: (storeDir: string, deviceId: string) => Promise<void>;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-daemon-'));
  dirs.push(root);
  server ??= await TestServer.start();
  if (options.serverFlag !== false) server.setAckCapabilities(['sealed-payload-v1']);
  const adapter = new StubRuntimeAdapter('pi');
  const storeDir = path.join(root, 'store');
  const config = {
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Sealed daemon test', productId: 'sealed-daemon-test',
    serverUrl: server.url, storeDir, workspaceRoot: path.join(root, 'workspace'),
    hostedJournal: { mode: 'sqlite' as const },
  };
  daemon = options.keyring === undefined
    ? createDaemonWithAdapters(config, [adapter])
    : buildDaemonWithAdapters(config, [adapter], {}, undefined, { keyring: options.keyring });
  const { deviceId } = await daemon.pair('pair-code');
  await options.beforeStart?.(storeDir, deviceId);
  await daemon.start();
  return { server, adapter, deviceId, storeDir, cursor: () => new CursorStore(storeDir).load(server!.url, deviceId) };
}

function binding(family: MessageType, direction: SealedBinding['direction'], identity: SealedBinding['identity'], deviceId: string, sealing: TaskSealing): SealedBinding {
  return { tenantId: TENANT, family, direction, identity, deviceId, agentRef: null, categories: sealing.categories, notAfter: null };
}

async function sealedMember(keyring: TestKeyring, plaintext: Record<string, unknown>, bound: SealedBinding, category: 'task-input' | 'task-output' = 'task-input') {
  const { header, ciphertext } = await sealContent({
    scopeKey: keyring.scopeKey, scope: { id: SCOPE, epoch: EPOCH }, chainHead: CHAIN_HEAD, sender: SENDER,
    category, binding: bound, plaintext: plaintext as never, maxContentLength: SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  });
  return { header, ciphertext };
}

async function sealedOffer(keyring: TestKeyring, taskId: string, seq: number, deviceId: string, instruction: unknown, sealing = BOTH): Promise<Envelope> {
  if (!sealing.categories.includes('task-input')) {
    return createEnvelope('task.offer_sealed', { instruction, sealing } as never, { taskId, seq });
  }
  const { header, ciphertext } = await sealedMember(keyring, { instruction }, binding('task.offer', 'server-to-daemon', { taskId }, deviceId, sealing));
  return createEnvelope('task.offer_sealed', { sealing, sealed: { ...header, ciphertext: Buffer.from(ciphertext).toString('base64url') } } as never, { taskId, seq });
}

/** Opens a sealed output as a member would, with the binding the receiver builds. */
async function openOutput(keyring: TestKeyring, envelope: Envelope, deviceId: string, sealing = BOTH, ciphertextOf?: (ref: { blobId: string }) => Uint8Array) {
  const entry = SEALED_SPLIT_TABLE[envelope.type as SealedMessageType];
  const { sealed, ...kept } = envelope.payload as Record<string, unknown> & { sealed: Record<string, unknown> & { ciphertext?: string; ciphertextRef?: { blobId: string } } };
  const { ciphertext, ciphertextRef, ...header } = sealed;
  const identity = { taskId: envelope.task_id!, ...Object.fromEntries(entry.identity.map((field) => [field, kept[field] as string | number])) };
  const opened = await openSealedContent({
    header,
    ciphertext: ciphertext !== undefined ? Buffer.from(ciphertext, 'base64url') : ciphertextOf!(ciphertextRef!),
    scopeKey: keyring.scopeKey,
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
  it('advertises sealed-payload-v1 only with the injected keyring', async () => {
    const plain = await start();
    const hello = await plain.server.waitFor((envelope) => envelope.type === 'conn.hello', BUDGET_MS);
    expect((hello.payload as { capabilities: string[] }).capabilities).not.toContain('sealed-payload-v1');
    await daemon!.stop(); daemon = undefined;
    await server!.close(); server = undefined;

    const sealed = await start({ keyring: new TestKeyring() });
    const sealedHello = await sealed.server.waitFor((envelope) => envelope.type === 'conn.hello', BUDGET_MS);
    expect((sealedHello.payload as { capabilities: string[] }).capabilities).toContain('sealed-payload-v1');
  });

  it('opens a sealed offer, runs it, and seals every output', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId, storeDir } = await start({ keyring });
    const instruction = `secret instruction ${randomUUID()}`;
    server.send(await sealedOffer(keyring, 'sealed-task', server.nextSeq(), deviceId, instruction));

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    expect(adapter.startCalls[0]!.task.instruction).toBe(instruction);
    adapter.sessions[0]!.emit({ type: 'progress', text: 'secret progress' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed', BUDGET_MS);
    expect(await openOutput(keyring, complete, deviceId)).toMatchObject({ summary: 'secret progress' });
    const progress = taskEnvelopes('sealed-task').filter((envelope) => envelope.type === 'task.progress_sealed');
    expect(progress.length).toBeGreaterThan(0);
    expect(JSON.stringify((await openOutput(keyring, progress[0]!, deviceId)).events)).toContain('secret progress');

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

  it('seals the output of a task whose instruction is plaintext', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring });
    server.send(await sealedOffer(keyring, 'output-only', server.nextSeq(), deviceId, 'plain instruction', OUTPUT_ONLY));

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    adapter.sessions[0]!.emit({ type: 'progress', text: 'sealed answer' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((envelope) => envelope.type === 'task.complete_sealed', BUDGET_MS);
    expect(await openOutput(keyring, complete, deviceId, OUTPUT_ONLY)).toMatchObject({ summary: 'sealed answer' });
    expect(JSON.stringify(taskEnvelopes('output-only'))).not.toContain('sealed answer');
  });

  it.each([
    ['sealed_key_unavailable', 'no key for the scope', async (keyring: TestKeyring, offer: Envelope) => {
      keyring.sealing = false;
      return offer;
    }],
    ['sealed_open_failed', 'a tampered ciphertext', async (_keyring: TestKeyring, offer: Envelope) => {
      const sealed = (offer.payload as { sealed: { ciphertext: string } }).sealed;
      const bytes = Buffer.from(sealed.ciphertext, 'base64url');
      bytes[0] = bytes[0]! ^ 1;
      return { ...offer, payload: { ...offer.payload, sealed: { ...sealed, ciphertext: bytes.toString('base64url') } } } as Envelope;
    }],
  ] as const)('declines with %s once, non-retryably, before a claim, for %s', async (code, _label, alter) => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId, cursor } = await start({ keyring });
    const offer = await alter(keyring, await sealedOffer(keyring, 'declined', server.nextSeq(), deviceId, 'never runs'));
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
    const keyring = new TestKeyring();
    const { server, deviceId } = await start({ keyring });
    const blobRef = { blobId: 'b1', contentHash: `sha256:${'1'.repeat(64)}`, size: 1, contentType: 'text/plain' };
    server.send(await sealedOffer(keyring, 'blob-instruction', server.nextSeq(), deviceId, blobRef));

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'blob-instruction', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealing_policy_mismatch', code: 'sealing_policy_mismatch', retryable: false });
  });

  it('declines in plaintext, without a code, when the server does not accept sealed output', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring, serverFlag: false });
    server.send(await sealedOffer(keyring, 'no-flag', server.nextSeq(), deviceId, 'never runs'));

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === 'no-flag', BUDGET_MS);
    expect(decline.payload).toEqual({ reason: 'sealed_payload_unsupported: the server does not accept sealed task output', retryable: false });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('applies a sealed steer once per steerId', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring });
    server.send(await sealedOffer(keyring, 'steered', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);

    const steerId = randomUUID();
    const { header, ciphertext } = await sealedMember(keyring, { text: 'go left' }, binding('task.steer', 'server-to-daemon', { taskId: 'steered', steerId }, deviceId, BOTH));
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

  it('seals an approval request, a cancel and a runtime failure', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring });
    server.send(await sealedOffer(keyring, 'approval', server.nextSeq(), deviceId, 'run'));
    server.send(await sealedOffer(keyring, 'failing', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2), BUDGET_MS);
    const session = (taskIndex: number) => adapter.sessions[taskIndex]!;

    session(0).emit({ type: 'needs_approval', summary: 'secret approval summary' });
    const approval = await server.waitFor((envelope) => envelope.type === 'task.await_approval_sealed', BUDGET_MS);
    expect(approval.payload).toMatchObject({ approvalId: expect.any(String) });
    expect(await openOutput(keyring, approval, deviceId)).toEqual({ summary: 'secret approval summary' });
    server.send(createEnvelope('task.cancel', { reason: 'user stopped it' }, { taskId: approval.task_id!, seq: server.nextSeq() }));
    const cancelled = await server.waitFor((envelope) => envelope.type === 'task.cancelled_sealed', BUDGET_MS);
    expect(cancelled.task_id).toBe(approval.task_id);
    expect(await openOutput(keyring, cancelled, deviceId)).toEqual({ reason: expect.any(String) });

    session(1).fail(new Error('secret runtime failure'));
    const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed', BUDGET_MS);
    expect(await openOutput(keyring, failed, deviceId)).toEqual({ reason: expect.any(String) });

    const wire = JSON.stringify(server.received);
    expect(wire).not.toContain('secret approval summary');
    expect(server.received.map((envelope) => envelope.type)).not.toEqual(expect.arrayContaining(['task.await_approval']));
  });

  it('settles a terminal over the sealed plaintext limit with a small sealed failure', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring });
    server.send(await sealedOffer(keyring, 'huge', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      adapter.sessions[0]!.emit({ type: 'progress', text: 'p'.repeat(SEALED_PAYLOAD_MAX_CONTENT_LENGTH + 1024) });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      const failed = await server.waitFor((envelope) => envelope.type === 'task.fail_sealed' && envelope.task_id === 'huge', 15_000);
      expect(await openOutput(keyring, failed, deviceId)).toEqual({ reason: 'terminal_result_unsealable' });
    } finally {
      diagnostic.mockRestore();
    }
  }, 30_000);

  it('reports sealed_key_unavailable in plaintext when the sealing key is gone at the terminal', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring });
    server.send(await sealedOffer(keyring, 'key-lost', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    keyring.sealing = false;
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

  it('reports an interrupted sealed task with the plaintext daemon_interrupted terminal', async () => {
    const keyring = new TestKeyring();
    let offer: Envelope | undefined;
    await start({
      keyring,
      // A crash image: the sealed offer was admitted, and the process died before any terminal.
      beforeStart: async (storeDir, deviceId) => {
        offer = await sealedOffer(keyring, 'interrupted', 1, deviceId, 'run');
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

  it('sends a sealed artifact inline with a fresh artifactId, above the plaintext 64 KB limit', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring });
    server.send(await sealedOffer(keyring, 'artifact', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const content = randomBytes(100 * 1024);
    await fs.writeFile(path.join(adapter.startCalls[0]!.ctx.workspaceDir, 'out.bin'), content);
    adapter.sessions[0]!.emit({ type: 'artifact', name: 'out.bin', contentType: 'application/octet-stream' });

    const artifact = await server.waitFor((envelope) => envelope.type === 'task.artifact_sealed', BUDGET_MS);
    expect(artifact.payload).toMatchObject({ name: 'out.bin', contentType: 'application/octet-stream', artifactId: expect.any(String) });
    expect(await openOutput(keyring, artifact, deviceId)).toEqual({ inline: content.toString('base64') });
    expect(taskEnvelopes('artifact').map((envelope) => envelope.type)).not.toContain('task.artifact');
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((envelope) => envelope.type === 'task.complete_sealed', BUDGET_MS);
  });

  it('uploads a large sealed output as an octet-stream ciphertext blob', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring });
    server.send(await sealedOffer(keyring, 'large', server.nextSeq(), deviceId, 'run'));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), BUDGET_MS);
    const content = randomBytes(220 * 1024);
    await fs.writeFile(path.join(adapter.startCalls[0]!.ctx.workspaceDir, 'large.bin'), content);
    adapter.sessions[0]!.emit({ type: 'artifact', name: 'large.bin', contentType: 'application/octet-stream' });

    const artifact = await server.waitFor((envelope) => envelope.type === 'task.artifact_sealed', BUDGET_MS);
    const ref = (artifact.payload as { sealed: { paddedLength: number; ciphertextRef?: { blobId: string; contentType: string } } }).sealed;
    expect(ref.paddedLength).toBeGreaterThan(SEALED_INLINE_MAX_PADDED_LENGTH);
    expect(ref.ciphertextRef?.contentType).toBe('application/octet-stream');
    const opened = await openOutput(keyring, artifact, deviceId, BOTH, ({ blobId }) => server.blobContent(blobId)!);
    expect(opened).toEqual({ inline: content.toString('base64') });
  });

  it('opens a sealed offer whose ciphertext is a blob, after the hash check', async () => {
    const keyring = new TestKeyring();
    const { server, adapter, deviceId } = await start({ keyring });
    const instruction = 'i'.repeat(300 * 1024);
    const offerOf = async (taskId: string, corrupt: boolean): Promise<Envelope> => {
      const { header, ciphertext } = await sealedMember(keyring, { instruction }, binding('task.offer', 'server-to-daemon', { taskId }, deviceId, BOTH));
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
    const keyring = new TestKeyring();
    const { server, cursor } = await start({ keyring });
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
