import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  AgentContentAuditReceipt,
  AgentContentActorKind,
  AgentContentReadDecision,
  AgentContentReadReason,
  AgentContentReadSurface,
  AgentContentSessionIdentity,
} from './agent-content-read';

/**
 * A durable audit ledger for explicit Agent content reads.
 *
 * This store deliberately knows only the content-free receipt shape. It does
 * not accept a payload, pathname, MIME body, or a caller-supplied extension
 * point. The content-read policy engine is the only component that should
 * produce receipts; keeping the ledger narrow makes accidentally persisting a
 * preview or transcript body a type- and runtime-visible failure.
 */
export class AgentContentAuditStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentContentAuditStoreError';
  }
}

const AUDIT_VERSION = 1 as const;
const MAX_AUDIT_FILE_BYTES = 16 * 1024 * 1024;

const DECISIONS = new Set<AgentContentReadDecision>(['allow', 'deny']);
const SURFACES = new Set<AgentContentReadSurface>(['workspace', 'transcript', 'artifact']);
const ACTOR_KINDS = new Set<AgentContentActorKind>(['user', 'agent', 'system']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000\r\n]/u.test(value);
}

function isAgentRef(value: unknown): value is { agentId: string; profileRevision: string } {
  return (
    isRecord(value) &&
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.profileRevision)
  );
}

function isCanonicalRelativeTarget(value: string): boolean {
  if (value === '[invalid-target]') return true;
  if (path.isAbsolute(value) || value.includes('\\')) return false;
  const segments = value.split('/');
  return value.length > 0 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validateIdentity(value: unknown, label: string): AgentContentSessionIdentity {
  if (
    !isRecord(value) ||
    !isAgentRef(value.agentRef) ||
    !isNonEmptyString(value.sessionRef) ||
    !isNonEmptyString(value.runtimeId) ||
    !isNonEmptyString(value.cwd) ||
    !path.isAbsolute(value.cwd)
  ) {
    throw new AgentContentAuditStoreError(`${label} has an invalid exact Agent/session identity`);
  }
  return Object.freeze({
    agentRef: Object.freeze({
      agentId: value.agentRef.agentId,
      profileRevision: value.agentRef.profileRevision,
    }),
    sessionRef: value.sessionRef,
    runtimeId: value.runtimeId,
    cwd: path.resolve(value.cwd),
  });
}

function validateReceipt(value: unknown): AgentContentAuditReceipt {
  if (!isRecord(value)) throw new AgentContentAuditStoreError('content audit entry is not an object');

  const expectedKeys = new Set([
    'version',
    'requestId',
    'actor',
    'tenantId',
    'deviceId',
    'agentRef',
    'surface',
    'session',
    'relativeTarget',
    'policyRevision',
    'byteCount',
    'contentHash',
    'decision',
    'reason',
    'recordedAt',
  ]);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      throw new AgentContentAuditStoreError(`content audit entry contains forbidden field ${key}`);
    }
  }

  if (
    value.version !== AUDIT_VERSION ||
    !isNonEmptyString(value.requestId) ||
    !isRecord(value.actor) ||
    typeof value.actor.kind !== 'string' ||
    !ACTOR_KINDS.has(value.actor.kind as AgentContentActorKind) ||
    !isNonEmptyString(value.actor.id) ||
    !isNonEmptyString(value.tenantId) ||
    !isNonEmptyString(value.deviceId) ||
    !isAgentRef(value.agentRef) ||
    typeof value.surface !== 'string' ||
    !SURFACES.has(value.surface as AgentContentReadSurface) ||
    !isNonEmptyString(value.relativeTarget) ||
    !isCanonicalRelativeTarget(value.relativeTarget) ||
    !isNonEmptyString(value.policyRevision) ||
    typeof value.byteCount !== 'number' ||
    !Number.isInteger(value.byteCount) ||
    value.byteCount < 0 ||
    !DECISIONS.has(value.decision as AgentContentReadDecision) ||
    !isNonEmptyString(value.recordedAt) ||
    !Number.isFinite(Date.parse(value.recordedAt))
  ) {
    throw new AgentContentAuditStoreError('content audit entry has an invalid shape');
  }

  if (value.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(String(value.contentHash))) {
    throw new AgentContentAuditStoreError('content audit entry contentHash is not sha256');
  }
  if (value.decision === 'allow' && typeof value.contentHash !== 'string') {
    throw new AgentContentAuditStoreError('allowed content audit entry must contain a contentHash');
  }
  if (value.decision === 'deny' && value.byteCount !== 0) {
    throw new AgentContentAuditStoreError('denied content audit entry must contain zero bytes');
  }
  if (value.reason !== undefined && !isNonEmptyString(value.reason)) {
    throw new AgentContentAuditStoreError('content audit entry reason is invalid');
  }

  const session = value.session === undefined ? undefined : validateIdentity(value.session, 'content audit session');
  return Object.freeze({
    version: AUDIT_VERSION,
    requestId: value.requestId,
    actor: Object.freeze({ kind: value.actor.kind as AgentContentActorKind, id: value.actor.id }),
    tenantId: value.tenantId,
    deviceId: value.deviceId,
    agentRef: Object.freeze({
      agentId: value.agentRef.agentId,
      profileRevision: value.agentRef.profileRevision,
    }),
    surface: value.surface as AgentContentReadSurface,
    ...(session === undefined ? {} : { session }),
    relativeTarget: value.relativeTarget,
    policyRevision: value.policyRevision,
    byteCount: value.byteCount,
    ...(value.contentHash === undefined ? {} : { contentHash: value.contentHash as string }),
    decision: value.decision as AgentContentReadDecision,
    ...(value.reason === undefined ? {} : { reason: value.reason as AgentContentReadReason }),
    recordedAt: value.recordedAt,
  });
}

