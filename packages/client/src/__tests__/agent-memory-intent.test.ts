import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentMemoryIntentOperationDigest } from '@byok-sdk/core';
import {
  AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM,
  AGENT_MEMORY_INTENT_REJECTION_CODES,
  createEnvelope,
  type AgentMemoryIntentCompletion,
  type AgentMemoryIntentHostTerminalCode,
  type AgentMemoryIntentReadback,
  type AgentMemoryIntentReadbackDisposition,
  type AgentMemoryIntentV1,
  type AgentRef,
} from '@byok-sdk/protocol';

import { AgentHomeManager, type AgentHomeLease } from '../agent-home';
import {
  AGENT_MEMORY_AUDIT_FILENAME,
  AGENT_MEMORY_MAX_LOCAL_LOG_BYTES,
  AgentMemoryIoError,
  AgentMemoryRevisionConflictError,
  AgentMemoryValidationError,
  agentMemoryHomeBinding,
  appendAgentMemoryHomeAudit,
  compareAndSwapAgentMemoryHomeFile,
  isAgentMemorySecureFilesystemAvailable,
  replaceAgentMemoryHomeInternalFileStrict,
  validateAgentMemoryPath,
} from '../daemon/agent-memory';
import type { AgentMemoryFilesystem, AgentMemoryFilesystemFileState } from '../daemon/agent-memory-filesystem';
import { isAgentMemoryFilesystemHelperSupported, openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import {
  AGENT_MEMORY_INTENT_LEDGER_CAPACITY,
  AGENT_MEMORY_INTENT_LEDGER_ENVELOPE_BYTES,
  AGENT_MEMORY_INTENT_LEDGER_FILENAME,
  AGENT_MEMORY_INTENT_LEDGER_RECORD_MAX_BYTES,
  AGENT_MEMORY_INTENT_NOTICE_FAILURE_REASONS,
  AgentMemoryIntentNoticeError,
  NATIVE_AGENT_MEMORY_INTENT_BACKEND,
  agentMemoryIntentLedgerRecordBytes,
  createAgentMemoryIntentProcessor,
  helperAgentMemoryIntentBackend,
  parseAgentMemoryIntentLedger,
  serializeAgentMemoryIntentLedger,
  type AgentMemoryIntentBackend,
  type AgentMemoryIntentFetchInput,
  type AgentMemoryIntentLedgerRecord,
  type AgentMemoryIntentNoticeFailureReason,
  type AgentMemoryIntentTransport,
} from '../daemon/agent-memory-intent';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DaemonObserver, type DaemonEvent } from '../daemon/observer';
import { formatDaemonEventLine } from '../bin/format';
import { CursorStore } from '../daemon/cursor-store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/*
 * WP2I-S2 — the daemon half of Host-approved Agent memory intents
 * (docs/researches/2026-09-28-hermes-device-memory-cas-contract.md).
 *
 * Every trace runs against a REAL temp Agent home (real `AgentHomeManager`
 * leases and directories) and an injected fake Host transport. The memory
 * backend is either the native Linux descriptor backend (Linux only), the
 * product macOS helper (only when `BYOK_TEST_AGENT_MEMORY_FS_BIN` names a
 * built helper), or `FakeBackend`: an `AgentMemoryFilesystem` (the existing
 * external-backend seam) over the same real files, which can inject a ledger
 * write whose rename is visible but whose fsync fails, and a power loss that
 * restores every file to its last durable state.
 */

const TENANT = 'tenant-s2';
const DEVICE = 'device-s2';
const AGENT: AgentRef = Object.freeze({ agentId: 'agent-s2', profileRevision: '7' });
const EMPTY = sha('');
const SEED_PREFIX = '00000000-0000-4000-8000-';

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
}

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// Fake proven backend over the real home files
// ---------------------------------------------------------------------------

type LedgerStep = 'ok' | 'visible-then-fsync-fails' | 'fails-before-rename';

