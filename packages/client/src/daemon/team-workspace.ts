import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir } from '../util/secure-dir';

/**
 * The local team channel is deliberately a small, versioned contract.  It is
 * not a task outbox and it has no cloud or runtime authority.  The state file
 * is an atomic envelope so a post, a receipt, or a membership change is
 * either wholly visible after a restart or not visible at all.
 */
export const TEAM_WORKSPACE_VERSION = 1 as const;
export const TEAM_WORKSPACE_DIRECTORY = path.join('team-workspaces', 'v1');
export const TEAM_WORKSPACE_STATE_FILENAME = 'state.json';
export const TEAM_WORKSPACE_DEFAULT_CONTENT_TYPE = 'text/plain';

/** Bounds are intentionally smaller than the control protocol's 64 KiB line. */
export const TEAM_WORKSPACE_MAX_ID_BYTES = 128;
export const TEAM_WORKSPACE_MAX_BODY_BYTES = 32 * 1024;
export const TEAM_WORKSPACE_MAX_CONTENT_TYPE_BYTES = 128;
export const TEAM_WORKSPACE_MAX_MEMBERS = 256;
export const TEAM_WORKSPACE_MAX_MESSAGES = 100_000;
export const TEAM_WORKSPACE_MAX_BYTES = 64 * 1024 * 1024;
export const TEAM_WORKSPACE_DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
export const TEAM_WORKSPACE_MIN_LEASE_TTL_MS = 1;
export const TEAM_WORKSPACE_MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTENT_TYPE_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,127})$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** A stable, content-addressed registry revision. */
export type TeamWorkspaceRevision = `sha256:${string}`;

export interface TeamWorkspaceLimits {
  readonly maxMembers: number;
  readonly maxMessages: number;
  readonly maxBytes: number;
}

export interface TeamWorkspaceDefinition {
  readonly version: typeof TEAM_WORKSPACE_VERSION;
  readonly workspaceId: string;
  readonly revision: TeamWorkspaceRevision;
  readonly members: readonly string[];
  readonly limits: TeamWorkspaceLimits;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeamWorkspaceMemberReceipt {
  readonly workspaceId: string;
  readonly memberId: string;
  readonly acknowledgedThroughSeq: number;
  readonly deliveredThroughSeq: number;
  readonly registryRevision: TeamWorkspaceRevision;
  readonly updatedAt: string;
}

export interface TeamMessage {
  readonly version: typeof TEAM_WORKSPACE_VERSION;
  readonly workspaceId: string;
  readonly seq: number;
  readonly messageId: string;
  readonly senderMemberId: string;
  readonly body: string;
  readonly contentType: string;
  readonly byteCount: number;
  readonly contentHash: TeamWorkspaceRevision;
  readonly createdAt: string;
}

/**
 * The token is intentionally opaque to callers.  It is returned once from
 * lease issuance and only its digest is persisted; raw bearer material never
 * enters the durable state file.
 */
export interface TeamMemberLease {
  readonly opaqueToken: string;
  readonly workspaceId: string;
  readonly memberId: string;
  readonly registryRevision: TeamWorkspaceRevision;
  readonly expiresAt: string;
}

export interface CreateTeamWorkspaceInput {
  readonly workspaceId: string;
  readonly members: readonly string[];
  readonly limits: TeamWorkspaceLimits;
}

export interface UpdateTeamWorkspaceInput {
  readonly workspaceId: string;
  readonly expectedRevision: TeamWorkspaceRevision;
  readonly members: readonly string[];
  readonly limits?: TeamWorkspaceLimits;
}

export interface CreateTeamMemberLeaseInput {
  readonly workspaceId: string;
  readonly memberId: string;
  readonly ttlMs?: number;
}

export interface TeamPostMessageInput {
  readonly lease: TeamMemberLease;
  readonly body: string;
  readonly contentType?: string;
}

export interface TeamReadMessagesInput {
  readonly lease: TeamMemberLease;
  readonly afterSeq?: number;
}

export interface TeamAckMessagesInput {
  readonly lease: TeamMemberLease;
  readonly throughSeq: number;
}

export interface TeamMessageAcceptedReceipt {
  readonly accepted: true;
  readonly durable: true;
  readonly workspaceId: string;
  readonly memberId: string;
  readonly seq: number;
  readonly messageId: string;
  readonly message: TeamMessage;
}

export interface TeamReadMessagesResult {
  readonly workspaceId: string;
  readonly memberId: string;
  readonly messages: readonly TeamMessage[];
  readonly afterSeq: number;
  readonly deliveredThroughSeq: number;
  readonly receipt: TeamWorkspaceMemberReceipt;
}

export interface TeamAckReceipt {
  readonly accepted: true;
  readonly durable: true;
  readonly throughSeq: number;
  readonly receipt: TeamWorkspaceMemberReceipt;
}

export interface LocalTeamWorkspaceOptions {
  /** Test seam for deterministic lease expiry and timestamps. */
  readonly now?: () => number;
}

interface StoredLease {
  readonly leaseId: string;
  readonly tokenDigest: TeamWorkspaceRevision;
  readonly workspaceId: string;
  readonly memberId: string;
  readonly registryRevision: TeamWorkspaceRevision;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface StoredWorkspaceState {
  definition: TeamWorkspaceDefinition;
  messages: TeamMessage[];
  receipts: Record<string, TeamWorkspaceMemberReceipt>;
  /** One active lease per member keeps bearer state bounded and revocable. */
  leases: Record<string, StoredLease>;
}

interface StoredEnvelope {
  readonly version: typeof TEAM_WORKSPACE_VERSION;
  readonly workspaces: Record<string, StoredWorkspaceState>;
}

/** Common typed failure for all rejected local team operations. */
export class TeamWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamWorkspaceError';
  }
}

