import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import {
  AGENT_MEMORY_PROJECTION_CAPABILITY,
  AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES,
  AgentMemoryProjectionMutationSchema,
  type AgentMemoryProjectionMutation,
} from '@byok-sdk/protocol';
import { AGENT_HOME_INTERNAL_DIRECTORY, type AgentHomeLease, type AgentRef } from '../agent-home';
import type { AgentMemoryFilesystem, AgentMemoryFilesystemFileState } from './agent-memory-filesystem';

export const AGENT_MEMORY_AUDIT_FILENAME = 'agent-memory-audit-v1.jsonl';
export const AGENT_MEMORY_OUTBOX_FILENAME = 'agent-memory-redacted-outbox-v1.jsonl';
export const AGENT_MEMORY_MAX_FILE_BYTES = 256 * 1024;
export const AGENT_MEMORY_MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const AGENT_MEMORY_MAX_SNAPSHOT_FILES = 128;
export const AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES = 512;
const AGENT_MEMORY_MAX_LOCAL_LOG_BYTES = AGENT_MEMORY_MAX_SNAPSHOT_BYTES * 16;

const REVISION = /^sha256:[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SECRET_LIKE = /(?:^|[-_.])(secret|token|credential|password|passwd|api[-_]?key|private[-_]?key|cookie)(?:$|[-_.])/iu;
const encoder = new TextEncoder();

export class AgentMemoryError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentMemoryError'; }
}
export class AgentMemoryRevisionConflictError extends AgentMemoryError {
  constructor(readonly expectedRevision: string, readonly actualRevision: string) {
    super(`Agent memory revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    this.name = 'AgentMemoryRevisionConflictError';
  }
}

export interface AgentMemoryTaskContext {
  readonly taskId: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly agentRef: AgentRef;
  readonly sessionRef: string;
  readonly runtimeId: string;
  readonly canonicalHome: string;
  readonly leaseId: string;
  readonly homeIdentity: AgentHomeLease['homeIdentity'];
  /** Optional task-scoped external root handle; omission selects the native Linux backend. */
  readonly filesystem?: AgentMemoryFilesystem;
}
export interface AgentMemoryFile { readonly path: string; readonly revision: string; readonly byteCount: number; readonly content: string; }
export interface AgentMemorySnapshot { readonly files: readonly AgentMemoryFile[]; readonly totalBytes: number; }
/**
 * Embedder-owned redaction authority. Its output is opaque bytes: the local
 * relative paths, source revisions, and raw source content never enter the
 * outbox or projection port.
 */
export interface AgentMemoryRedactor {
  redact(input: Readonly<AgentMemorySnapshot>): Promise<Uint8Array> | Uint8Array;
}
/** Host-issued projection binding; no model-provided consent boolean exists. */
export interface AgentMemoryProjectionGrant {
  readonly grantRef: AgentMemoryProjectionMutation['grantRef'];
  readonly writerEpoch: AgentMemoryProjectionMutation['writerEpoch'];
  readonly policyRevision: AgentMemoryProjectionMutation['policyRevision'];
}
export interface AgentMemoryRedactedOutboxRecord {
  readonly version: 1;
  readonly mutation: AgentMemoryProjectionMutation;
  readonly createdAt: string;
}
/**
 * Optional bridge to a complete hosted client. It receives the canonical,
 * already-redacted protocol mutation only; this package intentionally owns no
 * consent, cloud transport, or raw-source upload fallback.
 */
export interface AgentMemoryProjectionPort {
  publish(input: Readonly<{ mutation: AgentMemoryProjectionMutation }>): Promise<{ readonly accepted: boolean }>;
}
/** Every member is mandatory before network projection is permitted. */
export interface AgentMemoryHostedProjection {
  readonly capability?: typeof AGENT_MEMORY_PROJECTION_CAPABILITY;
  readonly grant?: AgentMemoryProjectionGrant;
  readonly redactor?: AgentMemoryRedactor;
  readonly port?: AgentMemoryProjectionPort;
}

function digestBytes(content: Uint8Array): string { return `sha256:${createHash('sha256').update(content).digest('hex')}`; }
function digest(content: string): string { return digestBytes(encoder.encode(content)); }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !/[\u0000\r\n]/u.test(value); }
function revision(value: unknown): value is string { return typeof value === 'string' && REVISION.test(value); }
function taskContext(value: AgentMemoryTaskContext): AgentMemoryTaskContext {
  if (!value || !nonEmpty(value.taskId) || !nonEmpty(value.tenantId) || !nonEmpty(value.deviceId) || !nonEmpty(value.sessionRef) || !nonEmpty(value.runtimeId) || !nonEmpty(value.leaseId) || !value.agentRef || !nonEmpty(value.agentRef.agentId) || !nonEmpty(value.agentRef.profileRevision) || !path.isAbsolute(value.canonicalHome) || typeof value.homeIdentity?.dev !== 'bigint' || typeof value.homeIdentity.ino !== 'bigint') {
    throw new AgentMemoryError('Agent memory requires an exact active Agent task context');
  }
  return Object.freeze({ ...value, agentRef: Object.freeze({ ...value.agentRef }), homeIdentity: Object.freeze({ ...value.homeIdentity }), canonicalHome: path.resolve(value.canonicalHome) });
}

/** Model input can name one allowed file, never a root, directory, glob, or internal SDK state. */
export function validateAgentMemoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000\\]/u.test(value)) throw new AgentMemoryError('memory path is invalid');
  if (value === 'MEMORY.md') return value;
  if (path.posix.isAbsolute(value) || /[*?\[{]/u.test(value)) throw new AgentMemoryError('memory path must name exactly one file');
  const parts = value.split('/');
  if (parts.length < 2 || parts[0] !== 'notes' || !value.endsWith('.md') || parts.some((part) => part === '' || part === '.' || part === '..' || part === '.byok' || !SAFE_SEGMENT.test(part) || SECRET_LIKE.test(part))) {
    throw new AgentMemoryError('memory path must be MEMORY.md or notes/<safe-relative>.md');
  }
  return value;
}

/**
 * Node exposes no descriptor-relative filesystem API on macOS or Windows.
 * Linux `/proc/self/fd/<dirfd>/child` is an openat-like primitive: each next
 * component is resolved from a directory descriptor already opened with
 * O_NOFOLLOW, so an Agent cannot redirect a later operation by replacing an
 * ancestor after validation. Other platforms deliberately have no fallback.
 */
const SECURE_DIRECTORY_DESCRIPTOR_ROOT = '/proc/self/fd';

/**
 * The sole platform gate for the Agent-memory write authority. Linux retains
 * the native procfs descriptor backend. macOS requires the explicit external
 * helper that passed its local race proof. Windows remains unavailable rather
 * than selecting an unproved fallback.
 */
export function isAgentMemorySecureFilesystemAvailable(externalHelperConfigured = false): boolean {
  const nativeLinux = process.platform === 'linux'
    && typeof fsConstants.O_NOFOLLOW === 'number'
    && typeof fsConstants.O_DIRECTORY === 'number'
    && existsSync(SECURE_DIRECTORY_DESCRIPTOR_ROOT);
  // Windows remains fail-closed until its real reparse/junction proof exists.
  return nativeLinux || (externalHelperConfigured && process.platform === 'darwin');
}

function requireSecureDirectoryDescriptors(): string {
  if (!isAgentMemorySecureFilesystemAvailable(false) || process.platform !== 'linux') {
    throw new AgentMemoryError('Agent memory is unavailable because this Node platform lacks safe descriptor-relative filesystem operations');
  }
  return SECURE_DIRECTORY_DESCRIPTOR_ROOT;
}

function noFollowFlags(base: number): number {
  requireSecureDirectoryDescriptors();
  return base | fsConstants.O_NOFOLLOW;
}

function descriptorPath(handle: Awaited<ReturnType<typeof fs.open>>): string {
  return `${requireSecureDirectoryDescriptors()}/${handle.fd}`;
}

async function openPinnedDirectory(target: string, expectedIdentity?: AgentMemoryTaskContext['homeIdentity']): Promise<Awaited<ReturnType<typeof fs.open>>> {
  requireSecureDirectoryDescriptors();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(target, noFollowFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (expectedIdentity !== undefined && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino))) throw new AgentMemoryError('memory directory is not a real directory');
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof AgentMemoryError) throw error;
    throw new AgentMemoryError('memory directory is unavailable or unsafe');
  }
}

async function withPinnedDirectory<T>(home: string, parts: readonly string[], operation: (directory: Awaited<ReturnType<typeof fs.open>>) => Promise<T>, expectedHomeIdentity?: AgentMemoryTaskContext['homeIdentity']): Promise<T> {
  const handles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
  try {
    let directory = await openPinnedDirectory(home, expectedHomeIdentity);
    handles.push(directory);
    for (const part of parts) {
      directory = await openPinnedDirectory(`${descriptorPath(directory)}/${part}`);
      handles.push(directory);
    }
    return await operation(directory);
  } finally {
    await Promise.all(handles.reverse().map((handle) => handle.close().catch(() => {})));
  }
}

async function withMemoryParent<T>(context: AgentMemoryTaskContext, relativePath: string, operation: (directory: Awaited<ReturnType<typeof fs.open>>, fileName: string) => Promise<T>): Promise<T> {
  const parts = relativePath.split('/');
  const fileName = parts.pop();
  if (fileName === undefined || parts.some((part) => !SAFE_SEGMENT.test(part) && part !== '.byok')) throw new AgentMemoryError('memory path is invalid');
  return withPinnedDirectory(context.canonicalHome, parts, (directory) => operation(directory, fileName), context.homeIdentity);
}

type FileState = AgentMemoryFilesystemFileState;
async function readPinnedFile(directory: Awaited<ReturnType<typeof fs.open>>, fileName: string, maxBytes = AGENT_MEMORY_MAX_FILE_BYTES): Promise<FileState> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(`${descriptorPath(directory)}/${fileName}`, noFollowFlags(fsConstants.O_RDONLY));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ exists: false, content: '', revision: digest(''), byteCount: 0 });
    throw new AgentMemoryError('could not open memory file');
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new AgentMemoryError('memory file is not a bounded regular file');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (read.bytesRead === 0) break; offset += read.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (offset !== bytes.length || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ino !== before.ino) throw new AgentMemoryError('memory file changed during read');
    const content = bytes.toString('utf8');
    // A content revision is defined over bytes, while MCP is UTF-8 text. Do
    // not silently hash a replacement-character projection of arbitrary bytes.
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new AgentMemoryError('memory file is not valid UTF-8');
    return Object.freeze({ exists: true, content, revision: digestBytes(bytes), byteCount: bytes.length });
  } finally { await handle.close().catch(() => {}); }
}
async function readFile(context: AgentMemoryTaskContext, relativePath: string, maxBytes = AGENT_MEMORY_MAX_FILE_BYTES): Promise<FileState> {
  if (context.filesystem !== undefined) return context.filesystem.read(relativePath, maxBytes);
  return withMemoryParent(context, relativePath, (directory, fileName) => readPinnedFile(directory, fileName, maxBytes));
}
async function syncDirectory(directory: Awaited<ReturnType<typeof fs.open>>): Promise<void> {
  try { await directory.sync(); }
  catch (error) { if (!['EINVAL', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}
async function replaceNative(context: AgentMemoryTaskContext, relativePath: string, expected: string, content: string): Promise<FileState> {
  const byteCount = encoder.encode(content).byteLength;
  if (byteCount > AGENT_MEMORY_MAX_FILE_BYTES) throw new AgentMemoryError('memory content exceeds its bounded file size');
  return withMemoryParent(context, relativePath, async (directory, fileName) => {
    const before = await readPinnedFile(directory, fileName);
    if (before.revision !== expected) throw new AgentMemoryRevisionConflictError(expected, before.revision);
    const parent = descriptorPath(directory);
    const temporary = `${parent}/.byok-memory-${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const check = await readPinnedFile(directory, fileName);
      if (check.revision !== expected || check.exists !== before.exists) throw new AgentMemoryRevisionConflictError(expected, check.revision);
      handle = await fs.open(temporary, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
      await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      const finalCheck = await readPinnedFile(directory, fileName);
      if (finalCheck.revision !== expected || finalCheck.exists !== before.exists) throw new AgentMemoryRevisionConflictError(expected, finalCheck.revision);
      await fs.rename(temporary, `${parent}/${fileName}`); await syncDirectory(directory);
      return Object.freeze({ exists: true, content, revision: digest(content), byteCount });
    } catch (error) {
      await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {});
      if (error instanceof AgentMemoryError) throw error;
      throw new AgentMemoryError('could not atomically replace memory file');
    }
  });
}
async function replace(context: AgentMemoryTaskContext, relativePath: string, expected: string, content: string): Promise<FileState> {
  if (context.filesystem !== undefined) return context.filesystem.replace(relativePath, expected, content, AGENT_MEMORY_MAX_FILE_BYTES);
  return replaceNative(context, relativePath, expected, content);
}
async function removeNative(context: AgentMemoryTaskContext, relativePath: string, expected: string): Promise<void> {
  if (relativePath === 'MEMORY.md') throw new AgentMemoryError('MEMORY.md may not be deleted');
  await withMemoryParent(context, relativePath, async (directory, fileName) => {
    const before = await readPinnedFile(directory, fileName);
    if (!before.exists || before.revision !== expected) throw new AgentMemoryRevisionConflictError(expected, before.revision);
    const parent = descriptorPath(directory);
    const tombstone = `${parent}/.byok-memory-delete-${randomUUID()}.tmp`;
    try {
      const check = await readPinnedFile(directory, fileName);
      if (!check.exists || check.revision !== expected) throw new AgentMemoryRevisionConflictError(expected, check.revision);
      await fs.rename(`${parent}/${fileName}`, tombstone); await syncDirectory(directory); await fs.rm(tombstone); await syncDirectory(directory);
    } catch (error) {
      if (error instanceof AgentMemoryError) throw error;
      throw new AgentMemoryError('could not atomically delete memory file');
    }
  });
}
async function remove(context: AgentMemoryTaskContext, relativePath: string, expected: string): Promise<void> {
  if (relativePath === 'MEMORY.md') throw new AgentMemoryError('MEMORY.md may not be deleted');
  if (context.filesystem !== undefined) return context.filesystem.delete(relativePath, expected);
  return removeNative(context, relativePath, expected);
}

