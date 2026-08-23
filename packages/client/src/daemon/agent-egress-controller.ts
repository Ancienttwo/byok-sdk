import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { AgentRef } from '../agent-home';
import {
  type AgentEgressDropReason,
  type AgentEgressDropReceipt,
  type AgentEgressLaneStatus,
  type AgentEgressPolicy,
  type AgentEgressStatus,
  metadataStatusEvent,
} from './agent-egress-policy';
import {
  AGENT_EGRESS_DIRECTORY,
  AgentLatestValueState,
  AgentReliableQuotaError,
  AgentReliableSpool,
  type AgentReliableAck,
  type AgentReliableAppendInput,
  type AgentReliableEgressRecord,
} from './agent-egress-spool';
import { sanitizeReliablePayload, type AgentEgressSanitizer } from './agent-egress-sanitizer';

export interface AgentEgressControllerOptions {
  readonly policy: Readonly<AgentEgressPolicy>;
  /** Authenticated tenant identity, never accepted from an egress event. */
  readonly tenantId?: string;
  readonly sanitizer?: AgentEgressSanitizer;
}

export interface AgentEgressProgressInput {
  readonly agentRef?: AgentRef;
  readonly taskId: string;
  readonly events: readonly AgentEvent[];
  readonly serverCapabilities: readonly string[];
}

export interface AgentEgressReliableInput {
  readonly homeDir: string;
  readonly agentRef: AgentRef;
  readonly payload: unknown;
  readonly sessionRef: string;
  readonly taskId?: string;
  readonly eventId?: string;
}

export type AgentEgressReliableAppendResult =
  | Readonly<{ ok: true; record: AgentReliableEgressRecord }>
  | Readonly<{ ok: false; reason: AgentEgressDropReason }>;

function agentKey(agentRef: AgentRef): string {
  return `${agentRef.agentId}\u0000${agentRef.profileRevision}`;
}

function emptyLane(): AgentEgressLaneStatus {
  return { pendingEvents: 0, pendingBytes: 0, replaced: 0, dropped: 0 };
}

/**
 * The one daemon-owned policy consumer. Reliable and latest-value retain
 * distinct types and stores; retries are sends, and only exact acknowledgments
 * retire durable records.
 */
export class AgentEgressController {
  private readonly latest = new AgentLatestValueState();
  private readonly spools = new Map<string, AgentReliableSpool>();
  private readonly latestStatus = emptyLane();
  private readonly reliableStatus = emptyLane();
  private readonly drops: AgentEgressDropReceipt[] = [];

  constructor(private readonly options: AgentEgressControllerOptions) {}

  get policy(): Readonly<AgentEgressPolicy> { return this.options.policy; }

  status(): AgentEgressStatus {
    const reliable = this.reliableRecords();
    return Object.freeze({
      policyRevision: this.options.policy.policyRevision,
      latestValue: Object.freeze({ ...this.latestStatus, pendingEvents: this.latest.pendingEvents, pendingBytes: this.latest.pendingBytes }),
      reliable: Object.freeze({ ...this.reliableStatus, pendingEvents: reliable.length, pendingBytes: reliable.reduce((total, record) => total + record.byteCount, 0) }),
    });
  }

  dropReceipts(): readonly AgentEgressDropReceipt[] { return Object.freeze([...this.drops]); }

  noteTransportDrop(reason: AgentEgressDropReason, agentRef?: AgentRef): void {
    this.noteDrop('latest-value', reason, agentRef);
  }

  /** Project before TaskRunner builds a `task.progress` envelope. */
  projectLatestValue(input: AgentEgressProgressInput): readonly AgentEvent[] {
    if (this.options.policy.activity.mode === 'contentful-trajectory' && !input.serverCapabilities.includes('agent-egress-policy')) {
      this.noteDrop('latest-value', 'capability_missing', input.agentRef);
      return [];
    }
    const projected = input.events.map((event) => this.options.policy.activity.mode === 'metadata-status' ? metadataStatusEvent(event) : event);
    if (input.agentRef === undefined || this.options.tenantId === undefined) return Object.freeze(projected);

    let latest: AgentEvent | undefined;
    for (const event of projected) {
      const offered = this.latest.offer({ agentRef: input.agentRef, tenantId: this.options.tenantId, event }, this.options.policy);
      if (!offered.accepted) {
        this.noteDrop('latest-value', offered.reason, input.agentRef);
        continue;
      }
      if (offered.replaced) {
        this.latestStatus.replaced += 1;
        this.noteDrop('latest-value', 'coalesced', input.agentRef, false);
      }
      latest = offered.record.event;
    }
    return latest === undefined ? [] : Object.freeze([latest]);
  }

