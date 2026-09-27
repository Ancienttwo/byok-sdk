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

export class ProviderProvisioningNoticeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderProvisioningNoticeError';
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
 * does so for exactly three reasons: no handler is configured (a sender cannot
 * turn a missing consumer into a successful no-op), the handler itself threw,
 * or what it returned is not a terminal readback for THIS tenant, device and
 * request.
 */
export function createProviderProvisioningNoticeProcessor(
  options: ProviderProvisioningNoticeProcessorOptions,
): (payload: ProviderProvisioningAvailablePayload) => Promise<ProviderProvisioningReadback> {
  return async (payload) => {
    const handler = options.handler;
    if (handler === undefined) {
      throw new ProviderProvisioningNoticeError('provider provisioning is not configured on this daemon');
    }
    // A fresh frozen object: the handler receives the request id and nothing
    // that could alias the parsed envelope.
    const notice: ProviderProvisioningNotice = Object.freeze({ requestId: payload.requestId });
    const raw = await handler(notice);
    const parsed = ProviderProvisioningReadbackSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderProvisioningNoticeError('provider provisioning handler returned an invalid readback', {
        cause: parsed.error,
      });
    }
    const readback = parsed.data;
    if (
      readback.tenantId !== options.tenantId ||
      readback.deviceId !== options.deviceId ||
      readback.requestId !== payload.requestId
    ) {
      throw new ProviderProvisioningNoticeError(
        'provider provisioning readback does not match this tenant, device and request',
      );
    }
    return readback;
  };
}