async function audit(context: AgentMemoryTaskContext, kind: 'recall' | 'save' | 'snapshot', values: Record<string, unknown>): Promise<void> {
  const entry = `${JSON.stringify({ version: 1, kind, taskId: context.taskId, tenantId: context.tenantId, deviceId: context.deviceId, agentRef: context.agentRef, sessionRef: context.sessionRef, runtimeId: context.runtimeId, ...values, recordedAt: new Date().toISOString() })}\n`;
  if (context.filesystem !== undefined) {
    await context.filesystem.append(`${AGENT_HOME_INTERNAL_DIRECTORY}/${AGENT_MEMORY_AUDIT_FILENAME}`, entry, AGENT_MEMORY_MAX_LOCAL_LOG_BYTES);
    return;
  }
  await withPinnedDirectory(context.canonicalHome, [AGENT_HOME_INTERNAL_DIRECTORY], async (directory) => {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(`${descriptorPath(directory)}/${AGENT_MEMORY_AUDIT_FILENAME}`, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT), 0o600);
      // Only metadata/hashes/lengths are written; content is intentionally not a field.
      await handle.writeFile(entry, 'utf8');
      await handle.sync();
    } finally { await handle?.close().catch(() => {}); }
  }, context.homeIdentity);
}

export class AgentMemoryService {
  private static readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly input: AgentMemoryTaskContext) {}
  async recall(input: { readonly path: unknown; readonly ifRevision?: unknown }): Promise<Readonly<{ path: string; revision: string; content: string }>> {
    const context = taskContext(this.input); const relativePath = validateAgentMemoryPath(input.path);
    if (input.ifRevision !== undefined && !revision(input.ifRevision)) throw new AgentMemoryError('ifRevision must be a sha256 content revision');
    const current = await readFile(context, relativePath);
    if (!current.exists) throw new AgentMemoryError('memory file does not exist');
    if (input.ifRevision !== undefined && current.revision !== input.ifRevision) throw new AgentMemoryRevisionConflictError(input.ifRevision, current.revision);
    await audit(context, 'recall', { path: relativePath, revision: current.revision, byteCount: current.byteCount });
    return Object.freeze({ path: relativePath, revision: current.revision, content: current.content });
  }
  async save(input: { readonly op: unknown; readonly path: unknown; readonly expectedRevision: unknown; readonly content?: unknown }): Promise<Readonly<{ path: string; revision?: string; deleted: boolean }>> {
    const context = taskContext(this.input); const relativePath = validateAgentMemoryPath(input.path);
    if ((input.op !== 'replace' && input.op !== 'delete') || !revision(input.expectedRevision)) throw new AgentMemoryError('memory save requires op and sha256 expectedRevision');
    if (input.op === 'replace' && typeof input.content !== 'string') throw new AgentMemoryError('replace requires string content');
    if (input.op === 'delete' && input.content !== undefined) throw new AgentMemoryError('delete does not accept content');
    const expectedRevision = input.expectedRevision;
    const content = input.content;
    return this.exclusive(context.canonicalHome, async () => {
      if (input.op === 'delete') { await remove(context, relativePath, expectedRevision); await audit(context, 'save', { path: relativePath, operation: 'delete' }); return Object.freeze({ path: relativePath, deleted: true }); }
      if (typeof content !== 'string') throw new AgentMemoryError('replace requires string content');
      const current = await replace(context, relativePath, expectedRevision, content);
      await audit(context, 'save', { path: relativePath, operation: 'replace', revision: current.revision, byteCount: current.byteCount });
      return Object.freeze({ path: relativePath, revision: current.revision, deleted: false });
    });
  }
  private async exclusive<T>(home: string, fn: () => Promise<T>): Promise<T> {
    const previous = AgentMemoryService.queues.get(home) ?? Promise.resolve(); let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; }); AgentMemoryService.queues.set(home, next); await previous;
    try { return await fn(); } finally { release(); if (AgentMemoryService.queues.get(home) === next) AgentMemoryService.queues.delete(home); }
  }
}

