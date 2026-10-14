import type { OutboundRefusalReason } from '@byok-sdk/protocol';

export interface OutboundRejection {
  readonly envelopeId: string;
  readonly type: string;
  readonly taskId?: string;
  readonly reason: OutboundRefusalReason;
  readonly terminal: boolean;
}

/** Counts for this daemon run; payload bytes are never part of this projection. */
export interface OutboundStatus {
  accepted: number;
  duplicate: number;
  rejected: number;
  rejectedByReason: Partial<Record<OutboundRefusalReason, number>>;
  rejectedTerminals: number;
  lastRejection?: OutboundRejection;
}