export class TeamWorkspaceValidationError extends TeamWorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = 'TeamWorkspaceValidationError';
  }
}

export class TeamWorkspaceNotFoundError extends TeamWorkspaceError {
  constructor(readonly workspaceId: string) {
    super(`team workspace "${workspaceId}" does not exist`);
    this.name = 'TeamWorkspaceNotFoundError';
  }
}

export class TeamWorkspaceConflictError extends TeamWorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = 'TeamWorkspaceConflictError';
  }
}

export class TeamWorkspaceQuotaError extends TeamWorkspaceError {
  constructor(readonly quota: 'members' | 'messages' | 'bytes', message: string) {
    super(message);
    this.name = 'TeamWorkspaceQuotaError';
  }
}

export class TeamWorkspaceLeaseError extends TeamWorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = 'TeamWorkspaceLeaseError';
  }
}

export class TeamWorkspaceReceiptError extends TeamWorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = 'TeamWorkspaceReceiptError';
  }
}

export class TeamWorkspaceCorruptError extends TeamWorkspaceError {
  constructor(message: string) {
    super(`team workspace durable state is corrupt: ${message}`);
    this.name = 'TeamWorkspaceCorruptError';
  }
}

/**
 * All instances in one process sharing a store directory use the same queue.
 * This prevents a second service instance (the usual restart/readback test)
 * from interleaving a load-modify-save cycle with the daemon instance.  The
 * atomic rename still protects readers and crash recovery; the queue protects
 * the higher-level state transition from lost updates.
 */
const queues = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function digest(value: string): TeamWorkspaceRevision {
  return `sha256:${createHash('sha256').update(encoder.encode(value)).digest('hex')}` as TeamWorkspaceRevision;
}

function digestBytes(value: Uint8Array): TeamWorkspaceRevision {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as TeamWorkspaceRevision;
}

function cloneLimits(value: TeamWorkspaceLimits): TeamWorkspaceLimits {
  return Object.freeze({ maxMembers: value.maxMembers, maxMessages: value.maxMessages, maxBytes: value.maxBytes });
}

function freezeDefinition(value: TeamWorkspaceDefinition): TeamWorkspaceDefinition {
  return Object.freeze({
    ...value,
    members: Object.freeze([...value.members]),
    limits: cloneLimits(value.limits),
  });
}

function freezeReceipt(value: TeamWorkspaceMemberReceipt): TeamWorkspaceMemberReceipt {
  return Object.freeze({ ...value });
}

function freezeMessage(value: TeamMessage): TeamMessage {
  return Object.freeze({ ...value });
}

function freezeLease(value: TeamMemberLease): TeamMemberLease {
  return Object.freeze({ ...value });
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > TEAM_WORKSPACE_MAX_ID_BYTES || !ID_PATTERN.test(value)) {
    throw new TeamWorkspaceValidationError(`${label} must be 1-${TEAM_WORKSPACE_MAX_ID_BYTES} bytes of [A-Za-z0-9._-] and start with an alphanumeric character`);
  }
}

function assertContentType(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    byteLength(value) > TEAM_WORKSPACE_MAX_CONTENT_TYPE_BYTES ||
    !CONTENT_TYPE_PATTERN.test(value)
  ) {
    throw new TeamWorkspaceValidationError(`contentType must be 1-${TEAM_WORKSPACE_MAX_CONTENT_TYPE_BYTES} printable ASCII bytes`);
  }
}

function assertBody(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000') || byteLength(value) > TEAM_WORKSPACE_MAX_BODY_BYTES) {
    throw new TeamWorkspaceValidationError(`body must be non-empty, contain no NUL, and be at most ${TEAM_WORKSPACE_MAX_BODY_BYTES} UTF-8 bytes`);
  }
  // TextEncoder replaces lone UTF-16 surrogates.  Rejecting them keeps the
  // stored byte count/hash exactly equal to the string the caller submitted.
  if (new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(value)) !== value) {
    throw new TeamWorkspaceValidationError('body must be valid UTF-8 text');
  }
}