function fileState(content: string | undefined): AgentMemoryFilesystemFileState {
  const value = content ?? '';
  return Object.freeze({ exists: content !== undefined, content: value, revision: sha(value), byteCount: Buffer.byteLength(value, 'utf8') });
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

class FakeBackend {
  casCalls = 0;
  ledgerWrites = 0;
  /** Next ledger writes, consumed in order; an empty queue means `ok`. */
  ledgerSteps: LedgerStep[] = [];
  /** Throw an I/O error after the memory CAS installed its bytes. */
  casIoFailureAfterWrite = false;
  beforeCas?: () => Promise<void>;
  /** Absolute path -> last DURABLE content (undefined = absent). */
  private readonly durable = new Map<string, string | undefined>();

  constructor(readonly events: string[], private readonly proof: { conflictProvesNoRename: boolean; strictLedgerBarrier: boolean } = { conflictProvesNoRename: true, strictLedgerBarrier: true }) {}

  descriptor(): AgentMemoryIntentBackend {
    return {
      openFilesystem: async (lease: AgentHomeLease) => this.bind(lease.canonicalHome),
      conflictProvesNoRename: this.proof.conflictProvesNoRename,
      strictLedgerBarrier: this.proof.strictLedgerBarrier,
    };
  }

  /** Every tracked file returns to its last durable content. */
  async powerLoss(): Promise<void> {
    for (const [file, content] of this.durable) {
      if (content === undefined) await fs.rm(file, { force: true });
      else await fs.writeFile(file, content, 'utf8');
    }
  }

  private async track(file: string): Promise<void> {
    if (!this.durable.has(file)) this.durable.set(file, await readOptional(file));
  }

  private bind(home: string): AgentMemoryFilesystem {
    const resolve = (relative: string): string => path.join(home, ...relative.split('/'));
    return {
      read: async (relative, maxBytes) => {
        const content = await readOptional(resolve(relative));
        if (content !== undefined && Buffer.byteLength(content, 'utf8') > maxBytes) throw new AgentMemoryValidationError('memory file is not a bounded regular file');
        return fileState(content);
      },
      replace: async (relative, expectedRevision, content, maxBytes) => {
        const file = resolve(relative);
        await this.track(file);
        if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new AgentMemoryValidationError('too large');
        const before = fileState(await readOptional(file));
        if (relative === `.byok/${AGENT_MEMORY_INTENT_LEDGER_FILENAME}`) {
          const step = this.ledgerSteps.shift() ?? 'ok';
          if (before.revision !== expectedRevision) throw new AgentMemoryRevisionConflictError(expectedRevision, before.revision);
          if (step === 'fails-before-rename') throw new AgentMemoryIoError('injected: ledger write failed before rename');
          await fs.writeFile(file, content, 'utf8');
          if (step === 'visible-then-fsync-fails') throw new AgentMemoryIoError('injected: ledger rename visible, fsync failed');
          this.durable.set(file, content);
          this.ledgerWrites += 1;
          this.events.push(`ledger:${ledgerLabel(content)}`);
          return fileState(content);
        }
        if (relative.startsWith('.byok/')) {
          if (before.revision !== expectedRevision) throw new AgentMemoryRevisionConflictError(expectedRevision, before.revision);
          await fs.writeFile(file, content, 'utf8');
          this.durable.set(file, content);
          return fileState(content);
        }
        this.casCalls += 1;
        this.events.push('cas');
        await this.beforeCas?.();
        const current = fileState(await readOptional(file));
        if (current.revision !== expectedRevision) throw new AgentMemoryRevisionConflictError(expectedRevision, current.revision);
        await fs.writeFile(file, content, 'utf8');
        this.durable.set(file, content);
        if (this.casIoFailureAfterWrite) throw new AgentMemoryIoError('injected: directory fsync after memory rename failed');
        return fileState(content);
      },
      delete: async (relative, expectedRevision) => {
        const file = resolve(relative);
        await this.track(file);
        this.casCalls += 1;
        this.events.push('cas');
        await this.beforeCas?.();
        const current = fileState(await readOptional(file));
        if (!current.exists || current.revision !== expectedRevision) throw new AgentMemoryRevisionConflictError(expectedRevision, current.revision);
        await fs.rm(file);
        this.durable.set(file, undefined);
      },
      append: async () => { throw new Error('append is not an intent operation'); },
      walk: async () => Object.freeze([]),
      close: async () => {},
    };
  }
}

function ledgerLabel(content: string): string {
  const records = parseAgentMemoryIntentLedger(content).filter((record) => !record.intentId.startsWith(SEED_PREFIX));
  return records.map((record) => `${record.state}${record.ackedAt === null ? '' : '+acked'}`).join(',');
}

// ---------------------------------------------------------------------------
// Fake Host (transport)
// ---------------------------------------------------------------------------

interface HostIntent {
  readonly intent: AgentMemoryIntentV1;
  status: 'approved' | 'dispatched' | 'terminal';
  stored?: AgentMemoryIntentCompletion;
  hostCode?: AgentMemoryIntentHostTerminalCode;
  /** Host terminates a never-dispatched intent at its next held fetch. */
  terminateBeforeRelease?: AgentMemoryIntentHostTerminalCode;
  revokeRequested?: boolean;
  /** Disposition a no-row terminal fetch reports for a stored device completion. */
  storedDisposition?: AgentMemoryIntentReadbackDisposition;
}

function withoutContent(intent: AgentMemoryIntentV1): AgentMemoryIntentV1 {
  const { content: _content, ...identity } = intent;
  return identity;
}

function sameCompletion(left: AgentMemoryIntentCompletion, right: AgentMemoryIntentCompletion): boolean {
  return JSON.stringify(canonicalCompletion(left)) === JSON.stringify(canonicalCompletion(right));
}
function canonicalCompletion(completion: AgentMemoryIntentCompletion): unknown {
  const identity = [completion.intentId, completion.agentRef.agentId, completion.agentRef.profileRevision, completion.path, completion.operation, completion.operationDigest];
  switch (completion.outcome) {
    case 'applied': return [identity, completion.outcome, completion.result.exists, completion.result.revision];
    case 'rejected': return [identity, completion.outcome, completion.code];
    default: return [identity, completion.outcome, completion.observed.exists, completion.observed.revision];
  }
}

class FakeHost implements AgentMemoryIntentTransport {
  readonly intents = new Map<string, HostIntent>();
  readonly fetches: AgentMemoryIntentFetchInput[] = [];
  readonly completes: AgentMemoryIntentCompletion[] = [];
  leaseViolations = 0;
  fetchOverride?: (request: AgentMemoryIntentFetchInput) => unknown;
  completeOverride?: (completion: AgentMemoryIntentCompletion) => unknown;
  /** Runs after the lease probe, inside the network call. */
  onFetch?: () => Promise<void>;
  onComplete?: () => Promise<void>;
  /** Fail the next N completes before the Host records anything. */
  failCompletesBeforeRecord = 0;
  /** Record the next N completes, then lose the response. */
  loseCompleteResponses = 0;
  /** The tenant and device the Host authenticated (its assertion principal). */
  identity = { tenantId: TENANT, deviceId: DEVICE };

  constructor(private readonly homes: AgentHomeManager, private readonly events: string[]) {}

  add(intent: AgentMemoryIntentV1, init: Partial<HostIntent> = {}): HostIntent {
    const entry: HostIntent = { intent, status: 'approved', ...init };
    this.intents.set(intent.intentId, entry);
    return entry;
  }

  readback(intentId: string, disposition: AgentMemoryIntentReadbackDisposition, completion: AgentMemoryIntentCompletion): AgentMemoryIntentReadback {
    return { ...this.identity, intentId, disposition, completion, recordedAt: '2026-09-28T12:00:00.000Z' };
  }

  /** The home lease must be free during every network call. */
  private async probeLease(agentRef: AgentRef): Promise<void> {
    try {
      const binding = await this.homes.acquire(agentRef);
      await binding.lease.release();
    } catch {
      this.leaseViolations += 1;
    }
  }

  async fetch(request: AgentMemoryIntentFetchInput): Promise<unknown> {
    this.fetches.push(request);
    this.events.push(`fetch:${request.reservation}`);
    await this.probeLease(request.agentRef);
    await this.onFetch?.();
    if (this.fetchOverride !== undefined) return this.fetchOverride(request);
    const entry = this.intents.get(request.intentId);
    if (entry === undefined) throw new Error('404 unknown intent');
    const identity = withoutContent(entry.intent);
    if (entry.status === 'terminal') {
      const disposition = entry.hostCode !== undefined ? 'host_terminal' : (entry.storedDisposition ?? 'recorded');
      return { disposition: 'terminal', intent: identity, readback: this.readback(request.intentId, disposition, entry.stored!) };
    }
    // `none`: no state transition, no content, ever.
    if (request.reservation === 'none') return { disposition: 'deferred', intent: identity };
    if (entry.status === 'approved') {
      if (entry.terminateBeforeRelease !== undefined) {
        entry.status = 'terminal';
        entry.hostCode = entry.terminateBeforeRelease;
        entry.stored = { ...completionIdentity(entry.intent), outcome: 'rejected', code: entry.terminateBeforeRelease };
        return { disposition: 'terminal', intent: identity, readback: this.readback(request.intentId, 'host_terminal', entry.stored) };
      }
      entry.status = 'dispatched';
      return { disposition: 'release', intent: entry.intent };
    }
    if (entry.revokeRequested === true) return { disposition: 'withheld', intent: identity, code: 'intent_revoked' };
    return { disposition: 'release', intent: entry.intent };
  }

  async complete(completion: AgentMemoryIntentCompletion): Promise<unknown> {
    this.completes.push(completion);
    this.events.push(`complete:${completion.outcome}`);
    await this.probeLease(completion.agentRef);
    await this.onComplete?.();
    if (this.failCompletesBeforeRecord > 0) {
      this.failCompletesBeforeRecord -= 1;
      throw new Error('Host unreachable');
    }
    if (this.completeOverride !== undefined) return this.completeOverride(completion);
    const entry = this.intents.get(completion.intentId);
    if (entry === undefined) throw new Error('404 unknown intent');
    let answer: AgentMemoryIntentReadback;
    if (entry.status === 'terminal') {
      if (entry.hostCode !== undefined) answer = this.readback(completion.intentId, 'host_terminal', entry.stored!);
      else answer = this.readback(completion.intentId, sameCompletion(entry.stored!, completion) ? 'idempotent' : 'conflict', entry.stored!);
    } else {
      entry.status = 'terminal';
      entry.stored = completion;
      answer = this.readback(completion.intentId, 'recorded', completion);
    }
    if (this.loseCompleteResponses > 0) {
      this.loseCompleteResponses -= 1;
      throw new Error('response lost');
    }
    return answer;
  }
}

function completionIdentity(intent: AgentMemoryIntentV1) {
  return { intentId: intent.intentId, agentRef: { ...intent.agentRef }, path: intent.path, operation: intent.operation, operationDigest: intent.operationDigest };
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface IntentInput {
  readonly path: string;
  readonly operation: 'replace' | 'delete';
  readonly base: string;
  readonly content?: string;
  readonly agentRef?: AgentRef;
  readonly digestDeviceId?: string;
  readonly digestTenantId?: string;
  /** Replace the computed digest outright (a tampered digest). */
  readonly operationDigest?: string;
  readonly targetRevision?: string;
  readonly intentId?: string;
}

async function makeIntent(input: IntentInput): Promise<AgentMemoryIntentV1> {
  const intentId = input.intentId ?? randomUUID();
  const agentRef = input.agentRef ?? AGENT;
  const targetRevision = input.operation === 'replace' ? (input.targetRevision ?? sha(input.content ?? '')) : null;
  const approvalRef = `approval:${intentId.slice(0, 8)}`;
  const operationDigest = await agentMemoryIntentOperationDigest({
    tenantId: input.digestTenantId ?? TENANT,
    deviceId: input.digestDeviceId ?? DEVICE,
    intentId,
    agentRef,
    path: input.path,
    operation: input.operation,
    baseRevision: input.base,
    targetRevision,
    approvalRef,
  });
  return {
    intentId,
    agentRef: { ...agentRef },
    path: input.path,
    operation: input.operation,
    baseRevision: input.base,
    targetRevision,
    ...(input.operation === 'replace' ? { content: input.content ?? '' } : {}),
    approvalRef,
    operationDigest: input.operationDigest ?? operationDigest,
  };
}

async function world(proof?: { conflictProvesNoRename: boolean; strictLedgerBarrier: boolean }) {
  const hostStorageRoot = await tempRoot('bk-s2-home-');
  const homes = new AgentHomeManager({ hostStorageRoot });
  const events: string[] = [];
  const backend = new FakeBackend(events, proof);
  const host = new FakeHost(homes, events);
  const canonicalHome = path.join(hostStorageRoot, 'agents', AGENT.agentId);
  const integrityEvents: Array<Readonly<{ intentId: string; disposition: 'conflict' | 'host_terminal' }>> = [];
  const processor = (overrides: { backend?: AgentMemoryIntentBackend; transport?: AgentMemoryIntentTransport | null } = {}) =>
    createAgentMemoryIntentProcessor({
      tenantId: TENANT,
      deviceId: DEVICE,
      transport: overrides.transport === null ? undefined : (overrides.transport ?? host),
      homes,
      backend: overrides.backend ?? backend.descriptor(),
      onIntegrity: (event) => { integrityEvents.push(event); },
    });
  const ledgerFile = path.join(canonicalHome, '.byok', AGENT_MEMORY_INTENT_LEDGER_FILENAME);
  return {
    hostStorageRoot,
    homes,
    events,
    integrityEvents,
    backend,
    host,
    canonicalHome,
    processor,
    ledgerFile,
    async ledger(): Promise<readonly AgentMemoryIntentLedgerRecord[] | undefined> {
      const content = await readOptional(ledgerFile);
      return content === undefined ? undefined : parseAgentMemoryIntentLedger(content);
    },
    async record(intentId: string): Promise<AgentMemoryIntentLedgerRecord | undefined> {
      return (await this.ledger())?.find((record) => record.intentId === intentId);
    },
    memoryFile: (relative: string) => path.join(canonicalHome, ...relative.split('/')),
    async writeMemory(relative: string, content: string): Promise<void> {
      const file = path.join(canonicalHome, ...relative.split('/'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
    },
    readMemory: (relative: string) => readOptional(path.join(canonicalHome, ...relative.split('/'))),
    async seedLedger(records: readonly AgentMemoryIntentLedgerRecord[]): Promise<void> {
      await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
      await fs.writeFile(ledgerFile, serializeAgentMemoryIntentLedger(records), 'utf8');
    },
  };
}

function notice(intent: { intentId: string }, agentRef: AgentRef = AGENT) {
  return { intentId: intent.intentId, agentRef: { ...agentRef } };
}

async function failureReason(promise: Promise<unknown>): Promise<AgentMemoryIntentNoticeFailureReason> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMemoryIntentNoticeError);
    expect(Object.keys(error as object)).toEqual([]);
    return (error as AgentMemoryIntentNoticeError).reason;
  }
  throw new Error('the notice resolved; expected a closed failure reason');
}

function seed(index: number, overrides: Partial<AgentMemoryIntentLedgerRecord> = {}): AgentMemoryIntentLedgerRecord {
  return {
    intentId: `${SEED_PREFIX}${index.toString(16).padStart(12, '0')}`,
    profileRevision: '7',
    path: `notes/seed-${index}.md`,
    operation: 'replace',
    operationDigest: sha(`digest-${index}`),
    baseRevision: EMPTY,
    targetRevision: sha(`target-${index}`),
    approvalRef: `approval-${index}`,
    state: 'rejected',
    detail: { code: 'intent_invalid' },
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ackedAt: null,
    ...overrides,
  };
}

async function auditLines(canonicalHome: string): Promise<Array<Record<string, unknown>>> {
  const content = await readOptional(path.join(canonicalHome, '.byok', AGENT_MEMORY_AUDIT_FILENAME));
  if (content === undefined) return [];
  return content.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ===========================================================================
// Live path
// ===========================================================================

describe('WP2I-S2 live path (real temp Agent home, fake Host)', () => {
  it('replace creates a new note from the bootstrap sha256("") base (missing file) and orders every barrier', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'alpha' });
    w.host.add(intent);

    const result = await w.processor()(notice(intent));

    expect(result.kind).toBe('acknowledged');
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion).toEqual({ ...completionIdentity(intent), outcome: 'applied', result: { exists: true, revision: sha('alpha') } });
    expect(result.readback.disposition).toBe('recorded');
    expect(result.integrity).toBe(false);
    expect(await w.readMemory('notes/host-a.md')).toBe('alpha');
    expect(w.backend.casCalls).toBe(1);
    // durable applying -> ONE CAS -> terminal barrier -> complete -> ackedAt barrier -> resolve
    expect(w.events).toEqual(['fetch:held', 'ledger:applying', 'cas', 'ledger:applied', 'complete:applied', 'ledger:applied+acked']);
    const record = await w.record(intent.intentId);
    expect(record?.state).toBe('applied');
    expect(record?.ackedAt).not.toBeNull();
    expect(w.host.leaseViolations).toBe(0);
    // Content never reaches the ledger or the audit tail.
    expect(readFileSync(w.ledgerFile, 'utf8')).not.toContain('alpha');
    expect(JSON.stringify(await auditLines(w.canonicalHome))).not.toContain('alpha');
  });

  it('replace updates an existing note', async () => {
    const w = await world();
    await w.writeMemory('notes/host-b.md', 'old');
    const intent = await makeIntent({ path: 'notes/host-b.md', operation: 'replace', base: sha('old'), content: 'new' });
    w.host.add(intent);
    const result = await w.processor()(notice(intent));
    expect(result.kind === 'acknowledged' && result.completion.outcome).toBe('applied');
    expect(await w.readMemory('notes/host-b.md')).toBe('new');
    expect(w.backend.casCalls).toBe(1);
  });

  it('bootstrap sha256("") passes for an existing EMPTY file as well as a missing one', async () => {
    const w = await world();
    await w.writeMemory('notes/host-empty.md', '');
    const intent = await makeIntent({ path: 'notes/host-empty.md', operation: 'replace', base: EMPTY, content: 'filled' });
    w.host.add(intent);
    const result = await w.processor()(notice(intent));
    expect(result.kind === 'acknowledged' && result.completion.outcome).toBe('applied');
    expect(await w.readMemory('notes/host-empty.md')).toBe('filled');
  });

  it('delete of a note is applied with the missing-file receipt and a null targetRevision (a legitimate delete, not a revision mismatch)', async () => {
    const w = await world();
    await w.writeMemory('notes/host-gone.md', 'forget me');
    const intent = await makeIntent({ path: 'notes/host-gone.md', operation: 'delete', base: sha('forget me') });
    expect(intent.targetRevision).toBeNull();
    w.host.add(intent);
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion).toEqual({ ...completionIdentity(intent), outcome: 'applied', result: { exists: false, revision: EMPTY } });
    expect(result.readback.disposition).toBe('recorded');
    expect(await w.readMemory('notes/host-gone.md')).toBeUndefined();
    expect((await w.record(intent.intentId))?.state).toBe('applied');
  });

  it('replay: redelivery after resolve makes zero target-memory CAS, rewrites the ledger barrier, and re-completes idempotently', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'alpha' });
    w.host.add(intent);
    const process = w.processor();
    await process(notice(intent));
    const firstAckedAt = (await w.record(intent.intentId))?.ackedAt;
    const writesBefore = w.backend.ledgerWrites;
    w.events.length = 0;

    const replay = await process(notice(intent));

    if (replay.kind !== 'acknowledged') throw new Error('unreachable');
    expect(replay.readback.disposition).toBe('idempotent');
    expect(w.backend.casCalls).toBe(1);
    expect(w.host.fetches).toHaveLength(1);
    // Terminal barrier (a whole rewrite) BEFORE complete, ackedAt barrier after.
    expect(w.events).toEqual(['ledger:applied+acked', 'complete:applied', 'ledger:applied+acked']);
    expect(w.backend.ledgerWrites).toBe(writesBefore + 2);
    expect((await w.record(intent.intentId))?.ackedAt).toBe(firstAckedAt);
  });

  it('home busy at window 1: home_busy with zero writes and no fetch', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'alpha' });
    w.host.add(intent);
    const held = await w.homes.acquire(AGENT);
    try {
      expect(await failureReason(w.processor()(notice(intent)))).toBe('home_busy');
    } finally {
      await held.lease.release();
    }
    expect(w.host.fetches).toHaveLength(0);
    expect(w.host.completes).toHaveLength(0);
    expect(existsSync(w.ledgerFile)).toBe(false);
    expect(w.backend.casCalls).toBe(0);
    expect(await w.readMemory('notes/host-a.md')).toBeUndefined();
  });

  it('never runs a Host network call while the home lease is held', async () => {
    const w = await world();
    const intents = [
      await makeIntent({ path: 'notes/host-1.md', operation: 'replace', base: EMPTY, content: 'one' }),
      await makeIntent({ path: 'notes/host-2.md', operation: 'replace', base: sha('stale'), content: 'two' }),
    ];
    for (const intent of intents) w.host.add(intent);
    const process = w.processor();
    for (const intent of intents) {
      await process(notice(intent));
      await process(notice(intent));
    }
    expect(w.host.fetches.length + w.host.completes.length).toBeGreaterThan(0);
    expect(w.host.leaseViolations).toBe(0);
  });

  it('processes the intents of one Agent serially in this process', async () => {
    const w = await world();
    const first = await makeIntent({ path: 'notes/host-1.md', operation: 'replace', base: EMPTY, content: 'one' });
    const second = await makeIntent({ path: 'notes/host-2.md', operation: 'replace', base: EMPTY, content: 'two' });
    w.host.add(first);
    w.host.add(second);
    const process = w.processor();
    const results = await Promise.all([process(notice(first)), process(notice(second))]);
    expect(results.map((result) => result.kind)).toEqual(['acknowledged', 'acknowledged']);
    // The second intent's window 1 starts only after the first resolved.
    expect(w.events.indexOf('ledger:applied+acked')).toBeLessThan(w.events.indexOf('fetch:held', 1));
  });
});

