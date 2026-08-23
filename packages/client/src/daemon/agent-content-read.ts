import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import {
  AgentHomeLayout,
  validateAgentRef,
  type AgentRef,
} from '../agent-home';
import {
  AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
  AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
  AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
} from '@byok-sdk/protocol';
import { AgentContentAuditStore, AgentContentAuditStoreError } from './agent-content-audit-store';

export const AGENT_CONTENT_READ_SURFACES = ['workspace', 'transcript', 'artifact'] as const;
export type AgentContentReadSurface = (typeof AGENT_CONTENT_READ_SURFACES)[number];

/** Additive capability names. Each surface is independently admitted. */
export const AGENT_CONTENT_READ_CAPABILITIES = Object.freeze({
  workspace: AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
  transcript: AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
  artifact: AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
} as const);

export const AGENT_CONTENT_READ_CAPABILITY_WORKSPACE = AGENT_CONTENT_READ_CAPABILITIES.workspace;
export const AGENT_CONTENT_READ_CAPABILITY_TRANSCRIPT = AGENT_CONTENT_READ_CAPABILITIES.transcript;
export const AGENT_CONTENT_READ_CAPABILITY_ARTIFACT = AGENT_CONTENT_READ_CAPABILITIES.artifact;

export const AGENT_CONTENT_READ_DECISIONS = ['allow', 'deny'] as const;
export type AgentContentReadDecision = (typeof AGENT_CONTENT_READ_DECISIONS)[number];

/**
 * Reasons are stable policy observations, not user-facing prose. A denied
 * read has exactly one reason and never returns any bytes.
 */
export const AGENT_CONTENT_READ_REASONS = [
  'invalid-request',
  'policy-disabled',
  'capability-missing',
  'policy-revision-mismatch',
  'absolute-target',
  'non-relative-target',
  'dot-segment',
  'sensitive-name',
  'root-not-allowlisted',
  'root-invalid',
  'path-escape',
  'target-missing',
  'symlink',
  'not-regular-file',
  'byte-limit',
  'mime-not-allowlisted',
  'text-not-allowlisted',
  'text-decode-failed',
  'identity-mismatch',
] as const;
export type AgentContentReadReason = (typeof AGENT_CONTENT_READ_REASONS)[number];
export type AgentContentReadDropReason = AgentContentReadReason;

export type AgentContentActorKind = 'user' | 'agent' | 'system';

export interface AgentContentReadActor {
  readonly kind: AgentContentActorKind;
  readonly id: string;
}

/** Exact identity copied from the persisted Agent session handoff. */
export interface AgentContentSessionIdentity {
  readonly agentRef: AgentRef;
  readonly sessionRef: string;
  readonly runtimeId: string;
  readonly cwd: string;
}

export type AgentContentReadRoot =
  | { readonly kind: 'agent-home' }
  | { readonly kind: 'runtime-allowlisted'; readonly root: string };

/** The policy is one authority; no semantic defaults are inferred from a request. */
export interface AgentContentReadPolicy {
  readonly enabled: true;
  readonly capability: string;
  readonly root: AgentContentReadRoot;
  readonly policyRevision: string;
  /** Positive hard limit applied before allocating the file contents. */
  readonly maxBytes: number;
  /** Positive hard limit for an explicitly requested UTF-8 decode. */
  readonly maxTextBytes: number;
  /** Exact MIME strings. Wildcards are not accepted. */
  readonly allowedMimeTypes: readonly string[];
  /** Exact subset of allowedMimeTypes permitted with decodeAs=utf8. */
  readonly textMimeTypes: readonly string[];
  /** Product additions may tighten this list; SDK-reserved names cannot be removed. */
  readonly sensitiveNames?: readonly string[];
  /** Transcript reads must bind to this persisted identity, unless a resolver is supplied. */
  readonly expectedTranscriptIdentity?: AgentContentSessionIdentity;
}

export type AgentContentReadPolicySelection = 'disabled' | AgentContentReadPolicy;
export type ContentReadPolicy = AgentContentReadPolicy;