function assertInteger(value: unknown, label: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TeamWorkspaceValidationError(`${label} must be an integer in [${min}, ${max}]`);
  }
}

function normalizeMembers(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TeamWorkspaceValidationError('members must be an array');
  if (value.length > TEAM_WORKSPACE_MAX_MEMBERS) throw new TeamWorkspaceQuotaError('members', `workspace member quota cannot exceed ${TEAM_WORKSPACE_MAX_MEMBERS}`);
  const members = value.map((member) => {
    assertSafeId(member, 'memberId');
    return member;
  });
  if (new Set(members).size !== members.length) throw new TeamWorkspaceValidationError('members must not contain duplicates');
  return members.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function normalizeLimits(value: unknown): TeamWorkspaceLimits {
  if (!isRecord(value)) throw new TeamWorkspaceValidationError('limits must be an object');
  if (Object.keys(value).some((key) => key !== 'maxMembers' && key !== 'maxMessages' && key !== 'maxBytes')) {
    throw new TeamWorkspaceValidationError('limits only accepts maxMembers, maxMessages, and maxBytes');
  }
  assertInteger(value.maxMembers, 'limits.maxMembers', 1, TEAM_WORKSPACE_MAX_MEMBERS);
  assertInteger(value.maxMessages, 'limits.maxMessages', 1, TEAM_WORKSPACE_MAX_MESSAGES);
  assertInteger(value.maxBytes, 'limits.maxBytes', 1, TEAM_WORKSPACE_MAX_BYTES);
  return cloneLimits({ maxMembers: value.maxMembers, maxMessages: value.maxMessages, maxBytes: value.maxBytes });
}

/** Public fail-closed validators for control/MCP composition sites. */
export function validateTeamWorkspaceId(value: unknown): string {
  assertSafeId(value, 'workspaceId');
  return value;
}

export function validateTeamMemberId(value: unknown): string {
  assertSafeId(value, 'memberId');
  return value;
}

export function validateTeamMessageBody(value: unknown): string {
  assertBody(value);
  return value;
}

export function validateTeamContentType(value: unknown): string {
  assertContentType(value);
  return value;
}

/** Encode the full lease as one opaque helper context; it is never model input. */
export function encodeTeamMemberContext(lease: TeamMemberLease): string {
  assertLeaseShape(lease);
  return Buffer.from(JSON.stringify(lease), 'utf8').toString('base64url');
}

/** Decode only the exact bounded lease shape emitted by {@link encodeTeamMemberContext}. */
export function decodeTeamMemberContext(value: unknown): TeamMemberLease {
  if (typeof value !== 'string' || value.length < 32 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TeamWorkspaceLeaseError('team member context is invalid');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown; } catch { throw new TeamWorkspaceLeaseError('team member context is invalid'); }
  assertLeaseShape(parsed);
  if (Object.keys(parsed as unknown as Record<string, unknown>).some((key) => !['opaqueToken', 'workspaceId', 'memberId', 'registryRevision', 'expiresAt'].includes(key))) {
    throw new TeamWorkspaceLeaseError('team member context contains unknown fields');
  }
  return publicLease(parsed);
}

function canonicalDefinitionInput(workspaceId: string, members: readonly string[], limits: TeamWorkspaceLimits): string {
  return JSON.stringify({ version: TEAM_WORKSPACE_VERSION, workspaceId, members: [...members], limits });
}

function definitionRevision(workspaceId: string, members: readonly string[], limits: TeamWorkspaceLimits): TeamWorkspaceRevision {
  return digest(canonicalDefinitionInput(workspaceId, members, limits));
}

function assertRevision(value: unknown, label: string): asserts value is TeamWorkspaceRevision {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new TeamWorkspaceValidationError(`${label} must be a sha256 revision`);
}

function assertIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) throw new TeamWorkspaceCorruptError(`${label} is not a canonical timestamp`);
}

function assertTeamMessage(value: unknown, workspaceId: string, previousSeq: number): asserts value is TeamMessage {
  if (!isRecord(value) || value.version !== TEAM_WORKSPACE_VERSION || value.workspaceId !== workspaceId) throw new TeamWorkspaceCorruptError('message envelope is invalid');
  assertInteger(value.seq, 'message.seq', 1, Number.MAX_SAFE_INTEGER);
  if (value.seq !== previousSeq + 1) throw new TeamWorkspaceCorruptError('message sequence is not contiguous');
  assertSafeId(value.messageId, 'message.messageId');
  assertSafeId(value.senderMemberId, 'message.senderMemberId');
  assertBody(value.body);
  assertContentType(value.contentType);
  assertInteger(value.byteCount, 'message.byteCount', 1, TEAM_WORKSPACE_MAX_BODY_BYTES);
  if (value.byteCount !== byteLength(value.body)) throw new TeamWorkspaceCorruptError('message byteCount does not match body');
  assertRevision(value.contentHash, 'message.contentHash');
  if (value.contentHash !== digest(value.body)) throw new TeamWorkspaceCorruptError('message contentHash does not match body');
  assertIso(value.createdAt, 'message.createdAt');
}

