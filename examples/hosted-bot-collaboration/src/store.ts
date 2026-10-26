import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonical, hash, occurrenceRun, taskId, time, type Conclusion, type ExecutionTemplate, type FrozenInput, type HostJobHandler,
  type HostJobRun, type HostJobRoutineDefinition, type IntentInput, type Json, type Routine } from '@byok-sdk/example-host-execution-core';
import { botRoutines, endable, owned, resealDefinition, routineTurn, sealedDefinition, sealedTemplate, updateDefinition, type BotRoutineInput,
  type SealedRoutineAction } from '@byok-sdk/example-bot-collaboration/routines';
import { admitBotToolsets, applyHomeTerminal, applyManagement, failHomeFlush, homeEnqueued, homeHead, planHomeRetry, requireMain, updateBot,
  writeSnapshotBot, type HomeReadback } from '@byok-sdk/example-bot-collaboration/team';
import { admitUserInput, coalescePolicy, projectInputBatches, sealDueBatches, type CoalescePolicy, type InputFields } from '@byok-sdk/example-bot-collaboration/coalesce';
/** A K8 `update_routine` action. */
type UpdateRoutineAction = Parameters<typeof updateDefinition>[2];
import { addTurn, stateOf, type Card, type CollaborationState, type Turn } from '@byok-sdk/example-bot-collaboration/model';
import { advanceRoomSeats, cardCallDue, checkReply, CONNECTOR_OUTCOME_UNKNOWN, collaborationDue, commitCommand, expireCards, observeDevices, replyCheckDue, reportCardDecisions,
  seatTurn, settleCardCall, settleDelegations, syncTurn, type Command, type CommandPorts, type DelegationTimers, type ReplyCheck, type SyncOptions, type SyncStep } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { revisionOf, type CommitRequest, type CommitResult, type OutboxIntent } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { activeBinding, beginSwitch, refusesHomeWrites, switchFence, bindDevice, deviceRefusals, endSwitch, openSwitch, revokeDevice, DeviceSwitchRefusedError, type DeviceBinding } from './binding';
import { acknowledgedTurnIds, decideCompaction, type IntentCompaction, type IntentCompactionInput } from './compaction';
import { DDL, STORE_VERSION, SUPPORTED_STORE_VERSIONS } from './ddl';
import { cancelIntent, deliverCancels, freezeIntent, frozenIntent, intentConclusions, seatFacts, settleFacts, syncFacts, writeSyncStep } from './intents';
import { decideMessage, messageCommandId, type AgentMessageInput, type MessageDecision } from './messages';
import { decideFinish, type HostedIntentHandler, type IntentOutcomeError, type TaskEvidence } from './reconcile';
import { archivedRow, commitStored, decideRetention } from './retention';
import { dueRoutine, hostedRoutineCommands, hostJobCommands, hostJobRowKey, loadSlice, planSlice, recordDue, switchDueVersions,
  writeSlice } from './routines';
import type { RetentionInput, RetentionLimits, RetentionResult } from '@byok-sdk/example-bot-collaboration/retention';
import { classifyInbound, inboundKey, verified, type ChannelPort, type Delivery, type InboundClass, type InboundMessage, type PushRoute,
  type ReplyRoute } from '@byok-sdk/example-bot-collaboration/channel';
import { acceptDeliveryEcho, readbackDelivery, recoverDelivery, settleDelivery, startDelivery, unknownDelivery } from '@byok-sdk/example-bot-collaboration/delivery';
import { cleanReplyTokens, deliveryRoute, echoCandidates, enablePush, refuseRoute, rememberInbound, resendUnknown,
  revokePush } from '@byok-sdk/example-bot-collaboration/delivery-routing';
import { assemble, entryGroup, idOf, split, storedKey, type EntityKind, type EntryKind, type Split } from './layout';
import { sealSwitchExport, type SwitchExport } from '@byok-sdk/example-bot-collaboration/migration';
import { exportMarkOf, hostedSwitchContent, SwitchExportedError, type SwitchExportMark } from './switch';

/** A stored scope row of a store version that this code does not support. Nothing was written. */
export class HostedStoreVersionError extends Error {
  constructor(readonly version: number) { super(`Unsupported hosted collaboration store version ${version}`); this.name = 'HostedStoreVersionError'; }
}
export type Publish = (id: string, value: Json) => void;
/** `now` is the clock of the writer. A transaction that settles a delivery must give it, for the outbox index. */
export type Decision<T> = { value: T; outbox: OutboxIntent[]; now?: number };
type Decide<T> = (state: CollaborationState, publish: Publish, client: PoolClient) => Decision<T> | Promise<Decision<T>>;
type TurnHistory = NonNullable<SyncOptions<never>['history']>;
/**
 * The sync options of a scope. In history mode, `history` holds the rows of each Turn that may freeze, by Turn id.
 * The store reads the routines and their sealed templates itself (#793 D2f, #953). The delegation timers are store options
 * (#793 S4). The model names and the read-only toolsets come from the scope's Host config (#793 S9).
 */
export type HostedSyncOptions = Omit<SyncOptions<never>, 'history' | 'routines' | 'models' | 'readOnlyToolsets' | 'sealedTemplate'>
  & { history?: ReadonlyMap<string, TurnHistory> };
/** `dueAt`: the scope's due time after the sync, the value that it wrote to `scope.due_at` (#793 S4). */
export interface SyncResult { dueAt: number | null }
/**
 * The Host config of one scope, as L's `BotOptions.models` and `readOnlyToolsets` (#793 S9). A model template carries the
 * device that a new Bot runs on, so each scope has its own: the user's own devices.
 */
export interface HostConfig { models: Record<string, ExecutionTemplate>; readOnlyToolsets?: readonly string[] }
/** The outcome ports of the routine actions of a callback command. The store builds the committed intents and `manage`. */
export type OutcomeRoutinePorts = Omit<NonNullable<CommandPorts['outcome']>, 'committed' | 'manage'>;
/**
 * The command ports that the store builds on the state of the open transaction, as L `commitOwner` builds them (K8 host.ts),
 * from the scope's Host config. `manage` is the outcome team management of one task. No caller supplies a port (#793 S9).
 */
export type StorePorts = Omit<CommandPorts, 'intents' | 'deliver' | 'outcome' | 'occurrence' | 'remember' | 'admitInput' | 'routines'>
  & { manage(taskId: string): NonNullable<CommandPorts['outcome']>['manage'] };
/** The K4 callback commands. Only `finish`, `consume` and `fire` build them. */
const CALLBACK_KINDS = new Set<Command['kind']>(['outcome', 'message', 'occurrence']);
/** `commit()` takes no K4 callback command (#793 D2f-6). Nothing was written: no scope row and no command record. */
export class CallbackCommandError extends Error {
  constructor(readonly kind: Command['kind']) {
    super(`commit() does not take the K4 callback command ${kind}`);
    this.name = 'CallbackCommandError';
  }
}
/** `commit()` takes no inbound `receive` command: `receive()` runs it, with the store's `remember` port (#793 D2b-out-3). */
export class InboundCommandError extends Error {
  constructor() {
    super('commit() does not take the inbound receive command; receive() runs it');
    this.name = 'InboundCommandError';
  }
}
/**
 * Who the Host is on its channels, as L's options give it: the owner principal, and the Host's own bot ids by channel.
 * It is Host configuration from verified identity, never a field of the message.
 */
export interface InboundIdentity { owner: string; self?: Record<string, readonly string[]> }
export interface HostedStoreOptions {
  /**
   * The Host config of a scope: its model templates and read-only toolsets (#793 S9). Every port and sync reads it. A store
   * method awaits it once, and never while it holds a connection, so a product may read the one scope's record when it is
   * asked, from the store's own pool too.
   */
  host: (scope: string) => Promise<HostConfig>;
  /** The Host has a channel: a K4 callback queues its channel deliveries, as L does with `channel` set. */
  channel?: boolean;
  /**
   * The delegation timers of the K8 settlement and of the scope's due time, as L's (#793 D2f-5, S4). Without them the rule's
   * defaults apply.
   */
  timers?: DelegationTimers;
  /**
   * Input coalescing, as L's `coalesce` option: the policy that K8 `coalescePolicy` returns for the ContextPack budget that
   * the Host gives each sync in `limits`. Each sync checks it against that budget. Without it, each input keeps its own Turn.
   */
  coalesce?: CoalescePolicy;
  /**
   * The handlers of the Host's own Host job routines (#793 S14), by type, as L's `hostJobs`. The store checks a Host job
   * routine against them, and the outbox sender runs them. A Host job may return only a summary: a result with `execution`
   * concludes its occurrence `failed` (owner Q4 A).
   */
  hostJobs?: Readonly<Record<string, HostJobHandler>>;
  /**
   * The handlers of the Host's own intents (#955), by name, as L's `hostIntents`. `enqueueHostIntent` stores the name on the
   * intent row, and the terminal transaction of a `task.complete` result runs that handler.
   */
  hostIntents?: Readonly<Record<string, HostedIntentHandler>>;
}
/** A Host intent (#955): its key, its stable task id, and its conclusion once it has one. */
export interface HostIntent { key: string; taskId: string; conclusion?: Conclusion }
/** The delegation fields that a reply check read. A settle applies only while they are unchanged. */
export interface ReplyFence { checks?: number; nextCheckAt: number }
/**
 * One due reply check (#793 S7): the delegation, its fence, and the chain end's frozen task. A chain end with no intent row
 * has no task.
 */
export interface DueReplyCheck {
  delegationId: string;
  fence: ReplyFence;
  task?: { taskId: string; deviceId: string; agentRef: FrozenInput['payload']['agentRef'] };
}
/**
 * The sender's view of one delivery step (#793 D2b-out-2). `none`: the claim changed nothing. `moved`: it changed the entity
 * or its wait, and there is nothing to call. `send`: the claim committed; send `body` on `route` now. `readback`: read back
 * the row's `unknown` attempt `attempt`, and give its result with that attempt and `lease`, the `next_at` that the claim wrote.
 */
export type DeliveryClaim = { kind: 'none' } | { kind: 'moved' } | { kind: 'readback'; attempt: number; lease: number }
  | { kind: 'send'; attempt: number; route: ReplyRoute | PushRoute; body: string };
/** The outbox index times of a delivery that the sender owns: its lease, and the wait of an `unknown` row. */
export interface DeliveryTimes {
  leaseMs: number;
  /** The channel has a readback. An `unknown` row is read back at the next pass, and `readbackMs` after each readback. */
  readback: boolean;
  readbackMs: number;
}
/** How long an `unknown` delivery with no readback waits: only an echo or a manual resend changes it (#793 D2b-out E6). */
export const UNKNOWN_WAIT_MS = 3_600_000;
type SendResult = Awaited<ReturnType<ChannelPort['send']>>;
type ReadbackResult = Awaited<ReturnType<NonNullable<ChannelPort['readback']>>>;

/**
 * The sender's view of one card call claim (#793 S12). `none`: nothing to call. `ended`: an earlier claim's lease passed with
 * no settle, so the claim ended the card as a timeout and the scope changed. `call`: call the connector once, then settle
 * with `tries`.
 */
export type CardClaim = { kind: 'none' } | { kind: 'ended' } | { kind: 'call'; tries: number; action: string; draft: Json };
type HomeOperation = CollaborationState['team']['homeOperations'][number];
/**
 * The sender's view of one Agent home claim (#793 S13). `none`: nothing to flush now. `flush`: read back each request of
 * `op` in order, then settle with `retries` (the operation's retry count at the claim) as the fence. `lease` is the
 * `next_at` that the claim wrote; a settle that plans an enqueue keeps it until `homeEnqueued`.
 */
export type HomeClaim = { kind: 'none' } | { kind: 'flush'; op: HomeOperation; retries: number; lease: number };
/** One settle of an Agent home flush: a terminal readback, a retry plan (no request is terminal), or a step that threw. */
export type HomeStep = { terminal: HomeReadback } | { retry: true } | { error: unknown };
/** The outbox key of an Agent home operation's row. */
export const homeRowKey = (sequence: number): string => JSON.stringify(['home', sequence]);
/** The outbox key of a card's connector call row. An array key never equals a projection id. */
export const cardRowKey = (cardId: string): string => JSON.stringify(['card', cardId]);
/** The error of a Host job result that carries `execution` (owner Q4 A): its occurrence concludes `failed` with it. */
export const HOST_JOB_EXECUTION_UNSUPPORTED = 'host_job_execution_unsupported';
/**
 * The sender's view of one Host job claim (#793 S14). `none`: nothing to run. `run`: call the handler of `run.type` once, then
 * settle with `tries`, which is also the K4 `attempt`.
 */
export type HostJobClaim = { kind: 'none' } | { kind: 'run'; tries: number; run: Omit<HostJobRun, 'signal'> };
/**
 * One Host job settle: a valid summary, with `unsupported` when the result carried `execution`, or a handler that threw,
 * timed out or returned no JSON summary.
 */
