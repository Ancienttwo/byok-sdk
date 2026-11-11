import { AgentHomeProjectionAgentRefSchema, AgentHomeProjectionProfileRevisionSchema, AgentHomeProjectionValueSchema } from '@byok-sdk/protocol';
import type { RoomFields } from '@byok-sdk/protocol';
import { roomFields, type MemberMentions, type Room } from './rooms.js';
/** Team role checks as pure rules (#739 D1). They read only the Bot rows that the caller gives. */
export function activeBot<B extends { readonly archived: boolean }>(team: { readonly bots: Readonly<Record<string, B>> }, id: string): B {
  const bot = team.bots[id];
  if (!bot || bot.archived) throw new Error('Bot is archived or absent');
  return bot;
}
export function requireMain(team: { readonly bots: Readonly<Record<string, { readonly archived: boolean; readonly mainBot: boolean }>> }, actor: string): void {
  if (!activeBot(team, actor).mainBot) throw new Error('Main Bot role required');
}
/** A Bot execution may name only the connector toolsets that the Host declared read-only. */
export function admitBotToolsets(execution: { readonly payload: { readonly requiredToolsets?: readonly string[] } }, readOnlyToolsets: readonly string[] = []): void {
  for (const id of execution.payload.requiredToolsets ?? []) {
    if (!readOnlyToolsets.includes(id)) throw new Error(`Bot executions cannot have connector toolsets not declared read-only by the Host: ${id}`);
  }
}

/**
 * One Bot of an external team snapshot (#739 Q4c, T1). The Host maps `model` to its own execution template.
 * `profileRevision` is the Host's profile revision, a decimal string. It is required when the Host owns the persona
 * projection (#879), and refused otherwise.
 */
export interface TeamSnapshotBot {
  id: string; name: string; role: string; persona: string; model: string; mainBot: boolean; profileRevision?: string;
  /** #1319: the Bot stays in the team but takes no new K8 work. A later snapshot without it restores the Bot. */
  participation?: 'suspended';
}
/** One room of an external team snapshot in the external rooms mode (#1321). Its members are Bots of the same snapshot. */
export type TeamSnapshotRoom = RoomFields & { id: string; memberMentions?: MemberMentions };
/**
 * `revision` is the authority's team revision. It is not the collaboration commit revision.
 * `rooms` (#1321): the authority's whole room list, present exactly in the external rooms mode.
 */
export interface TeamSnapshot { revision: number; bots: TeamSnapshotBot[]; rooms?: TeamSnapshotRoom[] }
/**
 * The team mode marker. Present: an external authority owns the Bots, and `revision` is its last applied team revision.
 * `persona` (#879): the Host projects each Bot's Agent home and reports readiness with `persona_ready`. The ledger keeps it.
 * `rooms` (#1321): the team snapshot also owns the rooms and their memberMentions. The ledger keeps it.
 */
export interface ExternalTeam { revision: number; persona?: true; rooms?: true }
export const TEAM_BOT_LIMIT = 24;
export const TEAM_ROOM_LIMIT = 64;
export type TeamModeCode = 'external_team' | 'stale_team' | 'external_persona' | 'bot_suspended' | 'external_rooms';
export class TeamModeError extends Error {
  constructor(readonly code: TeamModeCode, message: string) { super(message); this.name = 'TeamModeError'; }
}
/**
 * The one check of whether a Bot can take new work (#1319). Absent or archived: `archived`. A suspended Bot is still a team
 * member, so membership and return checks read `archived` instead.
 */
export function inactive(bot: { readonly archived: boolean; readonly participation?: 'suspended' } | undefined): 'archived' | 'suspended' | undefined {
  if (!bot || bot.archived) return 'archived';
  return bot.participation;
}
/** A command that would give a suspended Bot new work refuses, and the commit writes nothing. */
export function refuseSuspended(team: { readonly bots: Readonly<Record<string, { readonly archived: boolean; readonly participation?: 'suspended' }>> },
  botId: string): void {
  if (inactive(team.bots[botId]) === 'suspended') throw new TeamModeError('bot_suspended', `bot_suspended: Bot ${botId} is not participating`);
}
/** T3: the team authority owns the Bots, so local Bot management refuses. */
export function refuseExternalTeam(team: { readonly external?: ExternalTeam }, action: string): void {
  if (team.external) throw new TeamModeError('external_team', `external_team: ${action} is owned by the team authority`);
}
/** #1321: in the external rooms mode the team authority owns the rooms, so local room management refuses. */
export function refuseExternalRooms(team: { readonly external?: ExternalTeam }, action: string): void {
  if (team.external?.rooms) throw new TeamModeError('external_rooms', `external_rooms: ${action} is owned by the team authority`);
}
/**
 * The one room id rule of an owner `create_room` and a snapshot room (#1321). No `:`, so a `room-message:<roomId>:<messageId>`
 * projection id has one reading. Room rows are plain object keys, so an `Object.prototype` key is refused too.
 */