function assertDefinition(value: unknown, workspaceId: string): asserts value is TeamWorkspaceDefinition {
  if (!isRecord(value) || value.version !== TEAM_WORKSPACE_VERSION || value.workspaceId !== workspaceId) throw new TeamWorkspaceCorruptError('workspace definition is invalid');
  assertRevision(value.revision, 'workspace.revision');
  const members = normalizeMembers(value.members);
  const limits = normalizeLimits(value.limits);
  if (members.length > limits.maxMembers) throw new TeamWorkspaceCorruptError('workspace member count exceeds its quota');
  if (value.revision !== definitionRevision(workspaceId, members, limits)) throw new TeamWorkspaceCorruptError('workspace revision does not match its definition');
  assertIso(value.createdAt, 'workspace.createdAt');
  assertIso(value.updatedAt, 'workspace.updatedAt');
}

function assertReceipt(value: unknown, workspaceId: string, memberId: string, revision: TeamWorkspaceRevision, maxSeq: number): asserts value is TeamWorkspaceMemberReceipt {
  if (!isRecord(value) || value.workspaceId !== workspaceId || value.memberId !== memberId || value.registryRevision !== revision) throw new TeamWorkspaceCorruptError('member receipt binding is invalid');
  assertInteger(value.acknowledgedThroughSeq, 'receipt.acknowledgedThroughSeq', 0, maxSeq);
  assertInteger(value.deliveredThroughSeq, 'receipt.deliveredThroughSeq', 0, maxSeq);
  if (value.acknowledgedThroughSeq > value.deliveredThroughSeq) throw new TeamWorkspaceCorruptError('member receipt acknowledges an undelivered sequence');
  assertIso(value.updatedAt, 'receipt.updatedAt');
}

function assertStoredLease(value: unknown, workspaceId: string, memberId: string, revision: TeamWorkspaceRevision): asserts value is StoredLease {
  if (!isRecord(value) || value.workspaceId !== workspaceId || value.memberId !== memberId || value.registryRevision !== revision) throw new TeamWorkspaceCorruptError('member lease binding is invalid');
  assertSafeId(value.leaseId, 'lease.leaseId');
  assertRevision(value.tokenDigest, 'lease.tokenDigest');
  assertIso(value.issuedAt, 'lease.issuedAt');
  assertIso(value.expiresAt, 'lease.expiresAt');
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) throw new TeamWorkspaceCorruptError('member lease expiry is not after issue time');
}

function validateStoredState(workspaceId: string, value: unknown): StoredWorkspaceState {
  if (!isRecord(value) || !isRecord(value.definition) || !Array.isArray(value.messages) || !isRecord(value.receipts) || !isRecord(value.leases)) throw new TeamWorkspaceCorruptError(`workspace "${workspaceId}" state envelope is invalid`);
  assertDefinition(value.definition, workspaceId);
  const definition = freezeDefinition({ ...value.definition, members: normalizeMembers(value.definition.members), limits: normalizeLimits(value.definition.limits) });
  const messages: TeamMessage[] = [];
  let totalBytes = 0;
  for (const message of value.messages) {
    assertTeamMessage(message, workspaceId, messages.length);
    totalBytes += message.byteCount;
    if (totalBytes > definition.limits.maxBytes) throw new TeamWorkspaceCorruptError('stored messages exceed workspace byte quota');
    messages.push(freezeMessage({ ...message }));
  }
  if (messages.length > definition.limits.maxMessages) throw new TeamWorkspaceCorruptError('stored messages exceed workspace message quota');
  const receipts: Record<string, TeamWorkspaceMemberReceipt> = {};
  for (const memberId of definition.members) {
    const receipt = value.receipts[memberId];
    if (receipt === undefined) throw new TeamWorkspaceCorruptError(`receipt missing for member "${memberId}"`);
    assertReceipt(receipt, workspaceId, memberId, definition.revision, messages.length);
    receipts[memberId] = freezeReceipt({ ...receipt });
  }
  if (Object.keys(value.receipts).some((memberId) => !definition.members.includes(memberId))) throw new TeamWorkspaceCorruptError('receipt exists for a non-member');
  const leases: Record<string, StoredLease> = {};
  for (const memberId of Object.keys(value.leases)) {
    if (!definition.members.includes(memberId)) throw new TeamWorkspaceCorruptError('lease exists for a non-member');
    const lease = value.leases[memberId];
    if (lease === undefined) throw new TeamWorkspaceCorruptError('lease record is missing');
    assertStoredLease(lease, workspaceId, memberId, definition.revision);
    leases[memberId] = Object.freeze({ ...lease });
  }
  return { definition, messages, receipts, leases };
}

