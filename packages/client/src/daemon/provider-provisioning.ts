import { types as utilTypes } from 'node:util';
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
      // Deliberately unbound: the thrown value is never read, stringified,
      // logged or kept, so its getters, `toString` and `Symbol.toPrimitive`
      // are never invoked.
      throw new ProviderProvisioningNoticeError('handler_failed', requestId);
    }
    // Every touch of the returned value happens inside this one containment:
    // it is copied ONCE into inert plain data (no accessor, Proxy trap, toJSON
    // or prototype can run after this point) and that copy is what the schema
    // parses. Any throw here — a hostile getter or trap, or the schema itself —
    // and any schema failure become the closed reason with no cause, because
    // the schema error would quote Host-returned keys and shapes.
    let readback: ProviderProvisioningReadback;
    try {
      const parsed = ProviderProvisioningReadbackSchema.safeParse(plainDataSnapshot(raw, 0));
      if (!parsed.success) throw INVALID_READBACK;
      readback = parsed.data;
    } catch {
      throw new ProviderProvisioningNoticeError('readback_invalid', requestId);
    }
    // `readback` is the schema's own fresh output over the snapshot: these are
    // primitive string comparisons that cannot reach Host code.
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

/** Local sentinel; never escapes the containment in the processor. */
const INVALID_READBACK: unique symbol = Symbol('invalid provisioning readback');

/** A readback is shallow JSON; anything deeper is not one. */
const MAX_READBACK_DEPTH = 8;

/**
 * Copy a Host-returned value into inert plain data, reading each property
 * exactly once, or throw.
 *
 * Accepted: `null`, strings, finite numbers, booleans, arrays and objects
 * whose prototype is `Object.prototype` or `null`, carrying only string-keyed,
 * enumerable DATA properties. Anything else (an accessor, a symbol key, a
 * class instance, `undefined`, a function, a bigint, a non-finite number,
 * excess depth) throws, and the caller maps every throw to `readback_invalid`.
 * A Proxy at any level is refused before any of its traps runs.
 */
function plainDataSnapshot(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw INVALID_READBACK;
    return value;
  }
  if (typeof value !== 'object' || depth >= MAX_READBACK_DEPTH) throw INVALID_READBACK;
  // A Proxy is not plain data: refuse it before any trap can run.
  if (utilTypes.isProxy(value)) throw INVALID_READBACK;
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw INVALID_READBACK;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (isArray) {
    const lengthDescriptor = descriptors['length'];
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number') {
      throw INVALID_READBACK;
    }
    const length = lengthDescriptor.value;
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw INVALID_READBACK;
      out.push(plainDataSnapshot(descriptor.value, depth + 1));
    }
    if (Object.keys(descriptors).length !== length + 1 || Object.getOwnPropertySymbols(descriptors).length !== 0) {
      throw INVALID_READBACK;
    }
    return out;
  }
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) throw INVALID_READBACK;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!('value' in descriptor) || descriptor.enumerable !== true) throw INVALID_READBACK;
    out[key] = plainDataSnapshot(descriptor.value, depth + 1);
  }
  return out;
}