export type HostJobOutcome = { summary: Json; unsupported: boolean } | { error: unknown };
/** The stored text of a failed outbox step: the error message, cut to 1024 characters. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1024);

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
/**
 * Snapshots the Turn and room seat ids of `state` and the input count of each input batch. The returned function gives the
 * device of each Bot of a row that adds work since: a new Turn that is not concluded (a cancel concludes the Turn that it
 * seals), a new room seat, and a new input batch or one that took another input. In insertion order, once each. A row whose
 * Bot is not in the team is left to the rule that reads it.
 */
function addedDevices(state: CollaborationState): () => string[] {
  const turns = new Set(Object.keys(state.turns)), seats = new Set(Object.keys(state.team.seats));
  const inputs = new Map(Object.values(state.inputBatches ?? {}).map(batch => [batch.id, batch.inputIds.length]));
  return () => {
    const bots = [...Object.values(state.turns).filter(turn => !turns.has(turn.id) && !turn.conclusion).map(turn => turn.botId),
      ...Object.values(state.team.seats).filter(seat => !seats.has(seat.id)).map(seat => seat.botId),
      ...Object.values(state.inputBatches ?? {}).filter(batch => inputs.get(batch.id) !== batch.inputIds.length).map(batch => batch.botId)];
    return [...new Set(bots.flatMap(botId => state.team.bots[botId] ? [state.team.bots[botId]!.execution.deviceId] : []))];
  };
}
/** The open work of a device during its switch (#957), by kind. `homes`: sequences of sent Agent home writes with no terminal readback. */
export interface DeviceWork { intents: string[]; turns: string[]; batches: string[]; homes: number[] }
/** The open work of `deviceId` in `state` and the intent rows. The caller's transaction reads it. */
async function openWork(client: PoolClient, scopeKey: string, state: CollaborationState, deviceId: string): Promise<DeviceWork> {
  const bots = state.team.bots, onDevice = (botId: string) => Object.hasOwn(bots, botId) && bots[botId]!.execution.deviceId === deviceId;
  const intents = (await client.query<{ key: string }>(`SELECT key FROM intent WHERE scope = $1 AND conclusion IS NULL AND input->>'deviceId' = $2
    ORDER BY ordinal`, [scopeKey, deviceId])).rows.map(row => idOf(row.key));
  return { intents,
    turns: Object.values(state.turns).filter(turn => !turn.conclusion && onDevice(turn.botId)).map(turn => turn.id),
    batches: Object.values(state.inputBatches ?? {}).filter(batch => batch.state === 'open' && onDevice(batch.botId)).map(batch => batch.id),
    // A home write that was never sent is not work on the device: it moves with the exported state.
    homes: state.team.homeOperations.filter(op => op.status === 'pending' && op.sent && op.request.deviceId === deviceId).map(op => op.sequence) };
}
const releasedSeats = (state: CollaborationState) => Object.values(state.team.seats).filter(seat => seat.released).length;
const EMPTY_FRAME = split(stateOf({})).frame;

/**
 * The H store of the #739 D1 commit contract (#793 D2a): one Postgres transaction holds the state change,
 * the command record and the outbox rows. A commit locks its scope row first, so the commits of one scope
 * run one at a time. H has no K4 to deduplicate terminals and messages, so it records callbacks too.
 */
export class HostedCollaborationStore {
  private readonly channel: boolean;
  private readonly coalesce?: CoalescePolicy;
  private readonly timers: DelegationTimers | undefined;
  private readonly host: (scope: string) => Promise<HostConfig>;
  /** The Host job handlers by type (#793 S14). */
  readonly hostJobs: ReadonlyMap<string, HostJobHandler>;
  /** The Host intent handlers by name (#955). */
  private readonly hostIntents: ReadonlyMap<string, HostedIntentHandler>;
  constructor(private readonly pool: Pool, readonly schema: string, options: HostedStoreOptions) {
    if (typeof options?.host !== 'function') throw new Error('The Host config of each scope is required');
    this.host = options.host;
    this.hostJobs = new Map(Object.entries(options.hostJobs ?? {}));
    this.hostIntents = new Map(Object.entries(options.hostIntents ?? {}));
    this.channel = options.channel === true;
    // The ContextPack budget comes with each sync, so the construction checks every bound except that one.
    if (options.coalesce) this.coalesce = coalescePolicy(options.coalesce, Number.MAX_SAFE_INTEGER);
    if (!SCHEMA.test(schema)) throw new Error('Invalid hosted collaboration schema name');
    // As L checks its timers (K8 host.ts constructor).
    const timers = options.timers;
    if (timers && (time(timers.cancelGraceMs) < 1 || time(timers.uncertainAfterMs) < 1)) throw new Error('Invalid delegation timers');
    this.timers = timers && { cancelGraceMs: timers.cancelGraceMs, uncertainAfterMs: timers.uncertainAfterMs };
  }