function validateEnvelope(value: unknown): StoredEnvelope {
  if (!isRecord(value) || value.version !== TEAM_WORKSPACE_VERSION || !isRecord(value.workspaces)) throw new TeamWorkspaceCorruptError('state envelope version or workspaces map is invalid');
  const workspaces: Record<string, StoredWorkspaceState> = {};
  for (const [workspaceId, state] of Object.entries(value.workspaces)) {
    assertSafeId(workspaceId, 'workspaceId');
    workspaces[workspaceId] = validateStoredState(workspaceId, state);
  }
  return { version: TEAM_WORKSPACE_VERSION, workspaces };
}

function copyState(state: StoredWorkspaceState): StoredWorkspaceState {
  const receipts: Record<string, TeamWorkspaceMemberReceipt> = {};
  for (const [memberId, receipt] of Object.entries(state.receipts)) receipts[memberId] = { ...receipt };
  const leases: Record<string, StoredLease> = {};
  for (const [memberId, lease] of Object.entries(state.leases)) leases[memberId] = { ...lease };
  return {
    definition: { ...state.definition, members: [...state.definition.members], limits: { ...state.definition.limits } },
    messages: state.messages.map((message) => ({ ...message })),
    receipts,
    leases,
  };
}

function emptyReceipt(workspaceId: string, memberId: string, revision: TeamWorkspaceRevision, now: string): TeamWorkspaceMemberReceipt {
  return { workspaceId, memberId, acknowledgedThroughSeq: 0, deliveredThroughSeq: 0, registryRevision: revision, updatedAt: now };
}

function publicReceipt(receipt: TeamWorkspaceMemberReceipt): TeamWorkspaceMemberReceipt {
  return freezeReceipt({ ...receipt });
}

function publicDefinition(definition: TeamWorkspaceDefinition): TeamWorkspaceDefinition {
  return freezeDefinition({ ...definition, members: [...definition.members], limits: { ...definition.limits } });
}

function publicMessage(message: TeamMessage): TeamMessage {
  return freezeMessage({ ...message });
}

function publicLease(lease: TeamMemberLease): TeamMemberLease {
  return freezeLease({ ...lease });
}

function tokenDigest(token: string): TeamWorkspaceRevision {
  return digestBytes(encoder.encode(token));
}

function assertOpaqueToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !LEASE_TOKEN_PATTERN.test(value)) throw new TeamWorkspaceLeaseError('member lease token is invalid');
}

function assertLeaseShape(value: unknown): asserts value is TeamMemberLease {
  if (!isRecord(value)) throw new TeamWorkspaceLeaseError('member lease is required');
  assertOpaqueToken(value.opaqueToken);
  assertSafeId(value.workspaceId, 'lease.workspaceId');
  assertSafeId(value.memberId, 'lease.memberId');
  assertRevision(value.registryRevision, 'lease.registryRevision');
  assertIso(value.expiresAt, 'lease.expiresAt');
}

function assertAfterSeq(value: unknown): asserts value is number {
  assertInteger(value, 'afterSeq', 0, Number.MAX_SAFE_INTEGER);
}

/**
 * Local-only durable TeamWorkspace authority.  The service is intentionally
 * independent from TaskRunner and cloud protocol: a caller must first obtain
 * a member lease, and all message operations derive workspace/member identity
 * from that lease rather than accepting it from model input.
 */
export class LocalTeamWorkspace {
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly queueKey: string;

  constructor(storeDir: string, options: LocalTeamWorkspaceOptions = {}) {
    if (typeof storeDir !== 'string' || storeDir.length === 0) {
      throw new TeamWorkspaceValidationError('storeDir must be a non-empty path');
    }
    this.rootDir = path.join(path.resolve(storeDir), TEAM_WORKSPACE_DIRECTORY);
    this.statePath = path.join(this.rootDir, TEAM_WORKSPACE_STATE_FILENAME);
    this.queueKey = this.statePath;
    this.now = options.now ?? (() => Date.now());
  }

  /** Create the secure state directory; it is safe to call on every start. */
  async initialize(): Promise<void> {
    await ensureSecureDir(this.rootDir);
  }