// ===========================================================================
// Typed rejections
// ===========================================================================

describe('WP2I-S2 typed rejections (zero memory writes, no applying)', () => {
  async function rejected(input: IntentInput, noticeAgent: AgentRef = AGENT) {
    const w = await world();
    const intent = await makeIntent(input);
    w.host.add(intent);
    const result = await w.processor()(notice(intent, noticeAgent));
    if (result.kind !== 'acknowledged') throw new Error('expected an acknowledged rejection');
    expect(w.backend.casCalls).toBe(0);
    expect(w.events).not.toContain('ledger:applying');
    expect(result.completion.outcome).toBe('rejected');
    const record = await w.record(intent.intentId);
    expect(record?.state).toBe('rejected');
    return { w, intent, result, code: result.completion.outcome === 'rejected' ? result.completion.code : undefined };
  }

  it('delete of MEMORY.md -> memory_md_not_deletable', async () => {
    const { code, w } = await rejected({ path: 'MEMORY.md', operation: 'delete', base: EMPTY });
    expect(code).toBe('memory_md_not_deletable');
    expect(w.host.completes).toHaveLength(1);
  });

  it('content over 256 KiB -> content_invalid (typed, not fetch_invalid)', async () => {
    const { code } = await rejected({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'a'.repeat(262_145) });
    expect(code).toBe('content_invalid');
  });

  it('content that is not well-formed Unicode (not UTF-8 encodable) -> content_invalid', async () => {
    const { code } = await rejected({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'bad \uD800 surrogate', targetRevision: sha('anything') });
    expect(code).toBe('content_invalid');
  });

  it('replace whose sha256(utf8(content)) differs from targetRevision -> content_invalid before applying', async () => {
    const { code } = await rejected({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'alpha', targetRevision: sha('approved-body') });
    expect(code).toBe('content_invalid');
  });

  it('a syntactically valid path outside the memory path rule -> path_invalid', async () => {
    const { code } = await rejected({ path: 'notes/../escape.md', operation: 'replace', base: EMPTY, content: 'x' });
    expect(code).toBe('path_invalid');
  });

  it('stale baseRevision -> live-path conflict{observed} with the target untouched', async () => {
    const w = await world();
    await w.writeMemory('notes/host-a.md', 'current');
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: sha('stale'), content: 'next' });
    w.host.add(intent);
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion).toEqual({ ...completionIdentity(intent), outcome: 'conflict', observed: { exists: true, revision: sha('current') } });
    expect(w.backend.casCalls).toBe(1);
    expect(await w.readMemory('notes/host-a.md')).toBe('current');
  });

  it('a Host answer for another intent, or a malformed answer, is fetch_invalid with zero writes', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    const other = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    w.host.fetchOverride = () => ({ disposition: 'release', intent: other });
    expect(await failureReason(w.processor()(notice(intent)))).toBe('fetch_invalid');
    w.host.fetchOverride = () => ({ disposition: 'release', intent, extra: true });
    expect(await failureReason(w.processor()(notice(intent)))).toBe('fetch_invalid');
    w.host.fetchOverride = () => ({ disposition: 'release', intent: { ...intent, targetRevision: intent.baseRevision } });
    expect(await failureReason(w.processor()(notice(intent)))).toBe('fetch_invalid');
    expect(existsSync(w.ledgerFile)).toBe(false);
    expect(w.backend.casCalls).toBe(0);
  });

  it('a transport throw is fetch_failed / complete_failed and never resolves', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    w.host.fetchOverride = () => { throw new Error('HTTP 503 with a secret in its message'); };
    expect(await failureReason(w.processor()(notice(intent)))).toBe('fetch_failed');
    w.host.fetchOverride = undefined;
    w.host.failCompletesBeforeRecord = 1;
    expect(await failureReason(w.processor()(notice(intent)))).toBe('complete_failed');
    expect((await w.record(intent.intentId))?.ackedAt).toBeNull();
  });

  it('keeps a closed failure-reason set', () => {
    expect([...AGENT_MEMORY_INTENT_NOTICE_FAILURE_REASONS].sort()).toEqual([
      'complete_failed', 'fetch_failed', 'fetch_invalid', 'filesystem_unavailable', 'home_busy', 'ledger_full',
      'ledger_invalid', 'local_io_failed', 'readback_invalid', 'readback_mismatch', 'transport_unconfigured',
    ]);
    expect(AGENT_MEMORY_INTENT_REJECTION_CODES).toContain('content_invalid');
  });
});

// ===========================================================================
// Identity binding gate (S2 blocker fix, option A)
// ===========================================================================

/**
 * A Host that stores ONLY completions bound to the approved intent (identity
 * and digest) and to the enrolled tenant/device. Anything else is refused and
 * never stored. Separate from `FakeHost`, which stores whatever it is handed.
 */
class StrictHost implements AgentMemoryIntentTransport {
  readonly approved = new Map<string, { intent: AgentMemoryIntentV1; stored?: AgentMemoryIntentCompletion }>();
  readonly fetches: AgentMemoryIntentFetchInput[] = [];
  readonly completes: AgentMemoryIntentCompletion[] = [];
  refused = 0;

  approve(intent: AgentMemoryIntentV1): void {
    this.approved.set(intent.intentId, { intent });
  }

  private readback(intentId: string, disposition: AgentMemoryIntentReadbackDisposition, completion: AgentMemoryIntentCompletion): AgentMemoryIntentReadback {
    return { tenantId: TENANT, deviceId: DEVICE, intentId, disposition, completion, recordedAt: '2026-09-28T12:00:00.000Z' };
  }

  async fetch(request: AgentMemoryIntentFetchInput): Promise<unknown> {
    this.fetches.push(request);
    const entry = this.approved.get(request.intentId);
    if (entry === undefined) throw new Error('404 unknown intent');
    const identity = withoutContent(entry.intent);
    if (entry.stored !== undefined) return { disposition: 'terminal', intent: identity, readback: this.readback(request.intentId, 'recorded', entry.stored) };
    if (request.reservation === 'none') return { disposition: 'deferred', intent: identity };
    return { disposition: 'release', intent: entry.intent };
  }

  async complete(completion: AgentMemoryIntentCompletion): Promise<unknown> {
    this.completes.push(completion);
    const entry = this.approved.get(completion.intentId);
    const intent = entry?.intent;
    const enrolledDigest = intent === undefined ? undefined : await agentMemoryIntentOperationDigest({ tenantId: TENANT, deviceId: DEVICE, ...intent });
    if (
      entry === undefined || intent === undefined ||
      completion.agentRef.agentId !== intent.agentRef.agentId ||
      completion.agentRef.profileRevision !== intent.agentRef.profileRevision ||
      completion.path !== intent.path ||
      completion.operation !== intent.operation ||
      completion.operationDigest !== intent.operationDigest ||
      completion.operationDigest !== enrolledDigest
    ) {
      this.refused += 1;
      throw new Error('422 completion is not bound to the approved intent and enrollment');
    }
    if (entry.stored === undefined) {
      entry.stored = completion;
      return this.readback(completion.intentId, 'recorded', completion);
    }
    return this.readback(completion.intentId, sameCompletion(entry.stored, completion) ? 'idempotent' : 'conflict', entry.stored);
  }
}

