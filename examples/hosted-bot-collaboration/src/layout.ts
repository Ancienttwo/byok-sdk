import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';

// How H stores one `CollaborationState` (#793 D2a). Each map entry is one `entity` row and each list
// element is one `entry` row, keyed by stable identity. The `frame` is the state with each map emptied and
// each list cleared: it keeps the scalars, the key order and which optional fields exist, and it does not
// grow with history. Bodies are `JSON.stringify` text, so the stored bytes keep their key order.

/** Each keyed map of the state and its entity kind. */
export const MAPS = [
  ['turn', ['turns']], ['budget', ['budgets']], ['delegation', ['delegations']], ['batch', ['batches']], ['unit', ['units']],
  ['reply', ['replies']], ['schema', ['schemas']], ['question', ['questions']], ['card', ['cards']],
  ['input', ['inputs']], ['input_batch', ['inputBatches']],
  ['bot', ['team', 'bots']], ['room', ['team', 'rooms']], ['round', ['team', 'rounds']], ['seat', ['team', 'seats']], ['root', ['team', 'roots']],
  ['inbound', ['channel', 'inbounds']], ['push_route', ['channel', 'pushRoutes']], ['delivery', ['channel', 'deliveries']],
] as const satisfies ReadonlyArray<readonly [string, readonly string[]]>;
/** Each list of the state and its entry kind. Room messages are lists inside the room entities. */
export const LISTS = [
  ['audit', ['audit']], ['rejected', ['rejected']], ['note', ['team', 'notes']], ['home_operation', ['team', 'homeOperations']],
] as const satisfies ReadonlyArray<readonly [string, readonly string[]]>;
export const ROOM_MESSAGE = 'room_message';
export type EntityKind = typeof MAPS[number][0];
export type EntryKind = typeof LISTS[number][0] | typeof ROOM_MESSAGE;
/** The frame holds no history. A larger frame means a state field that this layout does not map. */
export const FRAME_MAX_BYTES = 4096;

/** A stored id is its JSON text: one form for any JavaScript string, also a lone surrogate or a NUL. */
export const storedKey = (id: string): string => JSON.stringify(id);
export const idOf = (key: string): string => {
  const id: unknown = JSON.parse(key);
  if (typeof id !== 'string') throw new Error('Invalid stored key');
  return id;
};

export interface StoredCommand { evidence: string; result: string }
/** The rows of one state. Each map keeps the iteration order of the state. */
export interface Split {
  frame: string;
  entities: Map<EntityKind, Map<string, string>>;
  /** Keyed by `kind` and owner: the owner is '' for a state list and the room key for room messages. */
  entries: Map<string, { kind: EntryKind; owner: string; bodies: string[] }>;
  commands: Map<string, StoredCommand>;
}
type Container = Record<string, unknown>;
const own = (value: Container, name: string): unknown => Object.hasOwn(value, name) ? value[name] : undefined;
function parent(root: Container, path: readonly string[]): Container | undefined {
  let at: unknown = root;
  for (const name of path.slice(0, -1)) at = at && typeof at === 'object' ? own(at as Container, name) : undefined;
  return at && typeof at === 'object' ? at as Container : undefined;
}
const plain = (value: unknown): value is Container => value !== null && typeof value === 'object' && !Array.isArray(value);
export const entryGroup = (kind: EntryKind, owner: string): string => `${kind}\u0000${owner}`;

/** Splits a state into rows. It does not change `state`. */
export function split(state: CollaborationState): Split {
  const root = JSON.parse(JSON.stringify(state)) as Container;
  const out: Split = { frame: '', entities: new Map(), entries: new Map(), commands: new Map() };
  const list = (kind: EntryKind, owner: string, values: unknown) => {
    if (!Array.isArray(values)) throw new Error(`Invalid ${kind} list`);
    out.entries.set(entryGroup(kind, owner), { kind, owner, bodies: values.map(value => JSON.stringify(value)) });
  };
  for (const [kind, path] of MAPS) {
    const at = parent(root, path), name = path.at(-1)!, map = at && own(at, name);
    if (map === undefined) continue;
    if (!plain(map)) throw new Error(`Invalid ${kind} map`);
    const rows = new Map<string, string>();
    for (const [id, value] of Object.entries(map)) {
      if (kind === 'room') {
        if (!plain(value)) throw new Error('Invalid room');
        list(ROOM_MESSAGE, storedKey(id), value.messages);
        value.messages = [];
      }
      rows.set(storedKey(id), JSON.stringify(value));
    }
    out.entities.set(kind, rows);
    at![name] = {};
  }
  for (const [kind, path] of LISTS) {
    const at = parent(root, path), name = path.at(-1)!;
    if (!at || own(at, name) === undefined) continue;
    list(kind, '', at[name]);
    at[name] = [];
  }
  const commands = own(root, 'commands');
  if (commands !== undefined) {
    if (!plain(commands)) throw new Error('Invalid command records');
    for (const [id, record] of Object.entries(commands)) {
      if (!plain(record) || typeof record.evidence !== 'string' || !plain(record.result)) throw new Error('Invalid command record');
      out.commands.set(storedKey(id), { evidence: record.evidence, result: JSON.stringify(record.result) });
    }
    root.commands = {};
  }
  out.frame = JSON.stringify(root);
  if (Buffer.byteLength(out.frame) > FRAME_MAX_BYTES) throw new Error('Collaboration frame is too large: a state field has no row layout');
  return out;
}

const define = (target: Container, id: string, value: unknown) =>
  Object.defineProperty(target, id, { value, enumerable: true, writable: true, configurable: true });
/** Builds a state from its rows. Rows of each kind arrive in insertion order. */
export function assemble(rows: Split): CollaborationState {
  const root = JSON.parse(rows.frame) as Container;
  for (const [kind, path] of MAPS) {
    const entities = rows.entities.get(kind);
    if (!entities?.size) continue;
    const map = parent(root, path) && own(parent(root, path)!, path.at(-1)!);
    if (!plain(map)) throw new Error(`Stored ${kind} rows have no map in the frame`);
    for (const [key, body] of entities) define(map, idOf(key), JSON.parse(body));
  }
  for (const { kind, owner, bodies } of rows.entries.values()) {
    let target: unknown;
    if (kind === ROOM_MESSAGE) {
      const rooms = own(own(root, 'team') as Container, 'rooms') as Container | undefined;
      const room = rooms && own(rooms, idOf(owner));
      target = plain(room) ? room.messages : undefined;
    } else {
      const path = LISTS.find(([name]) => name === kind)![1];
      target = parent(root, path) && own(parent(root, path)!, path.at(-1)!);
    }
    if (!Array.isArray(target) || target.length) throw new Error(`Stored ${kind} rows have no list in the frame`);
    for (const body of bodies) target.push(JSON.parse(body));
  }
  if (rows.commands.size) {
    const commands = own(root, 'commands');
    if (!plain(commands)) throw new Error('Stored command records have no map in the frame');
    for (const [key, { evidence, result }] of rows.commands) define(commands, idOf(key), { evidence, result: JSON.parse(result) });
  }
  return root as unknown as CollaborationState;
}