  async createWorkspace(input: CreateTeamWorkspaceInput): Promise<TeamWorkspaceDefinition> {
    assertSafeId(input?.workspaceId, 'workspaceId');
    const members = normalizeMembers(input?.members);
    const limits = normalizeLimits(input?.limits);
    if (members.length > limits.maxMembers) throw new TeamWorkspaceQuotaError('members', 'workspace members exceed maxMembers');
    return this.enqueue(async () => {
      const envelope = await this.load();
      if (envelope.workspaces[input.workspaceId] !== undefined) throw new TeamWorkspaceConflictError(`team workspace "${input.workspaceId}" already exists`);
      const now = new Date(this.now()).toISOString();
      const definition: TeamWorkspaceDefinition = {
        version: TEAM_WORKSPACE_VERSION,
        workspaceId: input.workspaceId,
        revision: definitionRevision(input.workspaceId, members, limits),
        members,
        limits,
        createdAt: now,
        updatedAt: now,
      };
      const receipts: Record<string, TeamWorkspaceMemberReceipt> = {};
      for (const memberId of members) receipts[memberId] = emptyReceipt(input.workspaceId, memberId, definition.revision, now);
      const state: StoredWorkspaceState = { definition, messages: [], receipts, leases: {} };
      envelope.workspaces[input.workspaceId] = state;
      await this.save(envelope);
      return publicDefinition(definition);
    });
  }

  async getWorkspace(workspaceId: string): Promise<TeamWorkspaceDefinition | undefined> {
    assertSafeId(workspaceId, 'workspaceId');
    return this.enqueue(async () => {
      const state = (await this.load()).workspaces[workspaceId];
      return state === undefined ? undefined : publicDefinition(state.definition);
    });
  }

  async listWorkspaces(): Promise<readonly TeamWorkspaceDefinition[]> {
    return this.enqueue(async () => {
      const envelope = await this.load();
      return Object.values(envelope.workspaces)
        .sort((left, right) => left.definition.workspaceId.localeCompare(right.definition.workspaceId))
        .map((state) => publicDefinition(state.definition));
    });
  }

  /** Local operator read for the tmux pane; it does not create or advance a member receipt. */
  async inspectMessages(workspaceId: string, afterSeq = 0): Promise<readonly TeamMessage[]> {
    assertSafeId(workspaceId, 'workspaceId');
    assertAfterSeq(afterSeq);
    return this.enqueue(async () => {
      const state = (await this.load()).workspaces[workspaceId];
      if (state === undefined) throw new TeamWorkspaceNotFoundError(workspaceId);
      return Object.freeze(state.messages.filter((message) => message.seq > afterSeq).map(publicMessage));
    });
  }

  /** CAS-guarded membership/limit update.  A revision change invalidates all leases. */
  async updateWorkspace(input: UpdateTeamWorkspaceInput): Promise<TeamWorkspaceDefinition> {
    assertSafeId(input?.workspaceId, 'workspaceId');
    assertRevision(input?.expectedRevision, 'expectedRevision');
    const members = normalizeMembers(input?.members);
    return this.enqueue(async () => {
      const envelope = await this.load();
      const current = envelope.workspaces[input.workspaceId];
      if (current === undefined) throw new TeamWorkspaceNotFoundError(input.workspaceId);
      if (current.definition.revision !== input.expectedRevision) throw new TeamWorkspaceConflictError(`team workspace "${input.workspaceId}" revision conflict`);
      const limits = input.limits === undefined ? current.definition.limits : normalizeLimits(input.limits);
      if (members.length > limits.maxMembers) throw new TeamWorkspaceQuotaError('members', 'workspace members exceed maxMembers');
      if (current.messages.length > limits.maxMessages) throw new TeamWorkspaceQuotaError('messages', 'new workspace message quota is below retained messages');
      const retainedBytes = current.messages.reduce((sum, message) => sum + message.byteCount, 0);
      if (retainedBytes > limits.maxBytes) throw new TeamWorkspaceQuotaError('bytes', 'new workspace byte quota is below retained messages');
      const revision = definitionRevision(input.workspaceId, members, limits);
      const now = new Date(this.now()).toISOString();
      const definition: TeamWorkspaceDefinition = {
        version: TEAM_WORKSPACE_VERSION,
        workspaceId: input.workspaceId,
        revision,
        members,
        limits,
        createdAt: current.definition.createdAt,
        updatedAt: now,
      };
      const next = copyState(current);
      next.definition = definition;
      next.receipts = {};
      // A registry revision invalidates leases, but it must not make a
      // surviving member's durable acknowledgement move backwards.  Carry
      // the bounded cursor/high-water forward while rebinding it to the new
      // revision; newly added members start at zero.
      for (const memberId of members) {
        const previous = current.receipts[memberId];
        next.receipts[memberId] = previous === undefined
          ? emptyReceipt(input.workspaceId, memberId, revision, now)
          : { ...previous, registryRevision: revision, updatedAt: now };
      }
      next.leases = {};
      envelope.workspaces[input.workspaceId] = next;
      await this.save(envelope);
      return publicDefinition(definition);
    });
  }