async function memoryNotePaths(context: AgentMemoryTaskContext): Promise<readonly string[]> {
  if (context.filesystem !== undefined) {
    const paths = await context.filesystem.walk('notes', AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES);
    const candidates: string[] = [];
    for (const candidate of paths) {
      try { candidates.push(validateAgentMemoryPath(candidate)); } catch { /* opaque non-memory file */ }
    }
    return Object.freeze(candidates);
  }
  const candidates: string[] = [];
  let entriesSeen = 0;
  async function walk(directory: Awaited<ReturnType<typeof fs.open>>, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(descriptorPath(directory), { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES) throw new AgentMemoryError('memory snapshot exceeds bounded directory entries');
      const candidate = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new AgentMemoryError('memory notes contains a symlink');
      if (entry.isDirectory()) {
        // A directory component has the same safe-name policy as a leaf. An
        // unsafe directory is opaque local state and is never traversed.
        if (SAFE_SEGMENT.test(entry.name) && !SECRET_LIKE.test(entry.name) && entry.name !== '.byok') {
          const nested = await openPinnedDirectory(`${descriptorPath(directory)}/${entry.name}`);
          try { await walk(nested, candidate); } finally { await nested.close().catch(() => {}); }
        }
        continue;
      }
      if (!entry.isFile()) continue;
      try { candidates.push(validateAgentMemoryPath(candidate)); } catch { /* opaque non-memory file */ }
    }
  }
  await withPinnedDirectory(context.canonicalHome, ['notes'], (directory) => walk(directory, 'notes'), context.homeIdentity);
  return Object.freeze(candidates);
}

