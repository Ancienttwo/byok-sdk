import { admitBotToolsets } from './toolset-policy';
import type { BotTurnOutcome, CreateBotAction, RoomFields, UpdateBotAction } from '@byok-sdk/protocol';
import { hash, canonical, type ExecutionTemplate } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from './model';
import type { BotProfile, Room } from './team-model';
import { roomFields, roomVisibility } from './rules/rooms';

import { NEW_BOTS, NEW_ROOMS } from './rules/schema';
import { activeBot, archiveBot, profileProjection, refuseExternalTeam, requireMain, TEAM_BOT_LIMIT, type TeamSnapshotBot } from './rules/team';

export { activeBot, NEW_BOTS, NEW_ROOMS, requireMain, roomFields };
export const TEAM_NOTE_LIMIT = 20;
export function projectionRequestId(value: unknown): string {
  const digest = hash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
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
  const bot: BotProfile = { id, name: action.name, role: action.role, persona: action.persona, model: action.model,
    mainBot: false, archived: false, revision: '1', readyRevision: null, execution };
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
 */
export function writeSnapshotBot(state: CollaborationState, row: TeamSnapshotBot, models: Record<string, ExecutionTemplate>, readOnlyToolsets: readonly string[] = []): void {
  const bot = state.team.bots[row.id];
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
    mainBot: false, archived: false, revision: '1', readyRevision: null, execution };
  state.team.bots[row.id] = created;
  projection(state, created);
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
