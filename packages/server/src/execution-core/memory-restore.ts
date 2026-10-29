import { AgentRefSchema, validateAgentMemoryPath, type AgentMemoryExport, type AgentMemoryFile } from '@byok-sdk/protocol';
import { AGENT_MEMORY_MAX_SNAPSHOT_BYTES, AGENT_MEMORY_MAX_SNAPSHOT_FILES } from '@byok-sdk/protocol/constants';
import { HostLedger } from './ledger';
import { canonical, hash, type LedgerState } from './model';
import type { MemoryApproval, MemoryBinding, MemoryIntentRow, MemoryOptions } from './memory';
import { createHash } from 'node:crypto';

export interface MemoryRestoreInput extends MemoryBinding {
  restoreId: string;
  files: readonly AgentMemoryFile[];
  mode: 'initial' | 'overwrite';
  /** Exact export the user approved overwriting; never automatically refreshed. */
  observed?: AgentMemoryExport;
  expiresAt: number;
}
export interface MemoryRestoreFileResult {
  path: string; operation: 'replace' | 'delete'; intentId?: string;
  outcome: 'pending' | 'unchanged' | 'applied' | 'conflict' | 'rejected' | 'uncertain';
}
export interface MemoryRestoreResult extends MemoryBinding {
  restoreId: string;
  status: 'preparing' | 'applying' | 'applied' | 'conflict' | 'rejected' | 'uncertain' | 'cancelled';
  files: MemoryRestoreFileResult[];
}
export interface MemoryRestoreRow extends MemoryRestoreResult {
  requestHash: string;
  /** Purged atomically once intent rows own the pending bodies. */
  request?: MemoryRestoreInput;
}
const active = (row: MemoryRestoreRow) => row.status === 'preparing' || row.status === 'applying';
const key = (binding: MemoryBinding, restoreId: string) => hash([binding.deviceId, restoreId]);
const sameHome = (a: MemoryBinding, b: MemoryBinding) => a.deviceId === b.deviceId && a.agentRef.agentId === b.agentRef.agentId;
const revision = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const EMPTY = revision('');
function store(state: LedgerState) {
  const memory = state.memory ??= { intents: {}, approvals: {}, projections: {} };
  return memory.restores ??= {};
}
export function memoryRestoreBlocked(state: LedgerState, binding: MemoryBinding): boolean {
  return Object.values(state.memory?.restores ?? {}).some(row => active(row) && sameHome(row, binding));
}
function result(row: MemoryRestoreRow): MemoryRestoreResult {
  const { request: _, requestHash: __, ...value } = row;
  return structuredClone(value);
}
function tree(files: readonly AgentMemoryFile[]): string {
  return revision(JSON.stringify(['byok-agent-memory-export.v1', files.map(file => [file.path, file.revision, file.byteCount])]));
}
function validateFiles(value: readonly AgentMemoryFile[]): AgentMemoryFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > AGENT_MEMORY_MAX_SNAPSHOT_FILES) throw new Error('Invalid restore file count');
  const seen = new Set<string>(); let bytes = 0;
  const files = value.map(file => {
    const path = validateAgentMemoryPath(file.path);
    if (seen.has(path) || typeof file.content !== 'string' || Buffer.from(file.content).toString('utf8') !== file.content
      || file.byteCount !== Buffer.byteLength(file.content) || file.byteCount > 256 * 1024 || file.revision !== revision(file.content)) throw new Error('Invalid restore file');
    seen.add(path); bytes += file.byteCount;
    return { path, content: file.content, revision: file.revision, byteCount: file.byteCount };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!seen.has('MEMORY.md') || bytes > AGENT_MEMORY_MAX_SNAPSHOT_BYTES) throw new Error('Invalid complete restore tree');
  return files;
}
function observed(value: AgentMemoryExport, binding: MemoryBinding): AgentMemoryFile[] {
  if (!value || canonical(value.requestedAgentRef) !== canonical(binding.agentRef)
    || value.appliedProfileRevision !== undefined && value.appliedProfileRevision !== binding.agentRef.profileRevision) throw new Error('Restore observation identity mismatch');
  const files = validateFiles(value.files);
  if (value.totalBytes !== files.reduce((sum, file) => sum + file.byteCount, 0) || value.snapshotDigest !== tree(files)) throw new Error('Restore observation digest mismatch');
  return files;
}
export function recordRestoreTerminal(state: LedgerState, intent: MemoryIntentRow): void {
  if (!intent.restoreId) return;
  const row = store(state)[key({ deviceId: intent.deviceId, agentRef: intent.intent.agentRef }, intent.restoreId)];
  if (!row || row.status !== 'applying') return;
  for (const file of row.files) {
    if (file.intentId) file.outcome = state.memory!.intents[file.intentId]!.readback?.completion.outcome ?? 'pending';
  }
  if (row.files.some(file => file.outcome === 'pending')) return;
  row.status = row.files.some(file => file.outcome === 'uncertain') ? 'uncertain'
    : row.files.some(file => file.outcome === 'conflict') ? 'conflict'
    : row.files.some(file => file.outcome === 'rejected') ? 'rejected' : 'applied';
}

