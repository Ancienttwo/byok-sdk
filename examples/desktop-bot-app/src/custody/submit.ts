/**
 * Main's half of custody. Main loads no SDK code: it spawns the custody child,
 * writes the request once, keeps no reference to it and returns the receipt.
 */
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { ProviderStatus } from '@byok-sdk/keys';
import { CustodyError, type CustodyReceipt, type CustodyRequest } from './protocol.ts';

/** One custody child with piped stdin and stdout; stderr goes to main's diagnostics. */
export interface CustodyChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  once(event: 'exit', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

function parseReceipt(text: string): CustodyReceipt | undefined {
  try {
    const receipt = JSON.parse(text) as CustodyReceipt;
    return typeof receipt === 'object' && receipt !== null && typeof receipt.ok === 'boolean' ? receipt : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves to the committed profile's secret-free status; a refusal rejects with its code. */
export async function submitToCustody(child: CustodyChild, request: CustodyRequest): Promise<ProviderStatus> {
  // A child that cannot spawn never exits, and a dead child's stdin raises EPIPE: either rejects this submission.
  const failed = new Promise<never>((_resolve, reject) => {
    const broken = (error: Error) => reject(new CustodyError('custody_exited', `Custody child pipe failed: ${error.message}`));
    child.once('error', broken);
    child.stdin.on('error', broken);
  });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  const drained = once(child.stdout, 'end');
  // Settled through the races below; these keep a late rejection from becoming unhandled.
  failed.catch(() => {});
  drained.catch(() => {});
  child.stdin.end(JSON.stringify(request));
  const code = await Promise.race([exited, failed]);
  await Promise.race([drained, failed]);
  const receipt = parseReceipt(output.trim());
  if (receipt === undefined) throw new CustodyError('custody_exited', `Custody child exited with code ${code} and no receipt`);
  if (!receipt.ok) throw new CustodyError(receipt.code, receipt.message);
  if (code !== 0) throw new CustodyError('custody_exited', `Custody child exited with code ${code} after a receipt`);
  return receipt.status;
}