  /** Creates the schema and its tables when they are absent. */
  async migrate(): Promise<void> {
    await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hosted-collaboration:${this.schema}`]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await client.query(DDL);
    }, false);
  }

  /**
   * Runs one command through the commit contract. `scope` is the scope that the authenticated caller owns;
   * a request for another scope is a `scope_mismatch` conflict. A throw leaves every row unchanged.
   *
   * This is the command entry's call, so it refuses the K4 callback commands (`outcome`, `message`, `occurrence`) with
   * `CallbackCommandError` before any write (#793 D2f-6). They come only from `finish`, `consume` and `fire`, which build
   * them from SDK evidence or a due slot.
   *
   * A new `cancel_turn` of a Turn with a frozen intent runs the K4 cancel in the same transaction, in L's order (K8
   * host.ts `cancelTurn`): the commit, the cancel of the intent, then the version switch check (#793 D2f-4). A new commit
   * that leaves a delegation cancel fact to deliver (`cancel_turn` of an open chain, `cancel_delegation`,
   * `abandon_delegation`) delivers it in the same transaction, as L `settleChain` does after its commit.
   *
   * `end_routine` (§55c) runs on the routine slice of the scope, as L `endRoutine` runs K4 `setLifecycle` in its commit: the store
   * gives the K8 rule its `routines` port, and a new acceptance writes the slice back.
   *
   * The store builds every command port from the scope's Host config (#793 S9). `clock` is the Host clock.
   *
   * With `requireBinding` (the command entry's commits, #793 S10), a new commit checks, under the scope lock, that each Bot
   * of the work that the commit added (see `addedDevices`) runs on a device with an active H binding, and throws
   * `DeviceBindingError` otherwise, so the commit rolls back. It reads what the K8 rule produced, so H keeps no copy of the
   * mention and seat selection.
   */
  commit(scope: string, request: CommitRequest<Command>, clock: () => number, options: { requireBinding?: boolean } = {}): Promise<CommitResult> {
    if (CALLBACK_KINDS.has(request.command.kind)) return Promise.reject(new CallbackCommandError(request.command.kind));
    if (request.command.kind === 'receive') return Promise.reject(new InboundCommandError());
    return this.commitWith(scope, request, clock, undefined, options.requireBinding === true ? 'binding' : undefined);
  }

  /**
   * The inbound channel entry (#793 D2b-out-3), as L `receive()` (K8 host.ts). K8 `classifyInbound` sorts the message:
   * - `echo`: in one transaction under the scope lock, K8 `echoCandidates` and `acceptDeliveryEcho` settle the one delivery
   *   that the echo names, or an `unmatched_echo` audit line is written; then the reply tokens are cleaned. The delivery index
   *   follows the entity. An echo never creates input.
   * - `owner_input` and `room_input`: the K8 `receive` command, under the command id `hash(['receive', inboundKey])`, so a
   *   redelivered event replays. With a channel, the store's `remember` port (K8 `rememberInbound`) keeps the inbound and its
   *   reply route.
   * - `bot_background`: the K8 `room_input` command of a bot, with no mention, as L `roomInput`.
   * - every other kind: an audit line only, one for each delivery, as L.
   * Returns the kind, and the Turn id of an input. The authenticated command entry calls it with the scope of its owner,
   * and with `identity` from the Host's configuration, never from the message.
   */
  async receive(scope: string, message: InboundMessage, identity: InboundIdentity, clock: () => number): Promise<{ kind: InboundClass; id?: string }> {
    const kind = classifyInbound(message, identity.owner, identity.self), { channel, conversation, platformMessageId, sender } = message;
    const turnOf = (result: CommitResult) => {
      if (result.disposition.outcome !== 'accepted') throw new Error(`Inbound refused: ${JSON.stringify(result.disposition)}`);
      return result.disposition.value as string;
    };
    if (kind === 'echo') {
      await this.change(scope, undefined, async (state, _publish, client) => {
        const now = clock(), matches = echoCandidates(state, message);
        if (matches.length !== 1 || !acceptDeliveryEcho(matches[0]!, platformMessageId)) state.audit.push(`Delivery unmatched_echo: ${channel} ${platformMessageId}`.slice(0, 1024));
        cleanReplyTokens(await intentConclusions(client, scope), state, now);
        return { value: undefined, outbox: [], now };
      });
      return { kind };
    }
    if (kind === 'owner_input' || kind === 'room_input') {
      const key = inboundKey(message), from = sender!.id;
      const command: Command = kind === 'owner_input'
        ? { kind: 'receive', inbound: kind, key, botId: conversation.id, request: message.text, sender: from }
        : { kind: 'receive', inbound: kind, key, roomId: conversation.id, text: message.text, mentions: message.mentions, from };
      // Input for a Bot whose device is switching, or was switched to L, rolls back with the typed refusal (#957). Input for
      // an unbound or revoked device is still taken and held by the sync (#956): the channel entry is not the command entry.
      const result = await this.commitWith(scope, { scope, commandId: hash(['receive', key]), command }, clock,
        state => ({ remember: this.channel ? (root: string) => rememberInbound(state, message, root) : undefined }), 'switch');
      return { kind, id: turnOf(result) };
    }
    if (kind === 'bot_background') {
      // R5: a bot message is room background. Its mention entities select no seat.
      const key = inboundKey(message);
      const result = await this.commitWith(scope, { scope, commandId: hash(['room_input', conversation.id, key]),
        command: { kind: 'room_input', key, roomId: conversation.id, text: message.text, mentions: [], from: sender!.id } }, clock, undefined, 'switch');
      return { kind, id: turnOf(result) };
    }
    const who = verified(sender) ? ` ${sender.kind}:${sender.id}` : '';
    await this.change(scope, undefined, async state => {
      state.audit.push(`Inbound ${kind}: ${channel} ${conversation.kind}:${conversation.id} ${platformMessageId}${who}`.slice(0, 1024));
      return { value: undefined, outbox: [], now: clock() };
    });
    return { kind };
  }

  /**
   * The commit body, which takes the callback commands too, with the given routine ports of an outcome. Host code only: the
   * shared K8 vectors reach it through a test subclass, as L's vector subject commits through `commitInLedger`.
   */
  protected commitIn(scope: string, request: CommitRequest<Command>, clock: () => number, outcome?: OutcomeRoutinePorts): Promise<CommitResult> {
    const command = request.command;
    return this.commitWith(scope, request, clock, (_state, ports) => outcome && command.kind === 'outcome'
      ? { outcome: { ...outcome, manage: ports.manage(command.taskId) } } : {});
  }

  /** One commit with the store's ports and `extra`, the ports that only the store's own entries add. */
  private async commitWith(scope: string, request: CommitRequest<Command>, clock: () => number,
    extra?: (state: CollaborationState, ports: StorePorts) => { remember?: CommandPorts['remember']; outcome?: Omit<NonNullable<CommandPorts['outcome']>, 'committed'> },
    fence?: 'binding' | 'switch', guard?: (client: PoolClient) => Promise<void>): Promise<CommitResult> {
    const key = storedKey(scope), config = await this.host(scope);
    return this.change(scope, request.commandId, async (state, publish, client) => {
      await guard?.(client);
      // The store admits each input with its own policy, as L does (K8 host.ts `commitOwner`), so the admission and the sync's
      // seal use one policy.
      const { manage, ...own } = this.ports(config, state, publish, clock), head = revisionOf(state);
      const slice = request.command.kind === 'end_routine' ? await loadSlice(client, key) : undefined;
      const commands = slice && hostedRoutineCommands(slice, own.now());
      const base = { ...own, ...extra?.(state, { ...own, manage }), admitInput: (fields: InputFields) => admitUserInput(state, fields, this.coalesce, own.now()),
        routines: commands && { end: (id: string) => commands.lifecycle(endable(commands.list(), id).definition.id, 'completed') } };
      const before = fence ? addedDevices(state) : undefined;
      const result = await commitStored(client, scope, state, request, base, this.channel);
      // A new commit moves the head by 1. A replay returns its first result and writes nothing.
      if (result.revision !== head + 1) return { value: result, outbox: [] };
      if (before) for (const deviceId of before()) await (fence === 'binding' ? activeBinding : switchFence)(client, key, deviceId);
      const value = result.disposition.outcome === 'accepted'
        ? result.disposition.value as { target?: string; admitted?: boolean; deliver?: boolean } | undefined : undefined;
      if (request.command.kind === 'cancel_turn' && value?.admitted && value.target !== undefined) {
        const now = base.now();
        await cancelIntent(client, scope, value.target, now);
        await switchDueVersions(client, key, now);
      } else if (value?.deliver) await deliverCancels(client, scope, state, base.now());
      if (slice && result.disposition.outcome === 'accepted') {
        await writeSlice(client, key, slice);
        await switchDueVersions(client, key, base.now());
      }
      return { value: result, outbox: result.outbox, now: base.now() };
    });
  }

  /**
   * The command ports of one transaction on `state`, from the scope's Host config, as L `commitOwner` and `applyOutcome` build
   * them (K8 host.ts). The route ports exist only with a channel.
   */
  private ports(config: HostConfig, state: CollaborationState, publish: Publish, now: () => number): StorePorts {
    const { models, readOnlyToolsets = [] } = config;
    return { now, publish,
      updatePersona: (botId, persona) => updateBot(state, { botId, persona }, models, readOnlyToolsets),
      teamBot: row => writeSnapshotBot(state, row, models, readOnlyToolsets),
      ...(this.channel ? { routes: {
        enable: (conversation, channel, target, owner) => enablePush(state, conversation, channel, target, owner, now()).id,
        revoke: routeId => revokePush(state, routeId, now()),
        resend: deliveryId => resendUnknown(state, deliveryId, now()).id,
      } } : {}),
      manage: taskId => (turn, outcome, managed) => applyManagement(state, turn.botId, taskId, outcome, models, managed, readOnlyToolsets) };
  }

  /**
   * Appends one audit line to the scope's state, in its own transaction, as L's `audit` (K8 host.ts). The command entry writes
   * an R2 refusal with it before it throws (#793 S10). Adapter data can be unverified, so a line is cut to 1024 characters.
   */
  async audit(scope: string, line: string, clock: () => number): Promise<void> {
    await this.change(scope, undefined, async state => {
      state.audit.push(line.slice(0, 1024));
      return { value: undefined, outbox: [], now: clock() };
    });
  }

  /**
   * Changes a scope's state outside the commit contract, in one transaction. For seeds and fixtures. It writes no outbox
   * row: no projection, and no delivery index row.
   */
  async seed(scope: string, mutate: (state: CollaborationState) => void): Promise<void> {
    await this.change(scope, undefined, state => { mutate(state); return { value: undefined, outbox: [] }; }, false);
  }

  /** The stored state of a scope, with every command record. A scope row of an unknown store version is refused. */
  async read(scope: string): Promise<CollaborationState> {
    return this.transaction(client => this.snapshot(client, storedKey(scope)), true);
  }

  /** Every stored row of a scope, in a fixed order, as text. */
  async dump(scope: string): Promise<string> {
    return this.transaction(async client => {
      const rows = [];
      for (const query of [
        'SELECT state_version, frame::text, due_at::text, switch_export::text FROM scope WHERE scope = $1',
        'SELECT kind, key, ordinal::text, body::text FROM entity WHERE scope = $1 ORDER BY kind, key',
        'SELECT kind, owner, position::text, body::text FROM entry WHERE scope = $1 ORDER BY kind, owner, entry.position',
        'SELECT key, ordinal::text, evidence, result::text, root FROM command WHERE scope = $1 ORDER BY key',
        'SELECT key, ordinal::text, kind, body::text FROM outbox WHERE scope = $1 ORDER BY key',
        `SELECT key, task_id, ordinal::text, agent, source, input::text, wait_until::text, submission, tries, next_at::text, last_error,
          cancel_reason, conclusion, started, attempt::text, terminal::text, reconcile_at::text, retry_until::text, retry::text, preparation_error
          FROM intent WHERE scope = $1 ORDER BY key`,
        'SELECT device, ordinal::text, mode, mode_revision::text, revoked_at::text FROM device_binding WHERE scope = $1 ORDER BY device',
        'SELECT kind, identity, expires_at::text FROM retired_identity WHERE scope = $1 ORDER BY kind, identity',
        'SELECT namespace, id, body::text, expires_at::text FROM archived_row WHERE scope = $1 ORDER BY namespace, id',
        `SELECT id, ordinal::text, definition::text, pending::text, lifecycle, status, next_at::text, calendar_errors::text,
          schedule_retry_at::text, schedule_retry_count, last_error::text FROM routine WHERE scope = $1 ORDER BY id`,
        `SELECT key, ordinal::text, routine_id, definition_version, trigger_kind, planned_at::text, recorded_at::text, next_at::text,
          execution_superseded, conclusion FROM occurrence WHERE scope = $1 ORDER BY key`,
      ]) rows.push((await client.query({ text: query, values: [storedKey(scope)], rowMode: 'array' })).rows);
      return JSON.stringify(rows);
    }, true);
  }

  /**
   * One Host sync of a scope (#793 D2b-2): the sync rule for each stored Turn, in insertion order, in one transaction
   * under the scope lock. It reads the intent facts in that transaction, and writes each step with the state and the
   * projections. Every frozen instruction lists the scope's Bot routines, in insertion order. A routine Turn joins the FIFO
   * as its occurrence intent, and a routine Turn that ends before that concludes its occurrence (#793 D2f). It writes no
   * command record and keeps the revision. A throw writes nothing.
   *
   * Each round then runs the K8 delegation settlement at L's position, after the Turn steps (K8 host.ts sync), on the intent
   * facts read again after those steps wrote. Then it delivers each new delegation cancel fact in the same transaction, as
   * the L pass does after its sync (#793 D2f-5). The K8 card steps run at L's positions too (#793 S5): `expireCards` before
   * the Turn steps, and `reportCardDecisions` after the settlement. A decided card's `action_result` Turn starts a new round.
   *
   * It runs to a fixed point, as the L pass drains again after a step that changed K4 (K8 host.ts pass): while a round
   * froze, promoted or concluded an intent or an occurrence, delivered a cancel fact, added a Turn (the `bot_reply` of a
   * batch join, or an `action_result`), or released a seat (a blocked or retired seat Turn), it reads the facts again and
   * runs the Turns again. Each such step happens once per intent, occurrence, fact, join or seat, so the rounds end.
   */
  async sync(scope: string, options: HostedSyncOptions): Promise<SyncResult> {
    // As L checks its coalesce policy against its ContextPack budget (K8 host.ts constructor).
    if (this.coalesce) coalescePolicy(this.coalesce, options.limits.contextMaxBytes);
    const key = storedKey(scope), config = await this.host(scope), models = Object.keys(config.models), readOnlyToolsets = config.readOnlyToolsets ?? [];
    return this.change(scope, undefined, async (state, publish, client) => {
      const published = new Set<string>();
      const slice = await loadSlice(client, key), routines = botRoutines(Object.values(slice.state.routines));
      const emit: Publish = (id, body) => { publish(id, body); published.add(id); };
      let more = true;
      while (more) {
        // As L's sync, a batch sealed here gets its Turn's step in this round, before later Turns of its Bot.
        sealDueBatches(state, this.coalesce, options.now);
        // As L's sync, card expiry runs before the Turn steps, so a ContextPack frozen in this round shows it.
        expireCards(state, options.now);
        // As L's sync, the room step runs before the Turn steps, so a seat Turn that it adds freezes in this round. The K4
        // cancel of a seat's admitted work is H's `cancelIntent`, as for a delegation cancel.
        const seats = await seatFacts(client, scope, Object.keys(state.team.seats));
        for (const seatId of advanceRoomSeats(state, seats, options.now, (id, botId, request) => addTurn(state, seatTurn(id, botId, request)))) {
          await cancelIntent(client, scope, seatId, options.now);
        }
        const released = releasedSeats(state);
        const facts = await syncFacts(client, scope, Object.keys(state.turns), state.team.bots);
        const steps: Array<[Turn, SyncStep<ExecutionTemplate>]> = [];
        for (const turn of Object.values(state.turns)) {
          const step = syncTurn(state, turn, facts, { ...options, models, readOnlyToolsets, routines, history: options.history?.get(turn.id),
            sealedTemplate: ref => sealedTemplate(Object.values(slice.state.routines), ref) }, emit);
          if (step) steps.push([turn, step]);
        }
        more = false;
        for (const [turn, step] of steps) more = await writeSyncStep(client, scope, turn, step, slice, options.now) || more;
        const turns = Object.keys(state.turns).length;
        settleDelegations(state, await settleFacts(client, scope, Object.keys(state.turns)), options.now, emit, this.timers);
        reportCardDecisions(state, emit);
        // A Turn step can release a seat (a blocked seat Turn): the room step then runs again, so the next seat gets its Turn.
        more = await deliverCancels(client, scope, state, options.now) || Object.keys(state.turns).length > turns || releasedSeats(state) > released || more;
      }
      await writeSlice(client, key, slice);
      await switchDueVersions(client, key, options.now);
      // As L's sync (K8 host.ts `sync`), H's sync drops expired and unreserved reply tokens. L's call in each flush pass is a
      // call in each delivery settle here (`finishDelivery`).
      if (state.channel) cleanReplyTokens(await intentConclusions(client, scope), state, options.now);
      // Last, as in L's sync: it sees every seal of this sync and of earlier transactions.
      projectInputBatches(state, emit);
      return { value: { dueAt: await this.dueAt(client, key, state) }, outbox: [...published].map(id => ({ kind: 'projection' as const, id })), now: options.now };
    });
  }

  /**
   * Owner API for the Main Bot's own routines (#793 D2f), as L `updateRoutine` (K8 host.ts:462-467): stages the next version of
   * routine `action.routineId` of Bot `botId`. The authenticated command entry calls it. A refusal writes nothing.
   */
  updateRoutine(scope: string, botId: string, action: UpdateRoutineAction, now: number): Promise<void> {
    return this.routineCommand(scope, botId, now, commands => commands.update(updateDefinition(commands.list(), botId, action)));
  }
  /**
   * Owner API for a sealed routine of the Main Bot `botId` (#953), from the owner's member endpoint: adds version 1 with the
   * member's template, checked against the Bot's current execution template. A retry is a no-op while version 1 is the
   * definition. A refusal writes nothing.
   */
  createSealedRoutine(scope: string, botId: string, action: SealedRoutineAction, now: number): Promise<void> {
    return this.routineCommand(scope, botId, now, (commands, execution) => commands.create(sealedDefinition(commands.list(), botId, action, execution)));
  }
  /**
   * Owner API (#953): stages version `max(current, pending) + 1` of a sealed routine of the Main Bot `botId` with a new
   * template. A template sealed for another version throws `SealedRoutineVersionError`, and nothing is written. A retry is
   * a no-op while its version is current or staged, also after the Bot's Agent changed: the freeze then reports
   * `sealed_routine_agent_changed`.
   */
  resealRoutine(scope: string, botId: string, action: SealedRoutineAction, now: number): Promise<void> {
    return this.routineCommand(scope, botId, now, (commands, execution) => commands.update(resealDefinition(commands.list(), botId, action, execution)));
  }
  /** Owner API, as L `setRoutineLifecycle` (K8 host.ts:456-461): pauses, resumes or completes a routine of the Main Bot `botId`. */
  setRoutineLifecycle(scope: string, botId: string, id: string, lifecycle: Routine['lifecycle'], now: number): Promise<void> {
    return this.routineCommand(scope, botId, now, commands => commands.lifecycle(owned(commands.list(), botId, id).definition.id, lifecycle));
  }
  private routineCommand(scope: string, botId: string, now: number,
    run: (commands: ReturnType<typeof hostedRoutineCommands>, execution: ExecutionTemplate) => void): Promise<void> {
    const key = storedKey(scope);
    return this.change(scope, undefined, async (state, _publish, client) => {
      // H has no Host-wide Bot id, so the caller names the acting Bot. Only the Main Bot owns this API.
      requireMain(state.team, botId);
      const slice = await loadSlice(client, key);
      run(hostedRoutineCommands(slice, now), state.team.bots[botId]!.execution);
      await writeSlice(client, key, slice);
      await switchDueVersions(client, key, now);
      return { value: undefined, outbox: [] };
    });
  }

  /**
   * Host API, as L's `core.addRoutine` for a Host job (#793 S14): adds a Host job routine to `scope`, checked by K4 against
   * the store's handlers. Host code calls it; no Bot command or entry reaches it. A refusal writes nothing.
   */
  addHostJobRoutine(scope: string, definition: HostJobRoutineDefinition, now: number): Promise<void> {
    return this.hostJobCommand(scope, now, commands => commands.create(definition));
  }
  /** Host API, as L's `core.updateRoutine` for a Host job: stages the next version, which switches once no old work is open. */
  updateHostJobRoutine(scope: string, definition: HostJobRoutineDefinition, now: number): Promise<void> {
    return this.hostJobCommand(scope, now, commands => commands.update(definition));
  }
  /** Host API, as L's `core.lifecycle` for a Host job: pauses, resumes or completes it. A Bot routine id is refused. */
  setHostJobLifecycle(scope: string, id: string, lifecycle: Routine['lifecycle'], now: number): Promise<void> {
    return this.hostJobCommand(scope, now, commands => commands.lifecycle(id, lifecycle));
  }
  private hostJobCommand(scope: string, now: number, run: (commands: ReturnType<typeof hostJobCommands>) => void): Promise<void> {
    const key = storedKey(scope);
    return this.change(scope, undefined, async (_state, _publish, client) => {
      const slice = await loadSlice(client, key);
      run(hostJobCommands(slice, now, this.hostJobs));
      await writeSlice(client, key, slice);
      await switchDueVersions(client, key, now);
      return { value: undefined, outbox: [] };
    });
  }

  /**
   * Fires the due slot of routine `id` (#793 D2f-3, scheduler note §2.2), as K4 `consume` records an occurrence and runs its
   * hook in one transaction: the occurrence row, the routine's next slot, the supersede of its earlier untried intents and
   * the K8 routine Turn commit together, under the scope lock. The K8 `occurrence` command gets no record, as in L: the slot
   * is the replay guard. A routine that is not active, or whose slot is not due, is `skipped` with nothing written: another
   * pass fired it, or a command changed it.
   *
   * The fire can create execution, so the owner Bot's device must have an active H binding (#793 D2e), read from the state of
   * this transaction, as the sync builds the routine offer from it. Otherwise it throws `DeviceBindingError` and writes
   * nothing, and the slot stays due. The promotion checks the binding again. An archived owner Bot skips the fence: its
   * routine Turn creates no execution, because the sync ends it before any freeze, as L does. A revoke and an archive are both
   * final, so with the fence that slot could never fire.
   *
   * A Host job routine (#793 S14) records its occurrence and its `host_job` outbox row, as K4 `recordOccurrence` does, with no
   * K8 command and no fence: a Host job creates no execution. The outbox sender runs it.
   *
   * It runs no version switch: a fire leaves its new occurrence open, so K4 `versionSwitchDue` stays false for the routine.
   */
  fire(scope: string, id: string, now: number): Promise<'fired' | 'skipped'> {
    const key = storedKey(scope);
    return this.transaction(client => this.decideIn(client, key, undefined, async (state, publish) => {
      const slice = await loadSlice(client, key), routine = dueRoutine(slice, id, now);
      if (!routine) return { value: 'skipped' as const, outbox: [] };
      if (routine.definition.hostJob) {
        await writeSlice(client, key, slice, recordDue(slice, scope, routine, now).key);
        return { value: 'fired' as const, outbox: [] };
      }
      const owner = (routine.definition.hostOccurrence?.input as BotRoutineInput | undefined)?.owner;
      const bot = owner === undefined ? undefined : state.team.bots[owner];
      if (!bot) throw new Error('Routine owner Bot not found');
      if (!bot.archived) await activeBinding(client, key, bot.execution.deviceId);
      const occurrence = recordDue(slice, scope, routine, now);
      const run = occurrenceRun(routine, occurrence);
      const result = commitCommand(state, { scope, commandId: occurrence.key, command: { kind: 'occurrence', key: occurrence.key } },
        { scope, recordCallbacks: false }, { now: () => now, publish, occurrence: () => routineTurn(state, run) });
      await writeSlice(client, key, slice, occurrence.key);
      return { value: 'fired' as const, outbox: result.outbox };
    }), false);
  }

  /**
   * The schedule upkeep of the scope's routines (#793 D2f-3, scheduler note §2.6), under the scope lock. `start` re-plans an
   * active routine with no slot within the horizon, as K4 `recover`. Both phases set `ok` on a `schedule_retrying` routine
   * whose slot is within the horizon, as K4 `scheduleNext`. Then a staged version switches when it is due.
   */
  planRoutines(scope: string, now: number, phase: 'start' | 'pass'): Promise<void> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      await lockScope(client, key);
      const slice = await loadSlice(client, key);
      planSlice(slice, now, phase);
      await writeSlice(client, key, slice);
      await switchDueVersions(client, key, now);
    }, false);
  }

  /**
   * The SDK `agentMessage.consume` decision for one Agent message of `scope` (#793 D2c), as K4 `consumeMessage` decides it.
   * One transaction under the scope lock checks the frozen binding and the task's accepted reply, and commits the `message`
   * command. A scope with no row has no task, so it is refused with nothing written. A throw writes nothing and leaves the
   * SDK admission pending.
   */
  async consume(scope: string, input: AgentMessageInput, clock: () => number): Promise<MessageDecision> {
    const key = storedKey(scope);
    const refused: MessageDecision = { outcome: 'refused', reasonCode: 'unknown_task' };
    const exists = (client: PoolClient) => client.query('SELECT 1 FROM scope WHERE scope = $1', [key]).then(found => found.rows.length > 0);
    // The scope check runs alone first, so a scope that H does not have reads no Host config, and the config is read with no
    // connection held. The check in the transaction is the one that decides.
    if (!await this.transaction(exists, true)) return refused;
    const config = await this.host(scope);
    return this.transaction(async client => {
      if (!await exists(client)) return refused;
      return this.decideIn(client, key, messageCommandId(input), (state, publish) => decideMessage(client, scope, state, input,
        this.ports(config, state, publish, clock), this.channel));
    }, false);
  }

  /**
   * The terminal transaction of one reconciled task of `scope` (#793 D2d), as K4 `finish`: the outcome command, the
   * projections and the intent's conclusion commit together, under the scope lock. Returns the conclusion that it wrote,
   * or nothing when the intent already had one. A throw writes nothing.
   */
  async finish(scope: string, turnId: string, evidence: TaskEvidence, clock: () => number): Promise<Conclusion | undefined> {
    const config = await this.host(scope);
    return this.transaction(client => this.decideIn(client, storedKey(scope), evidence.terminal.envelope.task_id,
      (state, publish) => decideFinish(client, scope, turnId, state, evidence, this.ports(config, state, publish, clock), this.channel,
        this.hostIntents)), false);
  }

  /**
   * Host API (#955), as L's `enqueueHostIntent` (K8 host.ts): the Host's own work in the scope's FIFOs, with Host authority.
   * One transaction under the scope lock saves the intent row with its handler name. Its outcome goes to that handler, never
   * to a Bot Turn. On a Bot's agentRef, it shares that Bot's FIFO. An exact replay returns the same intent, until compaction
   * removes the row. It refuses, with nothing written, a handler that the store does not have, connector toolsets that the
   * scope's Host config does not declare read-only, a key that is a Bot Turn, a key whose row has another handler or none,
   * and every refusal of `freezeIntent`: another identity, a retired key, a retry policy, and a device with no active H binding.
   */
  async enqueueHostIntent(scope: string, input: IntentInput, handler: string, clock: () => number): Promise<HostIntent> {
    if (!this.hostIntents.has(handler)) throw new Error(`Unknown Host intent handler: ${handler}`);
    admitBotToolsets(input.execution, (await this.host(scope)).readOnlyToolsets ?? []);
    const scopeKey = storedKey(scope), key = storedKey(input.key);
    return this.change(scope, undefined, async (state, _publish, client) => {
      if (Object.hasOwn(state.turns, input.key)) throw new Error('Host intent identity conflict: the key is a Bot Turn');
      const prior = (await client.query<{ handler: string | null }>('SELECT handler FROM intent WHERE scope = $1 AND key = $2', [scopeKey, key])).rows[0];
      if (prior && prior.handler !== handler) throw new Error('Host intent identity conflict');
      const frozen = await freezeIntent(client, scope, { ...input, handler });
      const row = (await client.query<{ conclusion: Conclusion | null }>('SELECT conclusion FROM intent WHERE scope = $1 AND key = $2', [scopeKey, key])).rows[0]!;
      return { value: { key: input.key, taskId: frozen.taskId, ...(row.conclusion ? { conclusion: row.conclusion } : {}) }, outbox: [], now: clock() };
    });
  }

  /**
   * Records a terminal of `scope` that the reconciliation refused (#955), as L's `reportIntentFailures`: the reason goes to
   * the open intent's `last_error`, and a reason that differs from the stored one writes one audit line, so a stuck intent
   * adds one line and not one for each pass, in any number of processes.
   */
  async refuseTerminal(scope: string, error: IntentOutcomeError, clock: () => number): Promise<void> {
    await this.change(scope, undefined, async (state, _publish, client) => {
      const changed = await client.query(`UPDATE intent SET last_error = $3 WHERE scope = $1 AND key = $2 AND conclusion IS NULL
        AND last_error IS DISTINCT FROM $3`, [storedKey(scope), storedKey(error.key), `${error.code}: ${error.message}`]);
      if (changed.rowCount) state.audit.push(`Intent outcome refused ${error.code}: ${error.key} ${error.message}`.slice(0, 1024));
      return { value: undefined, outbox: [], now: clock() };
    });
  }

  /**
   * The settle of the owner's `failStuckIntent` (#955), after the reconciliation refused the terminal of `error.key`: in one
   * transaction under the scope lock, the open intent concludes `failed` with no terminal, its audit line is written, and a
   * staged routine version that is now due switches. A settled intent refuses with `Intent already settled`.
   */
  failIntent(scope: string, error: IntentOutcomeError, clock: () => number): Promise<void> {
    const scopeKey = storedKey(scope);
    return this.change(scope, undefined, async (state, _publish, client) => {
      const now = clock();
      const settled = await client.query(`UPDATE intent SET conclusion = 'failed', last_error = NULL WHERE scope = $1 AND key = $2
        AND conclusion IS NULL`, [scopeKey, storedKey(error.key)]);
      if (!settled.rowCount) throw new Error(`Intent already settled: ${error.key}`);
      state.audit.push(`Intent failed by owner ${error.code}: ${error.key} ${error.message}`.slice(0, 1024));
      await switchDueVersions(client, scopeKey, now);
      return { value: undefined, outbox: [], now };
    });
  }

  /**
   * The due reply checks of `scope` at `now` (#793 S7), selected by K8 `replyCheckDue` as L's `flushReplies` selects them,
   * read in one snapshot with no lock. A scope with no row has none.
   */
  replyChecks(scope: string, now: number): Promise<DueReplyCheck[]> {
    return this.transaction(async client => {
      const checks: DueReplyCheck[] = [];
      for (const d of Object.values((await this.snapshot(client, storedKey(scope))).delegations)) {
        if (!replyCheckDue(d, now)) continue;
        const frozen = await frozenIntent(client, scope, taskId(d.chainTurnIds.at(-1)!, 0));
        checks.push({ delegationId: d.id, fence: { ...(d.checks === undefined ? {} : { checks: d.checks }), nextCheckAt: d.nextCheckAt! },
          ...(frozen ? { task: { taskId: frozen.input.taskId, deviceId: frozen.input.deviceId, agentRef: frozen.input.payload.agentRef } } : {}) });
      }
      return checks;
    }, true);
  }

  /**
   * Applies one reply check (#793 S7), the K8 `checkReply` decision with the store's timers, in one transaction under the
   * scope lock. The SDK read ran before, outside any transaction. The clock is read after the lock is taken, as L reads it
   * again in its ledger transaction. When the delegation is gone, is no longer due at that time (a verdict, or a later
   * check time), or no longer matches `fence` (another check applied first), it writes nothing and returns false. A throw
   * writes nothing.
   */
  settleReplyCheck(scope: string, delegationId: string, fence: ReplyFence, check: ReplyCheck, clock: () => number): Promise<boolean> {
    return this.transaction(client => this.decideIn(client, storedKey(scope), undefined, async (state, publish) => {
      const now = clock(), d = state.delegations[delegationId];
      if (!d || !replyCheckDue(d, now) || d.checks !== fence.checks || d.nextCheckAt !== fence.nextCheckAt) return { value: false, outbox: [] };
      const published = new Set<string>();
      checkReply(state, d, check, now, (id, body) => { publish(id, body); published.add(id); }, this.timers?.uncertainAfterMs);
      return { value: true, outbox: [...published].map(id => ({ kind: 'projection' as const, id })), now };
    }), false);
  }

  /**
   * Whether `scope` has a delegation that a device observation can change (#793 S11), as L's `refreshDevices` checks before
   * its discovery read: no verdict, no cancel, and `queued` or `waiting_device`. Read in one snapshot with no lock.
   */
  async awaitsDevice(scope: string): Promise<boolean> {
    const state = await this.transaction(client => this.snapshot(client, storedKey(scope)), true);
    return Object.values(state.delegations).some(d => !d.verdict && !d.cancel && (d.status === 'queued' || d.status === 'waiting_device'));
  }

  /**
   * Applies one device observation (#793 S11), the K8 `observeDevices` rule on the intent facts, in one transaction under the
   * scope lock, as L's `refreshDevices` runs it in one ledger transaction. `devices` maps a device id to its `connected` fact;
   * a device that it lacks gives no fact. The rule only switches a delegation between `queued` and `waiting_device`, and
   * publishes it. Returns how many delegations changed. A throw writes nothing.
   */
  observeDevices(scope: string, devices: ReadonlyMap<string, boolean>, clock: () => number): Promise<number> {
    return this.transaction(client => this.decideIn(client, storedKey(scope), undefined, async (state, publish) => {
      const ends = Object.values(state.delegations).flatMap(d => d.chainTurnIds.length ? [d.chainTurnIds.at(-1)!] : []);
      const published = new Set<string>();
      observeDevices(state, await settleFacts(client, scope, ends), devices, (id, body) => { publish(id, body); published.add(id); });
      return { value: published.size, outbox: [...published].map(id => ({ kind: 'projection' as const, id })), now: clock() };
    }), false);
  }

  /**
   * Claims the connector call of card `cardId` (#793 S12), in one transaction under the scope lock, at the clock read after
   * the lock. A due row of a card that K8 `cardCallDue` still selects takes a try and a lease (`next_at = now + leaseMs`).
   * A row that already had a try belongs to a claim whose lease passed with no settle: the call may have run, so the claim
   * ends the card with K8's `CONNECTOR_OUTCOME_UNKNOWN` through `settleCardCall` and never calls again (owner Q3 A), as L
   * does since #958. A row whose card is gone, or has its outcome, settles with no call.
   */
  claimCard(scope: string, cardId: string, clock: () => number, leaseMs: number): Promise<CardClaim> {
    const key = storedKey(scope), row = cardRowKey(cardId);
    return this.transaction(client => this.decideIn<CardClaim>(client, key, undefined, async state => {
      const now = clock(), card = state.cards[cardId];
      if (!card || !cardCallDue(card)) {
        await client.query(`UPDATE outbox SET settled_at = $3 WHERE scope = $1 AND key = $2 AND kind = 'card' AND settled_at IS NULL`, [key, row, now]);
        return { value: { kind: 'none' }, outbox: [] };
      }
      const claimed = await client.query<{ tries: number }>(`UPDATE outbox SET tries = tries + 1, next_at = $3 + $4
        WHERE scope = $1 AND key = $2 AND kind = 'card' AND settled_at IS NULL AND next_at <= $3 RETURNING tries`, [key, row, now, leaseMs]);
      const tries = claimed.rows[0]?.tries;
      if (tries === undefined) return { value: { kind: 'none' }, outbox: [] };
      if (tries > 1) {
        settleCardCall(card, { error: new Error(CONNECTOR_OUTCOME_UNKNOWN) });
        return { value: { kind: 'ended' }, outbox: [], now };
      }
      return { value: { kind: 'call', tries, action: card.action.action, draft: card.action.draft }, outbox: [] };
    }), false);
  }

  /**
   * Writes the outcome of one card connector call (#793 S12) with K8 `settleCardCall`, in one transaction under the scope
   * lock. It applies only while the card's row is unsettled with the claim's `tries` and the card still waits for its call;
   * otherwise it writes nothing and returns false. The card index settles the row in the same transaction.
   */
  settleCard(scope: string, cardId: string, tries: number, outcome: Parameters<typeof settleCardCall>[1], clock: () => number): Promise<boolean> {
    const key = storedKey(scope);
    return this.transaction(client => this.decideIn(client, key, undefined, async state => {
      const card = state.cards[cardId];
      const row = await client.query<{ tries: number }>(`SELECT tries FROM outbox WHERE scope = $1 AND key = $2 AND kind = 'card' AND settled_at IS NULL`,
        [key, cardRowKey(cardId)]);
      if (!card || !cardCallDue(card) || row.rows[0]?.tries !== tries) return { value: false, outbox: [] };
      settleCardCall(card, outcome);
      return { value: true, outbox: [], now: clock() };
    }), false);
  }

  /**
   * Claims the Host job of occurrence `occurrenceKey` (#793 S14), in one transaction under the scope lock, at the clock read
   * after the lock, as K4 `runHostJobs` raises `attempts` before the handler runs: the row takes a try and a lease. A claim
   * whose lease passed runs the job again, as K4 retries pending work, so a handler runs at least once. A row whose
   * occurrence is no longer open settles with no run.
   */
  claimHostJob(scope: string, occurrenceKey: string, clock: () => number, leaseMs: number): Promise<HostJobClaim> {
    const key = storedKey(scope), row = hostJobRowKey(occurrenceKey);
    return this.transaction(async (client): Promise<HostJobClaim> => {
      await lockScope(client, key);
      const now = clock(), slice = await loadSlice(client, key);
      const occurrence = Object.hasOwn(slice.state.occurrences, occurrenceKey) ? slice.state.occurrences[occurrenceKey]! : undefined;
      if (!occurrence?.job || occurrence.intentId || occurrence.conclusion) {
        await client.query(`UPDATE outbox SET settled_at = $3 WHERE scope = $1 AND key = $2 AND kind = 'host_job' AND settled_at IS NULL`, [key, row, now]);
        return { kind: 'none' };
      }
      const hostJob = slice.state.routines[hash(occurrence.routineId)]?.definition.hostJob;
      if (!hostJob) throw new Error('Invalid pending Host job');
      const claimed = await client.query<{ tries: number }>(`UPDATE outbox SET tries = tries + 1, next_at = $3 + $4
        WHERE scope = $1 AND key = $2 AND kind = 'host_job' AND settled_at IS NULL AND next_at <= $3 RETURNING tries`, [key, row, now, leaseMs]);
      const tries = claimed.rows[0]?.tries;
      if (tries === undefined) return { kind: 'none' };
      return { kind: 'run', tries, run: { ...structuredClone(hostJob), occurrenceKey, routineId: occurrence.routineId,
        definitionVersion: occurrence.definitionVersion, trigger: structuredClone(occurrence.trigger), attempt: tries } };
    }, false);
  }

  /**
   * Writes the outcome of one Host job run (#793 S14), in one transaction under the scope lock, fenced by the claim's `tries`:
   * a settle after another claim took the row writes nothing and returns false. A summary is stored and concludes the
   * occurrence `succeeded`, as K4 does; a result with `execution` stores its summary and concludes it `failed`, with
   * `host_job_execution_unsupported` as the row's error, and nothing is promoted, superseded or not (owner Q4 A). Either
   * settles the row, then a staged version switches when it is due. An error keeps the occurrence pending and the row waits
   * `backoffMs`, as K4 keeps the row for its next pass.
   */
  settleHostJob(scope: string, occurrenceKey: string, tries: number, outcome: HostJobOutcome, clock: () => number, backoffMs: number): Promise<boolean> {
    const key = storedKey(scope), row = hostJobRowKey(occurrenceKey);
    return this.transaction(async client => {
      await lockScope(client, key);
      const now = clock();
      if ('error' in outcome) {
        const failed = await client.query(`UPDATE outbox SET last_error = $4, next_at = $5 WHERE scope = $1 AND key = $2 AND tries = $3
          AND settled_at IS NULL`, [key, row, tries, errorText(outcome.error), now + backoffMs]);
        return failed.rowCount === 1;
      }
      const settled = await client.query(`UPDATE outbox SET settled_at = $4, last_error = $5 WHERE scope = $1 AND key = $2 AND tries = $3
        AND settled_at IS NULL`, [key, row, tries, now, outcome.unsupported ? HOST_JOB_EXECUTION_UNSUPPORTED : null]);
      if (settled.rowCount !== 1) return false;
      const concluded = await client.query(`UPDATE occurrence SET job = $3::json, conclusion = $4 WHERE scope = $1 AND key = $2 AND job IS NOT NULL
        AND conclusion IS NULL`, [key, storedKey(occurrenceKey), JSON.stringify({ summary: outcome.summary }), outcome.unsupported ? 'failed' : 'succeeded']);
      if (concluded.rowCount !== 1) throw new Error('Invalid pending Host job');
      await switchDueVersions(client, key, now);
      return true;
    }, false);
  }

  /**
   * Claims the Agent home operation `sequence` (#793 S13), in one transaction under the scope lock, at the clock read after the
   * lock. K8 `homeHead` decides, as L's `flushHomes`: the operation must be its Bot's oldest pending one, and the Bot must have
   * no intent row with no conclusion. A pending operation that is not a head waits `backoffMs` (never earlier). A head takes
   * a lease (`next_at = now + leaseMs`); the entity is the fence, so `tries` stays 0. A row whose operation is gone or
   * settled settles with no call. While the operation's device refuses new home writes (#957: a switch is open, or its row
   * names mode L), an operation that was never sent waits `backoffMs` too, and a sent one is read back with no new enqueue
   * (`settleHome`), as L's `flushHomes` does.
   */
  claimHome(scope: string, sequence: number, clock: () => number, leaseMs: number, backoffMs: number): Promise<HomeClaim> {
    const key = storedKey(scope), row = homeRowKey(sequence);
    return this.transaction(client => this.decideIn<HomeClaim>(client, key, undefined, async state => {
      const now = clock(), op = state.team.homeOperations.find(o => o.sequence === sequence);
      if (!op || op.status !== 'pending') {
        await client.query(`UPDATE outbox SET settled_at = $3 WHERE scope = $1 AND key = $2 AND kind = 'home' AND settled_at IS NULL`, [key, row, now]);
        return { value: { kind: 'none' }, outbox: [] };
      }
      const busy = (await client.query<{ busy: boolean }>(`SELECT EXISTS (SELECT 1 FROM intent WHERE scope = $1 AND conclusion IS NULL
        AND input->'payload'->'agentRef'->>'agentId' = $2) AS busy`, [key, op.botId])).rows[0]!.busy;
      // A write that was never sent waits while its device refuses new home writes: it has nothing to read back.
      const unsent = !op.sent && await refusesHomeWrites(client, key, op.request.deviceId);
      if (unsent || !homeHead(state.team, sequence, botId => botId === op.botId && busy)) {
        await client.query('UPDATE outbox SET next_at = GREATEST(next_at, $3) WHERE scope = $1 AND key = $2 AND settled_at IS NULL', [key, row, now + backoffMs]);
        return { value: { kind: 'none' }, outbox: [] };
      }
      const leased = await client.query(`UPDATE outbox SET next_at = $3 + $4
        WHERE scope = $1 AND key = $2 AND kind = 'home' AND settled_at IS NULL AND next_at <= $3`, [key, row, now, leaseMs]);
      if (!leased.rowCount) return { value: { kind: 'none' }, outbox: [] };
      return { value: { kind: 'flush', op: structuredClone(op), retries: op.retries.length, lease: now + leaseMs }, outbox: [] };
    }), false);
  }

  /**
   * Settles one Agent home flush step (#793 S13) with the K8 rule, in one transaction under the scope lock: a terminal runs
   * `applyHomeTerminal` (its projection reaches the outbox), a retry runs `planHomeRetry` and returns the request to enqueue,
   * an error runs `failHomeFlush`. It applies only while the operation is pending with `retries` retries; otherwise it writes
   * nothing and returns `undefined`. It returns the retry count after the step, the fence of the next step. The home index
   * writes the row's `next_at` or `settled_at` in the same transaction. A retry that plans an enqueue then puts `next_at`
   * back to the claim's `lease`: the enqueue runs after this transaction, and no other sender may claim the row before
   * `homeEnqueued` publishes the new `retryAt`.
   */
  settleHome(scope: string, sequence: number, retries: number, step: HomeStep, clock: () => number, lease: number):
    Promise<{ retries: number; enqueue?: HomeOperation['request'] } | undefined> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      const settled = await this.settleHomeIn(client, key, sequence, retries, step, clock);
      if (settled?.enqueue) await setHomeDue(client, key, homeRowKey(sequence), lease);
      return settled;
    }, false);
  }
  private settleHomeIn(client: PoolClient, key: string, sequence: number, retries: number, step: HomeStep, clock: () => number) {
    return this.decideIn(client, key, undefined, async (state, publish) => {
      const now = clock(), op = state.team.homeOperations.find(o => o.sequence === sequence);
      if (!op || op.status !== 'pending' || op.retries.length !== retries) return { value: undefined, outbox: [] };
      const published = new Set<string>();
      let enqueue: HomeOperation['request'] | undefined;
      if ('terminal' in step) applyHomeTerminal(state, op, step.terminal, (id, body) => { publish(id, body); published.add(id); });
      else if ('retry' in step) {
        // The mark comes before the first send, in the transaction that plans it, so a crash or a failed send still counts the
        // write as sent (K8 `HomeOperation.sent`). A device that refuses new home writes gets no enqueue: the row waits.
        if (!await refusesHomeWrites(client, key, op.request.deviceId)) {
          op.sent = true;
          enqueue = structuredClone(planHomeRetry(op, now));
        }
      }
      else failHomeFlush(op, step.error);
      return { value: { retries: op.retries.length, ...enqueue ? { enqueue } : {} }, outbox: [...published].map(id => ({ kind: 'projection' as const, id })), now };
    });
  }

  /**
   * K8 `homeEnqueued` after the enqueue of the operation's latest request (#793 S13), fenced like `settleHome`. It ends the
   * flush's lease: the row is due at the operation's `retryAt`. Returns false when the operation moved on.
   */
  homeEnqueued(scope: string, sequence: number, retries: number, clock: () => number): Promise<boolean> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      const retryAt = await this.decideIn(client, key, undefined, async state => {
        const now = clock(), op = state.team.homeOperations.find(o => o.sequence === sequence);
        if (!op || op.status !== 'pending' || op.retries.length !== retries) return { value: undefined, outbox: [] };
        homeEnqueued(op, now);
        return { value: op.retryAt!, outbox: [], now };
      });
      if (retryAt === undefined) return false;
      await setHomeDue(client, key, homeRowKey(sequence), retryAt);
      return true;
    }, false);
  }

  /**
   * One K8 retention call on `scope` (#793 D2g, #798), in one transaction under the scope lock: the acknowledged roots move
   * into `archived_row`, their ids are retired in `retired_identity`, and the moved command records answer replays until
   * they expire. A refusal or a throw writes nothing. A scope with no row has no rows to retain, so the rule runs on the
   * empty state, as L runs it on an empty ledger.
   */
  retain(scope: string, input: RetentionInput, limits: RetentionLimits): Promise<RetentionResult> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      if (!(await client.query('SELECT 1 FROM scope WHERE scope = $1', [key])).rowCount) return decideRetention(client, key, stateOf({}), input, limits);
      return this.decideIn(client, key, undefined, async state => ({ value: await decideRetention(client, key, state, input, limits), outbox: [] }));
    }, false);
  }

  /**
   * Operator compaction of settled intent rows on `scope` (#793 S8), as K4 `compact`: never automatic. In one transaction
   * under the scope lock, the K8 veto `compactVeto` checks each acknowledged Turn, and each settled intent row leaves with a
   * permanent intent tombstone (kind `intent`, `hash(turnId)`) in `retired_identity`. A Turn id with no row counts as
   * already compacted when its intent tombstone exists. A routine intent is refused. A refusal or a throw writes nothing.
   * A scope with no row has no intents.
   */
  compactIntents(scope: string, input: IntentCompactionInput): Promise<IntentCompaction> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      if (!(await client.query('SELECT 1 FROM scope WHERE scope = $1', [key])).rowCount) {
        // No scope row means no intent and no tombstone (`retired_identity` references `scope`), so no lock is needed.
        if (acknowledgedTurnIds(input).length) throw new Error('Acknowledged intent not found');
        return { compactedIntents: 0, alreadyCompactedIntents: 0 };
      }
      return this.decideIn(client, key, undefined, async state => ({ value: await decideCompaction(client, key, state, input), outbox: [] }));
    }, false);
  }

  /**
   * Binds a device of `scope` to H (#793 D2e) and returns its mode revision. A second bind changes nothing. A revoked
   * device id throws `DeviceBindingError` (#793 O1 option A).
   */
  bindDevice(scope: string, deviceId: string): Promise<number> {
    // Through the state transaction, so a bind that frees a held Turn writes the scope's due time with it (#956).
    return this.change(scope, undefined, async (_state, _publish, client) => ({ value: await bindDevice(client, storedKey(scope), deviceId), outbox: [] }));
  }

  /**
   * Revokes a device id of `scope` for good, and raises its mode revision. A second revoke changes nothing. An id that was
   * never bound, also in a new scope, gets a revoked tombstone row.
   */
  revokeDevice(scope: string, deviceId: string, revokedAt: number): Promise<void> {
    return this.change(scope, undefined, async (_state, _publish, client) => {
      await revokeDevice(client, storedKey(scope), deviceId, revokedAt);
      return { value: undefined, outbox: [] };
    });
  }

  /**
   * Opens the owner switch of a device toward `target` (§4.1, #957): the durable freeze, on the expected mode revision. It
   * raises the revision and returns the row read back in the same transaction. From its commit, every write that can create
   * execution for the device throws `DeviceSwitchingError`, and the sync holds the Turns of its Bots. A device with no row
   * (the default mode L, revision 0) starts its switch to H here; `bindDevice` is only for a device that pairs with H first.
   */
  beginSwitch(scope: string, deviceId: string, target: 'L' | 'H', expectedRevision: number): Promise<DeviceBinding> {
    return this.change(scope, undefined, async (_state, _publish, client) =>
      ({ value: await beginSwitch(client, storedKey(scope), deviceId, target, expectedRevision), outbox: [] }));
  }

  /**
   * The drain of a device that H is switching away from (#957): its open work, and with `cancel` the cancel of each item
   * first. It refuses with `not_owner` for a switch toward H, whose old owner L drains its own work. Open work is the
   * open intent rows that run on the device, and for the Bots on the device the Turns that are not concluded (held, queued,
   * routine, delegation chain and seat Turns), the open input batches and the Agent home writes to the device that were
   * sent and have no terminal readback. A home write that was never sent, and a room seat that has no Turn yet, are state,
   * not execution: they move with the state export. A cancel is the K8 `cancel_turn` command for a Turn or a batch, and the
   * K4 cancel for an intent with no Turn. A tried intent concludes only from SDK evidence, so it stays open until the
   * reconciler concludes it. A sent home write is never cancelled: its readback settles it. The drain waits for nothing: the caller syncs the scope,
   * which concludes the cancelled Turns, and calls it again.
   * Returns the work that is still open, and each cancel that threw.
   */
  async drainDevice(scope: string, deviceId: string, expectedRevision: number, options: { cancel?: boolean }, clock: () => number):
    Promise<{ open: DeviceWork; failed: Array<{ id: string; error: unknown }> }> {
    const key = storedKey(scope), failed: Array<{ id: string; error: unknown }> = [];
    // Every transaction of the drain checks the open switch on its revision under the scope lock, so a drain that an abort
    // or a commit overtook stops with the switch refusal (`not_switching`) and cancels nothing more.
    const owned = async (client: PoolClient) => {
      if ((await openSwitch(client, key, deviceId, expectedRevision)).mode !== 'H') {
        throw new DeviceSwitchRefusedError(deviceId, 'not_owner', `H is not the old owner of the switch of device ${deviceId}: L drains it`);
      }
    };
    const work = await this.change(scope, undefined, async (state, _publish, client) => {
      await owned(client);
      return { value: await openWork(client, key, state, deviceId), outbox: [] };
    });
    if (!options.cancel) return { open: work, failed };
    const state = await this.read(scope);
    const each = async (id: string, cancel: () => Promise<unknown>) => {
      try { await cancel(); }
      catch (error) { if (error instanceof DeviceSwitchRefusedError) throw error; failed.push({ id, error }); }
    };
    for (const id of [...work.turns, ...work.batches]) {
      // `cancel_turn` is a keyless K8 command: it keeps no record, and a second cancel of a concluded Turn changes nothing.
      await each(id, () => this.commitWith(scope, { scope, commandId: randomUUID(), command: { kind: 'cancel_turn', turnId: id } }, clock,
        undefined, undefined, owned));
    }
    for (const id of work.intents.filter(id => !Object.hasOwn(state.turns, id))) {
      await each(id, () => this.change(scope, undefined, async (_state, _publish, client) => {
        await owned(client);
        return { value: await cancelIntent(client, scope, id, clock()), outbox: [] };
      }));
    }
    const open = await this.transaction(async client => openWork(client, key, await this.snapshot(client, key), deviceId), true);
    return { open, failed };
  }

  /**
   * Step 3 of a switch away from H (#975): seals the whole scope into a switch export, once each device in `devices` has an
   * open switch away from H at its revision and no open work. The export must name the device of every live Bot. It
   * refuses a pending projection (the sender flushes it first), a card connector call in flight, a pending Host job, and
   * every other state the format refuses (`SwitchExportError`). From the export on, no transaction that locks the scope
   * commits (`SwitchExportedError`), except `commitSwitch` and `abortSwitch`, so the commit away can check that the scope
   * still holds what was exported. Returns the document; `clock` gives its export time.
   */
  exportScope(scope: string, devices: ReadonlyArray<{ deviceId: string; expectedRevision: number }>, clock: () => number): Promise<SwitchExport> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      const prior = await this.exportMark(client, key);
      if (prior) throw new SwitchExportedError(prior.digest);
      const state = await this.snapshot(client, key);
      for (const { deviceId, expectedRevision } of devices) await this.awayFromH(client, key, state, deviceId, expectedRevision);
      const exportedAt = clock();
      const document = sealSwitchExport(await hostedSwitchContent(client, scope, state, { source: 'H', domain: scope, exportedAt,
        devices: devices.map(({ deviceId, expectedRevision }) => ({ deviceId, frozenRevision: expectedRevision })) }));
      const mark: SwitchExportMark = { digest: document.manifest.digest, exportedAt, devices: document.devices.map(device => ({ ...device })) };
      await client.query('UPDATE scope SET switch_export = $2::json WHERE scope = $1', [key, JSON.stringify(mark)]);
      return document;
    }, false);
  }

  /**
   * Commits the open switch of a device on its frozen revision (#957): the target becomes the owner mode, the revision rises,
   * and the freeze ends. Toward H, the caller commits after L's commit.
   *
   * Away from H, the new owner imported and verified the export first (#975): `receipt` must be the digest of this scope's
   * export, and `deviceId` at `expectedRevision` one of its devices. Every device of the export then moves to L in this one
   * transaction, each on its frozen revision and only with no open work, whatever its age (§4.1 gives no timeout path),
   * so a domain is never split between the owners. The scope is sealed again under the export's header and must give the
   * same digest. The export mark stays, so H keeps writing nothing to the scope. After a commit to L, every H write that
   * can create execution for a device refuses with the `mode` reason. Returns the record of `deviceId`.
   */
  commitSwitch(scope: string, deviceId: string, expectedRevision: number, receipt: string): Promise<DeviceBinding> {
    const key = storedKey(scope);
    return this.change(scope, undefined, async (state, _publish, client) => {
      const mark = await this.exportMark(client, key);
      // H checks its own open work only as the old owner. Toward H, the old owner is L: L's drain and L's commit come first,
      // and H's held Turns of the device are the work that runs after this commit.
      if ((await openSwitch(client, key, deviceId, expectedRevision)).mode !== 'H') {
        // An exported scope takes no new owner device: the domain moved with its export.
        if (mark) throw new SwitchExportedError(mark.digest);
        return { value: await endSwitch(client, key, deviceId, expectedRevision, 'commit'), outbox: [] };
      }
      // The device checks first, so a device that is not ready refuses the same way with or without an export.
      await this.awayFromH(client, key, state, deviceId, expectedRevision);
      if (!mark) throw new Error('This scope has not been exported for a switch');
      if (mark.digest !== receipt) throw new Error(`The receipt ${receipt} is not this scope's export ${mark.digest}`);
      if (!mark.devices.some(device => device.deviceId === deviceId && device.frozenRevision === expectedRevision)) {
        throw new Error(`Device ${deviceId} at revision ${expectedRevision} is not a device of the export`);
      }
      const now = sealSwitchExport(await hostedSwitchContent(client, scope, state,
        { source: 'H', domain: scope, devices: mark.devices, exportedAt: mark.exportedAt }));
      if (now.manifest.digest !== mark.digest) throw new Error(`The scope changed after its export: ${now.manifest.digest}, not ${mark.digest}`);
      let committed: DeviceBinding | undefined;
      for (const device of mark.devices) {
        await this.awayFromH(client, key, state, device.deviceId, device.frozenRevision);
        const binding = await endSwitch(client, key, device.deviceId, device.frozenRevision, 'commit');
        if (device.deviceId === deviceId) committed = binding;
      }
      return { value: committed!, outbox: [] };
    });
  }

  /**
   * Ends the open switch of a device on its frozen revision and keeps the old owner (#957): a failed export or verification.
   * An abort of a device of the scope's export ends the export (#975), and the new owner discards its import. After the
   * commit away every device of the export is owned by L, so none aborts.
   */
  abortSwitch(scope: string, deviceId: string, expectedRevision: number): Promise<DeviceBinding> {
    const key = storedKey(scope);
    return this.change(scope, undefined, async (_state, _publish, client) => {
      const mark = await this.exportMark(client, key), binding = await endSwitch(client, key, deviceId, expectedRevision, 'abort');
      if (mark?.devices.some(device => device.deviceId === deviceId)) await client.query('UPDATE scope SET switch_export = NULL WHERE scope = $1', [key]);
      return { value: binding, outbox: [] };
    });
  }

  /** Takes the scope lock as a switch step (#975), which the switch fence lets commit, and reads the export mark. */
  private async exportMark(client: PoolClient, key: string): Promise<SwitchExportMark | undefined> {
    await lockScope(client, key, 'switch');
    const found = await client.query<{ mark: unknown }>('SELECT switch_export AS mark FROM scope WHERE scope = $1', [key]);
    return found.rows[0]?.mark == null ? undefined : exportMarkOf(found.rows[0].mark);
  }
  /** A device whose open switch away from H, at its frozen revision, has no open work left. Throws `DeviceSwitchRefusedError`. */
  private async awayFromH(client: PoolClient, key: string, state: CollaborationState, deviceId: string, expectedRevision: number): Promise<void> {
    if ((await openSwitch(client, key, deviceId, expectedRevision)).mode !== 'H') {
      throw new DeviceSwitchRefusedError(deviceId, 'not_owner', `H is not the old owner of the switch of device ${deviceId}`);
    }
    const work = await openWork(client, key, state, deviceId);
    if (Object.values(work).some(items => items.length)) {
      throw new DeviceSwitchRefusedError(deviceId, 'open_work', `Device ${deviceId} still has open work: ${JSON.stringify(work)}`);
    }
  }

  /**
   * D1 and D3 of one delivery outbox row (#793 D2b-out-2), in one transaction under the scope lock, with the K8 rules:
   * - a `sending` entity whose lease (`next_at`) has passed becomes `unknown` (`interrupted`), as L recovers a claim at startup;
   * - an `unknown` entity asks for a readback when the channel has one;
   * - a due `pending` entity takes its route, or is refused (`refuseRoute`, whose push fallback the index picks up), or is
   *   claimed (`startDelivery`) with a lease. The claim commits before the send, and the route stays in memory.
   * A readback claim takes the same lease. `clock` is read after the scope lock, so a claim that waited for the lock takes its
   * lease from the time it holds it. An unsettled row whose entity is not in the state throws: retention archives a delivery
   * only after its row settled, so it is drift.
   */
  claimDelivery(scope: string, id: string, clock: () => number, times: DeliveryTimes): Promise<DeliveryClaim> {
    const key = storedKey(scope), rowKey = storedKey(id);
    return this.transaction(async client => {
      let nextAt: number | undefined;
      const claim = await this.decideIn(client, key, undefined, async (state): Promise<Decision<DeliveryClaim>> => {
        const now = clock();
        const done = (value: DeliveryClaim): Decision<DeliveryClaim> => ({ value, outbox: [], now });
        const index = (await client.query<{ next_at: string; settled_at: string | null }>(`SELECT next_at::text, settled_at::text FROM outbox
          WHERE scope = $1 AND key = $2 AND kind = 'delivery'`, [key, rowKey])).rows[0];
        if (!index) throw new Error('Delivery outbox row not found');
        if (index.settled_at !== null) return done({ kind: 'none' });
        const deliveries = state.channel?.deliveries, row = deliveries && Object.hasOwn(deliveries, id) ? deliveries[id]! : undefined;
        if (!row) {
          if (await archivedRow(client, key, 'deliveries', id) === undefined) throw new Error('Delivery not found');
          throw new Error('Delivery outbox row unsettled for an archived entity');
        }
        if (row.state === 'sending') {
          if (Number(index.next_at) > now) return done({ kind: 'none' });
          recoverDelivery(row);
          nextAt = times.readback ? now : now + UNKNOWN_WAIT_MS;
          return done({ kind: 'moved' });
        }
        if (row.state === 'unknown') {
          // Another sender's readback holds the row until its lease passes, and a row that waits is not due yet.
          if (Number(index.next_at) > now) return done({ kind: 'none' });
          if (times.readback) {
            nextAt = now + times.leaseMs;
            return done({ kind: 'readback', attempt: row.attempts, lease: nextAt });
          }
          nextAt = now + UNKNOWN_WAIT_MS;
          return done({ kind: 'moved' });
        }
        if (row.state !== 'pending' || (row.nextAttemptAt ?? 0) > now) return done({ kind: 'none' });
        const route = deliveryRoute(state, row, now);
        if (!route) { refuseRoute(state, row); return done({ kind: 'moved' }); }
        if (!startDelivery(row, now)) return done({ kind: 'none' });
        nextAt = now + times.leaseMs;
        return done({ kind: 'send', attempt: row.attempts, route, body: row.body });
      });
      if (nextAt !== undefined) await client.query('UPDATE outbox SET next_at = $3 WHERE scope = $1 AND key = $2', [key, rowKey, nextAt]);
      return claim;
    }, false);
  }

  /**
   * D5 of one delivery (#793 D2b-out-2): the K8 settle of send attempt `attempt`, fenced by that attempt, then the K8 reply
   * token cleanup of the scope, in one transaction under the scope lock. A move into `unknown` sets the row's readback time.
   */
  finishDelivery(scope: string, id: string, attempt: number, outcome: { result: SendResult } | { code: 'send_timeout' | 'send_failed' },
    clock: () => number, times: DeliveryTimes): Promise<void> {
    return this.deliveryStep(scope, id, clock, async (row, state, client, now) => {
      const was = row.state;
      if ('result' in outcome) settleDelivery(row, attempt, outcome.result, now);
      else unknownDelivery(row, attempt, outcome.code);
      cleanReplyTokens(await intentConclusions(client, scope), state, now);
      return was !== 'unknown' && row.state === 'unknown' ? (times.readback ? now : now + UNKNOWN_WAIT_MS) : undefined;
    });
  }

  /**
   * D2 of one delivery (#793 D2b-out-2): the K8 readback rule, fenced by the attempt that the readback observed. A row that
   * stays `unknown` at that attempt is read back again after `readbackMs`. A result for an earlier attempt changes nothing.
   * `undefined` is missing evidence (the readback threw or passed its deadline): it changes only the wait, with the same fence.
   * The wait is also fenced by `lease`, the `next_at` of the readback claim: a readback that outlasted its lease leaves the
   * lease of a later readback claim alone, so that claim keeps the row (#793 S2).
   */
  readDelivery(scope: string, id: string, attempt: number, lease: number, result: ReadbackResult | undefined, clock: () => number,
    readbackMs: number): Promise<void> {
    return this.deliveryStep(scope, id, clock, async (row, _state, _client, now) => {
      if (result !== undefined) readbackDelivery(row, attempt, result, now);
      return row.state === 'unknown' && row.attempts === attempt ? now + readbackMs : undefined;
    }, lease);
  }

  /**
   * The wait after a step that threw: moves the `next_at` of an unsettled outbox row of `scope` (`id` is the row id, see
   * `SendFailure`) to `waitMs` after the clock, read under the scope lock. It never moves `next_at` earlier, so it cannot
   * shorten the lease of a newer claim.
   */
  deferOutbox(scope: string, id: string | readonly (string | number)[], clock: () => number, waitMs: number): Promise<void> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      await lockScope(client, key);
      await client.query('UPDATE outbox SET next_at = GREATEST(next_at, $3) WHERE scope = $1 AND key = $2 AND settled_at IS NULL',
        [key, JSON.stringify(id), clock() + waitMs]);
    }, false);
  }

  /**
   * One K8 rule on the delivery entity `id`, then the `next_at` that `step` returns, in one transaction under the scope lock.
   * `clock` is read once, after the lock. With `lease`, the `next_at` is written only while the row still holds that lease.
   */
  private deliveryStep(scope: string, id: string, clock: () => number,
    step: (row: Delivery, state: CollaborationState, client: PoolClient, now: number) => Promise<number | undefined>, lease?: number): Promise<void> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      const nextAt = await this.decideIn(client, key, undefined, async (state, _publish, tx) => {
        const now = clock();
        const deliveries = state.channel?.deliveries;
        if (!deliveries || !Object.hasOwn(deliveries, id)) throw new Error('Delivery not found');
        return { value: await step(deliveries[id]!, state, tx, now), outbox: [], now };
      });
      if (nextAt === undefined) return;
      if (lease === undefined) await client.query('UPDATE outbox SET next_at = $3 WHERE scope = $1 AND key = $2', [key, storedKey(id), nextAt]);
      else await client.query('UPDATE outbox SET next_at = $3 WHERE scope = $1 AND key = $2 AND next_at = $4', [key, storedKey(id), nextAt, lease]);
    }, false);
  }

  private change<T>(scope: string, commandId: string | undefined, decide: Decide<T>, indexed = true): Promise<T> {
    // #793 O4: each table stores the scope as JSON text, so two scopes that UTF-8 would merge stay apart.
    const key = storedKey(scope);
    return this.transaction(async client => {
      await this.upsertScope(client, key);
      return this.decideIn(client, key, commandId, decide, indexed);
    }, false);
  }

  /** Upsert, then lock: a missing scope row would lock nothing, and two first writes would race. */
  private async upsertScope(client: PoolClient, key: string): Promise<void> {
    await client.query('INSERT INTO scope (scope, state_version, frame) VALUES ($1, $2, $3::json) ON CONFLICT (scope) DO NOTHING',
      [key, STORE_VERSION, EMPTY_FRAME]);
  }

  /** Locks the scope row, runs `decide` on the loaded state, and writes the changed rows, the delivery index and the outbox. */
  private async decideIn<T>(client: PoolClient, key: string, commandId: string | undefined, decide: Decide<T>, indexed = true): Promise<T> {
    const frame = await lockScope(client, key);
    const rows = await this.load(client, key, frame, commandId);
    const state = stateOf({ collaboration: assemble(rows) as unknown as Json });
    const before = split(state);
    const published = new Map<string, Json>();
    const { value, outbox, now } = await decide(state, (id, body) => {
      if (published.has(id) && canonical(published.get(id)!) !== canonical(body)) throw new Error('Projection identity conflict');
      published.set(id, structuredClone(body));
    }, client);
    const after = split(state);
    await this.write(client, key, rows, before, after);
    if (indexed) {
      await this.indexDeliveries(client, key, before, after, now);
      await this.indexCards(client, key, before, after, now);
      await this.indexHomes(client, key, before, after, now);
    }
    await this.writeOutbox(client, key, outbox, published);
    // The scope's due time is a projection of the state that this transaction commits (#793 S4).
    // A new due time is new work, so it clears the scheduler's backoff (#794 H1).
    await client.query('UPDATE scope SET due_at = $2, retry_at = NULL WHERE scope = $1 AND due_at IS DISTINCT FROM $2', [key, await this.dueAt(client, key, state)]);
    return value;
  }

  /** The stored state of a scope in the caller's transaction. A scope row of an unknown store version is refused. */
  private async snapshot(client: PoolClient, key: string): Promise<CollaborationState> {
    const head = await client.query<{ state_version: number; frame: string }>('SELECT state_version, frame::text AS frame FROM scope WHERE scope = $1', [key]);
    if (head.rows[0] && !SUPPORTED_STORE_VERSIONS.has(head.rows[0].state_version)) throw new HostedStoreVersionError(head.rows[0].state_version);
    const rows = await this.load(client, key, head.rows[0]?.frame ?? EMPTY_FRAME, undefined);
    return stateOf({ collaboration: assemble(rows) as unknown as Json });
  }

  /**
   * The earliest time that the K8 rule `collaborationDue` gives for `state`, or null for none. A held Turn (#956) that the
   * next sync would no longer hold is due at once (0): its Bot's device now has an active binding (after `bindDevice`), or
   * its Bot is archived or gone (for example after a `team_snapshot` without it), so the sync ends it. A held Turn on a
   * refused device adds no time, so it never makes the scope spin.
   */
  private async dueAt(client: PoolClient, key: string, state: CollaborationState): Promise<number | null> {
    const due = collaborationDue(state, this.timers), bots = state.team.bots;
    const held = Object.values(state.turns).filter(turn => turn.held && !turn.conclusion)
      .map(turn => Object.hasOwn(bots, turn.botId) && !bots[turn.botId]!.archived ? bots[turn.botId]!.execution.deviceId : undefined);
    if (held.length) {
      const devices = [...new Set(held.filter(device => device !== undefined))];
      const refused = await deviceRefusals(client, key, devices);
      if (held.some(device => device === undefined || !refused.has(device))) due.push(0);
    }
    return due.length ? Math.min(...due) : null;
  }

  /** Loads the scope's entities and entries, and only the one command record that a commit can replay. `scopeKey` is the stored scope key. */
  private async load(client: PoolClient, scopeKey: string, frame: string, commandId: string | undefined): Promise<Split & { ordinals: Map<EntityKind, Map<string, number>> }> {
    const rows: Split & { ordinals: Map<EntityKind, Map<string, number>> } =
      { frame, entities: new Map(), entries: new Map(), commands: new Map(), ordinals: new Map() };
    const entities = await client.query<{ kind: EntityKind; key: string; ordinal: string; body: string }>(
      'SELECT kind, key, ordinal::text, body::text FROM entity WHERE scope = $1 ORDER BY kind, entity.ordinal', [scopeKey]);
    for (const row of entities.rows) {
      if (!rows.entities.has(row.kind)) { rows.entities.set(row.kind, new Map()); rows.ordinals.set(row.kind, new Map()); }
      rows.entities.get(row.kind)!.set(row.key, row.body);
      rows.ordinals.get(row.kind)!.set(row.key, Number(row.ordinal));
    }
    const entries = await client.query<{ kind: EntryKind; owner: string; position: string; body: string }>(
      'SELECT kind, owner, position::text, body::text FROM entry WHERE scope = $1 ORDER BY kind, owner, entry.position', [scopeKey]);
    for (const row of entries.rows) {
      const group = entryGroup(row.kind, row.owner);
      if (!rows.entries.has(group)) rows.entries.set(group, { kind: row.kind, owner: row.owner, bodies: [] });
      const bodies = rows.entries.get(group)!.bodies;
      if (Number(row.position) !== bodies.length) throw new Error(`Stored ${row.kind} positions have a gap`);
      bodies.push(row.body);
    }
    const commands = await client.query<{ key: string; evidence: string; result: string; root: string | null }>(commandId === undefined
      ? 'SELECT key, evidence, result::text, root FROM command WHERE scope = $1 ORDER BY ordinal'
      : 'SELECT key, evidence, result::text, root FROM command WHERE scope = $1 AND key = $2',
    commandId === undefined ? [scopeKey] : [scopeKey, storedKey(commandId)]);
    for (const row of commands.rows) {
      rows.commands.set(row.key, { evidence: row.evidence, result: row.result, ...(row.root === null ? {} : { root: row.root }) });
    }
    return rows;
  }

  /** Writes only the rows that changed. A new row of a kind gets the next ordinal of that kind. */
  private async write(client: PoolClient, scopeKey: string, loaded: { ordinals: Map<EntityKind, Map<string, number>> }, before: Split, after: Split): Promise<void> {
    if (after.frame !== before.frame) await client.query('UPDATE scope SET frame = $2::json WHERE scope = $1', [scopeKey, after.frame]);
    for (const kind of new Set([...before.entities.keys(), ...after.entities.keys()])) {
      const old = before.entities.get(kind) ?? new Map<string, string>(), next = after.entities.get(kind) ?? new Map<string, string>();
      const ordinals = loaded.ordinals.get(kind) ?? new Map<string, number>();
      let ordinal = [...ordinals.values()].reduce((max, value) => Math.max(max, value), -1) + 1;
      for (const key of old.keys()) if (!next.has(key)) await client.query('DELETE FROM entity WHERE scope = $1 AND kind = $2 AND key = $3', [scopeKey, kind, key]);
      for (const [key, body] of next) {
        if (!old.has(key)) await client.query('INSERT INTO entity (scope, kind, key, ordinal, body) VALUES ($1, $2, $3, $4, $5::json)', [scopeKey, kind, key, ordinal++, body]);
        else if (old.get(key) !== body) await client.query('UPDATE entity SET body = $4::json WHERE scope = $1 AND kind = $2 AND key = $3', [scopeKey, kind, key, body]);
      }
    }
    for (const group of new Set([...before.entries.keys(), ...after.entries.keys()])) {
      const { kind, owner } = (after.entries.get(group) ?? before.entries.get(group))!;
      const old = before.entries.get(group)?.bodies ?? [], next = after.entries.get(group)?.bodies ?? [];
      if (next.length < old.length) await client.query('DELETE FROM entry WHERE scope = $1 AND kind = $2 AND owner = $3 AND position >= $4', [scopeKey, kind, owner, next.length]);
      for (const [position, body] of next.entries()) {
        if (position >= old.length) await client.query('INSERT INTO entry (scope, kind, owner, position, body) VALUES ($1, $2, $3, $4, $5::json)', [scopeKey, kind, owner, position, body]);
        else if (old[position] !== body) await client.query('UPDATE entry SET body = $5::json WHERE scope = $1 AND kind = $2 AND owner = $3 AND position = $4', [scopeKey, kind, owner, position, body]);
      }
    }
    for (const [key, record] of after.commands) {
      const prior = before.commands.get(key);
      if (prior && prior.evidence === record.evidence && prior.result === record.result && prior.root === record.root) continue;
      if (prior) throw new Error('A command record cannot change');
      await client.query(`INSERT INTO command (scope, key, ordinal, evidence, result, root)
        SELECT $1, $2, coalesce(max(ordinal) + 1, 0), $3, $4::json, $5 FROM command WHERE scope = $1`, [scopeKey, key, record.evidence, record.result, record.root ?? null]);
    }
  }

  /**
   * The delivery outbox index (#793 D2b-out-2). It is the only writer of a delivery's outbox row: the K8 delivery entity is
   * the authority, and this projects it. For each delivery entity that is new, or whose `state` or `nextAttemptAt` changed in
   * this transaction, it inserts the row, sets `settled_at` once the entity is `accepted` or `rejected`, and sets `next_at`
   * for a `pending` entity. It does not touch `next_at` of a `sending` or `unknown` entity: the sender owns that value.
   * So every queued, refused, revoked, resent, echoed or sent delivery gets its row, also the push fallback that
   * `refuseRoute` inserts with no outbox intent.
   */
  private async indexDeliveries(client: PoolClient, scopeKey: string, before: Split, after: Split, now: number | undefined): Promise<void> {
    const old = before.entities.get('delivery'), next = after.entities.get('delivery');
    for (const [key, body] of next ?? []) {
      const prior = old?.get(key);
      if (prior === body) continue;
      const row = JSON.parse(body) as Delivery, was = prior === undefined ? undefined : JSON.parse(prior) as Delivery;
      if (!was) {
        await client.query(`INSERT INTO outbox (scope, key, ordinal, kind) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'delivery'
          FROM outbox WHERE scope = $1`, [scopeKey, key]);
      } else if (was.state === row.state && was.nextAttemptAt === row.nextAttemptAt) continue;
      if (row.state === 'accepted' || row.state === 'rejected') {
        if (now === undefined) throw new Error('A settled delivery needs the clock of its writer');
        await client.query('UPDATE outbox SET settled_at = $3 WHERE scope = $1 AND key = $2 AND settled_at IS NULL', [scopeKey, key, now]);
      } else if (row.state === 'pending') {
        await client.query('UPDATE outbox SET next_at = $3 WHERE scope = $1 AND key = $2', [scopeKey, key, row.nextAttemptAt ?? 0]);
      }
    }
  }

  /**
   * The card index of the outbox (#793 S12), from the card entities that this transaction changed, beside the delivery index:
   * a card that K8 `cardCallDue` starts to select gets a `card` row, due at once; a card that leaves it (its call has an
   * outcome) settles its row. The card is the authority.
   */
  private async indexCards(client: PoolClient, scopeKey: string, before: Split, after: Split, now: number | undefined): Promise<void> {
    const old = before.entities.get('card'), next = after.entities.get('card');
    for (const [key, body] of next ?? []) {
      const prior = old?.get(key);
      if (prior === body) continue;
      const due = cardCallDue(JSON.parse(body) as Card), was = prior !== undefined && cardCallDue(JSON.parse(prior) as Card);
      if (due && !was) {
        await client.query(`INSERT INTO outbox (scope, key, ordinal, kind) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'card'
          FROM outbox WHERE scope = $1`, [scopeKey, cardRowKey(idOf(key))]);
      } else if (was && !due) {
        if (now === undefined) throw new Error('A settled card call needs the clock of its writer');
        await client.query(`UPDATE outbox SET settled_at = $3 WHERE scope = $1 AND key = $2 AND kind = 'card' AND settled_at IS NULL`,
          [scopeKey, cardRowKey(idOf(key)), now]);
      }
    }
  }

  /**
   * The Agent home index of the outbox (#793 S13), from the home operations that this transaction changed, beside the
   * delivery index: a new pending operation gets a `home` row due at its `retryAt` (0 when unset); a pending operation whose
   * `retryAt` changed moves its row's `next_at` there; an operation that is `applied` or `failed` settles its row. The
   * operation is the authority and the fence.
   */
  private async indexHomes(client: PoolClient, scopeKey: string, before: Split, after: Split, now: number | undefined): Promise<void> {
    const group = entryGroup('home_operation', '');
    const parse = (split: Split) => new Map((split.entries.get(group)?.bodies ?? []).map(body => {
      const op = JSON.parse(body) as HomeOperation;
      return [op.sequence, op] as const;
    }));
    const old = parse(before);
    for (const [sequence, op] of parse(after)) {
      const was = old.get(sequence);
      if (was && canonical(was as unknown as Json) === canonical(op as unknown as Json)) continue;
      const row = homeRowKey(sequence);
      if (op.status !== 'pending') {
        if (was?.status !== 'pending') continue;
        if (now === undefined) throw new Error('A settled home operation needs the clock of its writer');
        await client.query(`UPDATE outbox SET settled_at = $3 WHERE scope = $1 AND key = $2 AND kind = 'home' AND settled_at IS NULL`, [scopeKey, row, now]);
      } else if (!was) {
        await client.query(`INSERT INTO outbox (scope, key, ordinal, kind, next_at) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'home', $3
          FROM outbox WHERE scope = $1`, [scopeKey, row, op.retryAt ?? 0]);
      } else if (was.retryAt !== op.retryAt) {
        await setHomeDue(client, scopeKey, row, op.retryAt ?? 0);
      }
    }
  }

  /**
   * Saves each outbox intent of the commit. An existing projection with the same id must hold the same value;
   * otherwise the commit throws and rolls back, as the K4 projection does in L.
   */
  private async writeOutbox(client: PoolClient, scopeKey: string, outbox: OutboxIntent[], published: Map<string, Json>): Promise<void> {
    for (const intent of outbox) {
      const body = intent.kind === 'projection' ? published.get(intent.id) : undefined;
      if (intent.kind === 'projection' && body === undefined) throw new Error('A projection intent has no published value');
      const key = storedKey(intent.id);
      const prior = await client.query<{ kind: string; body: string | null }>('SELECT kind, body::text FROM outbox WHERE scope = $1 AND key = $2', [scopeKey, key]);
      // The delivery index writes every delivery row from the entity (indexDeliveries), so an intent must find its row.
      if (intent.kind === 'delivery' && !prior.rows[0]) throw new Error('A delivery intent has no delivery entity');
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.kind !== intent.kind || (body !== undefined && canonical(JSON.parse(row.body!) as Json) !== canonical(body))) {
          throw new Error(intent.kind === 'projection' ? 'Projection identity conflict' : 'Delivery identity conflict');
        }
        continue;
      }
      await client.query(`INSERT INTO outbox (scope, key, ordinal, kind, body)
        SELECT $1, $2, coalesce(max(ordinal) + 1, 0), $3, $4::json FROM outbox WHERE scope = $1`,
      [scopeKey, key, intent.kind, body === undefined ? null : JSON.stringify(body)]);
    }
  }

  private transaction<T>(work: (client: PoolClient) => Promise<T>, readOnly: boolean): Promise<T> {
    return inSchema(this.pool, this.schema, work, readOnly);
  }
}