describe('WP2I-S2 identity binding gate: only an intent bound to this notice and enrollment completes', () => {
  const OTHER_AGENT: AgentRef = { agentId: 'another-agent', profileRevision: '7' };
  const OTHER_PROFILE: AgentRef = { agentId: AGENT.agentId, profileRevision: '8' };
  const unbound: Array<[string, Partial<IntentInput>]> = [
    ['agentId mismatch', { agentRef: OTHER_AGENT }],
    ['profileRevision mismatch', { agentRef: OTHER_PROFILE }],
    ['digest computed for another tenant', { digestTenantId: 'tenant-other' }],
    ['digest computed for another device', { digestDeviceId: 'device-other' }],
    ['tampered digest alone', { operationDigest: sha('tampered') }],
  ];

  async function expectFetchInvalid(w: Awaited<ReturnType<typeof world>>, intent: AgentMemoryIntentV1): Promise<void> {
    const before = await readOptional(w.ledgerFile);
    expect(await failureReason(w.processor()(notice(intent)))).toBe('fetch_invalid');
    expect(await readOptional(w.ledgerFile)).toBe(before);
    expect(w.backend.ledgerWrites).toBe(0);
    expect(w.backend.casCalls).toBe(0);
    expect(w.host.completes).toHaveLength(0);
    expect(w.events.filter((event) => event.startsWith('ledger') || event === 'cas' || event.startsWith('complete'))).toEqual([]);
  }

  it.each(unbound)('release: %s -> fetch_invalid, zero ledger writes, zero CAS, zero complete, no resolve', async (_label, binding) => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x', ...binding });
    w.host.add(intent);
    await expectFetchInvalid(w, intent);
  });

  it.each(unbound)('withheld: %s -> fetch_invalid, zero ledger writes, zero CAS, zero complete, no resolve', async (_label, binding) => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x', ...binding });
    w.host.add(intent);
    w.host.fetchOverride = () => ({ disposition: 'withheld', intent: withoutContent(intent), code: 'intent_revoked' });
    await expectFetchInvalid(w, intent);
  });

  it.each([
    ['an invalid path', { path: 'notes/../escape.md', content: 'x' }],
    ['content over 256 KiB', { content: 'a'.repeat(262_145) }],
    ['content that is not well-formed Unicode', { content: 'bad \uD800', targetRevision: sha('anything') }],
    ['content whose digest is not targetRevision', { content: 'x', targetRevision: sha('approved-body') }],
  ] as const)('a binding mismatch together with %s is still fetch_invalid (a bad body never masks a wrong binding)', async (_label, defect) => {
    for (const binding of [{ agentRef: OTHER_PROFILE }, { digestDeviceId: 'device-other' }, { operationDigest: sha('tampered') }]) {
      const w = await world();
      const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, ...defect, ...binding });
      w.host.add(intent);
      await expectFetchInvalid(w, intent);
    }
  });

  it('the device never emits agent_ref_mismatch or intent_digest_mismatch', () => {
    const source = readFileSync(new URL('../daemon/agent-memory-intent.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("'agent_ref_mismatch'");
    expect(source).not.toContain("'intent_digest_mismatch'");
  });

  it('a strict Host refuses the old mixed tuple {agentRef: A, operationDigest: D(B)} and accepts a bound completion', async () => {
    const strict = new StrictHost();
    const intentB = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x', agentRef: OTHER_PROFILE });
    strict.approve(intentB);
    const mixed: AgentMemoryIntentCompletion = { ...completionIdentity(intentB), agentRef: { ...AGENT }, outcome: 'rejected', code: 'agent_ref_mismatch' };
    await expect(strict.complete(mixed)).rejects.toThrow(/not bound/u);
    const otherDevice = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x', digestDeviceId: 'device-other' });
    strict.approve(otherDevice);
    await expect(strict.complete({ ...completionIdentity(otherDevice), outcome: 'rejected', code: 'intent_digest_mismatch' })).rejects.toThrow(/not bound/u);
    expect(strict.refused).toBe(2);
    const bound = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    strict.approve(bound);
    await expect(strict.complete({ ...completionIdentity(bound), outcome: 'rejected', code: 'path_invalid' })).resolves.toMatchObject({ disposition: 'recorded' });
  });

  it('with a strict Host, a bound path_invalid rejection is recorded, acked, really pruned, and its replayed notice resolves on HT3', async () => {
    const w = await world();
    const strict = new StrictHost();
    const process = createAgentMemoryIntentProcessor({ tenantId: TENANT, deviceId: DEVICE, transport: strict, homes: w.homes, backend: w.backend.descriptor() });
    // N − 1 unacknowledged records: the next append after P must prune P.
    await w.seedLedger(Array.from({ length: AGENT_MEMORY_INTENT_LEDGER_CAPACITY - 1 }, (_, index) => seed(index)));

    const invalid = await makeIntent({ path: 'notes/../escape.md', operation: 'replace', base: EMPTY, content: 'x' });
    strict.approve(invalid);
    const recorded = await process(notice(invalid));
    if (recorded.kind !== 'acknowledged') throw new Error('unreachable');
    expect(recorded.completion).toEqual({ ...completionIdentity(invalid), outcome: 'rejected', code: 'path_invalid' });
    expect(recorded.readback.disposition).toBe('recorded');
    expect((await w.record(invalid.intentId))?.ackedAt).not.toBeNull();
    expect((await w.ledger())).toHaveLength(AGENT_MEMORY_INTENT_LEDGER_CAPACITY);

    const next = await makeIntent({ path: 'notes/host-b.md', operation: 'replace', base: EMPTY, content: 'y' });
    strict.approve(next);
    const applied = await process(notice(next));
    expect(applied.kind === 'acknowledged' && applied.completion.outcome).toBe('applied');
    // The acknowledged rejection was the only prunable record, and it is gone.
    expect(await w.record(invalid.intentId)).toBeUndefined();
    expect((await w.ledger())).toHaveLength(AGENT_MEMORY_INTENT_LEDGER_CAPACITY);

    const replay = await process(notice(invalid));
    if (replay.kind !== 'host_terminal') throw new Error('unreachable');
    expect(replay.readback.disposition).toBe('recorded');
    expect(replay.readback.completion).toEqual(recorded.completion);
    expect(strict.refused).toBe(0);
    expect(strict.completes).toHaveLength(2);
    expect(w.backend.casCalls).toBe(1);
  });
});

// ===========================================================================
// §R traces T1–T6: `applying` is never re-executed
// ===========================================================================

describe('WP2I-S2 §R recovery: applying -> uncertain, never a second CAS', () => {
  async function applyingThenCrash(options: { casRuns: boolean; content?: string; existing?: string }) {
    const w = await world();
    if (options.existing !== undefined) await w.writeMemory('notes/host-a.md', options.existing);
    const base = options.existing === undefined ? EMPTY : sha(options.existing);
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base, content: options.content ?? 'B' });
    w.host.add(intent);
    // CAS runs (T2..T5): the terminal write fails before its rename.
    // CAS never runs (T1/T6): the `applying` write's rename is visible but its fsync failed.
    w.backend.ledgerSteps = options.casRuns ? ['ok', 'fails-before-rename'] : ['visible-then-fsync-fails'];
    expect(await failureReason(w.processor()(notice(intent)))).toBe('local_io_failed');
    expect(w.host.completes).toHaveLength(0);
    expect((await w.record(intent.intentId))?.state).toBe('applying');
    expect(w.backend.casCalls).toBe(options.casRuns ? 1 : 0);
    return { w, intent };
  }

  async function recoverUncertain(w: Awaited<ReturnType<typeof world>>, intent: AgentMemoryIntentV1, observed: { exists: boolean; revision: string }) {
    const casBefore = w.backend.casCalls;
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion).toEqual({ ...completionIdentity(intent), outcome: 'uncertain', observed });
    expect(w.backend.casCalls - casBefore).toBe(0);
    expect(w.backend.casCalls).toBeLessThanOrEqual(1);
    expect(w.host.completes.map((completion) => completion.outcome)).toEqual(['uncertain']);
    expect(w.host.fetches).toHaveLength(1);
  }

  it('T1: crash before the CAS -> uncertain{A}; CAS count 0', async () => {
    const { w, intent } = await applyingThenCrash({ casRuns: false });
    await recoverUncertain(w, intent, { exists: false, revision: EMPTY });
    expect(w.backend.casCalls).toBe(0);
  });

  it('T2: CAS wrote B, crash before the terminal persisted -> restart -> uncertain{B}; CAS count 1', async () => {
    const { w, intent } = await applyingThenCrash({ casRuns: true });
    await recoverUncertain(w, intent, { exists: true, revision: sha('B') });
    expect(w.backend.casCalls).toBe(1);
  });

  it('T3: CAS wrote B, terminal write failed -> local_io_failed now, redelivery in the same process -> uncertain{B}; CAS count 1', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    w.host.add(intent);
    const process = w.processor();
    w.backend.ledgerSteps = ['ok', 'fails-before-rename'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    const result = await process(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion.outcome).toBe('uncertain');
    expect(w.backend.casCalls).toBe(1);
    expect(w.host.completes.map((completion) => completion.outcome)).toEqual(['uncertain']);
  });

  it('T4: after T2 another writer does B->A -> uncertain{A}, never a replayed CAS', async () => {
    const { w, intent } = await applyingThenCrash({ casRuns: true, existing: 'A' });
    await w.writeMemory('notes/host-a.md', 'A');
    await recoverUncertain(w, intent, { exists: true, revision: sha('A') });
    expect(w.backend.casCalls).toBe(1);
  });

  it('T5: after T2 another writer does B->C -> uncertain{C}, never a zero-write conflict', async () => {
    const { w, intent } = await applyingThenCrash({ casRuns: true });
    await w.writeMemory('notes/host-a.md', 'C');
    await recoverUncertain(w, intent, { exists: true, revision: sha('C') });
    expect(w.backend.casCalls).toBe(1);
  });

  it('T6: crash before the CAS, another writer produced B -> uncertain{B}, never applied; CAS count 0', async () => {
    const { w, intent } = await applyingThenCrash({ casRuns: false });
    await w.writeMemory('notes/host-a.md', 'B');
    await recoverUncertain(w, intent, { exists: true, revision: sha('B') });
    expect(w.backend.casCalls).toBe(0);
  });

  it('a non-conflict CAS failure after its write is uncertain{observed}, separate from the deterministic conflict', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    w.host.add(intent);
    w.backend.casIoFailureAfterWrite = true;
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion).toEqual({ ...completionIdentity(intent), outcome: 'uncertain', observed: { exists: true, revision: sha('B') } });
    expect(w.backend.casCalls).toBe(1);
  });
});

// ===========================================================================
// §L durable barriers D1–D4
// ===========================================================================

describe('WP2I-S2 §L durable barriers D1–D4 (fault injection on the ledger writer)', () => {
  it('D1: terminal rename visible then fsync fails -> no complete; failed barrier retry -> no complete; power loss -> applying -> uncertain is the only completion', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    w.host.add(intent);
    const process = w.processor();
    w.backend.ledgerSteps = ['ok', 'visible-then-fsync-fails'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    expect((await w.record(intent.intentId))?.state).toBe('applied'); // visible, not durable
    expect(w.host.completes).toHaveLength(0);

    w.backend.ledgerSteps = ['visible-then-fsync-fails'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    expect(w.host.completes).toHaveLength(0);

    await w.backend.powerLoss();
    expect((await w.record(intent.intentId))?.state).toBe('applying');
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(w.host.completes.map((completion) => completion.outcome)).toEqual(['uncertain']);
    expect(w.backend.casCalls).toBe(1);
  });

  it('D1 variant: a visible terminal is completed only after a SUCCESSFUL barrier rewrite (then the true applied)', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    w.host.add(intent);
    const process = w.processor();
    w.backend.ledgerSteps = ['ok', 'visible-then-fsync-fails'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    w.events.length = 0;
    const result = await process(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion.outcome).toBe('applied');
    expect(w.events).toEqual(['ledger:applied', 'complete:applied', 'ledger:applied+acked']);
    expect(w.backend.casCalls).toBe(1);
  });

  it('D2: terminal barrier ok -> Host recorded -> power loss before ackedAt -> redelivery barrier -> idempotent -> resolve', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    w.host.add(intent);
    w.backend.ledgerSteps = ['ok', 'ok', 'fails-before-rename'];
    expect(await failureReason(w.processor()(notice(intent)))).toBe('local_io_failed');
    expect(w.host.intents.get(intent.intentId)?.status).toBe('terminal');
    await w.backend.powerLoss();
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.readback.disposition).toBe('idempotent');
    expect(w.backend.casCalls).toBe(1);
  });

  it('D3: ackedAt rename visible then fsync fails -> no resolve; retry fails again; power loss drops ackedAt -> barrier -> idempotent -> resolve', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    w.host.add(intent);
    const process = w.processor();
    w.backend.ledgerSteps = ['ok', 'ok', 'visible-then-fsync-fails'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    expect((await w.record(intent.intentId))?.ackedAt).not.toBeNull(); // visible only
    // The recovery path must rebuild a barrier; a visible ackedAt is not one.
    w.backend.ledgerSteps = ['visible-then-fsync-fails'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    await w.backend.powerLoss();
    const afterLoss = await w.record(intent.intentId);
    expect(afterLoss?.state).toBe('applied');
    expect(afterLoss?.ackedAt).toBeNull();
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.readback.disposition).toBe('idempotent');
    expect((await w.record(intent.intentId))?.ackedAt).not.toBeNull();
    expect(w.backend.casCalls).toBe(1);
  });

  it('D4: ackedAt barrier ok -> resolve -> cursor lost -> redelivery re-barriers and re-completes idempotently', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    w.host.add(intent);
    await w.processor()(notice(intent));
    await w.backend.powerLoss(); // everything was durable: nothing changes
    w.events.length = 0;
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.readback.disposition).toBe('idempotent');
    expect(w.events).toEqual(['ledger:applied+acked', 'complete:applied', 'ledger:applied+acked']);
    expect(w.backend.casCalls).toBe(1);
  });
});

// ===========================================================================
// Host terminal branch HT1–HT9
// ===========================================================================