export interface AgentContentReadRequest {
  readonly requestId: string;
  readonly actor: AgentContentReadActor;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly agentRef: AgentRef;
  readonly surface: AgentContentReadSurface;
  /** Portable, slash-separated relative target. */
  readonly relativeTarget: string;
  /** Caller-declared MIME. No extension or content inference is performed. */
  readonly mimeType: string;
  readonly capability: string;
  readonly policyRevision: string;
  /** Optional narrower request bound; it can never widen policy.maxBytes. */
  readonly maxBytes?: number;
  /** Optional narrower request MIME declaration; it can never widen policy allowlist. */
  readonly allowedMimeTypes?: readonly string[];
  /** Omit for bytes; utf8 is explicit and bounded by maxTextBytes. */
  readonly decodeAs?: 'bytes' | 'utf8';
  /** Required for transcript; optional for workspace/artifact projections. */
  readonly session?: AgentContentSessionIdentity;
}

export interface AgentContentAuditReceipt {
  readonly version: 1;
  readonly requestId: string;
  readonly actor: AgentContentReadActor;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly agentRef: AgentRef;
  readonly surface: AgentContentReadSurface;
  readonly session?: AgentContentSessionIdentity;
  /** Canonical relative target only; no absolute pathname is ever recorded. */
  readonly relativeTarget: string;
  readonly policyRevision: string;
  readonly byteCount: number;
  readonly contentHash?: string;
  readonly decision: AgentContentReadDecision;
  readonly reason?: AgentContentReadReason;
  readonly recordedAt: string;
}

export interface AgentContentReadAllowed {
  readonly decision: 'allow';
  readonly surface: AgentContentReadSurface;
  readonly relativeTarget: string;
  readonly mimeType: string;
  readonly byteCount: number;
  readonly contentHash: string;
  readonly content: Uint8Array;
  readonly text?: string;
  readonly receipt: AgentContentAuditReceipt;
}

export interface AgentContentReadDenied {
  readonly decision: 'deny';
  readonly surface: AgentContentReadSurface;
  readonly relativeTarget: string;
  readonly reason: AgentContentReadReason;
  readonly receipt: AgentContentAuditReceipt;
}

export type AgentContentReadResult = AgentContentReadAllowed | AgentContentReadDenied;
export type AgentContentReadDecisionRecord = AgentContentReadResult;

export class AgentContentReadPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentContentReadPolicyError';
  }
}

export class AgentContentReadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentContentReadRequestError';
  }
}

export class AgentContentReadAuditError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentContentReadAuditError';
  }
}

export interface AgentContentReadPolicyEngineOptions {
  readonly agentHomeLayout?: AgentHomeLayout;
  readonly policies: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>;
  readonly capabilities: Iterable<string>;
  readonly runtimeAllowlistedRoots?: readonly string[];
  readonly auditStore: AgentContentAuditStore;
  /** Binds transcript claims to AgentSessionHandoffStore-backed exact identity. */
  readonly resolveTranscriptIdentity?: (
    request: AgentContentReadRequest,
  ) => Promise<AgentContentSessionIdentity | undefined> | AgentContentSessionIdentity | undefined;
}

export const SDK_RESERVED_CONTENT_NAMES = Object.freeze([
  'MEMORY.md',
  '.byok',
  '.env',
  '.git',
  '.ssh',
  'credentials',
  'credentials.json',
  'secrets',
  'secret',
  'id_rsa',
  'id_ed25519',
  'authorized_keys',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
]) as readonly string[];

const MAX_POLICY_BYTES = 64 * 1024 * 1024;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const ACTOR_KINDS = new Set<AgentContentActorKind>(['user', 'agent', 'system']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new AgentContentReadPolicyError(`${field} must be a non-empty string without control characters`);
  }
  return value;
}

function requestString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new AgentContentReadRequestError(`${field} must be a non-empty string without control characters`);
  }
  return value;
}

function positiveBound(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_POLICY_BYTES
  ) {
    throw new AgentContentReadPolicyError(`${field} must be a positive bounded byte count`);
  }
  return value;
}

function positiveRequestBound(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_POLICY_BYTES) {
    throw new AgentContentReadRequestError(`${field} must be a positive bounded byte count`);
  }
  return value;
}

function normalizeMime(value: unknown, field: string, errorType: 'policy' | 'request'): string {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (!MIME_PATTERN.test(text)) {
    const ErrorType = errorType === 'policy' ? AgentContentReadPolicyError : AgentContentReadRequestError;
    throw new ErrorType(`${field} must be an explicit MIME type; wildcards and inference are not accepted`);
  }
  return text;
}

