import type { BotTurnOutcome, CreateBotAction, RoomFields, UpdateBotAction } from '@byok-sdk/protocol';
import { hash, canonical, type ExecutionTemplate } from '../../host-execution-core/src/model';
import type { CollaborationState } from './model';
import type { BotProfile, Room, TeamState } from './team-model';

export const NEW_BOTS = ['new_bot_1', 'new_bot_2', 'new_bot_3'] as const;
export const NEW_ROOMS = ['new_room_1'] as const;
export const TEAM_NOTE_LIMIT = 20;
export function activeBot(team: TeamState, id: string): BotProfile {
  const bot = team.bots[id];
  if (!bot || bot.archived) throw new Error('Bot is archived or absent');
  return bot;
}
export function requireMain(team: TeamState, actor: string): void {
  if (!activeBot(team, actor).mainBot) throw new Error('Main Bot role required');
}
export function projectionRequestId(value: unknown): string {
  const digest = hash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
function projection(state: CollaborationState, bot: BotProfile): void {
  const value = { schemaVersion: 'bot-profile.v1', name: bot.name, role: bot.role, persona: bot.persona, model: bot.model };
  const requestId = projectionRequestId([bot.id, bot.revision]);
  state.team.homeOperations.push({ sequence: ++state.sequence, botId: bot.id, status: 'pending', retries: [], request: {
    deviceId: bot.execution.deviceId, payload: { requestId,
      agentRef: { agentId: bot.id, profileRevision: bot.revision }, projectionHash: `sha256:${hash(value)}`, projection: value },
  } });
}
export function createBot(state: CollaborationState, taskId: string, action: CreateBotAction, models: Record<string, ExecutionTemplate>): BotProfile {
  if (!NEW_BOTS.includes(action.localId as typeof NEW_BOTS[number])) throw new Error('Unknown local Bot slot');
  if (Object.values(state.team.bots).filter(b => !b.archived).length >= 24) throw new Error('Team Bot limit is 24');
  const base = models[action.model];
  if (!base || base.payload.requiredToolsets?.length) throw new Error('Unavailable model or connector toolset');
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
export function updateBot(state: CollaborationState, action: UpdateBotAction, models: Record<string, ExecutionTemplate>): void {
  const bot = activeBot(state.team, action.botId);
  if (!['name', 'role', 'persona', 'model'].some(k => k in action)) throw new Error('An update must change a Bot field');
  const model = action.model ?? bot.model, base = models[model];
  if (!base || base.payload.requiredToolsets?.length) throw new Error('Unavailable model or connector toolset');
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
export function roomFields(team: TeamState, fields: RoomFields): Omit<Room, 'id' | 'messages'> {
  if (fields.mode && fields.mode !== 'mention') throw new Error('Only mention mode is supported');
  const members = [...fields.members];
  if (!members.length || members.length > 12 || new Set(members).size !== members.length) throw new Error('Room needs 1 to 12 distinct members');
  members.forEach(id => activeBot(team, id));
  if (fields.admin && !members.includes(fields.admin)) throw new Error('Admin must be a room member');
  return { name: fields.name, members, ...(fields.admin ? { admin: fields.admin } : {}), mode: 'mention', announcement: fields.announcement ?? '' };
}
export function applyManagement(state: CollaborationState, actor: string, taskId: string, outcome: BotTurnOutcome,
  models: Record<string, ExecutionTemplate>, accept: (action: string, work: () => void) => void): void {
  const team = state.team, local: Record<string, string> = {};
  const managed = (kind: string, work: () => void) => accept(kind, () => { requireMain(team, actor); work(); });
  outcome.create_bot?.forEach(action => managed('create_bot', () => { local[action.localId] = createBot(state, taskId, action, models).id; }));
  outcome.update_bot?.forEach(action => managed('update_bot', () => updateBot(state, action, models)));
  outcome.delete_bot?.forEach(action => managed('delete_bot', () => {
    activeBot(team, action.botId).archived = true;
    for (const room of Object.values(team.rooms)) {
      room.members = room.members.filter(id => id !== action.botId);
      if (room.admin === action.botId) delete room.admin;
    }
  }));
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
