/**
 * The task-free `e2ee.key_package.available` notice (#654 E2d-2; E2c-3,
 * design §7.4 notice-and-fetch). Like `provider.provisioning.available`, it
 * is consumed before the journal append and never journaled.
 *
 * Resolving acknowledges the notice. Only a state that a redelivery can still
 * change throws, which keeps the mailbox row and the cursor: a member whose
 * resume has not finished, or a Host read that failed or timed out. A final
 * Host answer (a 4xx other than 429, a chain or body past its cap, more than
 * one package) and every other end resolve with a log line, and the first
 * open or seal at that epoch fetches again on its cache miss.
 */
import type { E2eeKeyPackageAvailablePayload } from '@byok-sdk/protocol';
import type { DeviceMemberLog } from './device-member';
import type { DeviceMemberKeyring, ScopeKeyFetchResult } from './e2ee-keyring';
import { E2eeMemberClientError } from './e2ee-member-client';

/** This run's member: still resuming, none, or the verified keyring. */
export type DeviceMemberStatus = 'resuming' | 'none' | DeviceMemberKeyring;

export async function processE2eeKeyPackageNotice(
  payload: E2eeKeyPackageAvailablePayload,
  member: DeviceMemberStatus,
  log: DeviceMemberLog,
): Promise<void> {
  if (member === 'resuming') throw new Error('the E2EE member is still resuming; the key package notice waits for redelivery');
  const at = `epoch ${payload.epoch} of scope ${JSON.stringify(payload.scopeId)}`;
  if (member === 'none') return log(`a key package notice for ${at} reached a device that is no E2EE member; ignored`);
  let result: ScopeKeyFetchResult;
  try {
    result = await member.fetch(payload.scopeId, payload.epoch);
  } catch (error) {
    if (!(error instanceof E2eeMemberClientError && error.final)) throw error;
    // The message is client text: the status, a bounded Host code, or the cap that refused the answer.
    return log(`the key package for ${at} was not fetched; the Host's answer is final (${error.message})`);
  }
  if (!result.ok) log(`the key package for ${at} was not opened (${result.reason})`);
}