/** Moves the `next_at` of an unsettled home row: the home index, a flush that keeps its lease, and the end of that lease. */
async function setHomeDue(client: PoolClient, scopeKey: string, row: string, at: number): Promise<void> {
  await client.query(`UPDATE outbox SET next_at = $3 WHERE scope = $1 AND key = $2 AND kind = 'home' AND settled_at IS NULL`, [scopeKey, row, at]);
}

/** Runs `work` in one transaction with `search_path` set to `schema`. A throw rolls back every row. */
export async function inSchema<T>(pool: Pool, schema: string, work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  if (!SCHEMA.test(schema)) throw new Error('Invalid hosted collaboration schema name');
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    if (!readOnly) locks.set(client, { scopes: new Set(), switchStep: false });
    const value = await work(client);
    if (!readOnly) await refuseExported(client, locks.get(client)!);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    // A client whose rollback failed is broken: release it with the error, so the pool drops it.
    broken = await client.query('ROLLBACK').then(() => undefined, (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure)));
    throw error;
  } finally {
    locks.delete(client);
    client.release(broken);
  }
}

/** The scopes that each open write transaction of `inSchema` locked, and whether it is a switch step (#975). */
const locks = new WeakMap<PoolClient, { scopes: Set<string>; switchStep: boolean }>();
/**
 * The switch fence (#975): a transaction that locked an exported scope does not commit, so H writes nothing to it. It runs
 * right before the commit, so the work's own refusals come first, as each L write refuses after its own (K8 `writeLedger`).
 * Only the switch steps (`lockScope` with `'switch'`) pass: the export, the commit away and the abort.
 */