/** Bounded stable snapshot, called after Session.close() while the Agent lease still exists. */
export async function captureAgentMemorySnapshot(input: AgentMemoryTaskContext): Promise<AgentMemorySnapshot> {
  const context = taskContext(input); const candidates = ['MEMORY.md', ...await memoryNotePaths(context)];
  const paths = [...new Set(candidates)].sort((a, b) => a.localeCompare(b));
  if (paths.length > AGENT_MEMORY_MAX_SNAPSHOT_FILES) throw new AgentMemoryError('memory snapshot exceeds bounded file count');
  const files: AgentMemoryFile[] = []; let totalBytes = 0;
  for (const relativePath of paths) {
    const current = await readFile(context, relativePath);
    if (!current.exists) { if (relativePath === 'MEMORY.md') throw new AgentMemoryError('MEMORY.md disappeared before snapshot'); continue; }
    totalBytes += current.byteCount; if (totalBytes > AGENT_MEMORY_MAX_SNAPSHOT_BYTES) throw new AgentMemoryError('memory snapshot exceeds bounded total size');
    files.push(Object.freeze({ path: relativePath, revision: current.revision, byteCount: current.byteCount, content: current.content }));
  }
  const snapshot = Object.freeze({ files: Object.freeze(files), totalBytes });
  await audit(context, 'snapshot', { files: files.map((file) => ({ path: file.path, revision: file.revision, byteCount: file.byteCount })) });
  return snapshot;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

/** Canonical local-only raw form used solely to reject an obvious identity redactor. */
function rawSnapshotBytes(snapshot: AgentMemorySnapshot): Uint8Array {
  return encoder.encode(JSON.stringify({
    files: snapshot.files.map((file) => ({ path: file.path, revision: file.revision, byteCount: file.byteCount, content: file.content })),
  }));
}

function redactedBytes(raw: AgentMemorySnapshot, candidate: Uint8Array): Uint8Array {
  if (!(candidate instanceof Uint8Array)) throw new AgentMemoryError('redactor must return Uint8Array bytes');
  const bytes = candidate.slice();
  if (bytes.byteLength > AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES) throw new AgentMemoryError('redacted snapshot exceeds bounded projection bytes');
  if (bytesEqual(bytes, rawSnapshotBytes(raw))) throw new AgentMemoryError('identity/pass-through redactor is forbidden');
  return bytes;
}

type OutboxEntry = { version: 1; kind: 'append'; record: AgentMemoryRedactedOutboxRecord } | { version: 1; kind: 'accepted'; mutationId: string };
export class AgentMemoryRedactedOutbox {
  private readonly pendingById = new Map<string, AgentMemoryRedactedOutboxRecord>();
  private readonly highestSourceSeqByEpoch = new Map<number, number>();
  private writeTail: Promise<void> = Promise.resolve();
  private constructor(private readonly context: AgentMemoryTaskContext, private readonly grant: AgentMemoryProjectionGrant, readonly filePath: string) {}
  static async open(input: AgentMemoryTaskContext, grant: AgentMemoryProjectionGrant): Promise<AgentMemoryRedactedOutbox> {
    const context = taskContext(input);
    const outbox = new AgentMemoryRedactedOutbox(context, grant, path.join(context.canonicalHome, AGENT_HOME_INTERNAL_DIRECTORY, AGENT_MEMORY_OUTBOX_FILENAME));
    await outbox.load();
    return outbox;
  }
  pending(): readonly AgentMemoryRedactedOutboxRecord[] { return Object.freeze([...this.pendingById.values()].sort((a, b) => a.mutation.sourceSeq - b.mutation.sourceSeq)); }
  async append(bytes: Uint8Array): Promise<AgentMemoryRedactedOutboxRecord> { return this.exclusive(async () => {
    const sourceSeq = (this.highestSourceSeqByEpoch.get(this.grant.writerEpoch) ?? 0) + 1;
    const mutation = AgentMemoryProjectionMutationSchema.parse({
      taskId: this.context.taskId,
      agentRef: this.context.agentRef,
      sessionRef: this.context.sessionRef,
      runtimeId: this.context.runtimeId,
      grantRef: this.grant.grantRef,
      writerEpoch: this.grant.writerEpoch,
      sourceSeq,
      mutationId: randomUUID(),
      policyRevision: this.grant.policyRevision,
      snapshot: { redactedHash: digestBytes(bytes), redactedByteCount: bytes.byteLength, redactedBytes: Buffer.from(bytes).toString('base64url') },
    });
    const record: AgentMemoryRedactedOutboxRecord = Object.freeze({ version: 1, mutation: Object.freeze(mutation), createdAt: new Date().toISOString() });
    await this.entry({ version: 1, kind: 'append', record }); this.pendingById.set(mutation.mutationId, record);
    this.highestSourceSeqByEpoch.set(mutation.writerEpoch, mutation.sourceSeq);
    return record;
  }); }
  async replay(port: AgentMemoryProjectionPort): Promise<void> { await this.exclusive(async () => {
    for (const record of this.pending()) {
      if (!this.matchesActiveBinding(record.mutation)) continue;
      if (!(await port.publish(Object.freeze({ mutation: record.mutation }))).accepted) return;
      await this.entry({ version: 1, kind: 'accepted', mutationId: record.mutation.mutationId }); this.pendingById.delete(record.mutation.mutationId);
    }
  }); }
  private async load(): Promise<void> {
    if (this.context.filesystem !== undefined) {
      const state = await readFile(this.context, `${AGENT_HOME_INTERNAL_DIRECTORY}/${AGENT_MEMORY_OUTBOX_FILENAME}`, AGENT_MEMORY_MAX_LOCAL_LOG_BYTES);
      if (!state.exists) return;
      await this.loadBody(state.content);
      return;
    }
    const body = await withPinnedDirectory(this.context.canonicalHome, [AGENT_HOME_INTERNAL_DIRECTORY], async (directory) => {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(`${descriptorPath(directory)}/${AGENT_MEMORY_OUTBOX_FILENAME}`, noFollowFlags(fsConstants.O_RDONLY));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new AgentMemoryError('Agent memory outbox is unavailable or unsafe');
      }
      try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(AGENT_MEMORY_MAX_LOCAL_LOG_BYTES)) throw new AgentMemoryError('Agent memory outbox is invalid');
        return await handle.readFile({ encoding: 'utf8' });
      } finally { await handle.close().catch(() => {}); }
    }, this.context.homeIdentity);
    if (body === undefined) return;
    await this.loadBody(body);
  }
  private async loadBody(body: string): Promise<void> {
    for (const line of body.split('\n')) {
      if (!line) continue;
      let item: OutboxEntry;
      try { item = JSON.parse(line) as OutboxEntry; } catch { throw new AgentMemoryError('Agent memory outbox entry is invalid'); }
      if (item.version !== 1 || (item.kind !== 'append' && item.kind !== 'accepted')) throw new AgentMemoryError('Agent memory outbox entry is invalid');
      if (item.kind === 'append') {
        const parsed = AgentMemoryProjectionMutationSchema.safeParse(item.record?.mutation);
        if (!parsed.success || typeof item.record.createdAt !== 'string') throw new AgentMemoryError('Agent memory outbox entry is invalid');
        const record = Object.freeze({ version: 1 as const, mutation: Object.freeze(parsed.data), createdAt: item.record.createdAt });
        this.pendingById.set(record.mutation.mutationId, record);
        this.highestSourceSeqByEpoch.set(record.mutation.writerEpoch, Math.max(this.highestSourceSeqByEpoch.get(record.mutation.writerEpoch) ?? 0, record.mutation.sourceSeq));
      } else if (typeof item.mutationId === 'string') this.pendingById.delete(item.mutationId);
      else throw new AgentMemoryError('Agent memory outbox entry is invalid');
    }
  }
  private async entry(entry: OutboxEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    if (this.context.filesystem !== undefined) {
      await this.context.filesystem.append(`${AGENT_HOME_INTERNAL_DIRECTORY}/${AGENT_MEMORY_OUTBOX_FILENAME}`, line, AGENT_MEMORY_MAX_LOCAL_LOG_BYTES);
      return;
    }
    await withPinnedDirectory(this.context.canonicalHome, [AGENT_HOME_INTERNAL_DIRECTORY], async (directory) => {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(`${descriptorPath(directory)}/${AGENT_MEMORY_OUTBOX_FILENAME}`, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT), 0o600);
        await handle.writeFile(line, 'utf8'); await handle.sync();
      } finally { await handle?.close().catch(() => {}); }
    }, this.context.homeIdentity);
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> { const previous = this.writeTail; let release!: () => void; this.writeTail = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await fn(); } finally { release(); } }
  private matchesActiveBinding(mutation: AgentMemoryProjectionMutation): boolean {
    return mutation.taskId === this.context.taskId && mutation.agentRef.agentId === this.context.agentRef.agentId && mutation.agentRef.profileRevision === this.context.agentRef.profileRevision && mutation.sessionRef === this.context.sessionRef && mutation.runtimeId === this.context.runtimeId && mutation.grantRef === this.grant.grantRef && mutation.writerEpoch === this.grant.writerEpoch && mutation.policyRevision === this.grant.policyRevision;
  }
}

/** Missing capability, grant, redactor, or port has exactly zero network side effects. */
export async function snapshotAndProjectAgentMemory(input: AgentMemoryTaskContext, projection: AgentMemoryHostedProjection | undefined): Promise<void> {
  const context = taskContext(input); const snapshot = await captureAgentMemorySnapshot(context);
  if (projection?.capability !== AGENT_MEMORY_PROJECTION_CAPABILITY || !projection.grant || !projection.redactor || !projection.port) return;
  const outbox = await AgentMemoryRedactedOutbox.open(context, projection.grant);
  await outbox.append(redactedBytes(snapshot, await projection.redactor.redact(snapshot)));
  await outbox.replay(projection.port);
}
