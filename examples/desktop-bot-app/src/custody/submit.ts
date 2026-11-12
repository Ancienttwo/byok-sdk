/**
 * Main's half of custody. Main loads no SDK code: it spawns the custody child,
 * writes the request once, keeps no reference to it and returns the receipt.
 */
import type { ProviderStatus } from '@byok-sdk/keys';
import { askHostCommand, type CommandChild } from '../main/host-command.ts';
import { CustodyError, type CustodyAnswer, type CustodyChange, type CustodyReceipt, type CustodyRequest } from './protocol.ts';

export const CUSTODY_DEADLINE_MS = 30_000;

/** A custody child that main can end when a read outlives the deadline. */
export interface CustodyChild extends CommandChild {
  kill(signal: 'SIGKILL'): boolean;
}

/** Resolves to the committed profile's secret-free status; a refusal rejects with its code. */
export async function submitToCustody(child: CommandChild, request: CustodyChange): Promise<ProviderStatus> {
  // The deadline ends only main's wait. The child keeps the configuration lock until its OS-store write has settled, so a
  // write still in flight cannot land after a later change commits; killing it would release the lock under that write.
  const answer = await askCustody(child, request, () => new CustodyError('custody_timeout',
    `Key storage did not answer within ${CUSTODY_DEADLINE_MS / 1000} seconds and is still working, perhaps waiting for a system unlock prompt; the change may still be saved, `
    + 'so reload stored providers before trying again. A provider shown with an unfinished key change needs its key entered again.'));
  if (!('status' in answer)) throw new CustodyError('custody_failed', 'Custody child answered a change with a list');
  return answer.status;
}

/** Resolves to every stored profile's secret-free status, as the registry reports it; a refusal rejects with its code. */
export async function listFromCustody(child: CustodyChild): Promise<readonly ProviderStatus[]> {
  // A list takes no configuration lock and writes nothing, so a hung one is killed rather than left behind on every Reload.
  const answer = await askCustody(child, { op: 'list' }, () => {
    child.kill('SIGKILL');
    return new CustodyError('custody_timeout', `Key storage did not list stored providers within ${CUSTODY_DEADLINE_MS / 1000} seconds, `
      + 'perhaps waiting for a system unlock prompt. Nothing was changed; answer any prompt, then reload stored providers.');
  });
  if (!('statuses' in answer)) throw new CustodyError('custody_failed', 'Custody child answered a list with a change');
  return answer.statuses;
}

async function askCustody(child: CommandChild, request: CustodyRequest, timedOut: () => CustodyError): Promise<CustodyAnswer> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(timedOut()), CUSTODY_DEADLINE_MS);
  try {
    const { receipt, code } = await askHostCommand(child, JSON.stringify(request), message => new CustodyError('custody_exited', message), controller.signal);
    // SAFETY: the bundled custody child writes CustodyReceipt; the transport has checked its ok discriminator.
    const answer = receipt as unknown as CustodyReceipt;
    if (!answer.ok) throw new CustodyError(answer.code, answer.message);
    if (code !== 0) throw new CustodyError('custody_exited', `Custody child exited with code ${code} after a receipt`);
    return answer;
  } finally {
    clearTimeout(deadline);
  }
}