describe('WP2I-S2 Host terminal branch HT1–HT9', () => {
  it.each(['intent_expired', 'intent_revoked'] as const)('HT1/HT2: never-dispatched %s -> identity checked -> resolve with zero local writes', async (code) => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent, { terminateBeforeRelease: code });
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'host_terminal') throw new Error('unreachable');
    expect(result.readback.disposition).toBe('host_terminal');
    expect(result.readback.completion).toMatchObject({ outcome: 'rejected', code });
    expect(existsSync(w.ledgerFile)).toBe(false);
    expect(await auditLines(w.canonicalHome)).toEqual([]);
    expect(w.host.completes).toHaveLength(0);
    expect(w.backend.casCalls).toBe(0);
  });

  it('HT3: a pruned record\'s old notice resolves on the stored completion — including a stored conflict OUTCOME and a legitimate applied delete', async () => {
    const w = await world();
    const conflictIntent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(conflictIntent, {
      status: 'terminal',
      stored: { ...completionIdentity(conflictIntent), outcome: 'conflict', observed: { exists: true, revision: sha('other') } },
      storedDisposition: 'recorded',
    });
    const deleteIntent = await makeIntent({ path: 'notes/host-d.md', operation: 'delete', base: sha('old') });
    w.host.add(deleteIntent, {
      status: 'terminal',
      stored: { ...completionIdentity(deleteIntent), outcome: 'applied', result: { exists: false, revision: EMPTY } },
      storedDisposition: 'idempotent',
    });
    const process = w.processor();
    for (const intent of [conflictIntent, deleteIntent]) {
      const result = await process(notice(intent));
      expect(result.kind).toBe('host_terminal');
    }
    expect(w.host.fetches.map((request) => request.reservation)).toEqual(['held', 'held']);
    expect(existsSync(w.ledgerFile)).toBe(false);
    expect(w.backend.casCalls).toBe(0);
  });

  it('HT3 negative: an applied readback inconsistent with its operation is readback_invalid (no file re-read overturns or confirms it)', async () => {
    const w = await world();
    const replaceIntent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(replaceIntent, {
      status: 'terminal',
      stored: { ...completionIdentity(replaceIntent), outcome: 'applied', result: { exists: true, revision: sha('not-the-target') } },
    });
    const deleteIntent = await makeIntent({ path: 'notes/host-d.md', operation: 'delete', base: sha('old') });
    w.host.add(deleteIntent, {
      status: 'terminal',
      stored: { ...completionIdentity(deleteIntent), outcome: 'applied', result: { exists: true, revision: EMPTY } },
    });
    // The current file happens to hold the target bytes: that must not matter.
    await w.writeMemory('notes/host-a.md', 'x');
    const process = w.processor();
    expect(await failureReason(process(notice(replaceIntent)))).toBe('readback_invalid');
    expect(await failureReason(process(notice(deleteIntent)))).toBe('readback_invalid');
    expect(existsSync(w.ledgerFile)).toBe(false);
  });

  it('HT4: ledger full (N unacknowledged) + Host terminal -> reservation none -> resolve, ledger byte-identical', async () => {
    const w = await world();
    await w.seedLedger(Array.from({ length: AGENT_MEMORY_INTENT_LEDGER_CAPACITY }, (_, index) => seed(index)));
    const before = readFileSync(w.ledgerFile, 'utf8');
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent, { status: 'terminal', hostCode: 'intent_expired', stored: { ...completionIdentity(intent), outcome: 'rejected', code: 'intent_expired' } });
    const result = await w.processor()(notice(intent));
    expect(result.kind).toBe('host_terminal');
    expect(w.host.fetches.map((request) => request.reservation)).toEqual(['none']);
    expect(readFileSync(w.ledgerFile, 'utf8')).toBe(before);
  });

  it.each([['HT5', 'approved'], ['HT9', 'dispatched']] as const)('%s: ledger full + %s non-terminal intent -> deferred -> ledger_full, zero writes, Host state unchanged', async (_trace, status) => {
    const w = await world();
    await w.seedLedger(Array.from({ length: AGENT_MEMORY_INTENT_LEDGER_CAPACITY }, (_, index) => seed(index)));
    const before = readFileSync(w.ledgerFile, 'utf8');
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent, { status });
    expect(await failureReason(w.processor()(notice(intent)))).toBe('ledger_full');
    expect(w.host.fetches.map((request) => request.reservation)).toEqual(['none']);
    expect(w.host.intents.get(intent.intentId)?.status).toBe(status);
    expect(readFileSync(w.ledgerFile, 'utf8')).toBe(before);
    expect(w.backend.casCalls).toBe(0);
  });

  it('HT6: local uncertain vs a DIFFERENT Host completion -> integrity audit -> ackedAt barrier -> resolve', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    const entry = w.host.add(intent);
    w.backend.ledgerSteps = ['visible-then-fsync-fails'];
    expect(await failureReason(w.processor()(notice(intent)))).toBe('local_io_failed');
    // The Host (wrongly) holds a different fact for this intent.
    entry.status = 'terminal';
    entry.stored = { ...completionIdentity(intent), outcome: 'applied', result: { exists: true, revision: sha('B') } };
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion.outcome).toBe('uncertain');
    expect(result.readback.disposition).toBe('conflict');
    expect(result.integrity).toBe(true);
    const integrity = (await auditLines(w.canonicalHome)).filter((line) => line.kind === 'intent_integrity');
    expect(integrity).toHaveLength(1);
    expect(integrity[0]).toMatchObject({ intentId: intent.intentId, disposition: 'conflict', device: { outcome: 'uncertain' }, host: { outcome: 'applied' } });
    expect((await w.record(intent.intentId))?.ackedAt).not.toBeNull();
  });

  describe('HT7: readback identity mismatch -> readback_invalid, no resolve', () => {
    const mutations: Array<[string, (readback: AgentMemoryIntentReadback) => AgentMemoryIntentReadback]> = [
      ['tenant', (readback) => ({ ...readback, tenantId: 'tenant-other' })],
      ['device', (readback) => ({ ...readback, deviceId: 'device-other' })],
      ['intent', (readback) => {
        const intentId = randomUUID();
        return { ...readback, intentId, completion: { ...readback.completion, intentId } };
      }],
      ['agentRef', (readback) => ({ ...readback, completion: { ...readback.completion, agentRef: { agentId: AGENT.agentId, profileRevision: '8' } } })],
      ['digest', (readback) => ({ ...readback, completion: { ...readback.completion, operationDigest: sha('forged') } })],
    ];

    it.each(mutations)('after complete (%s)', async (_field, mutate) => {
      const w = await world();
      const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
      w.host.add(intent);
      w.host.completeOverride = (completion) => mutate(w.host.readback(intent.intentId, 'recorded', completion));
      expect(await failureReason(w.processor()(notice(intent)))).toBe('readback_invalid');
      expect((await w.record(intent.intentId))?.ackedAt).toBeNull();
    });

    it.each(mutations)('on the no-row terminal fetch (%s)', async (field, mutate) => {
      const w = await world();
      const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
      w.host.add(intent);
      const stored: AgentMemoryIntentCompletion = { ...completionIdentity(intent), outcome: 'rejected', code: 'intent_expired' };
      w.host.fetchOverride = () => {
        const readback = mutate(w.host.readback(intent.intentId, 'host_terminal', stored));
        // Keep the S1 fetch schema's own intent/readback identity coupling satisfied where the
        // mutation targets the readback only, so the DEVICE check is what refuses it.
        const intentView = { ...withoutContent(intent), ...(readback.completion.agentRef.profileRevision !== AGENT.profileRevision ? { agentRef: readback.completion.agentRef } : {}), ...(readback.completion.operationDigest !== intent.operationDigest ? { operationDigest: readback.completion.operationDigest } : {}) };
        return { disposition: 'terminal', intent: intentView, readback };
      };
      const reason = await failureReason(w.processor()(notice(intent)));
      // A readback for another intent already fails the S1 fetch schema's own
      // intent/readback coupling (fetch_invalid); every other mismatch reaches
      // the device identity check.
      expect(reason).toBe(field === 'intent' ? 'fetch_invalid' : 'readback_invalid');
      expect(existsSync(w.ledgerFile)).toBe(false);
    });
  });

  it('HT8: with a local row, a failed terminal barrier or ackedAt barrier never resolves', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    const process = w.processor();
    await process(notice(intent));
    w.backend.ledgerSteps = ['fails-before-rename'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    expect(w.host.completes).toHaveLength(1); // no re-complete without the terminal barrier
    w.backend.ledgerSteps = ['ok', 'visible-then-fsync-fails'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    expect(w.host.completes).toHaveLength(2);
    expect(w.backend.casCalls).toBe(1);
  });
});

// ===========================================================================
// Readback rules and the two different `conflict`s (S1 handoff constraints 1, 2)
// ===========================================================================

describe('WP2I-S2 readback rules', () => {
  it('readback mismatch (same identity, different stored completion under recorded) -> readback_mismatch, no resolve', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    const different: AgentMemoryIntentCompletion = { ...completionIdentity(intent), outcome: 'uncertain', observed: { exists: true, revision: sha('x') } };
    w.host.completeOverride = () => w.host.readback(intent.intentId, 'recorded', different);
    expect(await failureReason(w.processor()(notice(intent)))).toBe('readback_mismatch');
    expect((await w.record(intent.intentId))?.ackedAt).toBeNull();
  });

  it('a malformed readback is readback_invalid', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    w.host.completeOverride = () => ({ disposition: 'recorded' });
    expect(await failureReason(w.processor()(notice(intent)))).toBe('readback_invalid');
    w.host.completeOverride = () => new Proxy({}, {});
    expect(await failureReason(w.processor()(notice(intent)))).toBe('readback_invalid');
  });

  it('completion.outcome = conflict is a normal stored fact: recorded -> ackedAt -> resolve, no integrity audit', async () => {
    const w = await world();
    await w.writeMemory('notes/host-a.md', 'current');
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: sha('stale'), content: 'x' });
    w.host.add(intent);
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion.outcome).toBe('conflict');
    expect(result.readback.disposition).toBe('recorded');
    expect(result.integrity).toBe(false);
    expect((await auditLines(w.canonicalHome)).some((line) => line.kind === 'intent_integrity')).toBe(false);
  });

  it('readback.disposition = conflict in reply to complete keeps the integrity branch: audit -> ackedAt barrier -> resolve', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    const hostFact: AgentMemoryIntentCompletion = { ...completionIdentity(intent), outcome: 'rejected', code: 'intent_invalid' };
    w.host.completeOverride = () => w.host.readback(intent.intentId, 'conflict', hostFact);
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.integrity).toBe(true);
    expect((await auditLines(w.canonicalHome)).filter((line) => line.kind === 'intent_integrity')).toHaveLength(1);
    expect((await w.record(intent.intentId))?.ackedAt).not.toBeNull();
  });

  it('integrity branch: if the ackedAt barrier fails there is no resolve', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    const hostFact: AgentMemoryIntentCompletion = { ...completionIdentity(intent), outcome: 'uncertain', observed: { exists: true, revision: sha('x') } };
    w.host.completeOverride = () => w.host.readback(intent.intentId, 'conflict', hostFact);
    w.backend.ledgerSteps = ['ok', 'ok', 'fails-before-rename'];
    expect(await failureReason(w.processor()(notice(intent)))).toBe('local_io_failed');
    expect((await w.record(intent.intentId))?.ackedAt).toBeNull();
  });

  it('a host_terminal readback against a local terminal is the integrity branch too', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    w.host.completeOverride = () => w.host.readback(intent.intentId, 'host_terminal', { ...completionIdentity(intent), outcome: 'rejected', code: 'intent_expired' });
    const result = await w.processor()(notice(intent));
    expect(result.kind === 'acknowledged' && result.integrity).toBe(true);
  });

  it('no local row: a readback.disposition = conflict terminal is readback_invalid with ZERO ledger or audit writes and no device completion', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent, {
      status: 'terminal',
      stored: { ...completionIdentity(intent), outcome: 'conflict', observed: { exists: true, revision: sha('y') } },
      storedDisposition: 'conflict',
    });
    expect(await failureReason(w.processor()(notice(intent)))).toBe('readback_invalid');
    expect(existsSync(w.ledgerFile)).toBe(false);
    expect(await auditLines(w.canonicalHome)).toEqual([]);
    expect(w.host.completes).toHaveLength(0);
  });

  it.each(['host_terminal', 'recorded', 'idempotent'] as const)('no local row: disposition %s is accepted', async (disposition) => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    const stored: AgentMemoryIntentCompletion = disposition === 'host_terminal'
      ? { ...completionIdentity(intent), outcome: 'rejected', code: 'intent_revoked' }
      : { ...completionIdentity(intent), outcome: 'applied', result: { exists: true, revision: sha('x') } };
    w.host.add(intent, { status: 'terminal', stored, ...(disposition === 'host_terminal' ? { hostCode: 'intent_revoked' as const } : { storedDisposition: disposition }) });
    expect((await w.processor()(notice(intent))).kind).toBe('host_terminal');
    expect(existsSync(w.ledgerFile)).toBe(false);
  });
});

