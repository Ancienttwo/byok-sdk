/**
 * Main's side of a Host executable re-entered as a one-shot command (custody,
 * start fresh): write the input once, read one receipt line from stdout.
 */
import { addAbortListener, once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

/** One command child with piped stdin and stdout; stderr goes to main's diagnostics. */
export interface CommandChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  once(event: 'exit', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

/** A receipt line: an object with a boolean `ok`. */
export type Receipt = Record<string, unknown> & { readonly ok: boolean };

function parseReceipt(text: string): Receipt | undefined {
  try {
    const receipt = JSON.parse(text) as Receipt;
    return typeof receipt === 'object' && receipt !== null && typeof receipt.ok === 'boolean' ? receipt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes `input` and ends stdin, then resolves to the receipt and exit code once
 * the child exited and stdout ended. `exited(message)` builds the error for a
 * broken pipe or a child that printed no receipt. An owner-supplied signal cancels
 * both waits with its reason; the owner terminates the child.
 */
export async function askHostCommand(child: CommandChild, input: string, exited: (message: string) => Error, signal?: AbortSignal): Promise<{ receipt: Receipt; code: number | null }> {
  let abort: Disposable | undefined;
  // A child that cannot spawn never exits, and a dead child's stdin raises EPIPE: either rejects this call.
  const failed = new Promise<never>((_resolve, reject) => {
    const broken = (error: Error) => reject(exited(`Command child pipe failed: ${error.message}`));
    child.once('error', broken);
    child.stdin.on('error', broken);
    if (signal) abort = addAbortListener(signal, () => reject(signal.reason));
  });
  const exit = new Promise<number | null>(resolve => child.once('exit', resolve));
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  const drained = once(child.stdout, 'end');
  // Settled through the races below; these keep a late rejection from becoming unhandled.
  failed.catch(() => {});
  drained.catch(() => {});
  try {
    child.stdin.end(input);
    const code = await Promise.race([exit, failed]);
    await Promise.race([drained, failed]);
    const receipt = parseReceipt(output.trim());
    if (receipt === undefined) throw exited(`Command child exited with code ${code} and no receipt`);
    return { receipt, code };
  } finally {
    abort?.[Symbol.dispose]();
  }
}
