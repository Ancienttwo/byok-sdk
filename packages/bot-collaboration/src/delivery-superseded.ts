import type { Delivery } from './channel.js';
/** Manual replacements keep their predecessors as history, with acceptance still unknown. */
export function supersededDeliveryIds(deliveries: Readonly<Record<string, Delivery>>): Set<string> {
  return new Set(Object.values(deliveries).flatMap(row => row.resendOf === undefined ? [] : [row.resendOf]));
}