describe('WP2I-S2 integrity observer notification (gate finding 2)', () => {
  it('a readback conflict in reply to complete notifies exactly once with only {intentId, disposition}', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    w.host.completeOverride = () => w.host.readback(intent.intentId, 'conflict', { ...completionIdentity(intent), outcome: 'rejected', code: 'intent_invalid' });
    const result = await w.processor()(notice(intent));
    expect(result.kind === 'acknowledged' && result.integrity).toBe(true);
    expect(w.integrityEvents).toEqual([{ intentId: intent.intentId, disposition: 'conflict' }]);
    expect(Object.keys(w.integrityEvents[0]!).sort()).toEqual(['disposition', 'intentId']);
  });

  it('a host_terminal readback against a local terminal notifies exactly once', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    w.host.completeOverride = () => w.host.readback(intent.intentId, 'host_terminal', { ...completionIdentity(intent), outcome: 'rejected', code: 'intent_expired' });
    await w.processor()(notice(intent));
    expect(w.integrityEvents).toEqual([{ intentId: intent.intentId, disposition: 'host_terminal' }]);
  });

  it('recorded and idempotent readbacks, and a failed ackedAt barrier on the integrity branch, never notify', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    const process = w.processor();
    const first = await process(notice(intent));
    const replay = await process(notice(intent));
    expect(first.kind === 'acknowledged' && first.readback.disposition).toBe('recorded');
    expect(replay.kind === 'acknowledged' && replay.readback.disposition).toBe('idempotent');
    expect(w.integrityEvents).toEqual([]);

    const contradicted = await makeIntent({ path: 'notes/host-b.md', operation: 'replace', base: EMPTY, content: 'y' });
    w.host.add(contradicted);
    w.host.completeOverride = () => w.host.readback(contradicted.intentId, 'conflict', { ...completionIdentity(contradicted), outcome: 'rejected', code: 'intent_invalid' });
    w.backend.ledgerSteps = ['ok', 'ok', 'fails-before-rename'];
    expect(await failureReason(process(notice(contradicted)))).toBe('local_io_failed');
    expect(w.integrityEvents).toEqual([]);
  });

  it('DaemonObserver emits a metadata-only agent-memory-intent-integrity event and the CLI line names only id and disposition', () => {
    const observer = new DaemonObserver();
    const seen: DaemonEvent[] = [];
    observer.subscribe((event) => { seen.push(event); });
    const intentId = randomUUID();
    observer.noteAgentMemoryIntentIntegrity({ intentId, disposition: 'conflict' });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(['disposition', 'intentId', 'kind', 'ts']);
    expect(seen[0]).toMatchObject({ kind: 'agent-memory-intent-integrity', intentId, disposition: 'conflict' });
    expect(formatDaemonEventLine(seen[0]!)).toMatch(new RegExp(`agent-memory-intent-integrity intentId=${intentId} disposition=conflict$`, 'u'));
  });

  it('the daemon wires the processor integrity result to that observer method', () => {
    const source = readFileSync(new URL('../daemon/create-daemon.ts', import.meta.url), 'utf8');
    expect(source).toContain('onIntegrity: (event) => observer.noteAgentMemoryIntentIntegrity(event),');
  });
});

// ===========================================================================
// Negative controls L1–L8
// ===========================================================================

describe('WP2I-S2 negative controls L1–L8', () => {
  it('L1: N−1 unacknowledged records reserve (held); N reserve nothing (none); only acknowledged records are pruned', async () => {
    const reserve = async (records: AgentMemoryIntentLedgerRecord[]) => {
      const w = await world();
      await w.seedLedger(records);
      const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
      w.host.add(intent);
      await w.processor()(notice(intent)).catch(() => undefined);
      return { w, intent, reservation: w.host.fetches[0]?.reservation };
    };
    const n = AGENT_MEMORY_INTENT_LEDGER_CAPACITY;
    expect((await reserve(Array.from({ length: n - 1 }, (_, index) => seed(index)))).reservation).toBe('held');
    expect((await reserve(Array.from({ length: n }, (_, index) => seed(index)))).reservation).toBe('none');

    // N records, exactly one of which is acknowledged: it (and only it) is pruned.
    const records = Array.from({ length: n }, (_, index) => seed(index, index === 3 ? { ackedAt: '2026-09-28T01:00:00.000Z' } : {}));
    const { w, intent, reservation } = await reserve(records);
    expect(reservation).toBe('held');
    const after = (await w.ledger())!;
    expect(after).toHaveLength(n);
    expect(after.some((record) => record.intentId === seed(3).intentId)).toBe(false);
    expect(after.filter((record) => record.intentId.startsWith(SEED_PREFIX)).every((record) => record.ackedAt === null)).toBe(true);
    expect(after.find((record) => record.intentId === intent.intentId)?.state).toBe('applied');
  });

  it('L2 / stop point ④: the real serializer keeps the largest record + separator ≤ R_MAX and a full ledger ≤ 1 MiB', () => {
    const maxPath = `notes/${'a'.repeat(1024 - 'notes/'.length - '.md'.length)}.md`;
    expect(maxPath).toHaveLength(1024);
    const common = {
      intentId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      profileRevision: AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM,
      path: maxPath,
      operation: 'replace' as const,
      operationDigest: sha('d'),
      baseRevision: sha('b'),
      targetRevision: sha('t'),
      approvalRef: 'r'.repeat(128),
      createdAt: '2026-09-28T23:59:59.999Z',
      updatedAt: '2026-09-28T23:59:59.999Z',
      ackedAt: '2026-09-28T23:59:59.999Z',
    };
    const candidates: AgentMemoryIntentLedgerRecord[] = [
      { ...common, state: 'uncertain', detail: { exists: false, revision: sha('o') } },
      { ...common, state: 'conflict', detail: { exists: false, revision: sha('o') } },
      { ...common, state: 'applied', detail: { exists: true, revision: sha('t') } },
      ...AGENT_MEMORY_INTENT_REJECTION_CODES.map((code) => ({ ...common, state: 'rejected' as const, detail: { code } })),
    ];
    const largest = Math.max(...candidates.map(agentMemoryIntentLedgerRecordBytes));
    // Reported measurement (design estimate: 1810 B + 1 separator).
    console.info(`[WP2I-S2] measured max ledger record = ${largest} B, + separator = ${largest + 1} B, R_MAX = ${AGENT_MEMORY_INTENT_LEDGER_RECORD_MAX_BYTES} B`);
    expect(largest + 1).toBeLessThanOrEqual(AGENT_MEMORY_INTENT_LEDGER_RECORD_MAX_BYTES);
    expect(AGENT_MEMORY_INTENT_LEDGER_ENVELOPE_BYTES).toBe(serializeAgentMemoryIntentLedger([]).length);
    expect(AGENT_MEMORY_INTENT_LEDGER_CAPACITY).toBe(511);

    const full = Array.from({ length: AGENT_MEMORY_INTENT_LEDGER_CAPACITY }, (_, index) => ({
      ...candidates[0]!,
      intentId: `ffffffff-ffff-4fff-bfff-${index.toString(16).padStart(12, '0')}`,
    }));
    const body = serializeAgentMemoryIntentLedger(full);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(AGENT_MEMORY_MAX_LOCAL_LOG_BYTES);
    expect(parseAgentMemoryIntentLedger(body)).toHaveLength(AGENT_MEMORY_INTENT_LEDGER_CAPACITY);
  });

  it('L3: readback ok, ackedAt barrier fails -> no resolve -> redelivery idempotent -> resolve, zero second CAS', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    const process = w.processor();
    w.backend.ledgerSteps = ['ok', 'ok', 'fails-before-rename'];
    expect(await failureReason(process(notice(intent)))).toBe('local_io_failed');
    const result = await process(notice(intent));
    expect(result.kind === 'acknowledged' && result.readback.disposition).toBe('idempotent');
    expect(w.backend.casCalls).toBe(1);
  });

  it.each([
    ['after applying', { ledgerSteps: ['visible-then-fsync-fails'] as LedgerStep[] }, 'uncertain', 0],
    ['after the CAS', { ledgerSteps: ['ok', 'fails-before-rename'] as LedgerStep[] }, 'uncertain', 1],
    ['after the terminal barrier', { failCompletesBeforeRecord: 1 }, 'applied', 1],
    ['after complete (response lost)', { loseCompleteResponses: 1 }, 'applied', 1],
    ['after readback (ackedAt write failed)', { ledgerSteps: ['ok', 'ok', 'fails-before-rename'] as LedgerStep[] }, 'applied', 1],
  ] as const)('L4: restart %s -> %s, zero second CAS', async (_point, fault, outcome, cas) => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    if ('ledgerSteps' in fault) w.backend.ledgerSteps = [...fault.ledgerSteps];
    if ('failCompletesBeforeRecord' in fault) w.host.failCompletesBeforeRecord = fault.failCompletesBeforeRecord;
    if ('loseCompleteResponses' in fault) w.host.loseCompleteResponses = fault.loseCompleteResponses;
    await failureReason(w.processor()(notice(intent)));
    const result = await w.processor()(notice(intent)); // restart: a fresh processor on the same disk
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion.outcome).toBe(outcome);
    expect(w.backend.casCalls).toBe(cas);
  });

  it('L4: restart after the ackedAt barrier and before the cursor persisted -> idempotent, zero second CAS', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    await w.processor()(notice(intent));
    const result = await w.processor()(notice(intent));
    expect(result.kind === 'acknowledged' && result.readback.disposition).toBe('idempotent');
    expect(w.backend.casCalls).toBe(1);
  });

  it('L5: window 3 busy -> home_busy, no ackedAt, no resolve; later redelivery resolves idempotently', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    let held: Awaited<ReturnType<AgentHomeManager['acquire']>> | undefined;
    w.host.onComplete = async () => { held = await w.homes.acquire(AGENT); };
    const process = w.processor();
    expect(await failureReason(process(notice(intent)))).toBe('home_busy');
    const record = await w.record(intent.intentId);
    // Busy says only "no new write in this window": the target WAS written.
    expect(record?.state).toBe('applied');
    expect(record?.ackedAt).toBeNull();
    expect(await w.readMemory('notes/host-a.md')).toBe('x');
    w.host.onComplete = undefined;
    await held?.lease.release();
    const result = await process(notice(intent));
    expect(result.kind === 'acknowledged' && result.readback.disposition).toBe('idempotent');
    expect(w.backend.casCalls).toBe(1);
  });

  it.each([
    ['not JSON', '{"version":1,"records":['],
    ['unknown version', '{"version":2,"records":[]}'],
    ['extra top-level key', '{"version":1,"records":[],"x":1}'],
    ['applied delete that still exists', null],
    ['duplicate intentId', 'dup'],
    ['acknowledged applying', 'acked-applying'],
  ] as const)('L6: a corrupt ledger (%s) is ledger_invalid with no fetch and no reset', async (_label, body) => {
    const w = await world();
    let content: string;
    if (body === null) {
      content = JSON.stringify({ version: 1, records: [{ ...seed(1, { operation: 'delete', targetRevision: null, state: 'applied', detail: { exists: true, revision: EMPTY } }) }] });
    } else if (body === 'dup') {
      content = JSON.stringify({ version: 1, records: [seed(1), seed(1)] });
    } else if (body === 'acked-applying') {
      content = JSON.stringify({ version: 1, records: [seed(1, { state: 'applying', detail: null, ackedAt: '2026-09-28T01:00:00.000Z' })] });
    } else {
      content = body;
    }
    await fs.mkdir(path.dirname(w.ledgerFile), { recursive: true });
    await fs.writeFile(w.ledgerFile, content, 'utf8');
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    expect(await failureReason(w.processor()(notice(intent)))).toBe('ledger_invalid');
    expect(w.host.fetches).toHaveLength(0);
    expect(readFileSync(w.ledgerFile, 'utf8')).toBe(content);
  });

  it('L7 (processor): a directory-fsync failure after a visible rename blocks complete AND resolve', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    w.backend.ledgerSteps = ['ok', 'visible-then-fsync-fails'];
    expect(await failureReason(w.processor()(notice(intent)))).toBe('local_io_failed');
    expect(w.host.completes).toHaveLength(0);
    // Recovery: terminal barrier ok -> complete -> the ackedAt rename is visible but its fsync fails.
    w.backend.ledgerSteps = ['ok', 'visible-then-fsync-fails'];
    expect(await failureReason(w.processor()(notice(intent)))).toBe('local_io_failed');
    expect(w.host.completes).toHaveLength(1);
    expect((await w.record(intent.intentId))?.ackedAt).not.toBeNull(); // visible only; not resolved
  });

  it('L8: reservation none never receives a release or content; release/withheld in reply to none is fetch_invalid with zero writes', async () => {
    const w = await world();
    await w.seedLedger(Array.from({ length: AGENT_MEMORY_INTENT_LEDGER_CAPACITY }, (_, index) => seed(index)));
    const before = readFileSync(w.ledgerFile, 'utf8');
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    w.host.fetchOverride = (request) => {
      expect(request.reservation).toBe('none');
      return { disposition: 'release', intent };
    };
    expect(await failureReason(w.processor()(notice(intent)))).toBe('fetch_invalid');
    w.host.fetchOverride = () => ({ disposition: 'withheld', intent: withoutContent(intent), code: 'intent_revoked' });
    expect(await failureReason(w.processor()(notice(intent)))).toBe('fetch_invalid');
    expect(readFileSync(w.ledgerFile, 'utf8')).toBe(before);
    expect(w.backend.casCalls).toBe(0);
    // And the default Host never changes state for `none`, even for a revoke-pending intent.
    w.host.fetchOverride = undefined;
    const pending = w.host.add(await makeIntent({ path: 'notes/host-b.md', operation: 'replace', base: EMPTY, content: 'y' }), { status: 'dispatched', revokeRequested: true });
    expect(await failureReason(w.processor()(notice(pending.intent)))).toBe('ledger_full');
    expect(pending.status).toBe('dispatched');
  });
});

