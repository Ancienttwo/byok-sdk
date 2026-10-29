import type { ByokCloud } from '@byok-sdk/cloud';

/** Only these control-plane methods cross the test-only Worker RPC boundary. */
export const CANARY_METHODS = [
  'createPairingCode', 'appendMemberChainEntries', 'readMemberKeyRegistration', 'relayClientPairingMac', 'putScopeKeyPackages',
  'submitAgentExecution', 'submitSealedAgentExecution', 'readTaskOffer', 'readTaskAttempt', 'readDeviceTerminal', 'cancelTask',
  'listDevices', 'steerSealedTask', 'steerTask', 'readApprovalTimeline', 'approveTask', 'readActivity',
] as const;
export type CanaryCloud = Pick<ByokCloud, typeof CANARY_METHODS[number]>;

/** JSON for this local test control plane only; the SDK device wire is untouched. */
export function encodeCanaryRpc(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $canaryBigint: String(item) } : item);
}
export function decodeCanaryRpc(text: string): unknown {
  return JSON.parse(text, (_key, item) => item !== null && typeof item === 'object' && '$canaryBigint' in item
    ? BigInt(item.$canaryBigint) : item);
}
