import { ByokCloudError } from './errors';
export type ReceiptRetentionClass = 'identity' | 'request';
/** The sole receipt classification authority. Existing and unknown identities never expire. */
export const RECEIPT_RETENTION: readonly Readonly<{ prefix: string; class: ReceiptRetentionClass }>[] = Object.freeze([
  'task-offer:', 'task-offer-delivered:', 'task:', 'agent-message-offer:',
  'agent-content-request:', 'agent-content-receipt:',
  'agent-home-projection-request:', 'agent-home-projection-completion:',
  'agent-input-preparation-request:', 'agent-input-preparation-completion:',
  'pairing-completion:v1:', 'task-redaction:', 'e2ee-scope-shred:',
].map(prefix => Object.freeze({ prefix, class: 'identity' as const })));
export const REQUEST_RECEIPT_PREFIXES: readonly string[] = Object.freeze(
  RECEIPT_RETENTION.filter(entry => entry.class === 'request').map(entry => entry.prefix),
);
const identities = RECEIPT_RETENTION.filter(entry => entry.class === 'identity');
if (RECEIPT_RETENTION.some((entry, index) => RECEIPT_RETENTION.findIndex(other => other.prefix === entry.prefix) !== index)
  || REQUEST_RECEIPT_PREFIXES.some(prefix => !prefix.endsWith(':')
    || identities.some(identity => identity.prefix.startsWith(prefix) || prefix.startsWith(identity.prefix)))) {
  throw new ByokCloudError('maintenance_invalid_input', 'Receipt retention families must be distinct and request prefixes cannot overlap identity fences.');
}
export function receiptRetentionClass(key: string): ReceiptRetentionClass {
  return RECEIPT_RETENTION.find(entry => key.startsWith(entry.prefix))?.class ?? 'identity';
}