/** `recordedAt` is evidence timing, not request semantics. */
function sameSemanticReceipt(left: AgentContentAuditReceipt, right: AgentContentAuditReceipt): boolean {
  return (
    left.version === right.version &&
    left.requestId === right.requestId &&
    left.actor.kind === right.actor.kind &&
    left.actor.id === right.actor.id &&
    left.tenantId === right.tenantId &&
    left.deviceId === right.deviceId &&
    left.agentRef.agentId === right.agentRef.agentId &&
    left.agentRef.profileRevision === right.agentRef.profileRevision &&
    left.surface === right.surface &&
    left.session?.agentRef.agentId === right.session?.agentRef.agentId &&
    left.session?.agentRef.profileRevision === right.session?.agentRef.profileRevision &&
    left.session?.sessionRef === right.session?.sessionRef &&
    left.session?.runtimeId === right.session?.runtimeId &&
    left.session?.cwd === right.session?.cwd &&
    left.relativeTarget === right.relativeTarget &&
    left.policyRevision === right.policyRevision &&
    left.byteCount === right.byteCount &&
    left.contentHash === right.contentHash &&
    left.decision === right.decision &&
    left.reason === right.reason
  );
}

function assertUniqueRequestIds(entries: readonly AgentContentAuditReceipt[]): void {
  const seen = new Map<string, AgentContentAuditReceipt>();
  for (const entry of entries) {
    const prior = seen.get(entry.requestId);
    if (prior === undefined) {
      seen.set(entry.requestId, entry);
      continue;
    }
    if (sameSemanticReceipt(prior, entry)) {
      throw new AgentContentAuditStoreError(`content audit ledger duplicates requestId ${entry.requestId}`);
    }
    throw new AgentContentAuditStoreError(`content audit ledger reuses requestId ${entry.requestId} with conflicting semantics`);
  }
}

function assertAbsoluteFilePath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0 || !path.isAbsolute(filePath)) {
    throw new AgentContentAuditStoreError('content audit path must be absolute');
  }
  if (/[\u0000\r\n]/u.test(filePath)) {
    throw new AgentContentAuditStoreError('content audit path must not contain NUL or line breaks');
  }
  return path.resolve(filePath);
}

async function ensureDirectoryNoSymlink(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  // The host's temp or application root may itself be a platform alias (for
  // example macOS /var -> /private/var). Rejecting every ancestor symlink
  // would make a valid canonical Agent home unusable. The ledger's own
  // directory is still checked as a real directory; the content-read target
  // path has the stricter component-by-component symlink policy.
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentContentAuditStoreError(`content audit directory is not a real directory: ${absolute}`);
  }
}

async function assertAuditFile(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AgentContentAuditStoreError('content audit ledger is not a real regular file');
    }
    if (stat.size > BigInt(MAX_AUDIT_FILE_BYTES)) {
      throw new AgentContentAuditStoreError('content audit ledger exceeds the bounded read limit');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Append-only, fsynced JSONL receipt store. A new instance can read the same
 * path after a daemon restart; no in-memory cursor is authoritative.
 */
export class AgentContentAuditStore {
  readonly filePath: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(filePath: string) {
    this.filePath = assertAbsoluteFilePath(filePath);
  }

  async append(receipt: AgentContentAuditReceipt): Promise<AgentContentAuditReceipt> {
    const validated = validateReceipt(receipt);
    return this.enqueue(async () => {
      await ensureDirectoryNoSymlink(path.dirname(this.filePath));
      await assertAuditFile(this.filePath);
      // Validate the existing ledger before appending. A corrupt or widened
      // ledger is integrity failure, never a reason to add more records.
      const entries = await this.readAllUnlocked();
      const prior = entries.find((entry) => entry.requestId === validated.requestId);
      if (prior !== undefined) {
        if (!sameSemanticReceipt(prior, validated)) {
          throw new AgentContentAuditStoreError(
            `content audit requestId ${validated.requestId} conflicts with its durable receipt`,
          );
        }
        return prior;
      }

      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(
          this.filePath,
          fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
      } catch (error) {
        await handle?.close().catch(() => {});
        throw new AgentContentAuditStoreError(
          `could not durably append content audit receipt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return validated;
    });
  }

  async readAll(): Promise<readonly AgentContentAuditReceipt[]> {
    return this.enqueue(() => this.readAllUnlocked());
  }

  /** Explicit name for restart/readback integrations. */
  async readback(): Promise<readonly AgentContentAuditReceipt[]> {
    return this.readAll();
  }

  private async readAllUnlocked(): Promise<readonly AgentContentAuditReceipt[]> {
    await assertAuditFile(this.filePath);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(this.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw new AgentContentAuditStoreError(
        `could not open content audit ledger: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_AUDIT_FILE_BYTES)) {
        throw new AgentContentAuditStoreError('content audit ledger changed to an invalid bounded file');
      }
      const size = Number(before.size);
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await handle.read(buffer, offset, size - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (offset !== size || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
        throw new AgentContentAuditStoreError('content audit ledger changed during readback');
      }
      const raw = buffer.toString('utf8');
      if (raw.length === 0) return Object.freeze([]);
      const entries = raw.split('\n').filter((line) => line.length > 0).map((line) => validateReceipt(JSON.parse(line) as unknown));
      assertUniqueRequestIds(entries);
      return Object.freeze(entries);
    } catch (error) {
      if (error instanceof AgentContentAuditStoreError) throw error;
      throw new AgentContentAuditStoreError(
        `content audit ledger is corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await handle.close();
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const key = this.filePath;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }
}
