import type { ByokServer } from '@byok-sdk/server';
import { canonical } from './model';

/** The two SDK calls that one frozen submit uses. L binds them to its `ByokServer`; H binds them to its cloud tenant. */
export interface FrozenSubmitPort {
  submit: ByokServer['executions']['submit'];
  offer: ByokServer['tasks']['offer'];
}
export type FrozenInput = Parameters<FrozenSubmitPort['submit']>[0];
export type FrozenOffer = NonNullable<Awaited<ReturnType<FrozenSubmitPort['offer']>>>;

/** The recorded offer is the frozen input: the same task, device, offer type and canonical payload. */
export function sameFrozenOffer(offer: FrozenOffer, input: FrozenInput): boolean {
  return offer.taskId === input.taskId && offer.deviceId === input.deviceId && offer.type === 'task.offer_for_agent_with_egress_fresh'
    && canonical(offer.payload) === canonical(input.payload);
}

/** Reads the offer of the frozen task back. A different recorded offer throws; `delivered: false` is not a proof of no append. */
export async function frozenDelivered(port: Pick<FrozenSubmitPort, 'offer'>, input: FrozenInput): Promise<boolean> {
  const offer = await port.offer(input.taskId);
  if (!offer) return false;
  if (!sameFrozenOffer(offer, input)) throw new Error('Offer differs from the frozen input');
  return offer.delivered;
}

/**
 * Submits one frozen input under its own task id. It reads back first. `beforeSubmit` runs only when the readback
 * is not delivered, and returns false to stop with no submit (for example at `waitUntil`). After a throw, only a
 * delivered readback counts; otherwise the error is thrown again and the submit stays uncertain.
 */
export async function submitFrozen(port: FrozenSubmitPort, input: FrozenInput, beforeSubmit: () => boolean | Promise<boolean>): Promise<'delivered' | 'stopped'> {
  if (await frozenDelivered(port, input)) return 'delivered';
  if (!await beforeSubmit()) return 'stopped';
  try { await port.submit(input); }
  catch (error) { if (!await frozenDelivered(port, input)) throw error; }
  return 'delivered';
}
