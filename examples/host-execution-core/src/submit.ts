import type { ByokServer } from '@byok-sdk/server';
import type { AgentExecutionInput } from '@byok-sdk/server';
import { canonical, isSealed, type FrozenExecutionInput, type SealedAgentExecutionInput } from './model';

/**
 * The SDK calls that one frozen submit uses. L binds them to its `ByokServer`; H binds them to its cloud tenant.
 * `submitSealed` is the cloud's `submitSealedAgentExecution`. A port without it cannot dispatch a sealed input.
 */
export interface FrozenSubmitPort {
  submit: ByokServer['executions']['submit'];
  submitSealed?: (input: SealedAgentExecutionInput) => ReturnType<ByokServer['executions']['submit']>;
  offer: ByokServer['tasks']['offer'];
}
/** A plain frozen input. The frozen-submit functions also take a sealed one (`FrozenExecutionInput`). */
export type FrozenInput = AgentExecutionInput;
export type FrozenOffer = NonNullable<Awaited<ReturnType<FrozenSubmitPort['offer']>>>;

/** The wire type of a frozen input. It decides both the submit lane and the readback check. */
export function frozenOfferType(input: FrozenExecutionInput): 'task.offer_for_agent_with_egress_fresh' | 'task.offer_for_agent_with_egress_fresh_sealed' {
  return isSealed(input) ? 'task.offer_for_agent_with_egress_fresh_sealed' : 'task.offer_for_agent_with_egress_fresh';
}

/**
 * The recorded offer is the frozen input: the same task, device, offer type and canonical payload. A plain offer never
 * matches a sealed input, nor the reverse. The Host resubmits its frozen bytes, so a sealed payload compares exactly.
 */
export function sameFrozenOffer(offer: FrozenOffer, input: FrozenExecutionInput): boolean {
  return offer.taskId === input.taskId && offer.deviceId === input.deviceId && offer.type === frozenOfferType(input)
    && canonical(offer.payload) === canonical(input.payload);
}

/** The recorded offer of the task is not the frozen input. The submit must stop, and an operator must look at it. */
export class FrozenOfferMismatchError extends Error {
  readonly code = 'frozen_offer_mismatch';
  constructor() { super('Offer differs from the frozen input'); this.name = 'FrozenOfferMismatchError'; }
}

/** The input is sealed and the port has no sealed lane (`submitSealed`). Nothing was submitted. */
export class SealedDispatchUnavailableError extends Error {
  readonly code = 'sealed_dispatch_unavailable';
  constructor() { super('This Host has no sealed dispatch'); this.name = 'SealedDispatchUnavailableError'; }
}

/** Reads the offer of the frozen task back. A different recorded offer throws `FrozenOfferMismatchError`; `delivered: false` is not a proof of no append. */
export async function frozenDelivered(port: Pick<FrozenSubmitPort, 'offer'>, input: FrozenExecutionInput): Promise<boolean> {
  const offer = await port.offer(input.taskId);
  if (!offer) return false;
  if (!sameFrozenOffer(offer, input)) throw new FrozenOfferMismatchError();
  return offer.delivered;
}

/**
 * Submits one frozen input under its own task id. It reads back first. `beforeSubmit` runs only when the readback
 * is not delivered, and returns false to stop with no submit (for example at `waitUntil`). After a throw, only a
 * delivered readback counts; otherwise the error is thrown again and the submit stays uncertain. A sealed input on a
 * port without `submitSealed` throws `SealedDispatchUnavailableError` before the readback.
 */
export async function submitFrozen(port: FrozenSubmitPort, input: FrozenExecutionInput, beforeSubmit: () => boolean | Promise<boolean>): Promise<'delivered' | 'stopped'> {
  const send = dispatcher(port, input);
  if (await frozenDelivered(port, input)) return 'delivered';
  if (!await beforeSubmit()) return 'stopped';
  try { await send(); }
  catch (error) { if (!await frozenDelivered(port, input)) throw error; }
  return 'delivered';
}
function dispatcher(port: FrozenSubmitPort, input: FrozenExecutionInput): () => Promise<unknown> {
  if (!isSealed(input)) return () => port.submit(input);
  const { submitSealed } = port;
  if (!submitSealed) throw new SealedDispatchUnavailableError();
  return () => submitSealed(input);
}