export function roomId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value in Object.prototype) throw new Error('Invalid room id');
  return value;
}
const text = (value: unknown): value is string => typeof value === 'string';
/** A profile revision is the protocol's canonical positive decimal string: the protocol schema owns the rule. */
export function profileRevision(value: unknown): string {
  const parsed = AgentHomeProjectionProfileRevisionSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid profile revision');
  return parsed.data;
}
/** The persona projection value of a Bot profile. `update_bot` and a team snapshot write the same value. */
export function profileProjection(bot: { readonly name: string; readonly role: string; readonly persona: string; readonly model: string }) {
  return { schemaVersion: 'bot-profile.v1', name: bot.name, role: bot.role, persona: bot.persona, model: bot.model };
}
/** A validated copy, with the Bots sorted by id: the Bot order is not content. */
export function teamSnapshot(value: unknown): TeamSnapshot {
  const row = value as Partial<TeamSnapshot> | null;
  if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.revision) || row.revision! < 1 || !Array.isArray(row.bots)) {
    throw new Error('Invalid team snapshot');
  }
  const bots = row.bots.map(bot => {
    if (!bot || typeof bot !== 'object' || !text(bot.id) || !bot.id || !text(bot.name) || !text(bot.role) || !text(bot.persona)
      || !text(bot.model) || typeof bot.mainBot !== 'boolean' || bot.participation !== undefined && bot.participation !== 'suspended') {
      throw new Error('Invalid team snapshot Bot');
    }
    // The id becomes the projection agentRef and a home directory name. Bot rows are plain object keys, so an id
    // such as `__proto__` or `constructor` is refused too.
    if (bot.id in Object.prototype || !AgentHomeProjectionAgentRefSchema.safeParse({ agentId: bot.id, profileRevision: '1' }).success) {
      throw new Error('Invalid team snapshot Bot id');
    }
    const row: TeamSnapshotBot = { id: bot.id, name: bot.name, role: bot.role, persona: bot.persona, model: bot.model, mainBot: bot.mainBot,
      ...(bot.profileRevision === undefined ? {} : { profileRevision: profileRevision(bot.profileRevision) }),
      // Only a suspended row carries the field, so a snapshot without it keeps its evidence.
      ...(bot.participation ? { participation: bot.participation } : {}) };
    // A projection that the server refuses would leave the Bot never ready, so the snapshot is refused first.
    if (!AgentHomeProjectionValueSchema.safeParse(profileProjection(row)).success) throw new Error('Team snapshot Bot projection is too large');
    return row;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(bots.map(bot => bot.id)).size !== bots.length) throw new Error('Duplicate team snapshot Bot');
  if (bots.length > TEAM_BOT_LIMIT) throw new Error(`Team Bot limit is ${TEAM_BOT_LIMIT}`);
  if (row.rooms === undefined) return { revision: row.revision!, bots };
  if (!Array.isArray(row.rooms)) throw new Error('Invalid team snapshot');
  // The room rules read only `archived` of a member: each Bot of this snapshot is active. No prototype, so a member id such as
  // `constructor` is absent.
  const team = { bots: Object.assign(Object.create(null) as Record<string, { archived: boolean }>,
    Object.fromEntries(bots.map(bot => [bot.id, { archived: false }]))) };
  const rooms = row.rooms.map(room => {
    if (!room || typeof room !== 'object' || !text(room.name) || !Array.isArray(room.members) || !room.members.every(text)
      || room.admin !== undefined && (!text(room.admin) || !room.admin) || room.mode !== undefined && room.mode !== 'mention'
      || room.announcement !== undefined && !text(room.announcement)
      || room.memberMentions !== undefined && room.memberMentions !== 'execute' && room.memberMentions !== 'ignore') {
      throw new Error('Invalid team snapshot room');
    }
    const copy: TeamSnapshotRoom = { id: roomId(room.id), name: room.name, members: [...room.members],
      ...(room.admin === undefined ? {} : { admin: room.admin }), ...(room.mode === undefined ? {} : { mode: room.mode }),
      ...(room.announcement === undefined ? {} : { announcement: room.announcement }),
      ...(room.memberMentions === undefined ? {} : { memberMentions: room.memberMentions }) };
    roomFields(team, copy, true);
    return copy;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(rooms.map(room => room.id)).size !== rooms.length) throw new Error('Duplicate team snapshot room');
  if (rooms.length > TEAM_ROOM_LIMIT) throw new Error(`Team room limit is ${TEAM_ROOM_LIMIT}`);
  return { revision: row.revision!, bots, rooms };
}
/** `delete_bot` and a team snapshot archive a Bot the same way: it leaves every room. */
export function archiveBot(team: { readonly bots: Readonly<Record<string, { archived: boolean }>>; rooms: Record<string, Room> }, botId: string): void {
  activeBot(team, botId).archived = true;
  for (const room of Object.values(team.rooms)) {
    room.members = room.members.filter(id => id !== botId);
    if (room.visibleFrom) delete room.visibleFrom[botId];
    if (room.admin === botId) delete room.admin;
  }
}