// ===========================================================================
// §A release-time grant, device side A1–A5
// ===========================================================================

describe('WP2I-S2 §A release-time grant (device side)', () => {
  it.each(['A1 revoke after release', 'A2 expiry after release', 'A4 profile/placement change after release'])('%s: the released grant is applied; the device performs no further authorization check', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    const entry = w.host.add(intent);
    const baseFetch = w.host.fetch.bind(w.host);
    w.host.fetch = async (request) => {
      const answer = await baseFetch(request);
      entry.revokeRequested = true; // any post-release Host change
      return answer;
    };
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion.outcome).toBe('applied');
    expect(result.completion.agentRef).toEqual(intent.agentRef);
    expect(w.host.fetches).toHaveLength(1);
  });

  it('A3: window 2 busy discards the release; the next attempt RE-FETCHES and a withheld revoke is rejected with zero writes', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    const entry = w.host.add(intent);
    let held: Awaited<ReturnType<AgentHomeManager['acquire']>> | undefined;
    w.host.onFetch = async () => { held = await w.homes.acquire(AGENT); };
    const process = w.processor();
    expect(await failureReason(process(notice(intent)))).toBe('home_busy');
    expect(existsSync(w.ledgerFile)).toBe(false);
    expect(entry.status).toBe('dispatched');
    w.host.onFetch = undefined;
    await held?.lease.release();
    entry.revokeRequested = true;
    const result = await process(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(w.host.fetches.map((request) => request.reservation)).toEqual(['held', 'held']);
    expect(result.completion).toMatchObject({ outcome: 'rejected', code: 'intent_revoked' });
    expect(w.backend.casCalls).toBe(0);
    expect(await w.readMemory('notes/host-a.md')).toBeUndefined();
  });

  it('A5: late completion after days offline completes the durable device fact without a second CAS', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    const process = w.processor();
    w.host.failCompletesBeforeRecord = 2;
    expect(await failureReason(process(notice(intent)))).toBe('complete_failed');
    expect(await failureReason(process(notice(intent)))).toBe('complete_failed');
    const result = await process(notice(intent));
    expect(result.kind === 'acknowledged' && result.readback.disposition).toBe('recorded');
    expect(w.backend.casCalls).toBe(1);
  });
});

// ===========================================================================
// Backend proof, stale notices, and the S1 handoff constraints on typing
// ===========================================================================

describe('WP2I-S2 backend proof and fail-closed entry', () => {
  it('a backend that has not proven "conflict => no rename" reports a CAS conflict as uncertain', async () => {
    const w = await world({ conflictProvesNoRename: false, strictLedgerBarrier: true });
    await w.writeMemory('notes/host-a.md', 'current');
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: sha('stale'), content: 'x' });
    w.host.add(intent);
    const result = await w.processor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion).toEqual({ ...completionIdentity(intent), outcome: 'uncertain', observed: { exists: true, revision: sha('current') } });
  });

  it('a backend without a proven strict ledger barrier fails filesystem_unavailable before any fetch', async () => {
    const w = await world({ conflictProvesNoRename: true, strictLedgerBarrier: false });
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    w.host.add(intent);
    expect(await failureReason(w.processor()(notice(intent)))).toBe('filesystem_unavailable');
    expect(w.host.fetches).toHaveLength(0);
    expect(existsSync(w.ledgerFile)).toBe(false);
  });

  it('no transport -> transport_unconfigured; no backend -> filesystem_unavailable; both before any fetch', async () => {
    const w = await world();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'x' });
    expect(await failureReason(w.processor({ transport: null })(notice(intent)))).toBe('transport_unconfigured');
    const unproven = createAgentMemoryIntentProcessor({ tenantId: TENANT, deviceId: DEVICE, transport: w.host, homes: w.homes, backend: undefined });
    expect(await failureReason(unproven(notice(intent)))).toBe('filesystem_unavailable');
    expect(w.host.fetches).toHaveLength(0);
  });

  it('declares the helper backend unproven on both counts and the native backend proven', () => {
    const helper = helperAgentMemoryIntentBackend('/opt/byok-agent-memory-fs');
    expect(helper.strictLedgerBarrier).toBe(false);
    expect(helper.conflictProvesNoRename).toBe(false);
    expect(NATIVE_AGENT_MEMORY_INTENT_BACKEND).toEqual({ conflictProvesNoRename: true, strictLedgerBarrier: true });
  });

  it('types deterministic failures apart from I/O failures without reading messages', async () => {
    expect(() => validateAgentMemoryPath('notes/../x.md')).toThrow(AgentMemoryValidationError);
    const hostStorageRoot = await tempRoot('bk-s2-typed-');
    const home = agentMemoryHomeBinding({ canonicalHome: path.join(hostStorageRoot, 'missing-home'), homeIdentity: { dev: 1n, ino: 1n } });
    await expect(compareAndSwapAgentMemoryHomeFile(home, { operation: 'delete', path: 'MEMORY.md', expectedRevision: EMPTY })).rejects.toBeInstanceOf(AgentMemoryValidationError);
    await expect(compareAndSwapAgentMemoryHomeFile(home, { operation: 'replace', path: 'notes/a.md', expectedRevision: 'nope', content: 'x' })).rejects.toBeInstanceOf(AgentMemoryValidationError);
    expect(new AgentMemoryIoError('x')).toBeInstanceOf(Error);
    expect(new AgentMemoryIoError('x')).not.toBeInstanceOf(AgentMemoryValidationError);
    expect(new AgentMemoryValidationError('x')).not.toBeInstanceOf(AgentMemoryIoError);
  });

  it('the task path still requires the full task context (no optional taskId)', () => {
    const source = readFileSync(new URL('../daemon/agent-memory.ts', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('export interface AgentMemoryTaskContext {'), source.indexOf('}', source.indexOf('export interface AgentMemoryTaskContext {')));
    expect(block).toContain('readonly taskId: string;');
    expect(block).not.toMatch(/taskId\?/u);
  });

  it('exposes no control-socket method for intents; the mailbox notice is the only entry', () => {
    for (const file of ['../daemon/create-daemon.ts', '../daemon/control-protocol.ts', '../daemon/control-server.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/['"][a-z_]*intent[a-z_]*\.[a-z_]+['"]\s*:/u);
      expect(source, file).not.toMatch(/['"][a-z_]+\.[a-z_]*intent[a-z_]*['"]\s*:/u);
    }
  });
});

// ===========================================================================
// Native Linux backend: conflict => no rename, strict directory fsync (L7)
// ===========================================================================

const itNative = isAgentMemorySecureFilesystemAvailable(false) ? it : it.skip;