  async createMemberLease(input: CreateTeamMemberLeaseInput): Promise<TeamMemberLease> {
    assertSafeId(input?.workspaceId, 'workspaceId');
    assertSafeId(input?.memberId, 'memberId');
    const ttlMs = input?.ttlMs ?? TEAM_WORKSPACE_DEFAULT_LEASE_TTL_MS;
    assertInteger(ttlMs, 'ttlMs', TEAM_WORKSPACE_MIN_LEASE_TTL_MS, TEAM_WORKSPACE_MAX_LEASE_TTL_MS);
    return this.enqueue(async () => {
      const envelope = await this.load();
      const state = envelope.workspaces[input.workspaceId];
      if (state === undefined) throw new TeamWorkspaceNotFoundError(input.workspaceId);
      if (!state.definition.members.includes(input.memberId)) throw new TeamWorkspaceLeaseError(`member "${input.memberId}" is not in workspace "${input.workspaceId}"`);
      const nowMs = this.now();
      const issuedAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + ttlMs).toISOString();
      const opaqueToken = randomBytes(32).toString('base64url');
      const lease: TeamMemberLease = {
        opaqueToken,
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        registryRevision: state.definition.revision,
        expiresAt,
      };
      // At most one current lease per member.  Re-issuing a lease is an
      // explicit revocation of the prior bearer, not a second authority.
      const next = copyState(state);
      next.leases[input.memberId] = {
        leaseId: randomUUID(),
        tokenDigest: tokenDigest(opaqueToken),
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        registryRevision: state.definition.revision,
        issuedAt,
        expiresAt,
      };
      envelope.workspaces[input.workspaceId] = next;
      await this.save(envelope);
      return publicLease(lease);
    });
  }

  async revokeMemberLease(input: { readonly lease: TeamMemberLease }): Promise<void> {
    assertLeaseShape(input?.lease);
    return this.enqueue(async () => {
      const envelope = await this.load();
      const state = envelope.workspaces[input.lease.workspaceId];
      if (state === undefined) throw new TeamWorkspaceLeaseError('member lease workspace does not exist');
      const stored = state.leases[input.lease.memberId];
      if (stored === undefined || stored.tokenDigest !== tokenDigest(input.lease.opaqueToken)) throw new TeamWorkspaceLeaseError('member lease is revoked or unknown');
      const next = copyState(state);
      delete next.leases[input.lease.memberId];
      envelope.workspaces[input.lease.workspaceId] = next;
      await this.save(envelope);
    });
  }

  /** Validate the opaque lease and return its daemon-owned identity. */
  async validateMemberLease(lease: TeamMemberLease): Promise<Readonly<{ workspaceId: string; memberId: string; registryRevision: TeamWorkspaceRevision; expiresAt: string }>> {
    assertLeaseShape(lease);
    return this.enqueue(async () => {
      const resolved = await this.resolveLease(await this.load(), lease);
      const stored = resolved.leases[lease.memberId]!;
      return Object.freeze({ workspaceId: stored.workspaceId, memberId: stored.memberId, registryRevision: stored.registryRevision, expiresAt: stored.expiresAt });
    });
  }

  async postMessage(input: TeamPostMessageInput): Promise<TeamMessageAcceptedReceipt> {
    assertLeaseShape(input?.lease);
    assertBody(input?.body);
    const contentType = input?.contentType ?? TEAM_WORKSPACE_DEFAULT_CONTENT_TYPE;
    assertContentType(contentType);
    return this.enqueue(async () => {
      const envelope = await this.load();
      const state = await this.resolveLease(envelope, input.lease);
      const bodyBytes = byteLength(input.body);
      if (state.messages.length >= state.definition.limits.maxMessages) throw new TeamWorkspaceQuotaError('messages', 'workspace message quota is full');
      const totalBytes = state.messages.reduce((sum, message) => sum + message.byteCount, 0);
      if (totalBytes > state.definition.limits.maxBytes - bodyBytes) throw new TeamWorkspaceQuotaError('bytes', 'workspace byte quota is full');
      const seq = state.messages.length === 0 ? 1 : state.messages[state.messages.length - 1]!.seq + 1;
      const message: TeamMessage = {
        version: TEAM_WORKSPACE_VERSION,
        workspaceId: state.definition.workspaceId,
        seq,
        messageId: randomUUID(),
        senderMemberId: state.definition.members.find((memberId) => memberId === input.lease.memberId)!,
        body: input.body,
        contentType,
        byteCount: bodyBytes,
        contentHash: digest(input.body),
        createdAt: new Date(this.now()).toISOString(),
      };
      const next = copyState(state);
      next.messages.push(message);
      envelope.workspaces[state.definition.workspaceId] = next;
      // The awaited save is the durability boundary.  No accepted receipt is
      // created before this atomic fsync-backed replace has completed.
      await this.save(envelope);
      const publicValue = publicMessage(message);
      return Object.freeze({ accepted: true as const, durable: true as const, workspaceId: state.definition.workspaceId, memberId: input.lease.memberId, seq, messageId: message.messageId, message: publicValue });
    });
  }

  async readMessages(input: TeamReadMessagesInput): Promise<TeamReadMessagesResult> {
    assertLeaseShape(input?.lease);
    if (input?.afterSeq !== undefined) assertAfterSeq(input.afterSeq);
    return this.enqueue(async () => {
      const envelope = await this.load();
      const state = await this.resolveLease(envelope, input.lease);
      const currentReceipt = state.receipts[input.lease.memberId]!;
      const requestedAfter = input.afterSeq ?? currentReceipt.acknowledgedThroughSeq;
      const afterSeq = Math.max(requestedAfter, currentReceipt.acknowledgedThroughSeq);
      const messages = state.messages.filter((message) => message.seq > afterSeq);
      const highestDelivered = messages.length === 0 ? currentReceipt.deliveredThroughSeq : Math.max(currentReceipt.deliveredThroughSeq, messages[messages.length - 1]!.seq);
      const now = new Date(this.now()).toISOString();
      const receipt: TeamWorkspaceMemberReceipt = highestDelivered === currentReceipt.deliveredThroughSeq
        ? currentReceipt
        : {
        ...currentReceipt,
        deliveredThroughSeq: highestDelivered,
        updatedAt: now,
        };
      const next = copyState(state);
      next.receipts[input.lease.memberId] = receipt;
      if (highestDelivered !== currentReceipt.deliveredThroughSeq) {
        envelope.workspaces[state.definition.workspaceId] = next;
        await this.save(envelope);
      }
      return Object.freeze({
        workspaceId: state.definition.workspaceId,
        memberId: input.lease.memberId,
        messages: Object.freeze(messages.map(publicMessage)),
        afterSeq,
        deliveredThroughSeq: highestDelivered,
        receipt: publicReceipt(receipt),
      });
    });
  }

  async ackMessages(input: TeamAckMessagesInput): Promise<TeamAckReceipt> {
    assertLeaseShape(input?.lease);
    assertInteger(input?.throughSeq, 'throughSeq', 0, Number.MAX_SAFE_INTEGER);
    return this.enqueue(async () => {
      const envelope = await this.load();
      const state = await this.resolveLease(envelope, input.lease);
      const currentReceipt = state.receipts[input.lease.memberId]!;
      if (input.throughSeq < currentReceipt.acknowledgedThroughSeq) throw new TeamWorkspaceReceiptError('acknowledgement cannot move backward');
      if (input.throughSeq > currentReceipt.deliveredThroughSeq) throw new TeamWorkspaceReceiptError('acknowledgement cannot exceed the highest sequence delivered to this member');
      const now = new Date(this.now()).toISOString();
      const receipt: TeamWorkspaceMemberReceipt = { ...currentReceipt, acknowledgedThroughSeq: input.throughSeq, updatedAt: now };
      const next = copyState(state);
      next.receipts[input.lease.memberId] = receipt;
      envelope.workspaces[state.definition.workspaceId] = next;
      await this.save(envelope);
      return Object.freeze({ accepted: true as const, durable: true as const, throughSeq: input.throughSeq, receipt: publicReceipt(receipt) });
    });
  }

  private async resolveLease(envelope: StoredEnvelope, lease: TeamMemberLease): Promise<StoredWorkspaceState> {
    const state = envelope.workspaces[lease.workspaceId];
    if (state === undefined) throw new TeamWorkspaceLeaseError('member lease workspace does not exist');
    if (!state.definition.members.includes(lease.memberId)) throw new TeamWorkspaceLeaseError('member lease member is not in the workspace');
    if (lease.registryRevision !== state.definition.revision) throw new TeamWorkspaceLeaseError('member lease registry revision is stale');
    if (Date.parse(lease.expiresAt) <= this.now()) throw new TeamWorkspaceLeaseError('member lease has expired');
    const stored = state.leases[lease.memberId];
    if (stored === undefined || stored.tokenDigest !== tokenDigest(lease.opaqueToken) || stored.registryRevision !== state.definition.revision || stored.expiresAt !== lease.expiresAt) {
      throw new TeamWorkspaceLeaseError('member lease is revoked or does not match the active lease');
    }
    if (Date.parse(stored.expiresAt) <= this.now()) throw new TeamWorkspaceLeaseError('member lease has expired');
    return state;
  }

  private async load(): Promise<StoredEnvelope> {
    await this.initialize();
    let raw: string;
    try {
      raw = await fs.readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: TEAM_WORKSPACE_VERSION, workspaces: {} };
      throw new TeamWorkspaceError(`could not read team workspace state: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new TeamWorkspaceCorruptError(`state JSON cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return validateEnvelope(parsed);
  }

  private async save(envelope: StoredEnvelope): Promise<void> {
    await this.initialize();
    await atomicWriteFile(this.statePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, fsync: true });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const tail = queues.get(this.queueKey) ?? Promise.resolve();
    const result = tail.then(operation);
    queues.set(this.queueKey, result.then(() => undefined, () => undefined));
    return result;
  }
}

/** The longer name is useful at composition sites; both names denote one authority. */
export { LocalTeamWorkspace as LocalTeamWorkspaceService };
