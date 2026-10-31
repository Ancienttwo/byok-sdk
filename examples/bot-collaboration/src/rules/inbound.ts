/**
 * The inbound disposition projection as pure rules (#1229 item 3). It reads the existing inbound, input-batch and Turn
 * rows and returns one destination per recorded inbound human message. It writes nothing and keeps no disposition of its
 * own, so the ledger stays the only authority.
 */
/** The five destinations of #1229 item 3. */
export type InboundDisposition =
  | { id: string; disposition: 'filtered'; code: string }
  | { id: string; disposition: 'coalesced' | 'answered' | 'failed' | 'cancelled'; turnId: string };
/** The inbound fields that the projection reads. The delivery adapter stores more. */
export interface InboundRow {
  readonly id: string;
  /** The Turn or open input batch that answers the message. Absent on a filtered message. */
  readonly root?: string;
  /** The classification that refused the message before any Turn. */
  readonly filtered?: string;
  /** The ledger sequence, for the oldest-first order. */
  readonly sequence?: number;
}
/** The Turn fields that decide a message's destination. */
export interface InboundTurn {
  readonly id: string; readonly root: string; readonly status: string;
  readonly conclusion?: string; readonly inputIds?: readonly string[];
}
export interface InboundState {
  readonly channel?: { readonly inbounds?: Readonly<Record<string, InboundRow>> };
  readonly turns: Readonly<Record<string, InboundTurn>>;
  readonly inputBatches?: Readonly<Record<string, { readonly state: string }>>;
}
const ANSWERED = new Set(['succeeded', 'delivered']);
const FAILED = new Set(['failed', 'expired', 'declined', 'superseded', 'abandoned']);
/**
 * One message's current destination.
 * - `filtered` is the classification that refused it before a Turn.
 * - `coalesced` means it is in `turnId`: an open input batch, or a Turn that has not reached a terminal.
 * - `answered` is a succeeded Turn, `cancelled` a cancel, and every other terminal is `failed`.
 * A recorded message with no live Turn and no open batch is `failed`, never silent: retention or a crash cannot make
 * the Host UI report that the message has no destination.
 */
export function inboundDisposition(state: InboundState, row: InboundRow): InboundDisposition {
  if (row.filtered !== undefined) return { id: row.id, disposition: 'filtered', code: row.filtered };
  const root = row.root;
  if (root === undefined) return { id: row.id, disposition: 'failed', turnId: row.id };
  const turn = Object.hasOwn(state.turns, root) ? state.turns[root] : undefined;
  if (!turn) {
    // An open batch has no Turn yet. It is still the Turn that will answer the message.
    const batch = state.inputBatches && Object.hasOwn(state.inputBatches, root) ? state.inputBatches[root] : undefined;
    return batch?.state === 'open'
      ? { id: row.id, disposition: 'coalesced', turnId: root }
      : { id: row.id, disposition: 'failed', turnId: root };
  }
  const conclusions = [turn.conclusion, turn.status];
  if (conclusions.includes('cancelled')) return { id: row.id, disposition: 'cancelled', turnId: turn.id };
  if (conclusions.some(value => value !== undefined && ANSWERED.has(value))) return { id: row.id, disposition: 'answered', turnId: turn.id };
  if (conclusions.some(value => value !== undefined && FAILED.has(value))) return { id: row.id, disposition: 'failed', turnId: turn.id };
  return { id: row.id, disposition: 'coalesced', turnId: turn.id };
}
/** Every recorded inbound human message, oldest first. The order is the ledger sequence, never insertion order. */
export function inboundDispositions(state: InboundState): InboundDisposition[] {
  return Object.values(state.channel?.inbounds ?? {})
    .filter(row => row.filtered !== undefined || row.root !== undefined)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(row => inboundDisposition(state, row));
}
