// The `.` entry: the L Host (BotCollaboration), its ledger compaction veto, the daemon side of the persona
// projection and the team snapshot validator. Node only: persona.ts loads @byok-sdk/client.
export { BotCollaboration } from './host.js';
export { botCompactVeto } from './compaction.js';
export type { AgentMessageInput, BotOptions, HostIntentCancelResult, HostIntentHandler, HostIntentMessageHandler, MessageServer } from './host.js';
export { TEAM_ROOM_LIMIT, TeamModeError, teamSnapshot, type TeamModeCode, type TeamSnapshot, type TeamSnapshotBot, type TeamSnapshotRoom } from './rules/team.js';
export { createBotPersonaProjection } from './persona.js';
