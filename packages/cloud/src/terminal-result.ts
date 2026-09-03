import {
  decodeEnvelope,
  type AgentRef,
  type BlobRef,
  type Envelope,
  type TerminalInferenceUsage,
} from '@byok-sdk/protocol';
import { ByokCloudError } from './errors';
import type { RequestReceipt } from './stores/ports';

/**
 * The typed terminal read model — the hosted counterpart of the embedded
 * coordinator's `TaskResult`, projected off the receipt the inbound gate
 * stores. Every field is copied verbatim from the payload the gate already
 * zod-parsed before storing (`recordTerminal`, `inbound.ts`); this projection
 * neither re-validates nor synthesizes one.
 */
export interface TerminalResult {
  readonly taskId: string;
  readonly state: 'complete' | 'failed' | 'cancelled';
  /** Exact Agent identity echoed by the winning terminal, when Agent-bound. */
  readonly agentRef?: AgentRef;
  readonly summary?: string;
  readonly sessionRef?: string;
  readonly artifactRefs?: readonly BlobRef[];
  /**
   * The product's structured terminal result, verbatim `task.complete.document`.
   * Absent — key missing, never null — when the daemon sent none, which covers
   * both a legacy pre-`result-document` build and a daemon with no
   * `resultDocument` extractor.
   */
  readonly document?: unknown;
  /**
   * Device/runtime terminal observation copied from the canonical winning
   * receipt. It is telemetry only — never cloud storage usage, billing, quota
   * or entitlement authority.
   */
  readonly usage?: TerminalInferenceUsage;
  readonly reason?: string;
  /** Terminal cause projection; currently the protocol's terminal reason. */
  readonly terminalCause?: string;
  readonly retryable?: boolean;
  /** When the receipt store wrote the terminal fact — the first one, by its own first-write-wins rule. */
  readonly recordedAt: string;
}

/**
 * Pure projection of a terminal receipt onto {@link TerminalResult}. `taskId`
 * names the task the receipt was read for (the receipt's key carries it, its
 * body does not); `recordedAt` is the receipt store's write time.
 *
 * Fail closed on anything but a terminal envelope: the stored body is
 * `encodeEnvelope` of what the inbound gate accepted, so an undecodable body
 * or a non-terminal type means the receipt-store contract itself broke — an
 * error, never a best-effort shape.
 */
export function projectTerminalResult(taskId: string, receipt: RequestReceipt): TerminalResult {
  let envelope: Envelope;
  try {
    envelope = decodeEnvelope(receipt.body);
  } catch (cause) {
    throw new ByokCloudError(
      'terminal_receipt_unreadable',
      `The terminal receipt for task ${taskId} holds a body that is not a decodable envelope.`,
      { cause },
    );
  }
  switch (envelope.type) {
    case 'task.complete':
      return {
        taskId,
        state: 'complete',
        ...(envelope.payload.agentRef === undefined ? {} : { agentRef: envelope.payload.agentRef }),
        summary: envelope.payload.summary,
        sessionRef: envelope.payload.sessionRef,
        ...(envelope.payload.artifactRefs !== undefined
          ? { artifactRefs: envelope.payload.artifactRefs }
          : {}),
        ...(envelope.payload.document !== undefined ? { document: envelope.payload.document } : {}),
        ...(envelope.payload.usage !== undefined ? { usage: envelope.payload.usage } : {}),
        recordedAt: receipt.recordedAt,
      };
    case 'task.fail':
      return {
        taskId,
        state: 'failed',
        ...(envelope.payload.agentRef === undefined ? {} : { agentRef: envelope.payload.agentRef }),
        reason: envelope.payload.reason,
        terminalCause: envelope.payload.reason,
        ...(envelope.payload.retryable !== undefined
          ? { retryable: envelope.payload.retryable }
          : {}),
        ...(envelope.payload.usage !== undefined ? { usage: envelope.payload.usage } : {}),
        recordedAt: receipt.recordedAt,
      };
    // `task.decline` is the pre-claim terminal (§3.2, `Offered -> Failed`).
    // It projects onto the same `failed` state as `task.fail` — there is no
    // separate declined state — and carries the device's own `retryable`
    // verbatim, exactly like `task.fail` does; this projection never decides
    // that a decline is retryable on the device's behalf.
    case 'task.decline':
      return {
        taskId,
        state: 'failed',
        ...(envelope.payload.agentRef === undefined ? {} : { agentRef: envelope.payload.agentRef }),
        reason: envelope.payload.reason,
        terminalCause: envelope.payload.reason,
        ...(envelope.payload.retryable !== undefined
          ? { retryable: envelope.payload.retryable }
          : {}),
        recordedAt: receipt.recordedAt,
      };
    case 'task.cancelled':
      return {
        taskId,
        state: 'cancelled',
        ...(envelope.payload.agentRef === undefined ? {} : { agentRef: envelope.payload.agentRef }),
        ...(envelope.payload.reason !== undefined ? { reason: envelope.payload.reason } : {}),
        ...(envelope.payload.reason === undefined ? {} : { terminalCause: envelope.payload.reason }),
        ...(envelope.payload.usage !== undefined ? { usage: envelope.payload.usage } : {}),
        recordedAt: receipt.recordedAt,
      };
    default:
      throw new ByokCloudError(
        'terminal_receipt_unreadable',
        `The terminal receipt for task ${taskId} holds a ${envelope.type} envelope, which is not a terminal type.`,
      );
  }
}
