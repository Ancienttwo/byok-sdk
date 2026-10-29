import { tenantKey, type Clock, type TenantId } from '@byok-sdk/core';
import type { AgentMessageDraftStore, AgentMessageDraftRow, AgentMessageDraftApplyInput, AgentMessageDraftApplyResult } from '../../agent-message-draft';
import { DEFAULT_ACTIVITY_TTL_MS } from '../../coordination';

const ROWS = new WeakMap<InMemoryAgentMessageDraftStore, Map<string, AgentMessageDraftRow>>();

/** Deletes the task's draft for the Host task archive (#1120); returns the rows removed. */
export function deleteAgentMessageDraft(store: InMemoryAgentMessageDraftStore, tenant: TenantId, taskId: string): number {
  return ROWS.get(store)!.delete(tenantKey(tenant, taskId)) ? 1 : 0;
}

export class InMemoryAgentMessageDraftStore implements AgentMessageDraftStore {
  readonly #rows = new Map<string, AgentMessageDraftRow>();
  constructor(private readonly clock: Clock) {
    ROWS.set(this, this.#rows);
  }

  async apply(tenant: TenantId, input: AgentMessageDraftApplyInput): Promise<AgentMessageDraftApplyResult> {
    const key = tenantKey(tenant, input.taskId);
    let row = this.#rows.get(key);
    if (row !== undefined && row.expiresAt <= input.now) row = undefined;
    if (row === undefined || input.revision > row.revision) {
      if (input.offset !== 0) return 'gap';
      row = { taskId: input.taskId, deviceId: input.deviceId, agentRef: { ...input.agentRef }, revision: input.revision,
        text: '', byteCount: 0, state: 'open', updatedAt: input.now,
        expiresAt: new Date(Date.parse(input.now) + DEFAULT_ACTIVITY_TTL_MS).toISOString() };
    } else {
      if (input.revision < row.revision || input.offset < row.byteCount) return 'stale';
      if (row.state !== 'open') return row.state;
      if (input.offset > row.byteCount) {
        this.#rows.set(key, { ...row, state: 'gap' });
        return 'gap';
      }
    }
    const byteCount = row.byteCount + new TextEncoder().encode(input.text).byteLength;
    if (byteCount > input.maxBytes) {
      this.#rows.set(key, { ...row, state: 'overflow' });
      return 'overflow';
    }
    this.#rows.set(key, { ...row, text: row.text + input.text, byteCount,
      state: input.overflow ? 'overflow' : 'open', updatedAt: input.now,
      expiresAt: new Date(Date.parse(input.now) + DEFAULT_ACTIVITY_TTL_MS).toISOString() });
    return 'applied';
  }

  async read(tenant: TenantId, taskId: string): Promise<AgentMessageDraftRow | undefined> {
    const row = this.#rows.get(tenantKey(tenant, taskId));
    return row === undefined || row.expiresAt <= this.clock.now().toISOString() ? undefined : structuredClone(row);
  }
  async delete(tenant: TenantId, taskId: string): Promise<void> {
    this.#rows.delete(tenantKey(tenant, taskId));
  }
  async sweepExpired(now: string): Promise<void> {
    for (const [key, row] of this.#rows) if (row.expiresAt <= now) this.#rows.delete(key);
  }
}
