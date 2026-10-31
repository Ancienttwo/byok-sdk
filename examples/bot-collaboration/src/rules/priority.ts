/**
 * The reference Host's explicit work priority as pure rules (#1229 item 1). The K4 FIFO keeps its order: one queue per
 * Agent, the lowest sequence is the head, and a submitted execution keeps its taskId generation
 * (docs/host-execution-core.md section 3). These rules change only the sequence of queued, never-submitted intents and
 * the dispatch decision of one device.
 */
/** The concurrent task limit of a device, as the daemon maxConcurrentTasks default (#1121). */
export const DEVICE_CONCURRENCY = 8;
/** The slots of a device that autonomous work may not take, so user input always has one. */
export const USER_RESERVED_SLOTS = 1;
/** The intent fields that the priority rules read. K4 owns every other field. */
export interface QueuedIntent {
  readonly id: string; readonly agent: string; readonly sequence: number; readonly phase: string; readonly attempts: number;
}
/** A dispatched intent: the fields of the device reservation, and whether it currently occupies a slot of its device. */
export interface DispatchIntent extends QueuedIntent {
  readonly source: 'user' | 'bot' | 'routine';
  readonly deviceId: string;
  /** The intent is submitted or has attempt evidence, so it holds a device slot until its terminal. */
  readonly occupies: boolean;
}
/** A queued intent that never reached the SDK: the only rows that a priority rule may move. */
export function isUnsubmitted(row: Pick<QueuedIntent, 'phase' | 'attempts'>): boolean {
  return row.phase === 'queued' && row.attempts === 0;
}
/** The new sequence values of one Agent FIFO, and the counter value after them. */
export interface SequencePlan { assignments: Array<{ id: string; sequence: number }>; sequence: number }
/**
 * Puts the queued, never-submitted intents of the user intent's Agent FIFO in priority order: every non-autonomous
 * intent keeps its arrival order, then the autonomous ones (the ids in the set) keep theirs.
 * Returns undefined when the user intent is not queued and unsubmitted, or the order already holds.
 * The new values are one block above every current sequence, so a submitted or in-flight intent is never moved.
 */
export function userFirst(rows: readonly QueuedIntent[], userIntentId: string, autonomous: ReadonlySet<string>,
  next: number): SequencePlan | undefined {
  const user = rows.find(row => row.id === userIntentId);
  if (!user || !isUnsubmitted(user)) return undefined;
  const queued = rows.filter(row => row.agent === user.agent && isUnsubmitted(row))
    .sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order = [...queued.filter(row => !autonomous.has(row.id)), ...queued.filter(row => autonomous.has(row.id))];
  if (order.every((row, index) => row.id === queued[index]!.id)) return undefined;
  let base = next;
  for (const row of rows) if (row.sequence > base) base = row.sequence;
  return { assignments: order.map((row, index) => ({ id: row.id, sequence: base + 1 + index })), sequence: base + order.length };
}
/**
 * Whether the Host may begin the intent on its device now. User-source work may use every slot; other work leaves
 * USER_RESERVED_SLOTS free (none when the limit is 1, which has no spare slot). The rows hold the open intents of every
 * Agent on the device; the intent itself is not counted, so the check gives the same answer before and after the intent
 * becomes in-flight.
 */
export function admitDeviceSlot(intent: DispatchIntent, rows: Iterable<DispatchIntent>, limit = DEVICE_CONCURRENCY): boolean {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('A device concurrency limit is a positive safe integer');
  const reserved = Math.min(USER_RESERVED_SLOTS, limit - 1);
  let occupied = 0;
  for (const row of rows) if (row.id !== intent.id && row.deviceId === intent.deviceId && row.occupies) occupied++;
  return occupied < limit - (intent.source === 'user' ? 0 : reserved);
}
