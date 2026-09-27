import {
  ProviderProvisioningReadbackSchema,
  type ProviderProvisioningAvailablePayload,
  type ProviderProvisioningReadback,
} from '@byok-sdk/protocol';

/** Exactly what the daemon hands the Host for one `provider.provisioning.available` notice. */
export interface ProviderProvisioningNotice {
  readonly requestId: string;
}

/**
 * Host-injected consumer of `provider.provisioning.available`.
 *
 * The SDK never sees the sealed request: the Host fetches it over its own
 * device-authenticated route, opens and applies it locally, reports the
 * credential-free completion, and resolves with the Host's DURABLE terminal
 * readback for that request. Only then does the daemon acknowledge the notice.
 *
 * A deterministic end state — applied, rejected, expired, sealing key rotated,
 * or a conflicting stored result — MUST be returned as a readback, never
 * thrown: a thrown error keeps the mailbox row and the cursor behind it, which
 * is correct only for transport or otherwise unknown failures that a
 * redelivery can still change.
 */
export type ProviderProvisioningHandler = (notice: ProviderProvisioningNotice) => Promise<ProviderProvisioningReadback>;

/**
 * Closed reasons a provisioning notice is left un-acknowledged. Nothing else
 * about the failure crosses the processor boundary.
 */
export const PROVIDER_PROVISIONING_NOTICE_FAILURE_REASONS = [
  'handler_unconfigured',
  'handler_failed',
  'readback_invalid',
  'readback_mismatch',
] as const;
export type ProviderProvisioningNoticeFailureReason = (typeof PROVIDER_PROVISIONING_NOTICE_FAILURE_REASONS)[number];

/**
 * The only error the provisioning processor throws.
 *
 * The Host handler runs next to credential bytes (sealed fetch, HPKE open, OS
 * credential store), so anything it throws or returns is untrusted for logging.
 * This error therefore carries a fixed message built from a closed reason and
 * the non-secret request id, NO `cause`, and no own enumerable properties: the
 * original error, its message, nested causes, attached fields and any schema
 * issues are dropped here and never reach the connection manager's log line.
 */
export class ProviderProvisioningNoticeError extends Error {
  readonly #reason: ProviderProvisioningNoticeFailureReason;
  readonly #requestId: string;

  constructor(reason: ProviderProvisioningNoticeFailureReason, requestId: string) {
    super(`provider provisioning notice ${requestId} not acknowledged: ${reason}`);
    this.#reason = reason;
    this.#requestId = requestId;
    Object.defineProperty(this, 'name', {
      value: 'ProviderProvisioningNoticeError',
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  get reason(): ProviderProvisioningNoticeFailureReason {
    return this.#reason;
  }

  get requestId(): string {
    return this.#requestId;
  }
}

export interface ProviderProvisioningNoticeProcessorOptions {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly handler: ProviderProvisioningHandler | undefined;
}

/**
 * Turn one notice into one exact, durable, terminal readback — or throw.
 *
 * Throwing is the only way this leaves a mailbox row un-acknowledged, and it
 * does so only with a {@link ProviderProvisioningNoticeError} naming one closed
 * reason: no handler is configured (a sender cannot turn a missing consumer
 * into a successful no-op), the handler threw, or what it returned is not a
 * valid terminal readback for THIS tenant, device and request.
 */
export function createProviderProvisioningNoticeProcessor(
  options: ProviderProvisioningNoticeProcessorOptions,
): (payload: ProviderProvisioningAvailablePayload) => Promise<ProviderProvisioningReadback> {
  return async (payload) => {
    // `payload` already passed the strict protocol schema, so the request id
    // is a validated UUID and safe to name in the failure.
    const requestId = payload.requestId;
    const handler = options.handler;
    if (handler === undefined) {
      throw new ProviderProvisioningNoticeError('handler_unconfigured', requestId);
    }
    // A fresh frozen object: the handler receives the request id and nothing
    // that could alias the parsed envelope.
    const notice: ProviderProvisioningNotice = Object.freeze({ requestId });
    let raw: unknown;
    try {
      raw = await handler(notice);
    } catch {
      // Deliberately unbound: the thrown value is never read, logged or kept.
      throw new ProviderProvisioningNoticeError('handler_failed', requestId);
    }
    // The schema error would quote Host-returned keys and shapes; only the
    // closed reason survives.
    const parsed = ProviderProvisioningReadbackSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderProvisioningNoticeError('readback_invalid', requestId);
    }
    const readback = parsed.data;
    if (
      readback.tenantId !== options.tenantId ||
      readback.deviceId !== options.deviceId ||
      readback.requestId !== requestId
    ) {
      throw new ProviderProvisioningNoticeError('readback_mismatch', requestId);
    }
    return readback;
  };
}