async function refuseExported(client: PoolClient, lock: { scopes: Set<string>; switchStep: boolean }): Promise<void> {
  if (!lock.scopes.size || lock.switchStep) return;
  const found = await client.query<{ mark: unknown }>('SELECT switch_export AS mark FROM scope WHERE scope = ANY($1::text[]) AND switch_export IS NOT NULL LIMIT 1',
    [[...lock.scopes]]);
  if (found.rows[0]) throw new SwitchExportedError(exportMarkOf(found.rows[0].mark).digest);
}

/**
 * Locks an existing scope row for the rest of the transaction and returns its frame. Every writer of a scope
 * takes this lock first. A scope row of an unknown store version is refused before any write. The lock joins the switch
 * fence of the transaction, so it runs only in a write transaction of `inSchema`; `step` marks a switch step.
 */
export async function lockScope(client: PoolClient, scopeKey: string, step?: 'switch'): Promise<string> {
  const lock = locks.get(client);
  if (!lock) throw new Error('A scope lock needs a write transaction of inSchema');
  lock.scopes.add(scopeKey);
  if (step) lock.switchStep = true;
  const head = await client.query<{ state_version: number; frame: string }>(
    'SELECT state_version, frame::text AS frame FROM scope WHERE scope = $1 FOR UPDATE', [scopeKey]);
  if (!head.rows[0]) throw new Error('Unknown hosted collaboration scope');
  if (!SUPPORTED_STORE_VERSIONS.has(head.rows[0].state_version)) throw new HostedStoreVersionError(head.rows[0].state_version);
  return head.rows[0].frame;
}
