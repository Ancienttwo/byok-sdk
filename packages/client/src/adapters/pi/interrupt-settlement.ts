import type { PiRpcClient } from './rpc-client';

type Waiter = { resolve: () => void; reject: (error: Error) => void };
// Private protocol state: neither the client declaration nor its constructor
// options acquire another public capability for a task-owned interrupt.
const waitersByClient = new WeakMap<PiRpcClient, Set<Waiter>>();

/** The runner bounds interruption; agent_settled carries the final native usage. */
export async function abortPiRpcAndSettle(client: PiRpcClient): Promise<void> {
  let waiters = waitersByClient.get(client);
  if (!waiters) { waiters = new Set(); waitersByClient.set(client, waiters); }
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const settled = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  void settled.catch(() => undefined);
  const waiter = { resolve, reject };
  waiters.add(waiter);
  try {
    const response = await client.send({ type: 'abort' });
    if (response.success === false) throw new Error('pi refused abort');
    await settled;
  } finally { waiters.delete(waiter); }
}

export function observePiRpcSettlement(client: PiRpcClient, type: string): void {
  if (type === 'agent_settled') for (const waiter of waitersByClient.get(client) ?? []) waiter.resolve();
}

export function closePiRpcSettlement(client: PiRpcClient, error: Error): void {
  for (const waiter of waitersByClient.get(client) ?? []) waiter.reject(error);
}
