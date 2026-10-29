import { createHash, randomUUID } from 'node:crypto';
import { agentMemoryIntentOperationDigest } from '@byok-sdk/core';
import {
  AgentMemoryIntentCompletionSchema,
  AgentMemoryIntentReadbackSchema,
  AgentMemoryIntentV1Schema,
  AgentMemoryProjectionMutationSchema,
  type AgentMemoryIntentCompletion,
  type AgentMemoryIntentReadback,
  type AgentMemoryIntentV1,
  type AgentMemoryProjectionMutation,
} from '@byok-sdk/protocol';
import { HostLedger } from './ledger';
import { MemoryRestoreCoordinator, memoryRestoreBlocked, recordRestoreTerminal, type MemoryRestoreInput, type MemoryRestoreResult, type MemoryRestoreRow } from './memory-restore';
import { canonical, hash } from './model';
import type { LedgerState } from './model';
import type { AgentMemoryExport, AgentMemoryIntentTransport, AgentMemoryProjectionPort } from '@byok-sdk/protocol/agent-memory';

// Only repairable projection failures can hold an Agent queue.
export class MemoryBlockedError extends Error {}
export const RESIDENT_MEMORY_MAX_BYTES = 8 * 1024;
export function memoryRevision(text: string): string { return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`; }
export const EMPTY_MEMORY_REVISION = memoryRevision('');
type AgentRef = AgentMemoryIntentV1['agentRef'];
export interface MemoryBinding { deviceId: string; agentRef: AgentRef }
export interface MemoryApproval extends MemoryBinding {
  approvalRef: string;
  path: string;
  operation: 'replace' | 'delete';
  content?: string;
  /** Omit only after the user authorizes the possible absent-or-empty write. */
  baseRevision?: string;
  expiresAt: number;
}
export interface MemoryIntentRow {
  deviceId: string; requestHash: string; intent: AgentMemoryIntentV1;
  expiresAt: number; noticePending: boolean; releasedAt?: string; revoked?: true;
  readback?: AgentMemoryIntentReadback;
  restoreId?: string;
}
export interface ResidentProjection {
  mutation: AgentMemoryProjectionMutation;
  projectedAt: string;
  text: string | null;
  /** An applied small replacement invalidates this old display, not its ordering metadata. */
  invalidatedByIntent?: string;
  refreshTaskIds?: string[];
}
export interface MemoryState {
  restores?: Record<string, MemoryRestoreRow>;
  intents: Record<string, MemoryIntentRow>;
  approvals: Record<string, string>;
  projections: Record<string, ResidentProjection>;
}
export interface MemoryContextPack {
  residentMemory?: { text: string; projectedAt: string; mutationId: string; policyRevision: string };
}
export interface MemoryOptions {
  /** Trusted device-bound local export. Required only for explicit tree restore; never a redacted projection. */
  exportMemory?(binding: MemoryBinding): Promise<AgentMemoryExport>;
  /** Integer milliseconds, as `Date.now` returns. Pass `HostLedger.compact` the same clock. */
  now?: () => number;
  /** Resolve current placement and profile from trusted Host state on each call. */
  isCurrent(binding: MemoryBinding): boolean;
  /** Call the embedded server or cloud capability-gated enqueueAgentMemoryIntentNotice. Retry is safe. */
  notify(deviceId: string, notice: { intentId: string; agentRef: AgentRef }): Promise<unknown>;
  /** Validate the task, session, runtime, grant, policy and writer epoch before accepting a projection. */
  authorizeProjection(deviceId: string, mutation: AgentMemoryProjectionMutation): boolean;
}
function memory(state: LedgerState): MemoryState {
  return state.memory ??= { intents: {}, approvals: {}, projections: {} };
}
function bindingKey(binding: MemoryBinding): string { return hash([binding.deviceId, binding.agentRef]); }
function metadata(intent: AgentMemoryIntentV1): AgentMemoryIntentV1 {
  const { content: _, ...rest } = intent;
  return rest;
}
function sameIdentity(intent: AgentMemoryIntentV1, completion: AgentMemoryIntentCompletion): boolean {
  return intent.intentId === completion.intentId && canonical(intent.agentRef) === canonical(completion.agentRef)
    && intent.path === completion.path && intent.operation === completion.operation && intent.operationDigest === completion.operationDigest;
}

/** Host memory authority over the execution ledger. Public commands require authenticated Host approval. */
export class HostMemoryPage {
  private readonly listeners = new Set<(binding: MemoryBinding) => Promise<void>>();
  onChange(listener: (binding: MemoryBinding) => Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private async changed(binding: MemoryBinding): Promise<void> {
    for (const listener of this.listeners) await listener(binding);
  }
  private readonly restores: MemoryRestoreCoordinator;
  private readonly executionLedgers = new Set<HostLedger>();
  /** Core composition guard: restore must inspect the very same transactional execution state. */
  bindExecutionLedger(ledger: HostLedger): () => void {
    if (this.options.exportMemory && ledger !== this.ledger) throw new Error('Memory restore requires the same HostLedger instance as execution');
    this.executionLedgers.add(ledger);
    return () => { this.executionLedgers.delete(ledger); };
  }
  private assertRestoreLedger(): void {
    if ([...this.executionLedgers].some(ledger => ledger !== this.ledger)) throw new Error('Memory restore requires the same HostLedger instance as execution');
  }
  constructor(readonly ledger: HostLedger, private readonly options: MemoryOptions) {
    this.restores = new MemoryRestoreCoordinator(ledger, options, input => this.prepare(input));
  }
  async restore(input: MemoryRestoreInput): Promise<MemoryRestoreResult> {
    this.assertRestoreLedger();
    const result = await this.restores.restore(input);
    await this.changed(input);
    return result;
  }
  restoreResult(binding: MemoryBinding, restoreId: string): MemoryRestoreResult | undefined { return this.restores.read(binding, restoreId); }
  async cancelRestore(binding: MemoryBinding, restoreId: string): Promise<MemoryRestoreResult> {
    const result = this.restores.cancel(binding, restoreId); await this.changed(binding); return result;
  }
  /** Call before core.recover at Host startup, then flushNotices; same restore identity resumes safely. */
  async recoverRestores(): Promise<void> { this.assertRestoreLedger(); await this.restores.recover(); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  intent(intentId: string): MemoryIntentRow | undefined { return this.ledger.snapshot().memory?.intents[intentId]; }

  /** This is a write, including when baseRevision is omitted. It is never a read probe. */
  async approve(input: MemoryApproval): Promise<MemoryIntentRow> {
    input = structuredClone(input);
    if (!this.options.isCurrent(input)) throw new Error('Memory placement or profile changed');
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now()) throw new Error('Memory approval expired');
    if (input.operation === 'replace' && input.content === undefined || input.operation === 'delete' && input.content !== undefined) throw new Error('Invalid memory operation body');
    const prepared = await this.prepare(input);
    const { requestHash, intent } = prepared;
    const approvalKey = hash([input.deviceId, input.approvalRef]);
    return this.ledger.transaction(state => {
      if (!this.options.isCurrent(input) || input.expiresAt <= this.now()) throw new Error('Memory approval no longer current');
      if (memoryRestoreBlocked(state, input)) throw new MemoryBlockedError('Memory restore in progress');
      const store = memory(state);
      const previousId = store.approvals[approvalKey];
      if (previousId) {
        const previous = store.intents[previousId]!;
        if (previous.requestHash !== requestHash) throw new Error('Memory approval identity conflict');
        return previous;
      }
      // A compacted row answers replays from its retired copy until that copy expires.
      const retired = this.ledger.retiredMemoryIntent('approval', approvalKey, this.now());
      if (retired) {
        if (retired.requestHash !== requestHash) throw new Error('Memory approval identity conflict');
        return retired;
      }
      const row = prepared;
      store.intents[intent.intentId] = row;
      store.approvals[approvalKey] = intent.intentId;
      return row;
    });
  }
  private async prepare(input: MemoryApproval): Promise<MemoryIntentRow> {
    const requestHash = hash(input);
    const candidate = { intentId: randomUUID(), agentRef: input.agentRef, path: input.path, operation: input.operation,
      baseRevision: input.baseRevision ?? EMPTY_MEMORY_REVISION,
      targetRevision: input.operation === 'replace' ? memoryRevision(input.content!) : null,
      ...(input.content === undefined ? {} : { content: input.content }), approvalRef: input.approvalRef };
    const intent = AgentMemoryIntentV1Schema.parse({ ...candidate,
      operationDigest: await agentMemoryIntentOperationDigest({ ...candidate, tenantId: this.ledger.tenant, deviceId: input.deviceId }),
    });
    return { deviceId: input.deviceId, requestHash, intent, expiresAt: input.expiresAt, noticePending: true };
  }
  revoke(intentId: string): void {
    this.ledger.transaction(state => {
      const row = memory(state).intents[intentId];
      if (!row) throw new Error('Memory intent not found');
      if (!row.readback) row.revoked = true;
    });
  }
  async flushNotices(): Promise<void> {
    const failures: unknown[] = [];
    for (const row of Object.values(this.ledger.snapshot().memory?.intents ?? {})) {
      if (!row.noticePending || row.readback) continue;
      try {
        await this.options.notify(row.deviceId, { intentId: row.intent.intentId, agentRef: row.intent.agentRef });
        // Compaction can remove a row that settled while its notice was in flight.
        this.ledger.transaction(state => { const live = memory(state).intents[row.intent.intentId]; if (live) live.noticePending = false; });
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Memory notice delivery failed; pending intents retained');
  }
  /** Bind a new core submission to the pending refresh before the SDK can execute it. */
  refreshExecution(binding: MemoryBinding, taskId: string): void {
    this.ledger.transaction(state => {
      const projection = memory(state).projections[bindingKey(binding)];
      if (!projection?.invalidatedByIntent) return;
      const tasks = projection.refreshTaskIds ??= [];
      if (!tasks.includes(taskId)) tasks.push(taskId);
    });
  }
  /** Bind this adapter to the authenticated device. Do not take identity from a request body. */
  transport(deviceId: string): AgentMemoryIntentTransport {
    return {
      fetch: async request => {
        const answer = this.ledger.transaction(state => {
        const row = memory(state).intents[request.intentId] ?? this.ledger.retiredMemoryIntent('intent', request.intentId, this.now());
        if (!row || row.deviceId !== deviceId || canonical(row.intent.agentRef) !== canonical(request.agentRef)) throw new Error('Memory intent identity mismatch');
        if (row.readback) return { disposition: 'terminal', intent: metadata(row.intent), readback: row.readback };
        if (request.reservation === 'none') return { disposition: 'deferred', intent: metadata(row.intent) };
        if (request.reservation !== 'held') throw new Error('Invalid memory reservation');
        const code = row.revoked ? 'intent_revoked' : this.now() >= row.expiresAt ? 'intent_expired'
          : !this.options.isCurrent({ deviceId, agentRef: row.intent.agentRef }) ? 'placement_changed' : undefined;
        if (code) {
          this.record(state, row, { ...this.identity(row.intent), outcome: 'rejected', code }, 'host_terminal');
          return { disposition: 'terminal', intent: metadata(row.intent), readback: row.readback };
        }
        row.releasedAt ??= new Date(this.now()).toISOString();
        return { disposition: 'release', intent: row.intent };
        });
        if (this.intent(request.intentId)?.restoreId && answer.disposition === 'terminal') await this.changed({ deviceId, agentRef: answer.intent.agentRef });
        return answer;
      },
      complete: async value => {
        const completion = AgentMemoryIntentCompletionSchema.parse(value);
        const readback = this.ledger.transaction(state => {
          // A retired copy always holds a readback, so it takes only the terminal branch below.
          const row = memory(state).intents[completion.intentId] ?? this.ledger.retiredMemoryIntent('intent', completion.intentId, this.now());
          if (!row || row.deviceId !== deviceId || !sameIdentity(row.intent, completion)) throw new Error('Memory completion identity mismatch');
          if (row.readback) return { ...row.readback, disposition: row.readback.disposition === 'host_terminal' ? 'host_terminal'
            : canonical(row.readback.completion) === canonical(completion) ? 'idempotent' : 'conflict' };
          if (!row.releasedAt) throw new Error('Memory intent was not released');
          if (completion.outcome === 'applied' && (row.intent.operation === 'replace'
            ? !completion.result.exists || completion.result.revision !== row.intent.targetRevision
            : completion.result.exists || completion.result.revision !== EMPTY_MEMORY_REVISION)) throw new Error('Memory applied result mismatch');
          this.record(state, row, completion, 'recorded');
          return row.readback!;
        });
        if (this.intent(readback.intentId)?.restoreId || readback.completion.outcome === 'applied' && readback.completion.path === 'MEMORY.md') {
          await this.changed({ deviceId, agentRef: readback.completion.agentRef });
        }
        return readback;
      },
    };
  }
  private identity(intent: AgentMemoryIntentV1) {
    const { intentId, agentRef, path, operation, operationDigest } = intent;
    return { intentId, agentRef, path, operation, operationDigest };
  }
  private record(state: LedgerState, row: MemoryIntentRow, completion: AgentMemoryIntentCompletion, disposition: 'recorded' | 'host_terminal'): void {
    row.readback = AgentMemoryIntentReadbackSchema.parse({ tenantId: this.ledger.tenant, deviceId: row.deviceId,
      intentId: row.intent.intentId, disposition, completion, recordedAt: new Date(this.now()).toISOString() });
    if (completion.outcome === 'applied' && row.intent.path === 'MEMORY.md' && row.intent.operation === 'replace'
      && row.intent.content !== undefined && Buffer.byteLength(row.intent.content, 'utf8') <= RESIDENT_MEMORY_MAX_BYTES) {
      const prior = memory(state).projections[bindingKey({ deviceId: row.deviceId, agentRef: row.intent.agentRef })];
      if (prior) { prior.invalidatedByIntent = row.intent.intentId; delete prior.refreshTaskIds; }
    }
    row.intent = metadata(row.intent); // Purge pending content in the terminal commit.
    row.noticePending = false;
    recordRestoreTerminal(state, row);
  }

  /** Host-owned opaque profile: {residentMemory: policyApprovedText | null}. It conveys no edit proof. */
  projectionPort(deviceId: string): AgentMemoryProjectionPort {
    return { publish: async ({ mutation: value }) => {
      const mutation = AgentMemoryProjectionMutationSchema.parse(value);
      if (!this.options.isCurrent({ deviceId, agentRef: mutation.agentRef }) || !this.options.authorizeProjection(deviceId, mutation)) throw new Error('Memory projection not authorized');
      const bytes = Buffer.from(mutation.snapshot.redactedBytes, 'base64url');
      if (memoryRevisionBytes(bytes) !== mutation.snapshot.redactedHash) throw new Error('Memory projection hash mismatch');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const body: unknown = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'residentMemory'
        || !('residentMemory' in body) || body.residentMemory !== null && typeof body.residentMemory !== 'string'
        || typeof body.residentMemory === 'string' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body.residentMemory)) throw new Error('Invalid resident memory profile');
      const resident = body.residentMemory as string | null;
      const result = this.ledger.transaction(state => {
        const projections = memory(state).projections;
        const key = bindingKey({ deviceId, agentRef: mutation.agentRef });
        const prior = projections[key];
        if (prior) {
          const previous = prior.mutation;
          if (previous.mutationId === mutation.mutationId) {
            if (canonical(previous) !== canonical(mutation)) throw new Error('Memory projection identity conflict');
            return { accepted: true };
          }
          if (mutation.writerEpoch < previous.writerEpoch || mutation.writerEpoch === previous.writerEpoch && mutation.sourceSeq <= previous.sourceSeq) throw new Error('Stale memory projection');
        }
        const pending = prior?.invalidatedByIntent && !prior.refreshTaskIds?.includes(mutation.taskId)
          ? { invalidatedByIntent: prior.invalidatedByIntent, refreshTaskIds: prior.refreshTaskIds } : {};
        projections[key] = { mutation, text: resident, projectedAt: new Date(this.now()).toISOString(), ...pending };
        return { accepted: true };
      });
      await this.changed({ deviceId, agentRef: mutation.agentRef });
      return result;
    } };
  }
  contextPack(binding: MemoryBinding): MemoryContextPack {
    if (!this.options.isCurrent(binding)) throw new Error('Memory placement or profile changed');
    const state = this.ledger.snapshot();
    if (memoryRestoreBlocked(state, binding)) throw new MemoryBlockedError('Memory restore in progress');
    const projection = state.memory?.projections[bindingKey(binding)];
    if (!projection || projection.text === null || projection.invalidatedByIntent) return {};
    if (!this.options.authorizeProjection(binding.deviceId, projection.mutation)) throw new MemoryBlockedError('Memory projection no longer authorized');
    if (Buffer.byteLength(projection.text, 'utf8') > RESIDENT_MEMORY_MAX_BYTES) throw new MemoryBlockedError('Memory blocked: MEMORY.md exceeds 8 KiB. Reduce its size.');
    return { residentMemory: { text: projection.text, projectedAt: projection.projectedAt,
      mutationId: projection.mutation.mutationId, policyRevision: projection.mutation.policyRevision } };
  }
}
function memoryRevisionBytes(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