/** K4-only durable queue exclusion. This is resumable per-file CAS, not a tree transaction. */
export class MemoryRestoreCoordinator {
  constructor(private readonly ledger: HostLedger, private readonly options: MemoryOptions,
    private readonly prepare: (input: MemoryApproval) => Promise<MemoryIntentRow>) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  read(binding: MemoryBinding, restoreId: string): MemoryRestoreResult | undefined {
    const row = this.ledger.snapshot().memory?.restores?.[key(binding, restoreId)];
    if (row && canonical(row.agentRef) !== canonical(binding.agentRef)) throw new Error('Restore identity mismatch');
    return row && result(row);
  }
  async restore(input: MemoryRestoreInput): Promise<MemoryRestoreResult> {
    input = structuredClone(input);
    input.agentRef = AgentRefSchema.parse(input.agentRef);
    if (typeof input.deviceId !== 'string' || !input.deviceId.trim()) throw new Error('Invalid restore device');
    if (!this.options.exportMemory) throw new Error('Task-free memory export is not configured');
    if (!input.restoreId?.trim() || input.restoreId.length > 256 || !Number.isSafeInteger(input.expiresAt)
      || !['initial', 'overwrite'].includes(input.mode) || !this.options.isCurrent(input)) throw new Error('Invalid restore identity or policy');
    input.files = validateFiles(input.files);
    if (input.mode === 'overwrite') observed(input.observed!, input);
    else if (input.observed !== undefined) throw new Error('Initial restore does not accept overwrite authority');
    const requestHash = hash(input); const id = key(input, input.restoreId);
    const row = this.ledger.transaction(state => {
      const rows = store(state); const prior = rows[id];
      if (prior) { if (prior.requestHash !== requestHash) throw new Error('Restore identity conflict'); return prior; }
      if (input.expiresAt <= this.now()) throw new Error('Restore approval expired');
      if (memoryRestoreBlocked(state, input) || Object.values(state.memory!.intents).some(row => !row.readback && sameHome({ deviceId: row.deviceId, agentRef: row.intent.agentRef }, input))
        || Object.values(state.intents).some(row => !row.conclusion && row.phase === 'inflight' && sameHome({ deviceId: row.execution.deviceId, agentRef: row.execution.payload.agentRef }, input))) throw new Error('Memory restore busy');
      return rows[id] = { deviceId: input.deviceId, agentRef: input.agentRef, restoreId: input.restoreId,
        requestHash, request: input, status: 'preparing', files: [] };
    });
    if (row.status !== 'preparing') return result(row);
    return this.resume(id);
  }
  private async resume(id: string): Promise<MemoryRestoreResult> {
    const row = this.ledger.snapshot().memory!.restores![id]!;
    if (row.status !== 'preparing') return result(row);
    const input = row.request!;
    if (!this.options.exportMemory) throw new Error('Task-free memory export is not configured');
    if (!this.options.isCurrent(input) || input.expiresAt <= this.now()) {
      return this.ledger.transaction(state => {
        const live = store(state)[id]!;
        if (live.status === 'preparing') { live.status = 'rejected'; delete live.request; }
        return result(live);
      });
    }
    const exported = await this.options.exportMemory({ deviceId: input.deviceId, agentRef: input.agentRef });
    const current = observed(exported, input);
    const bases = input.mode === 'overwrite' ? observed(input.observed!, input) : current;
    const conflict = input.mode === 'initial'
      ? current.some(file => file.path !== 'MEMORY.md' || file.byteCount !== 0)
      : tree(current) !== tree(bases);
    const candidates: MemoryIntentRow[] = []; const files: MemoryRestoreFileResult[] = [];
    if (!conflict) {
      const target = new Map(input.files.map(file => [file.path, file]));
      const previous = new Map(bases.map(file => [file.path, file]));
      const paths = [...new Set([...target.keys(), ...previous.keys()])].sort();
      for (const path of paths) {
        const next = target.get(path); const before = previous.get(path);
        const operation = next ? 'replace' : 'delete';
        if (next && before?.revision === next.revision) { files.push({ path, operation, outcome: 'unchanged' }); continue; }
        const candidate = await this.prepare({ deviceId: input.deviceId, agentRef: input.agentRef,
          approvalRef: `restore:${hash([input.deviceId, input.restoreId, path])}`,
          path, operation, ...(next ? { content: next.content } : {}),
          baseRevision: before?.revision ?? EMPTY, expiresAt: input.expiresAt });
        candidate.restoreId = input.restoreId; candidates.push(candidate);
        files.push({ path, operation, intentId: candidate.intent.intentId, outcome: 'pending' });
      }
    }
    return this.ledger.transaction(state => {
      const live = store(state)[id]!;
      // A cancellation or competing same-id resume may finish while export/digest awaits.
      if (live.status !== 'preparing') return result(live);
      if (!this.options.isCurrent(input) || input.expiresAt <= this.now()) {
        live.status = 'rejected'; delete live.request; return result(live);
      }
      if (conflict) {
        live.status = 'conflict';
        live.files = input.files.map(file => ({ path: file.path, operation: 'replace', outcome: 'conflict' }));
      } else {
        for (const candidate of candidates) {
          const approval = hash([candidate.deviceId, candidate.intent.approvalRef]);
          if (state.memory!.approvals[approval]) throw new Error('Restore approval identity already exists');
          state.memory!.intents[candidate.intent.intentId] = candidate;
          state.memory!.approvals[approval] = candidate.intent.intentId;
        }
        live.files = files; live.status = candidates.length ? 'applying' : 'applied';
      }
      delete live.request;
      return result(live);
    });
  }
  cancel(binding: MemoryBinding, restoreId: string): MemoryRestoreResult {
    return this.ledger.transaction(state => {
      const row = store(state)[key(binding, restoreId)];
      if (!row || canonical(row.agentRef) !== canonical(binding.agentRef)) throw new Error('Restore not found');
      if (row.status === 'applying') throw new Error('Committed restore cannot be cancelled or rolled back');
      if (row.status === 'preparing') { row.status = 'cancelled'; delete row.request; }
      return result(row);
    });
  }
  async recover(): Promise<void> {
    for (const [id, row] of Object.entries(this.ledger.snapshot().memory?.restores ?? {})) {
      if (row.status === 'preparing') await this.resume(id);
    }
  }
}
