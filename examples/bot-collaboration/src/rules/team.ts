import { AgentHomeProjectionAgentRefSchema, AgentHomeProjectionValueSchema } from '@byok-sdk/protocol';
import type { Room } from './rooms';
/** Team role checks as pure rules (#739 D1). They read only the Bot rows that the caller gives. */
export function activeBot<B extends { readonly archived: boolean }>(team: { readonly bots: Readonly<Record<string, B>> }, id: string): B {
  const bot = team.bots[id];
  if (!bot || bot.archived) throw new Error('Bot is archived or absent');
  return bot;
}
export function requireMain(team: { readonly bots: Readonly<Record<string, { readonly archived: boolean; readonly mainBot: boolean }>> }, actor: string): void {
  if (!activeBot(team, actor).mainBot) throw new Error('Main Bot role required');
}

/** One Bot of an external team snapshot (#739 Q4c, T1). The Host maps `model` to its own execution template. */
export interface TeamSnapshotBot { id: string; name: string; role: string; persona: string; model: string; mainBot: boolean }
/** `revision` is the authority's team revision. It is not the collaboration commit revision. */
export interface TeamSnapshot { revision: number; bots: TeamSnapshotBot[] }
/** The team mode marker. Present: an external authority owns the Bots, and `revision` is its last applied team revision. */
export interface ExternalTeam { revision: number }
export const TEAM_BOT_LIMIT = 24;
export type TeamModeCode = 'external_team' | 'stale_team';
export class TeamModeError extends Error {
  constructor(readonly code: TeamModeCode, message: string) { super(message); this.name = 'TeamModeError'; }
}
/** T3: the team authority owns the Bots, so local Bot management refuses. */
export function refuseExternalTeam(team: { readonly external?: ExternalTeam }, action: string): void {
  if (team.external) throw new TeamModeError('external_team', `external_team: ${action} is owned by the team authority`);
}
const text = (value: unknown): value is string => typeof value === 'string';
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
      || !text(bot.model) || typeof bot.mainBot !== 'boolean') throw new Error('Invalid team snapshot Bot');
    // The id becomes the projection agentRef and a home directory name. Bot rows are plain object keys, so an id
    // such as `__proto__` or `constructor` is refused too.
    if (bot.id in Object.prototype || !AgentHomeProjectionAgentRefSchema.safeParse({ agentId: bot.id, profileRevision: '1' }).success) {
      throw new Error('Invalid team snapshot Bot id');
    }
    const row = { id: bot.id, name: bot.name, role: bot.role, persona: bot.persona, model: bot.model, mainBot: bot.mainBot };
    // A projection that the server refuses would leave the Bot never ready, so the snapshot is refused first.
    if (!AgentHomeProjectionValueSchema.safeParse(profileProjection(row)).success) throw new Error('Team snapshot Bot projection is too large');
    return row;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(bots.map(bot => bot.id)).size !== bots.length) throw new Error('Duplicate team snapshot Bot');
  if (bots.length > TEAM_BOT_LIMIT) throw new Error(`Team Bot limit is ${TEAM_BOT_LIMIT}`);
  return { revision: row.revision!, bots };
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
