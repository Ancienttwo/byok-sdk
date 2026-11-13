// The `./host-kit` entry: the L modules a Host adapter composes (model, channel, delivery, routines, team,
// migration, retention, dreaming, adapter steps). It does not load the L Host or @byok-sdk/client, so a Worker
// can bundle it.
import { botTurnInstruction as buildBotTurnInstruction, type BotHistoryState, type ContextTurn, type InstructionLimits } from './rules/context.js';
import { outcomeSchema, promptActions, type CheckedOffer, type ContextRoutine, type ContextState } from './rules/schema.js';
import type { RoomMessage } from './rules/rooms.js';
import type { Turn } from './rules/turn.js';

/** Inputs used by sync to freeze a Bot Turn's instruction. */
export interface BotTurnInstructionOptions<R extends ContextRoutine = ContextRoutine> {
  state: ContextState & BotHistoryState; turn: Turn; limits: InstructionLimits; models: readonly string[];
  routines?: readonly R[]; injected?: readonly ContextTurn[]; room?: readonly RoomMessage[]; offer?: CheckedOffer;
}
/** Compute the instruction sync freezes, with the same history, routines and offer. */
export function botTurnInstruction<R extends ContextRoutine>(options: BotTurnInstructionOptions<R>): { instruction: string } {
  const routines = options.routines ?? [];
  const schema = outcomeSchema(options.turn.botId, options.state, options.turn, options.models, routines, options.offer);
  const { instruction } = buildBotTurnInstruction(options.state, options.turn, options.limits, routines, options.injected, options.room, promptActions(schema, options.offer));
  return { instruction };
}
export type { InstructionLimits } from './rules/context.js';
export { DelegationError, HostIntentError } from './rules/delegation.js';
export { IntentOutcomeError } from './adapter-steps.js';
export { RetentionRefused, retainRoots } from './retention.js';
export type { RetentionFacts, RetentionInput, RetentionRefusedCode, RetentionLimits, RetentionResult, RetentionStore } from './retention.js';
export { refuseRetired, retiredIdentity, RetiredIdentityError, type AdmittedIds, type RetiredNamespace } from './rules/commands.js';
export type { DelegationCancelResult, TurnCancelResult } from './rules/delegation.js';
export type { MessageDisposition } from './rules/message.js';
export { contextTurns, historyRowFromTurn, type ContextTurn } from './rules/context.js';
export { classifyInbound, inboundKey } from './channel.js';
export type { ChannelOptions, ChannelPort, Conversation, Delivery, DeliveryState, InboundClass, InboundMessage, Principal, PushRoute, ReplyRoute } from './channel.js';
export { BOT_REPLY_MAX_BYTES, DEFAULT_INSTRUCTION_MAX_BYTES, minimumInstructionBytes } from './delegation.js';
export { SYSTEM_PROMPT, contextPack, outcomeOffer, outcomeSchema, DEFAULT_CONTEXT_MAX_BYTES, DEFAULT_CONTEXT_TURN_LIMIT, DEFAULT_HANDOFF_BUDGETS } from './schema.js';
export type { CheckedOffer, ConfirmableSpec, MainAction, OutcomeOffer, TurnAction } from './schema.js';
export type { Card, CollaborationState, Delegation, InputBatch, ReplyEntry, SealReason, Turn, UserInput } from './model.js';
export { BOT_DREAM, BOT_ROUTINE, botRoutines } from './routines.js';
export { DEFAULT_DREAM_MAX_DURATION_MS, DREAM_WAIT_MS, type DreamBot, type DreamingOptions, type DreamRecord, type DreamSkip, type DreamState, type OpenDream } from './dream.js';
export { CommitConflict, commitInLedger, migrateWouldDo, retainInLedger, revisionOf } from './commit.js';
export type { Command, CommandPorts, CommitRequest, CommitResult, Disposition, OutboxIntent, WouldDoMigration } from './commit.js';
export type { BotRoutine, BotRoutineInput } from './routines.js';
export type { BotProfile, Room, Round, Seat, TeamState } from './team-model.js';
export { DEFAULT_MEMBER_MENTIONS, ROOM_GRACE_MS, ROOM_CONTEXT_BYTES, ROOM_CONTEXT_MESSAGES, memberMentions, type MemberMentions, type RoomMessage } from './rooms.js';
export { TEAM_NOTE_LIMIT } from './team.js';
export { DEFAULT_AUTONOMY, autonomyOf, wouldDoRows, type Autonomy, type WouldDo, type WouldDoAction } from './rules/autonomy.js';
export { inboundDisposition, inboundDispositions, type InboundDisposition, type InboundRow, type InboundState } from './rules/inbound.js';
export { DEVICE_CONCURRENCY } from './rules/priority.js';
export { DeviceModeError, type DeviceTopology, type SwitchWork } from './topology.js';
export { SWITCH_EXPORT_VERSION, SWITCH_SECTIONS, SwitchExportError, sealSwitchExport, switchAttempts, verifySwitchExport, type ArchivedRecord, type ExecutionRecord, type IntentRecord, type MessageReceipt,
  type OccurrenceRecord, type OutboxRecord, type RoutineRecord, type SwitchContent, type SwitchDevice, type SwitchExport, type SwitchExportRefusal,
  type SwitchManifest, type SwitchSection, type TombstoneRecord } from './migration.js';
export { commitImport, discardImport, importForSwitch } from './switch.js';
export { DeviceSwitchingError, SwitchExportedError, SwitchImportedError, type SwitchReceipt } from './migration.js';
export { botOutcomePorts, outcomeFailure, routeTerminal, runHostIntentHandler, syncHead, syncTail } from './adapter-steps.js';
export { isOwner, verified } from './channel.js';
export { admitUserInput } from './coalesce.js';
export { acceptDeliveryEcho, readbackDelivery, recoverDelivery, settleDelivery, startDelivery, unknownDelivery } from './delivery.js';
export { cleanReplyTokens, deliveryRoute, echoCandidates, enablePush, promoteStaged, queueDelivery, refuseRoute, rememberInbound, resendUnknown,
  revokePush, type IntentConclusions } from './delivery-routing.js';
export { checkDreamInstruction, dreamIntentIds, dreamPolicy, reconcileDreamRoutines, recordDream, syncDreams, type DreamSync } from './dream.js';
export { exportMarkOf, type SwitchExportMark, type SwitchHeader } from './migration.js';
export { stateOf } from './model.js';
export { concludeRoutineTurn, createDefinition, endable, owned, resealDefinition, ROUTINE_LATE_AFTER_MS, ROUTINE_WAIT_MS, routineCalendar,
  routineOccurrence, routineTurn, sealedDefinition, sealedRoutineInstruction, sealedTemplate, SealedRoutineVersionError, updateDefinition,
  type SealedRoutineAction } from './routines.js';
export { sealLedger } from './switch.js';
export { applyHomeTerminal, applyManagement, applyModels, checkHomeReadback, failHomeFlush, homeEnqueued, homeHead, homeRequests, planHomeRetry,
  updateBot, writeSnapshotBot, type HomeReadback } from './team.js';