  async appendReliable(input: AgentEgressReliableInput): Promise<AgentEgressReliableAppendResult> {
    if (this.options.tenantId === undefined) {
      this.noteDrop('reliable', 'policy_denied', input.agentRef);
      return { ok: false, reason: 'policy_denied' };
    }
    let payload: unknown;
    try {
      payload = sanitizeReliablePayload(input.payload, this.options.policy, this.options.sanitizer, {
        agentId: input.agentRef.agentId,
        tenantId: this.options.tenantId,
      });
    } catch {
      this.noteDrop('reliable', 'sanitizer_rejected', input.agentRef);
      return { ok: false, reason: 'sanitizer_rejected' };
    }
    try {
      const spool = await this.spoolFor(input.homeDir, input.agentRef);
      const record = await spool.append({
        agentRef: input.agentRef,
        tenantId: this.options.tenantId,
        policyRevision: this.options.policy.policyRevision,
        payload,
        sessionRef: input.sessionRef,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      } satisfies AgentReliableAppendInput, this.options.policy, this.tenantPendingBytes());
      return { ok: true, record };
    } catch (error) {
      const reason: AgentEgressDropReason = error instanceof AgentReliableQuotaError ? error.reason : 'backpressure';
      this.noteDrop('reliable', reason, input.agentRef);
      return { ok: false, reason };
    }
  }

  /** Retires only the record whose full Agent/tenant/revision/id/cursor tuple matches. */
  async acknowledge(ack: AgentReliableAck): Promise<boolean> {
    const spool = this.spools.get(agentKey(ack.agentRef));
    if (!spool || this.options.tenantId === undefined || ack.tenantId !== this.options.tenantId) {
      this.noteDrop('reliable', 'ack_mismatch', ack.agentRef);
      return false;
    }
    const accepted = await spool.acknowledge(ack);
    if (!accepted) this.noteDrop('reliable', 'ack_mismatch', ack.agentRef);
    return accepted;
  }

  /** Re-open every existing Agent-local spool before retrying stable records after restart. */
  async recover(agentsRoot: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(agentsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const homeDir = path.join(agentsRoot, entry.name);
      try {
        await fs.lstat(path.join(homeDir, AGENT_EGRESS_DIRECTORY));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const spool = await AgentReliableSpool.open(homeDir);
      for (const record of spool.records()) {
        if (this.options.tenantId !== undefined && record.tenantId !== this.options.tenantId) continue;
        const key = agentKey(record.agentRef);
        const existing = this.spools.get(key);
        if (existing && existing !== spool) throw new Error('multiple Agent egress spools claim the same AgentRef');
        this.spools.set(key, spool);
      }
    }
  }

  reliableRecords(): readonly AgentReliableEgressRecord[] {
    return Object.freeze(
      [...this.spools.values()]
        .flatMap((spool) => spool.records())
        .filter((record) => this.options.tenantId === undefined || record.tenantId === this.options.tenantId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.cursor - right.cursor),
    );
  }

  /** Missing ack capability holds records in their reliable lane; it never makes them lossy. */
  retryableReliableRecords(serverCapabilities: readonly string[]): readonly AgentReliableEgressRecord[] {
    if (!serverCapabilities.includes('agent-egress-reliable-ack')) {
      for (const record of this.reliableRecords()) this.noteDrop('reliable', 'capability_missing', record.agentRef);
      return [];
    }
    return this.reliableRecords();
  }

  private async spoolFor(homeDir: string, agentRef: AgentRef): Promise<AgentReliableSpool> {
    const key = agentKey(agentRef);
    const existing = this.spools.get(key);
    if (existing) return existing;
    const spool = await AgentReliableSpool.open(homeDir);
    if (spool.records().some((record) => !sameAgent(record.agentRef, agentRef))) {
      throw new Error('Agent-local reliable spool has a different AgentRef');
    }
    this.spools.set(key, spool);
    return spool;
  }

  private tenantPendingBytes(): number {
    return this.reliableRecords().reduce((total, record) => total + record.byteCount, 0);
  }

  private noteDrop(lane: 'latest-value' | 'reliable', reason: AgentEgressDropReason, agentRef?: AgentRef, countDrop = true): void {
    const laneStatus = lane === 'latest-value' ? this.latestStatus : this.reliableStatus;
    if (countDrop) laneStatus.dropped += 1;
    laneStatus.lastDropReason = reason;
    this.drops.push(Object.freeze({
      lane,
      reason,
      ...(agentRef === undefined ? {} : { agentId: agentRef.agentId }),
      ...(this.options.tenantId === undefined ? {} : { tenantId: this.options.tenantId }),
      occurredAt: new Date().toISOString(),
    }));
    if (this.drops.length > 256) this.drops.shift();
  }
}

function sameAgent(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}