function normalizeMimeList(values: readonly string[], field: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new AgentContentReadPolicyError(`${field} must contain at least one explicit MIME type`);
  }
  const normalized = values.map((value, index) => normalizeMime(value, `${field}[${index}]`, 'policy'));
  if (new Set(normalized).size !== normalized.length) {
    throw new AgentContentReadPolicyError(`${field} must not contain duplicate MIME types`);
  }
  return Object.freeze(normalized);
}

function normalizeIdentity(value: AgentContentSessionIdentity, field: string): AgentContentSessionIdentity {
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef(value.agentRef);
  } catch (error) {
    throw new AgentContentReadPolicyError(`${field}.agentRef is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sessionRef = nonEmptyString(value.sessionRef, `${field}.sessionRef`);
  const runtimeId = nonEmptyString(value.runtimeId, `${field}.runtimeId`);
  const cwd = nonEmptyString(value.cwd, `${field}.cwd`);
  if (!path.isAbsolute(cwd)) throw new AgentContentReadPolicyError(`${field}.cwd must be absolute`);
  return Object.freeze({ agentRef, sessionRef, runtimeId, cwd: path.resolve(cwd) });
}

export function createAgentContentReadPolicy(input: AgentContentReadPolicy): AgentContentReadPolicy {
  if (!isRecord(input) || input.enabled !== true) {
    throw new AgentContentReadPolicyError('content read policy must be enabled explicitly or set to disabled');
  }
  const capability = nonEmptyString(input.capability, 'contentRead.capability');
  const policyRevision = nonEmptyString(input.policyRevision, 'contentRead.policyRevision');
  const maxBytes = positiveBound(input.maxBytes, 'contentRead.maxBytes');
  const maxTextBytes = positiveBound(input.maxTextBytes, 'contentRead.maxTextBytes');
  if (maxTextBytes > maxBytes) {
    throw new AgentContentReadPolicyError('contentRead.maxTextBytes must not exceed maxBytes');
  }
  const allowedMimeTypes = normalizeMimeList(input.allowedMimeTypes, 'contentRead.allowedMimeTypes');
  const textMimeTypes = normalizeMimeList(input.textMimeTypes, 'contentRead.textMimeTypes', true);
  for (const mime of textMimeTypes) {
    if (!allowedMimeTypes.includes(mime)) {
      throw new AgentContentReadPolicyError(`contentRead.textMimeTypes contains MIME not in allowedMimeTypes: ${mime}`);
    }
  }
  let root: AgentContentReadRoot;
  if (!isRecord(input.root)) {
    throw new AgentContentReadPolicyError('contentRead.root must be explicit');
  }
  if (input.root.kind === 'agent-home') {
    root = Object.freeze({ kind: 'agent-home' });
  } else if (input.root.kind === 'runtime-allowlisted') {
    const configuredRoot = nonEmptyString(input.root.root, 'contentRead.root.root');
    if (!path.isAbsolute(configuredRoot)) {
      throw new AgentContentReadPolicyError('contentRead.root.root must be absolute');
    }
    root = Object.freeze({ kind: 'runtime-allowlisted', root: path.resolve(configuredRoot) });
  } else {
    throw new AgentContentReadPolicyError('contentRead.root.kind is not supported');
  }
  if (input.sensitiveNames !== undefined && !Array.isArray(input.sensitiveNames)) {
    throw new AgentContentReadPolicyError('contentRead.sensitiveNames must be an array');
  }
  const sensitiveNames = input.sensitiveNames === undefined
    ? undefined
    : Object.freeze(input.sensitiveNames.map((value, index) => nonEmptyString(value, `contentRead.sensitiveNames[${index}]`)));
  const expectedTranscriptIdentity = input.expectedTranscriptIdentity === undefined
    ? undefined
    : normalizeIdentity(input.expectedTranscriptIdentity, 'contentRead.expectedTranscriptIdentity');
  return Object.freeze({
    enabled: true,
    capability,
    root,
    policyRevision,
    maxBytes,
    maxTextBytes,
    allowedMimeTypes,
    textMimeTypes,
    ...(sensitiveNames === undefined ? {} : { sensitiveNames }),
    ...(expectedTranscriptIdentity === undefined ? {} : { expectedTranscriptIdentity }),
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isPortableAbsoluteTarget(value: string): boolean {
  return path.isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value) || /^[/\\]/u.test(value);
}

function canonicalAuditTarget(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\u0000\r\n]/u.test(value) ||
    isPortableAbsoluteTarget(value) ||
    value.includes('\\')
  ) {
    return '[invalid-target]';
  }
  const segments = value.split('/');
  if (segments.some((part) => part.length === 0 || part === '.' || part === '..')) return '[invalid-target]';
  return segments.join('/') || '[invalid-target]';
}

function parseRelativeTarget(value: unknown): { relativeTarget: string; segments: readonly string[] } {
  const target = requestString(value, 'contentRead.relativeTarget');
  if (isPortableAbsoluteTarget(target)) {
    throw new TargetPolicyError('absolute-target');
  }
  if (target.includes('\\')) {
    throw new TargetPolicyError('non-relative-target');
  }
  const segments = target.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw new TargetPolicyError('non-relative-target');
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new TargetPolicyError('dot-segment');
  }
  return { relativeTarget: segments.join('/'), segments };
}

function nameMatches(pattern: string, component: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedComponent = component.toLowerCase();
  if (normalizedPattern.startsWith('*.')) return normalizedComponent.endsWith(normalizedPattern.slice(1));
  return normalizedPattern === normalizedComponent;
}

function isSensitiveTarget(segments: readonly string[], productNames: readonly string[] | undefined): boolean {
  const patterns = [...SDK_RESERVED_CONTENT_NAMES, ...(productNames ?? [])];
  return segments.some((segment) => patterns.some((pattern) => nameMatches(pattern, segment)));
}

interface ExistingAncestor {
  readonly canonical: string;
  readonly tail: readonly string[];
}

async function resolveExistingAncestor(inputPath: string): Promise<ExistingAncestor> {
  let cursor = path.resolve(inputPath);
  const tail: string[] = [];
  for (;;) {
    try {
      return { canonical: await fs.realpath(cursor), tail };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new TargetPolicyError('target-missing');
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

class TargetPolicyError extends Error {
  readonly reason: AgentContentReadReason;

  constructor(reason: AgentContentReadReason) {
    super(reason);
    this.name = 'TargetPolicyError';
    this.reason = reason;
  }
}

class RootPolicyError extends Error {
  readonly reason: AgentContentReadReason;

  constructor(reason: 'root-not-allowlisted' | 'root-invalid') {
    super(reason);
    this.name = 'RootPolicyError';
    this.reason = reason;
  }
}

function sameAgentRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

function sameSessionIdentity(left: AgentContentSessionIdentity, right: AgentContentSessionIdentity): boolean {
  return (
    sameAgentRef(left.agentRef, right.agentRef) &&
    left.sessionRef === right.sessionRef &&
    left.runtimeId === right.runtimeId &&
    left.cwd === right.cwd
  );
}

function validateRequest(request: AgentContentReadRequest): AgentContentReadRequest {
  if (!isRecord(request)) throw new AgentContentReadRequestError('content read request must be an object');
  const requestId = requestString(request.requestId, 'contentRead.requestId');
  const tenantId = requestString(request.tenantId, 'contentRead.tenantId');
  const deviceId = requestString(request.deviceId, 'contentRead.deviceId');
  if (!isRecord(request.actor) || !ACTOR_KINDS.has(request.actor.kind as AgentContentActorKind)) {
    throw new AgentContentReadRequestError('contentRead.actor.kind is not valid');
  }
  const actor = Object.freeze({
    kind: request.actor.kind as AgentContentActorKind,
    id: requestString(request.actor.id, 'contentRead.actor.id'),
  });
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef(request.agentRef);
  } catch (error) {
    throw new AgentContentReadRequestError(
      `contentRead.agentRef is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!AGENT_CONTENT_READ_SURFACES.includes(request.surface as AgentContentReadSurface)) {
    throw new AgentContentReadRequestError('contentRead.surface is not supported');
  }
  const mimeType = normalizeMime(request.mimeType, 'contentRead.mimeType', 'request');
  if (request.capability !== undefined) requestString(request.capability, 'contentRead.capability');
  const capability = requestString(request.capability, 'contentRead.capability');
  const policyRevision = requestString(request.policyRevision, 'contentRead.policyRevision');
  if (request.decodeAs !== undefined && request.decodeAs !== 'bytes' && request.decodeAs !== 'utf8') {
    throw new AgentContentReadRequestError('contentRead.decodeAs must be bytes or utf8');
  }
  const maxBytes = request.maxBytes === undefined ? undefined : positiveRequestBound(request.maxBytes, 'contentRead.maxBytes');
  const allowedMimeTypes = request.allowedMimeTypes === undefined
    ? undefined
    : Object.freeze(request.allowedMimeTypes.map((value, index) => normalizeMime(value, `contentRead.allowedMimeTypes[${index}]`, 'request')));
  const session = request.session === undefined ? undefined : normalizeRequestIdentity(request.session, 'contentRead.session');
  return Object.freeze({
    ...request,
    requestId,
    actor,
    tenantId,
    deviceId,
    agentRef,
    surface: request.surface as AgentContentReadSurface,
    mimeType,
    capability,
    policyRevision,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(allowedMimeTypes === undefined ? {} : { allowedMimeTypes }),
    ...(session === undefined ? {} : { session }),
  });
}

