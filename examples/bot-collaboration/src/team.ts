import type { AgentHomeProjectionReadback, BotTurnOutcome, CreateBotAction, RoomFields, UpdateBotAction } from '@byok-sdk/protocol';
import { hash, canonical, type ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { json, type CollaborationState } from './model';
import type { BotProfile, HomeOperation, Room, TeamState } from './team-model';
import type { Publish } from './rules/delegation';
import { roomFields, roomVisibility } from './rules/rooms';

import { NEW_BOTS, NEW_ROOMS } from './rules/schema';
import { DEFAULT_AUTONOMY } from './rules/autonomy';
import { activeBot, admitBotToolsets, archiveBot, profileProjection, refuseExternalTeam, requireMain, TEAM_BOT_LIMIT, type TeamSnapshotBot } from './rules/team';

export { activeBot, admitBotToolsets, NEW_BOTS, NEW_ROOMS, requireMain, roomFields };
export const TEAM_NOTE_LIMIT = 20;
export function projectionRequestId(value: unknown): string {
  const digest = hash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
/**
 * The Agent home flush rules (#793 S13), the pure part of L's `flushHomes`; each Host runs its own I/O around them.
 * `homeHead` gives the pending operation `sequence` when it is its Bot's oldest pending one and the Bot is free
 * (`busy(botId)`: the Bot has an intent with no conclusion). Only a head is flushed.
 */
export function homeHead(team: Pick<TeamState, 'homeOperations'>, sequence: number, busy: (botId: string) => boolean): HomeOperation | undefined {
  const op = team.homeOperations.find(row => row.sequence === sequence);
  if (!op || op.status !== 'pending') return undefined;
  const oldest = team.homeOperations.filter(row => row.botId === op.botId && row.status === 'pending').reduce((a, b) => a.sequence <= b.sequence ? a : b);
  return oldest === op && !busy(op.botId) ? op : undefined;
}
/** The requests of an operation in the order a flush reads them back: the first, then each retry. */
export const homeRequests = (op: HomeOperation) => [op.request, ...op.retries];
export type HomeReadback = Pick<AgentHomeProjectionReadback, 'deviceId' | 'agentRef' | 'requestId' | 'projectionHash' | 'status'>;
/**
 * Checks the readback of one request of the operation. A readback for another device, Agent, request or projection throws
 * `Home readback identity conflict`. Returns it when it is terminal (not `pending`); the flush reads no later request then.
 */
export function checkHomeReadback(request: HomeOperation['request'], read: HomeReadback | undefined): HomeReadback | undefined {
  if (!read) return undefined;
  const payload = request.payload;
  if (read.deviceId !== request.deviceId || !same(read.agentRef, payload.agentRef)
    || read.requestId !== payload.requestId || read.projectionHash !== payload.projectionHash) throw new Error('Home readback identity conflict');
  return read.status !== 'pending' ? read : undefined;
}
/**
 * No request is terminal. Once `retryAt` has passed, adds a retry of the same desired revision with the next durable request
 * id and a backoff (min(60 s, 1 s × 2^n)). Returns the request to enqueue: the latest.
 */
export function planHomeRetry(op: HomeOperation, now: number): HomeOperation['request'] {
  if (op.retryAt !== undefined && now >= op.retryAt) {
    const retry = structuredClone(op.request);
    retry.payload.requestId = projectionRequestId([op.request.payload.requestId, op.retries.length + 1]);
    op.retries.push(retry);
    op.retryAt = now + Math.min(60_000, 1000 * 2 ** Math.min(op.retries.length, 6));
  }
  return op.retries.at(-1) ?? op.request;
}
/** The enqueue of the latest request succeeded: the first retry is due a second later. */
export function homeEnqueued(op: HomeOperation, now: number): void {
  op.retryAt ??= now + 1000;
}
/**
 * Settles the operation with a terminal readback: `applied` or `idempotent` applies it and readies its Bot at that revision;
 * any other status fails it and publishes `persona-failed:<sequence>`.
 */
export function applyHomeTerminal(state: CollaborationState, op: HomeOperation, terminal: HomeReadback, publish: Publish): void {
  if (terminal.status === 'applied' || terminal.status === 'idempotent') {
    op.status = 'applied';
    const bot = state.team.bots[op.botId]!;
    if (bot.revision === op.request.payload.agentRef.profileRevision) bot.readyRevision = bot.revision;
  } else {
    op.status = 'failed'; op.error = terminal.status;
    publish(`persona-failed:${op.sequence}`, json({ owner: op.botId, revision: op.request.payload.agentRef.profileRevision, reason: op.error, recoverable: true }));
  }
}
/** A flush step threw: the operation keeps `pending` with the error. */
export function failHomeFlush(op: HomeOperation, error: unknown): void {
  op.error = String(error instanceof Error ? error.message : error);
}
function projection(state: CollaborationState, bot: BotProfile): void {
  const value = profileProjection(bot);
  const requestId = projectionRequestId([bot.id, bot.revision]);
  state.team.homeOperations.push({ sequence: ++state.sequence, botId: bot.id, status: 'pending', retries: [], request: {
    deviceId: bot.execution.deviceId, payload: { requestId,
      agentRef: { agentId: bot.id, profileRevision: bot.revision }, projectionHash: `sha256:${hash(value)}`, projection: value },
  } });
}
export function createBot(state: CollaborationState, taskId: string, action: CreateBotAction, models: Record<string, ExecutionTemplate>, readOnlyToolsets: readonly string[] = []): BotProfile {
  if (!NEW_BOTS.includes(action.localId as typeof NEW_BOTS[number])) throw new Error('Unknown local Bot slot');
  if (Object.values(state.team.bots).filter(b => !b.archived).length >= TEAM_BOT_LIMIT) throw new Error(`Team Bot limit is ${TEAM_BOT_LIMIT}`);
  const base = models[action.model];
  if (!base) throw new Error('Unavailable model');
  admitBotToolsets(base, readOnlyToolsets);
  const id = hash([taskId, action.localId]);
  if (state.team.bots[id]) throw new Error('Duplicate local Bot slot');
  const execution = structuredClone(base);
  execution.payload.agentRef = { agentId: id, profileRevision: '1' };
  // A new Bot starts in observe (#1229, owner ruling): the owner sees what it would do before it does it.
  const bot: BotProfile = { id, name: action.name, role: action.role, persona: action.persona, model: action.model,
    mainBot: false, archived: false, revision: '1', readyRevision: null, autonomy: DEFAULT_AUTONOMY, execution };
  state.team.bots[id] = bot;
  projection(state, bot);
  return bot;
}
export function updateBot(state: CollaborationState, action: UpdateBotAction, models: Record<string, ExecutionTemplate>, readOnlyToolsets: readonly string[] = []): void {
  const bot = activeBot(state.team, action.botId);
  if (!['name', 'role', 'persona', 'model'].some(k => k in action)) throw new Error('An update must change a Bot field');
  const model = action.model ?? bot.model, base = models[model];
  if (!base) throw new Error('Unavailable model');
  admitBotToolsets(base, readOnlyToolsets);
  const revision = (BigInt(bot.revision) + 1n).toString();
  if (BigInt(revision) > 9223372036854775807n) throw new Error('Profile revision limit');
  const execution = structuredClone(base);
  // Model selection cannot move the Bot home to another device.
  execution.deviceId = bot.execution.deviceId;
  execution.payload.agentRef = { agentId: bot.id, profileRevision: revision };
  Object.assign(bot, { name: action.name ?? bot.name, role: action.role ?? bot.role, persona: action.persona ?? bot.persona,
    model, revision, readyRevision: null, execution });
  projection(state, bot);
}
/**
 * The `teamBot` port of a team snapshot (#739 Q4c). A new Bot gets the snapshot id and its first projection.
 * A profile change takes the `update_bot` path, so it queues the same persona projection (T4).
 * Host persona mode (#879): the Bot takes the Host's profile revision and no projection is queued.
 */
export function writeSnapshotBot(state: CollaborationState, row: TeamSnapshotBot, models: Record<string, ExecutionTemplate>, readOnlyToolsets: readonly string[] = []): void {
  const bot = state.team.bots[row.id];
  if (state.team.external?.persona) { writeHostProfile(state, bot, row, models, readOnlyToolsets); return; }
  if (bot) {
    if (bot.name !== row.name || bot.role !== row.role || bot.persona !== row.persona || bot.model !== row.model) {
      updateBot(state, { botId: row.id, name: row.name, role: row.role, persona: row.persona, model: row.model }, models, readOnlyToolsets);
    }
    return;
  }
  const base = models[row.model];
  if (!base) throw new Error('Unavailable model');
  admitBotToolsets(base, readOnlyToolsets);
  const execution = structuredClone(base);
  execution.payload.agentRef = { agentId: row.id, profileRevision: '1' };
  const created: BotProfile = { id: row.id, name: row.name, role: row.role, persona: row.persona, model: row.model,
    mainBot: false, archived: false, revision: '1', readyRevision: null, autonomy: DEFAULT_AUTONOMY, execution };
  state.team.bots[row.id] = created;
  projection(state, created);
}
/**
 * Host persona mode (#879). The revision never goes back, and a profile change needs a newer revision. A newer revision
 * keeps `readyRevision` at the last revision that the Host reported ready: the Bot stays a delegate target, and its
 * Turns wait for `persona_ready` of the new revision.
 */
function writeHostProfile(state: CollaborationState, bot: BotProfile | undefined, row: TeamSnapshotBot, models: Record<string, ExecutionTemplate>,
  readOnlyToolsets: readonly string[]): void {
  const revision = row.profileRevision!;
  if (bot) {
    const changed = bot.name !== row.name || bot.role !== row.role || bot.persona !== row.persona || bot.model !== row.model;
    if (BigInt(revision) < BigInt(bot.revision)) throw new Error(`Profile revision ${revision} of ${row.id} is older than ${bot.revision}`);
    if (revision === bot.revision) {
      if (changed) throw new Error(`A profile change of ${row.id} needs a newer profile revision`);
      return;
    }
  }
  const base = models[row.model];
  if (!base) throw new Error('Unavailable model');
  admitBotToolsets(base, readOnlyToolsets);
  const execution = structuredClone(base);
  // Model selection cannot move the Bot home to another device.
  if (bot) execution.deviceId = bot.execution.deviceId;
  execution.payload.agentRef = { agentId: row.id, profileRevision: revision };
  const fields = { name: row.name, role: row.role, persona: row.persona, model: row.model, revision, execution };
  if (bot) Object.assign(bot, fields);
  else state.team.bots[row.id] = { id: row.id, ...fields, mainBot: false, archived: false, readyRevision: null, autonomy: DEFAULT_AUTONOMY };
}
export function applyManagement(state: CollaborationState, actor: string, taskId: string, outcome: BotTurnOutcome,
  models: Record<string, ExecutionTemplate>, accept: (action: string, work: () => void) => void, readOnlyToolsets: readonly string[] = []): void {
  const team = state.team, local: Record<string, string> = {};
  const managed = (kind: string, work: () => void) => accept(kind, () => { requireMain(team, actor); work(); });
  // T3: the team authority owns the Bots. Rooms and team notes stay local.
  const bots = (kind: string, work: () => void) => managed(kind, () => { refuseExternalTeam(team, kind); work(); });
  outcome.create_bot?.forEach(action => bots('create_bot', () => { local[action.localId] = createBot(state, taskId, action, models, readOnlyToolsets).id; }));
  outcome.update_bot?.forEach(action => bots('update_bot', () => updateBot(state, action, models, readOnlyToolsets)));
  outcome.delete_bot?.forEach(action => bots('delete_bot', () => archiveBot(team, action.botId)));
  const resolve = (fields: Partial<RoomFields>) => ({ ...fields,
    ...(fields.members ? { members: fields.members.map(id => local[id] ?? id) } : {}),
    ...(fields.admin ? { admin: local[fields.admin] ?? fields.admin } : {}),
  });
  outcome.create_room?.forEach(action => managed('create_room', () => {
    if (!NEW_ROOMS.includes(action.localId as typeof NEW_ROOMS[number])) throw new Error('Unknown local room slot');
    const id = hash([taskId, action.localId]);
    if (team.rooms[id]) throw new Error('Duplicate local room slot');
    team.rooms[id] = { id, ...roomFields(team, resolve(action) as RoomFields), messages: [] };
  }));
  outcome.update_room?.forEach(action => managed('update_room', () => {
    const room = team.rooms[action.roomId];
    if (!room) throw new Error('Room not found');
    if (!['name', 'members', 'admin', 'mode', 'announcement'].some(k => k in action)) throw new Error('An update must change a room field');
    const fields = { ...room, ...resolve(action) };
    if (!action.admin && !fields.members.includes(fields.admin ?? '')) delete fields.admin;
    const next = roomFields(team, fields);
    next.visibleFrom = roomVisibility(room, next.members);
    Object.assign(room, next);
    if (!next.admin) delete room.admin;
  }));
  if (outcome.team_note) managed('team_note', () => {
    if (team.notes.length >= TEAM_NOTE_LIMIT) throw new Error('Team note limit is 20');
    if (!outcome.team_note!.text.trim() || [...outcome.team_note!.text].length > 300) throw new Error('Team note needs 1 to 300 characters');
    team.notes.push({ id: hash([taskId, 'team_note']), text: outcome.team_note!.text });
  });
}
export function same(value: unknown, other: unknown): boolean { return canonical(value) === canonical(other); }