describe('WP2I-S2 native descriptor backend (Linux)', () => {
  async function nativeWorld() {
    const w = await world();
    const processor = () => createAgentMemoryIntentProcessor({ tenantId: TENANT, deviceId: DEVICE, transport: w.host, homes: w.homes, backend: NATIVE_AGENT_MEMORY_INTENT_BACKEND });
    return { ...w, nativeProcessor: processor };
  }

  itNative('applies replace and delete through the pinned native primitives', async () => {
    const w = await nativeWorld();
    const create = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'alpha' });
    w.host.add(create);
    const created = await w.nativeProcessor()(notice(create));
    expect(created.kind === 'acknowledged' && created.completion.outcome).toBe('applied');
    expect(await w.readMemory('notes/host-a.md')).toBe('alpha');
    const remove = await makeIntent({ path: 'notes/host-a.md', operation: 'delete', base: sha('alpha') });
    w.host.add(remove);
    const removed = await w.nativeProcessor()(notice(remove));
    if (removed.kind !== 'acknowledged') throw new Error('unreachable');
    expect(removed.completion).toMatchObject({ outcome: 'applied', result: { exists: false, revision: EMPTY } });
    expect(await w.readMemory('notes/host-a.md')).toBeUndefined();
    expect((await w.ledger())?.every((record) => record.ackedAt !== null)).toBe(true);
  });

  itNative('stop point ②: a native conflict renamed nothing (target bytes, inode and directory entries unchanged) and is reported as conflict', async () => {
    const w = await nativeWorld();
    await w.homes.prepare(AGENT).then((binding) => binding.lease.release());
    await w.writeMemory('notes/host-a.md', 'current');
    const before = await fs.stat(w.memoryFile('notes/host-a.md'), { bigint: true });
    const entriesBefore = (await fs.readdir(path.join(w.canonicalHome, 'notes'))).sort();
    for (const intent of [
      await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: sha('stale'), content: 'next' }),
      await makeIntent({ path: 'notes/host-a.md', operation: 'delete', base: sha('stale') }),
    ]) {
      w.host.add(intent);
      const result = await w.nativeProcessor()(notice(intent));
      if (result.kind !== 'acknowledged') throw new Error('unreachable');
      expect(result.completion).toMatchObject({ outcome: 'conflict', observed: { exists: true, revision: sha('current') } });
    }
    const after = await fs.stat(w.memoryFile('notes/host-a.md'), { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(await w.readMemory('notes/host-a.md')).toBe('current');
    expect((await fs.readdir(path.join(w.canonicalHome, 'notes'))).sort()).toEqual(entriesBefore);
  });

  function residue(intent: AgentMemoryIntentV1): AgentMemoryIntentLedgerRecord {
    return {
      intentId: intent.intentId,
      profileRevision: AGENT.profileRevision,
      path: intent.path,
      operation: intent.operation,
      operationDigest: intent.operationDigest,
      baseRevision: intent.baseRevision,
      targetRevision: intent.targetRevision,
      approvalRef: intent.approvalRef,
      state: 'applying',
      detail: null,
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
      ackedAt: null,
    };
  }

  /** A crash left `applying`; the target now holds `bytes` (written by anyone). */
  async function residueWorld(bytes: Buffer | undefined) {
    const w = await nativeWorld();
    await w.homes.prepare(AGENT).then((binding) => binding.lease.release());
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'B' });
    w.host.add(intent, { status: 'dispatched' });
    await w.seedLedger([residue(intent)]);
    if (bytes !== undefined) await fs.writeFile(w.memoryFile('notes/host-a.md'), bytes);
    return { w, intent };
  }

  const byteDigest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

  itNative.each([
    ['non-UTF-8', Buffer.from([0x42, 0xff, 0xfe, 0x00, 0xc3])],
    ['oversized (256 KiB + 1)', Buffer.alloc(262_145, 0x61)],
    ['oversized and non-UTF-8 (1 MiB + 7)', Buffer.concat([Buffer.alloc(1_048_576, 0x62), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])])],
  ])('a residue applying whose target is %s resolves to uncertain{exists, byte digest} with zero added CAS', async (_label, bytes) => {
    const { w, intent } = await residueWorld(bytes);
    const result = await w.nativeProcessor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion).toEqual({ ...completionIdentity(intent), outcome: 'uncertain', observed: { exists: true, revision: byteDigest(bytes) } });
    expect(result.readback.disposition).toBe('recorded');
    // No fetch, no CAS: the bytes are exactly what the other writer left.
    expect(w.host.fetches).toHaveLength(0);
    expect((await fs.readFile(w.memoryFile('notes/host-a.md'))).equals(bytes)).toBe(true);
    const record = await w.record(intent.intentId);
    expect(record?.state).toBe('uncertain');
    expect(record?.ackedAt).not.toBeNull();
  });

  itNative('a residue applying whose target or its parent directory is missing resolves to uncertain{exists:false, sha256("")}', async () => {
    const { w, intent } = await residueWorld(undefined);
    await fs.rm(path.join(w.canonicalHome, 'notes'), { recursive: true });
    const result = await w.nativeProcessor()(notice(intent));
    if (result.kind !== 'acknowledged') throw new Error('unreachable');
    expect(result.completion).toMatchObject({ outcome: 'uncertain', observed: { exists: false, revision: EMPTY } });
  });

  itNative.each([
    ['a symlink target', async (w: Awaited<ReturnType<typeof nativeWorld>>) => {
      await fs.writeFile(path.join(w.canonicalHome, 'outside.md'), 'x');
      await fs.symlink(path.join(w.canonicalHome, 'outside.md'), w.memoryFile('notes/host-a.md'));
    }],
    ['a directory target (non-regular)', async (w: Awaited<ReturnType<typeof nativeWorld>>) => {
      await fs.mkdir(w.memoryFile('notes/host-a.md'));
    }],
    ['a FIFO target (non-regular)', async (w: Awaited<ReturnType<typeof nativeWorld>>) => {
      const { execFileSync } = await import('node:child_process');
      execFileSync('mkfifo', [w.memoryFile('notes/host-a.md')]);
    }],
    ['a symlinked parent directory (containment)', async (w: Awaited<ReturnType<typeof nativeWorld>>) => {
      const elsewhere = await tempRoot('bk-s2-elsewhere-');
      await fs.rm(path.join(w.canonicalHome, 'notes'), { recursive: true });
      await fs.symlink(elsewhere, path.join(w.canonicalHome, 'notes'));
    }],
  ] as const)('a structurally unobservable target (%s) stays local_io_failed: no completion, no resolve, applying kept', async (_label, arrange) => {
    const { w, intent } = await residueWorld(undefined);
    await arrange(w);
    const before = readFileSync(w.ledgerFile, 'utf8');
    expect(await failureReason(w.nativeProcessor()(notice(intent)))).toBe('local_io_failed');
    expect(w.host.completes).toHaveLength(0);
    expect(w.host.fetches).toHaveLength(0);
    expect(readFileSync(w.ledgerFile, 'utf8')).toBe(before);
    expect((await w.record(intent.intentId))?.state).toBe('applying');
  });

  async function withDirectoryFsyncFailure<T>(code: string, armed: () => boolean, run: () => Promise<T>): Promise<T> {
    const probe = await fs.open(os.tmpdir(), 'r');
    const prototype = Object.getPrototypeOf(probe) as { sync: (this: Awaited<ReturnType<typeof fs.open>>) => Promise<void> };
    await probe.close();
    const original = prototype.sync;
    prototype.sync = async function sync(this: Awaited<ReturnType<typeof fs.open>>) {
      if (armed() && (await this.stat()).isDirectory()) throw Object.assign(new Error(`${code}: injected directory fsync refusal`), { code });
      return original.call(this);
    };
    try {
      return await run();
    } finally {
      prototype.sync = original;
    }
  }

  itNative.each(['EINVAL', 'EPERM', 'EIO'])('stop point ⑤ / L7: the strict ledger write fails on a %s directory fsync after its rename; the tolerant audit write does not', async (code) => {
    const hostStorageRoot = await tempRoot('bk-s2-strict-');
    const homes = new AgentHomeManager({ hostStorageRoot });
    const binding = await homes.acquire(AGENT);
    try {
      const home = agentMemoryHomeBinding({ canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity });
      const ledger = path.join(binding.lease.canonicalHome, '.byok', AGENT_MEMORY_INTENT_LEDGER_FILENAME);
      await withDirectoryFsyncFailure(code, () => true, async () => {
        await expect(replaceAgentMemoryHomeInternalFileStrict(home, AGENT_MEMORY_INTENT_LEDGER_FILENAME, EMPTY, '{"version":1,"records":[]}')).rejects.toBeInstanceOf(AgentMemoryIoError);
        // The rename WAS visible: visibility is not durability.
        expect(readFileSync(ledger, 'utf8')).toBe('{"version":1,"records":[]}');
        if (code !== 'EIO') await expect(appendAgentMemoryHomeAudit(home, { kind: 'probe' })).resolves.toBeUndefined();
      });
    } finally {
      await binding.lease.release();
    }
  });

  itNative('L7: an EINVAL directory fsync on the terminal write blocks complete and resolve; recovery re-barriers', async () => {
    const w = await nativeWorld();
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'alpha' });
    w.host.add(intent);
    // Armed once the CAS installed the bytes: the CAS's own tolerant directory
    // fsync swallows EINVAL, the strict terminal ledger write must not.
    const armed = () => existsSync(w.memoryFile('notes/host-a.md')) && readFileSync(w.memoryFile('notes/host-a.md'), 'utf8') === 'alpha';
    await withDirectoryFsyncFailure('EINVAL', armed, async () => {
      expect(await failureReason(w.nativeProcessor()(notice(intent)))).toBe('local_io_failed');
    });
    expect(w.host.completes).toHaveLength(0);
    expect((await w.record(intent.intentId))?.state).toBe('applied'); // visible, not a barrier
    const result = await w.nativeProcessor()(notice(intent));
    expect(result.kind === 'acknowledged' && result.completion.outcome).toBe('applied');
    expect(w.host.completes).toHaveLength(1);
  });
});

// ===========================================================================
// macOS helper backend (only with a built helper binary)
// ===========================================================================

const helperBin = process.env.BYOK_TEST_AGENT_MEMORY_FS_BIN;
const itHelper = helperBin !== undefined && isAgentMemoryFilesystemHelperSupported() ? it : it.skip;

describe('WP2I-S2 macOS helper backend (evidence only; not advertised)', () => {
  itHelper('a helper revision conflict leaves the target untouched, yet the processor still maps it to uncertain', async () => {
    const w = await world();
    await w.homes.prepare(AGENT).then((binding) => binding.lease.release());
    await w.writeMemory('notes/host-a.md', 'current');
    const before = await fs.stat(w.memoryFile('notes/host-a.md'), { bigint: true });
    const binding = await w.homes.acquire(AGENT);
    const filesystem = await openAgentMemoryFilesystemHelper({ helperBin: helperBin!, canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity });
    try {
      const home = agentMemoryHomeBinding({ canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity, filesystem });
      await expect(compareAndSwapAgentMemoryHomeFile(home, { operation: 'replace', path: 'notes/host-a.md', expectedRevision: sha('stale'), content: 'next' })).rejects.toBeInstanceOf(AgentMemoryRevisionConflictError);
    } finally {
      await filesystem.close();
      await binding.lease.release();
    }
    const after = await fs.stat(w.memoryFile('notes/host-a.md'), { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(await w.readMemory('notes/host-a.md')).toBe('current');
    expect((await fs.readdir(path.join(w.canonicalHome, 'notes'))).filter((name) => name.startsWith('.byok-'))).toEqual([]);

    // Only for this evidence run: grant the helper the ledger-barrier proof it
    // lacks in production, to show its conflict still maps to `uncertain`.
    const helper = { ...helperAgentMemoryIntentBackend(helperBin!), strictLedgerBarrier: true };
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: sha('stale'), content: 'x' });
    w.host.add(intent);
    const result = await w.processor({ backend: helper })(notice(intent));
    expect(result.kind === 'acknowledged' && result.completion.outcome).toBe('uncertain');
  });
});

// ===========================================================================
// Daemon composition: stale notices fail closed before any fetch
// ===========================================================================

describe('WP2I-S2 daemon routing', () => {
  const servers: TestServer[] = [];
  const daemons: Daemon[] = [];
  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop().catch(() => undefined)));
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function startDaemon(transport: AgentMemoryIntentTransport | undefined) {
    const server = await TestServer.start();
    servers.push(server);
    const storeDir = await tempRoot('bk-s2-store-');
    const workspaceRoot = await tempRoot('bk-s2-ws-');
    const hostStorageRoot = await tempRoot('bk-s2-agents-');
    const daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
        ...(transport === undefined ? {} : { agentMemoryIntents: transport }),
      },
      [new StubRuntimeAdapter()],
      { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } },
    );
    daemons.push(daemon);
    server.setPairingTenantId('pairing-code', TENANT);
    const record = await daemon.pair('pairing-code');
    await daemon.start();
    const hello = await server.waitFor((envelope) => envelope.type === 'conn.hello', 5_000);
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    const cursor = () => new CursorStore(storeDir).load(server.url, record.deviceId);
    return { server, hello, cursor, record };
  }

  async function staleNotice(transport: AgentMemoryIntentTransport | undefined, expected: AgentMemoryIntentNoticeFailureReason) {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, hello, cursor } = await startDaemon(transport);
    expect(hello.payload.capabilities).not.toContain('agent-memory-intent.v1');
    const envelope = createEnvelope('agent.memory.intent.available', { intentId: randomUUID(), agentRef: { ...AGENT } }, { seq: server.nextSeq() });
    server.pushLongPollEvent(envelope);
    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some((args) => String(args[0]).includes(`agent.memory.intent.available (seq=${envelope.seq})`))).toBe(true);
    }, { timeout: 5_000 });
    const failure = errorSpy.mock.calls.find((args) => String(args[0]).includes('agent.memory.intent.available'));
    expect(failure?.[1]).toBeInstanceOf(AgentMemoryIntentNoticeError);
    expect((failure?.[1] as AgentMemoryIntentNoticeError).reason).toBe(expected);
    expect(await cursor()).toBe(0);
  }

  it('without a transport: transport_unconfigured, not acknowledged', async () => {
    await staleNotice(undefined, 'transport_unconfigured');
  });

  const itUnproven = isAgentMemorySecureFilesystemAvailable(false) ? it.skip : it;
  itUnproven('with a transport on a platform with no proven backend (Windows, macOS): filesystem_unavailable before any fetch', async () => {
    const events: string[] = [];
    const hostStorageRoot = await tempRoot('bk-s2-unused-');
    const host = new FakeHost(new AgentHomeManager({ hostStorageRoot }), events);
    await staleNotice(host, 'filesystem_unavailable');
    expect(host.fetches).toHaveLength(0);
  });

  itNative('Linux native: advertised, and a notice is applied, completed and acknowledged end to end', async () => {
    const events: string[] = [];
    const probeRoot = await tempRoot('bk-s2-probe-');
    const host = new FakeHost(new AgentHomeManager({ hostStorageRoot: probeRoot }), events);
    const { server, hello, cursor, record } = await startDaemon(host);
    expect(hello.payload.capabilities).toContain('agent-memory-intent.v1');
    host.identity = { tenantId: TENANT, deviceId: record.deviceId };
    const intent = await makeIntent({ path: 'notes/host-a.md', operation: 'replace', base: EMPTY, content: 'alpha', digestDeviceId: record.deviceId });
    host.add(intent);
    const envelope = createEnvelope('agent.memory.intent.available', { intentId: intent.intentId, agentRef: { ...AGENT } }, { seq: server.nextSeq() });
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => expect(await cursor()).toBe(envelope.seq), { timeout: 5_000 });
    expect(host.completes.map((completion) => completion.outcome)).toEqual(['applied']);
  });
});
