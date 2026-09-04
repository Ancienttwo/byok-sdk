import { tenantKey, type Clock, type TenantId } from '@byok-sdk/core';
import { agentReliabilityKey } from '../../agent-reliability';
import type { AgentEgressRecord, AgentEgressStore } from '../ports';

/** Reference egress fact store. Duplicate event ids return, never overwrite, the first receipt. */
export class InMemoryAgentEgressStore implements AgentEgressStore {
  readonly #records = new Map<string, AgentEgressRecord>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async record(
    tenant: TenantId,
    input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>,
  ): Promise<{ readonly record: AgentEgressRecord; readonly created: boolean }> {
    const key = tenantKey(
      tenant,
      agentReliabilityKey('agent-egress', input.deviceId, input.payload.agentRef, input.payload.eventId),
    );
    const existing = this.#records.get(key);
    if (existing !== undefined) return { record: existing, created: false };
    const record: AgentEgressRecord = {
      tenantId: tenant,
      deviceId: input.deviceId,
      payload: input.payload,
      receiptId: input.receiptId,
      recordedAt: this.#clock.now().toISOString(),
    };
    this.#records.set(key, record);
    return { record, created: true };
  }

  async get(
    tenant: TenantId,
    deviceId: string,
    agentRef: AgentEgressRecord['payload']['agentRef'],
    eventId: string,
  ): Promise<AgentEgressRecord | undefined> {
    return this.#records.get(tenantKey(tenant, agentReliabilityKey('agent-egress', deviceId, agentRef, eventId)));
  }
}
