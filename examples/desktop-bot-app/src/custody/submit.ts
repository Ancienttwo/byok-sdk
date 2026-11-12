/**
 * Main's half of custody. Main loads no SDK code: it spawns the custody child,
 * writes the request once, keeps no reference to it and returns the receipt.
 */
import type { ProviderStatus } from '@byok-sdk/keys';
import { askHostCommand, type CommandChild } from '../main/host-command.ts';
import { CustodyError, type CustodyAnswer, type CustodyChange, type CustodyReceipt, type CustodyRequest } from './protocol.ts';

export const CUSTODY_DEADLINE_MS = 30_000;

/** A custody child can be terminated when its one-shot operation exceeds the deadline. */
export interface CustodyChild extends CommandChild {
  kill(signal: 'SIGKILL'): boolean;
}

/** Resolves to the committed profile's secret-free status; a refusal rejects with its code. */
export async function submitToCustody(child: CustodyChild, request: CustodyChange): Promise<ProviderStatus> {
  const answer = await askCustody(child, request);
  if (!('status' in answer)) throw new CustodyError('custody_failed', 'Custody child answered a change with a list');
  return answer.status;
}

/** Resolves to every stored profile's secret-free status, as the registry reports it; a refusal rejects with its code. */
export async function listFromCustody(child: CustodyChild): Promise<readonly ProviderStatus[]> {
  const answer = await askCustody(child, { op: 'list' });
  if (!('statuses' in answer)) throw new CustodyError('custody_failed', 'Custody child answered a list with a change');
  return answer.statuses;
}

async function askCustody(child: CustodyChild, request: CustodyRequest): Promise<CustodyAnswer> {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new CustodyError('custody_timeout', `Key storage did not answer within ${CUSTODY_DEADLINE_MS / 1000} seconds. A change may have been saved; reload stored providers before trying again. A provider shown with an unfinished key change needs its key entered again.`));
    child.kill('SIGKILL');
    child.stdin.destroy();
    child.stdout.destroy();
  }, CUSTODY_DEADLINE_MS);
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