function normalizeRequestIdentity(value: AgentContentSessionIdentity, field: string): AgentContentSessionIdentity {
  if (!isRecord(value)) throw new AgentContentReadRequestError(`${field} must be an exact identity object`);
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef(value.agentRef);
  } catch (error) {
    throw new AgentContentReadRequestError(`${field}.agentRef is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sessionRef = requestString(value.sessionRef, `${field}.sessionRef`);
  const runtimeId = requestString(value.runtimeId, `${field}.runtimeId`);
  const cwd = requestString(value.cwd, `${field}.cwd`);
  if (!path.isAbsolute(cwd)) throw new AgentContentReadRequestError(`${field}.cwd must be absolute`);
  return Object.freeze({ agentRef, sessionRef, runtimeId, cwd: path.resolve(cwd) });
}

async function inspectRegularTarget(root: string, target: string): Promise<void> {
  const ancestor = await resolveExistingAncestor(target);
  if (!isWithin(root, ancestor.canonical)) {
    throw new TargetPolicyError('path-escape');
  }

  const components = path.relative(root, target).split(path.sep).filter((component) => component.length > 0);
  let cursor = root;
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TargetPolicyError('target-missing');
      throw error;
    }
    if (stat.isSymbolicLink()) throw new TargetPolicyError('symlink');
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw new TargetPolicyError('not-regular-file');
    }
    if (index === components.length - 1 && !stat.isFile()) {
      throw new TargetPolicyError('not-regular-file');
    }
  }
  const realTarget = await fs.realpath(target);
  if (realTarget !== target || !isWithin(root, realTarget)) throw new TargetPolicyError('symlink');
}

function sameFileState(left: import('node:fs').BigIntStats, right: import('node:fs').BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedFile(target: string, maxBytes: number): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    const namedBefore = await fs.lstat(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !namedBefore.isFile() || namedBefore.isSymbolicLink() || !sameFileState(before, namedBefore)) {
      throw new TargetPolicyError('symlink');
    }
    if (before.size > BigInt(maxBytes)) throw new TargetPolicyError('byte-limit');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const namedAfter = await fs.lstat(target, { bigint: true });
    if (!sameFileState(before, after) || !sameFileState(after, namedAfter)) throw new TargetPolicyError('symlink');
    if (offset > maxBytes) throw new TargetPolicyError('byte-limit');
    return new Uint8Array(buffer.subarray(0, offset));
  } catch (error) {
    if (error instanceof TargetPolicyError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TargetPolicyError('target-missing');
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new TargetPolicyError('symlink');
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Independent local content-read policy engine. It reads one explicitly
 * requested file at a time; it never walks, mirrors, indexes, or parses an
 * Agent home or runtime directory.
 */
export class AgentContentReadPolicyEngine {
  private readonly policies: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>;
  private readonly capabilities: ReadonlySet<string>;
  private readonly runtimeRoots: readonly string[];
  private readonly runtimeRootCache = new Map<string, Promise<string>>();
  private readonly resolveTranscriptIdentity?: AgentContentReadPolicyEngineOptions['resolveTranscriptIdentity'];

  constructor(private readonly options: AgentContentReadPolicyEngineOptions) {
    this.policies = Object.freeze({
      workspace: normalizePolicySelection(options.policies.workspace, 'workspace'),
      transcript: normalizePolicySelection(options.policies.transcript, 'transcript'),
      artifact: normalizePolicySelection(options.policies.artifact, 'artifact'),
    });
    this.capabilities = new Set(options.capabilities);
    this.runtimeRoots = Object.freeze((options.runtimeAllowlistedRoots ?? []).map((root, index) => {
      const value = nonEmptyString(root, `contentRead.runtimeAllowlistedRoots[${index}]`);
      if (!path.isAbsolute(value)) throw new AgentContentReadPolicyError('runtime allowlisted roots must be absolute');
      return path.resolve(value);
    }));
    this.resolveTranscriptIdentity = options.resolveTranscriptIdentity;
  }

  async read(input: AgentContentReadRequest): Promise<AgentContentReadResult> {
    const request = validateRequest(input);
    const policySelection = this.policies[request.surface];
    let parsedTarget: { relativeTarget: string; segments: readonly string[] } | undefined;
    try {
      parsedTarget = parseRelativeTarget(request.relativeTarget);
    } catch (error) {
      if (error instanceof TargetPolicyError) return this.deny(request, canonicalAuditTarget(request.relativeTarget), error.reason);
      throw error;
    }
    const { relativeTarget, segments } = parsedTarget;

    if (policySelection === 'disabled') return this.deny(request, relativeTarget, 'policy-disabled');
    const policy = policySelection;
    if (request.capability !== policy.capability || !this.capabilities.has(policy.capability)) {
      return this.deny(request, relativeTarget, 'capability-missing');
    }
    if (request.policyRevision !== policy.policyRevision) {
      return this.deny(request, relativeTarget, 'policy-revision-mismatch');
    }
    if (isSensitiveTarget(segments, policy.sensitiveNames)) {
      return this.deny(request, relativeTarget, 'sensitive-name');
    }

    const root = await this.resolveRoot(policy, request);
    if (root instanceof RootPolicyError) return this.deny(request, relativeTarget, root.reason);

    if (request.surface === 'transcript') {
      const identityDecision = await this.checkTranscriptIdentity(request, policy, root);
      if (identityDecision !== undefined) return this.deny(request, relativeTarget, identityDecision);
    }

    const allowedMimes = new Set(policy.allowedMimeTypes);
    if (!allowedMimes.has(request.mimeType)) return this.deny(request, relativeTarget, 'mime-not-allowlisted');
    if (request.allowedMimeTypes !== undefined && !request.allowedMimeTypes.includes(request.mimeType)) {
      return this.deny(request, relativeTarget, 'mime-not-allowlisted');
    }
    if (request.decodeAs === 'utf8' && !policy.textMimeTypes.includes(request.mimeType)) {
      return this.deny(request, relativeTarget, 'text-not-allowlisted');
    }

    const target = path.resolve(root, ...segments);
    if (!isWithin(root, target)) return this.deny(request, relativeTarget, 'path-escape');
    try {
      await inspectRegularTarget(root, target);
    } catch (error) {
      if (error instanceof TargetPolicyError) return this.deny(request, relativeTarget, error.reason);
      throw error;
    }

    const policyLimit = request.decodeAs === 'utf8' ? Math.min(policy.maxBytes, policy.maxTextBytes) : policy.maxBytes;
    const requestedLimit = request.maxBytes === undefined ? policyLimit : request.maxBytes;
    if (requestedLimit > policyLimit) return this.deny(request, relativeTarget, 'byte-limit');
    let content: Uint8Array;
    try {
      content = await readBoundedFile(target, requestedLimit);
    } catch (error) {
      if (error instanceof TargetPolicyError) return this.deny(request, relativeTarget, error.reason);
      throw error;
    }

    let text: string | undefined;
    if (request.decodeAs === 'utf8') {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        return this.deny(request, relativeTarget, 'text-decode-failed');
      }
    }
    const contentHash = createHash('sha256').update(content).digest('hex');
    const receipt = await this.appendReceipt(request, relativeTarget, {
      decision: 'allow',
      byteCount: content.byteLength,
      contentHash,
    });
    return Object.freeze({
      decision: 'allow' as const,
      surface: request.surface,
      relativeTarget,
      mimeType: request.mimeType,
      byteCount: content.byteLength,
      contentHash,
      content,
      ...(text === undefined ? {} : { text }),
      receipt,
    });
  }

  /** Alias used by integration adapters that call the operation request. */
  async readContent(request: AgentContentReadRequest): Promise<AgentContentReadResult> {
    return this.read(request);
  }

  /** A request is one bounded read, never a directory listing or recursive mirror. */
  async request(request: AgentContentReadRequest): Promise<AgentContentReadResult> {
    return this.read(request);
  }

  private async resolveRoot(policy: AgentContentReadPolicy, request: AgentContentReadRequest): Promise<string | RootPolicyError> {
    if (policy.root.kind === 'agent-home') {
      if (this.options.agentHomeLayout === undefined) return new RootPolicyError('root-invalid');
      try {
        const resolution = await this.options.agentHomeLayout.resolve(request.agentRef);
        return resolution.canonicalHome;
      } catch {
        return new RootPolicyError('root-invalid');
      }
    }
    if (!this.runtimeRoots.includes(policy.root.root)) return new RootPolicyError('root-not-allowlisted');
    const cached = this.runtimeRootCache.get(policy.root.root);
    const promise = cached ?? this.validateRuntimeRoot(policy.root.root);
    if (cached === undefined) this.runtimeRootCache.set(policy.root.root, promise);
    try {
      return await promise;
    } catch {
      return new RootPolicyError('root-invalid');
    }
  }

  private async validateRuntimeRoot(root: string): Promise<string> {
    const ancestor = await resolveExistingAncestor(root);
    if (ancestor.tail.length > 0 || ancestor.canonical !== root) throw new RootPolicyError('root-invalid');
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RootPolicyError('root-invalid');
    return root;
  }

  private async checkTranscriptIdentity(
    request: AgentContentReadRequest,
    policy: AgentContentReadPolicy,
    root: string,
  ): Promise<AgentContentReadReason | undefined> {
    const session = request.session;
    if (session === undefined || !sameAgentRef(session.agentRef, request.agentRef) || session.cwd !== root) {
      return 'identity-mismatch';
    }
    let expected: AgentContentSessionIdentity | undefined;
    try {
      expected = policy.expectedTranscriptIdentity ?? await this.resolveTranscriptIdentity?.(request);
    } catch {
      return 'identity-mismatch';
    }
    if (expected === undefined) return 'identity-mismatch';
    try {
      const normalizedExpected = normalizeIdentity(expected, 'resolved transcript identity');
      return sameSessionIdentity(normalizedExpected, session) ? undefined : 'identity-mismatch';
    } catch {
      return 'identity-mismatch';
    }
  }

  private async deny(
    request: AgentContentReadRequest,
    relativeTarget: string,
    reason: AgentContentReadReason,
  ): Promise<AgentContentReadDenied> {
    const receipt = await this.appendReceipt(request, relativeTarget, { decision: 'deny', byteCount: 0, reason });
    return Object.freeze({ decision: 'deny', surface: request.surface, relativeTarget, reason, receipt });
  }

  private async appendReceipt(
    request: AgentContentReadRequest,
    relativeTarget: string,
    details: {
      readonly decision: AgentContentReadDecision;
      readonly byteCount: number;
      readonly contentHash?: string;
      readonly reason?: AgentContentReadReason;
    },
  ): Promise<AgentContentAuditReceipt> {
    const receipt: AgentContentAuditReceipt = Object.freeze({
      version: 1,
      requestId: request.requestId,
      actor: request.actor,
      tenantId: request.tenantId,
      deviceId: request.deviceId,
      agentRef: request.agentRef,
      surface: request.surface,
      ...(request.session === undefined ? {} : { session: request.session }),
      relativeTarget,
      policyRevision: request.policyRevision,
      byteCount: details.byteCount,
      ...(details.contentHash === undefined ? {} : { contentHash: details.contentHash }),
      decision: details.decision,
      ...(details.reason === undefined ? {} : { reason: details.reason }),
      recordedAt: new Date().toISOString(),
    });
    try {
      return await this.options.auditStore.append(receipt);
    } catch (error) {
      if (error instanceof AgentContentAuditStoreError) {
        throw new AgentContentReadAuditError('content read decision could not be durably audited', { cause: error });
      }
      throw error;
    }
  }
}

function normalizePolicySelection(
  selection: AgentContentReadPolicySelection,
  surface: AgentContentReadSurface,
): AgentContentReadPolicySelection {
  if (selection === 'disabled') return selection;
  try {
    const policy = createAgentContentReadPolicy(selection);
    if (policy.capability !== AGENT_CONTENT_READ_CAPABILITIES[surface]) {
      throw new AgentContentReadPolicyError(
        `contentRead.${surface}.capability must be ${AGENT_CONTENT_READ_CAPABILITIES[surface]}`,
      );
    }
    return policy;
  } catch (error) {
    if (error instanceof AgentContentReadPolicyError) throw error;
    throw new AgentContentReadPolicyError(`contentRead.${surface} policy is invalid`);
  }
}
