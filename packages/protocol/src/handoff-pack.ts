/**
 * A bounded conversation handoff from the turns a Host holds (#1441). The SDK
 * stores no conversation, so the Host calls this on its own history and puts
 * the result in the Turn input. The function is pure: same input, same bytes.
 *
 * Every size is the UTF-8 length of the `JSON.stringify` form, so a budget
 * bounds what the pack adds to a prompt. A text's size leaves out its two
 * quotes.
 */
import { truncateUtf8 } from './failure-reason';

/** Maximum bytes of a line in `earlier`, truncation marker included. */
export const HANDOFF_EXCERPT_LINE_MAX_BYTES = 512;

/** JSON data that a turn carries through the pack unchanged. */
export type HandoffJson = null | boolean | number | string | readonly HandoffJson[] | { readonly [key: string]: HandoffJson };

export interface HandoffLine { readonly speaker: string; readonly text: string }

export interface HandoffTurn {
  readonly lines: readonly HandoffLine[];
  /** Kept as it is and never truncated. A turn whose `meta` does not fit is left out. */
  readonly meta?: HandoffJson;
}

/** Non-negative safe integers. */
export interface HandoffPackBudgets {
  /** Bytes of the turns in `recent`. */
  readonly recentBytes: number;
  /** Bytes of the turns in `earlier`. */
  readonly earlyBytes: number;
  /** Bytes of the whole pack. It must hold the pack frame, in which `omittedTurns` has the count of `turns`. */
  readonly totalBytes: number;
}

export interface HandoffPack {
  /** How many of the input turns are in neither list. */
  readonly omittedTurns: number;
  /** Excerpts of the turns before `recent`, oldest first. */
  readonly earlier: readonly HandoffTurn[];
  /** Whole turns up to the newest one, oldest first. The newest turn may be cut; with turns in the input, the list is empty only when that turn does not fit. */
  readonly recent: readonly HandoffTurn[];
}

const encoder = new TextEncoder();

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function textBytes(text: string): number {
  return jsonBytes(text) - 2;
}

function withLines(turn: HandoffTurn, lines: readonly HandoffLine[]): HandoffTurn {
  return { lines, ...(turn.meta === undefined ? {} : { meta: turn.meta }) };
}

function whole(turn: HandoffTurn): HandoffTurn {
  return withLines(turn, turn.lines.map(({ speaker, text }) => ({ speaker, text })));
}

/** The largest limit with the sum of `min(size, limit)` at most `room`, where `room` is under the sum of `sizes`. */
function sharedLimit(sizes: readonly number[], room: number): number {
  let left = room, open = sizes.length;
  for (const size of [...sizes].sort((a, b) => a - b)) {
    if (size * open > left) break;
    left -= size;
    open -= 1;
  }
  return Math.floor(left / open);
}

/**
 * The newest turn cut to `cap`, or `undefined` when it does not fit. All its lines share one limit, so a short reply
 * survives a long request. A line over the limit keeps its start and end; a limit under a line's marker width keeps
 * only the marker, and the turn is left out unless it still fits.
 */
function fitNewest(turn: HandoffTurn, cap: number): HandoffTurn | undefined {
  const room = cap - jsonBytes(withLines(turn, turn.lines.map(({ speaker }) => ({ speaker, text: '' }))));
  if (room < 0) return undefined;
  const limit = sharedLimit(turn.lines.map(({ text }) => textBytes(text)), room);
  const fitted = withLines(turn, turn.lines.map(({ speaker, text }) => (
    { speaker, text: truncateUtf8(text, limit, { measure: textBytes, keepTail: true }) })));
  return jsonBytes(fitted) <= cap ? fitted : undefined;
}

function excerpt(turn: HandoffTurn): HandoffTurn {
  return withLines(turn, turn.lines.map(({ speaker, text }) => (
    { speaker, text: truncateUtf8(text, HANDOFF_EXCERPT_LINE_MAX_BYTES, { measure: textBytes }) })));
}

/** Takes turns from `next` back while they fit `room`, and returns them oldest first with the bytes they use. */
function takeBack(turns: readonly HandoffTurn[], next: number, room: number, form: (turn: HandoffTurn) => HandoffTurn) {
  const taken: HandoffTurn[] = [];
  let used = 0;
  for (let index = next; index >= 0; index -= 1) {
    const turn = form(turns[index]!);
    const size = jsonBytes(turn) + (taken.length === 0 ? 0 : 1);
    if (used + size > room) break;
    taken.push(turn);
    used += size;
  }
  return { taken: taken.reverse(), used };
}

/**
 * Builds the pack of `turns`, oldest first. `recent` holds the newest whole
 * turns that fit `min(recentBytes, totalBytes - frame)`; only a newest turn
 * that is over by itself is cut, to one limit shared by its lines.
 * `earlier` holds excerpts of the turns before `recent`, as far back as they
 * fit `earlyBytes` and the rest of `totalBytes`.
 *
 * @throws RangeError when a budget is not a non-negative safe integer, or
 * `totalBytes` does not hold the pack frame.
 */
export function buildHandoffPack(turns: readonly HandoffTurn[], budgets: HandoffPackBudgets): HandoffPack {
  const { recentBytes, earlyBytes, totalBytes } = budgets;
  // The largest `omittedTurns` this input can give, so the pack can never outgrow its frame.
  const frame = jsonBytes({ omittedTurns: turns.length, earlier: [], recent: [] });
  if (![recentBytes, earlyBytes, totalBytes].every(budget => Number.isSafeInteger(budget) && budget >= 0) || totalBytes < frame) {
    throw new RangeError(`Handoff budgets must be non-negative safe integers, and totalBytes at least ${frame}`);
  }
  const room = totalBytes - frame, recentRoom = Math.min(recentBytes, room);
  let { taken: recent, used } = takeBack(turns, turns.length - 1, recentRoom, whole);
  let next = turns.length - 1 - recent.length;
  if (recent.length === 0 && next >= 0) {
    const newest = fitNewest(turns[next]!, recentRoom);
    if (newest) { recent = [newest]; used = jsonBytes(newest); }
    next -= 1;
  }
  const { taken: earlier } = takeBack(turns, next, Math.min(earlyBytes, room - used), excerpt);
  return { omittedTurns: turns.length - recent.length - earlier.length, earlier, recent };
}
