import { randomUUID } from 'node:crypto';
import { hash, type Routine } from '@byok-sdk/server/execution-core';
import { type Command, CommitConflict, type CommitResult, type DelegationCancelResult, isOwner, type Principal, type TurnCancelResult, verified } from '@byok-sdk/bot-collaboration/host-kit';
import type { KeylessCommand } from '@byok-sdk/bot-collaboration/rules';
import type { HostedCollaborationStore } from './store';

type RoomInputCommand = Extract<Command, { kind: 'room_input' }>;
type CreateRoomCommand = Extract<Command, { kind: 'create_room' }>;
type PushRouteCommand = Extract<KeylessCommand, { kind: 'enable_push_route' }>;
/** A K8 `update_routine` action, as the store's owner API takes it. */
type UpdateRoutineAction = Parameters<HostedCollaborationStore['updateRoutine']>[2];
type SealedRoutineAction = Parameters<HostedCollaborationStore['createSealedRoutine']>[2];

/** The scope that an authenticated request acts in, and the principal that the Host verified for it. */
export interface EntryCaller { scope: string; principal: Principal }
/** The request had no valid product session. Nothing was written. */
export class UnauthenticatedError extends Error {
  readonly code = 'unauthenticated' as const;
  constructor() { super('unauthenticated: the request has no valid product session'); this.name = 'UnauthenticatedError'; }
}
/** An R2 refusal (K8 host.ts `verifiedOnly`, `ownerOnly`), after its audit line committed. */
export class EntryRefusedError extends Error {
  constructor(readonly code: 'unverified_sender' | 'not_owner', message: string) { super(message); this.name = 'EntryRefusedError'; }
}
export interface CommandEntryOptions<C> {
  /**
   * The product's session check: the scope that the caller owns and the principal of the request. A throw or `undefined`
   * refuses the request with `UnauthenticatedError`. H never reads a token itself.
   */
  authenticate(credential: C): Promise<EntryCaller | undefined>;
  /**
   * The owner principal id of a scope, the value that `InboundIdentity.owner` gives the inbound entry. Async, so a product
   * reads the one scope's record when it is asked.
   */
  owner(scope: string): Promise<string>;
  /** The deployment's composed sync of a scope, the function that `HostedDueScheduler` runs. */
  sync(scope: string, now: number): Promise<unknown>;
  /**
   * The deployment's owner settle of a stuck intent (#955), the reconciler's `failStuckIntent` for the scope's tenant.
   * Without it, `failStuckIntent` refuses.
   */
  failStuckIntent?(scope: string, key: string): Promise<void>;
  now?: () => number;
}

/**
 * The authenticated product command entry of H (#793 S10), L's owner API (K8 host.ts) for requests: each method
 * authenticates, checks the principal (R2), commits with L's command id, then syncs the scope.
 * A commit that adds work (a Turn that is not concluded, a room seat, or an input batch or an input to one) for a Bot
 * whose device has no active H binding rolls back with `DeviceBindingError` (§55a, the entry half).
 *
 * L trusts the caller of `setMainBot`, `createRoom`, `updateRoom`, `retryPersona` and its routine API; every call here comes from a
 * request, so they need the owner too. The Host's own calls (`personaReady`, a team snapshot, retention, compaction, device
 * binding) stay store methods.
 */
export class HostedCommandEntry<C> {
  private readonly now: () => number;
  constructor(private readonly store: HostedCollaborationStore, private readonly options: CommandEntryOptions<C>) {
    this.now = options.now ?? Date.now;
  }

  /** Owner input to Bot `botId`. Returns the Turn id, or with coalescing the batch id. */
  async input(credential: C, botId: string, key: string, request: string): Promise<string> {
    const { scope, principal } = await this.owned(credential, 'input', botId);
    return turnOf(await this.commit(scope, hash(['input', botId, key]), { kind: 'input', botId, key, request, sender: principal.id }));
  }
  /** Any verified principal posts in a room. A bot principal's mentions select no seat (R5). Returns the room input id. */
  async roomInput(credential: C, roomId: string, key: string, text: string, mentions: RoomInputCommand['mentions'] = []): Promise<string> {
    const { scope, principal } = await this.verifiedCaller(credential, 'roomInput', roomId);
    return turnOf(await this.commit(scope, hash(['room_input', roomId, key]),
      { kind: 'room_input', key, roomId, text, mentions: principal.kind === 'bot' ? [] : mentions, from: principal.id }));
  }
  async answer(credential: C, questionId: string, answer: string): Promise<void> {
    const { scope } = await this.owned(credential, 'answer', questionId);
    await this.commit(scope, hash(['answer', questionId]), { kind: 'answer', questionId, answer });
  }
  /** A refused decision, or another decision for a decided card, throws after the sync. */
  async decide(credential: C, cardId: string, decision: 'confirmed' | 'rejected'): Promise<void> {
    const { scope } = await this.owned(credential, 'decide', cardId);
    let error: string | undefined;
    try {
      const { disposition } = await this.store.commit(scope, { scope, commandId: hash(['decide', cardId]), command: { kind: 'decide', cardId, decision } },
        this.now, { requireBinding: true });
      if (disposition.outcome === 'refused') error = disposition.reason;
    } catch (cause) {
      if (!(cause instanceof CommitConflict) || cause.code !== 'identity_conflict') throw cause;
      error = cause.message;
    }
    await this.options.sync(scope, this.now());
    if (error) throw new Error(error);
  }
  /** Only a `cancelled` result committed, so only it syncs (#1405). */
  async cancelTurn(credential: C, turnId: string): Promise<TurnCancelResult> {
    const { scope } = await this.owned(credential, 'cancelTurn', turnId);
    const result = await this.store.cancelTurn(scope, turnId, this.now);
    if (result.result === 'cancelled') await this.options.sync(scope, this.now());
    return result;
  }
  /** Refuses with `DelegationError` (#1405). */
  async cancelDelegation(credential: C, delegationId: string): Promise<DelegationCancelResult> {
    const { scope } = await this.owned(credential, 'cancelDelegation', delegationId);
    const result = await this.store.cancelDelegation(scope, delegationId, this.now);
    if (result.result === 'cancelled') await this.options.sync(scope, this.now());
    return result;
  }
  async abandonDelegation(credential: C, delegationId: string): Promise<void> {
    const { scope } = await this.owned(credential, 'abandonDelegation', delegationId);
    await this.keyless(scope, { kind: 'abandon_delegation', delegationId });
  }
  /** Returns the push route id. The store needs `{ channel: true }`. */
  async enablePushRoute(credential: C, conversation: PushRouteCommand['conversation'], channel: string, target: string): Promise<string> {
    const { scope, principal } = await this.owned(credential, 'enablePushRoute', conversation.id);
    return valueOf<string>(await this.keyless(scope, { kind: 'enable_push_route', conversation, channel, target, owner: principal.id }));
  }
  async revokePushRoute(credential: C, routeId: string): Promise<void> {
    const { scope } = await this.owned(credential, 'revokePushRoute', routeId);
    await this.keyless(scope, { kind: 'revoke_push_route', routeId });
  }
  /** Returns the id of the new delivery. */
  async resendDelivery(credential: C, deliveryId: string): Promise<string> {
    const { scope } = await this.owned(credential, 'resendDelivery', deliveryId);
    return valueOf<string>(await this.keyless(scope, { kind: 'resend_delivery', deliveryId }));
  }
  async setMainBot(credential: C, botId: string, mainBot: boolean): Promise<void> {
    const { scope } = await this.owned(credential, 'setMainBot', botId);
    await this.keyless(scope, { kind: 'set_main_bot', botId, mainBot });
  }
  /** Owner room with a Host room id (#1321): the same id with the same fields replays, other fields are an identity conflict. */
  async createRoom(credential: C, roomId: string, fields: CreateRoomCommand['fields']): Promise<void> {
    const { scope } = await this.owned(credential, 'createRoom', roomId);
    await this.commit(scope, hash(['create_room', roomId]), { kind: 'create_room', roomId, fields });
  }
  async updateRoom(credential: C, roomId: string, update: Extract<KeylessCommand, { kind: 'update_room' }>['update']): Promise<void> {
    const { scope } = await this.owned(credential, 'updateRoom', roomId);
    await this.keyless(scope, { kind: 'update_room', roomId, update });
  }
  /** Owner switch of one Bot between `observe` and `auto` (#1229). Only outcomes recorded after the switch are affected. */
  async setBotAutonomy(credential: C, botId: string, autonomy: Extract<KeylessCommand, { kind: 'set_autonomy' }>['autonomy']): Promise<void> {
    const { scope } = await this.owned(credential, 'setBotAutonomy', botId);
    await this.keyless(scope, { kind: 'set_autonomy', botId, autonomy });
  }
  async retryPersona(credential: C, botId: string): Promise<void> {
    const { scope } = await this.owned(credential, 'retryPersona', botId);
    await this.keyless(scope, { kind: 'retry_persona', botId });
  }
  /** Main Bot `botId` completes any open Bot routine, an archived owner's too (§55c). */
  async endRoutine(credential: C, botId: string, routineId: string): Promise<void> {
    const { scope } = await this.owned(credential, 'endRoutine', routineId);
    await this.keyless(scope, { kind: 'end_routine', botId, routineId });
  }
  /** Main Bot `botId` stages the next version of one of its routines. */
  async updateRoutine(credential: C, botId: string, action: UpdateRoutineAction): Promise<void> {
    const { scope } = await this.owned(credential, 'updateRoutine', action.routineId);
    await this.store.updateRoutine(scope, botId, action, this.now());
    await this.options.sync(scope, this.now());
  }
  /**
   * The owner's member endpoint adds a sealed routine of Main Bot `botId` (#953): version 1, with the template that the member
   * sealed for it. A retry is a no-op while version 1 is the definition.
   */
  async createSealedRoutine(credential: C, botId: string, action: SealedRoutineAction): Promise<void> {
    const { scope } = await this.owned(credential, 'createSealedRoutine', action.routineId);
    await this.store.createSealedRoutine(scope, botId, action, this.now());
    await this.options.sync(scope, this.now());
  }
  /** The member endpoint stages the next version of a sealed routine of Main Bot `botId`, with a new template (#953). */
  async resealRoutine(credential: C, botId: string, action: SealedRoutineAction): Promise<void> {
    const { scope } = await this.owned(credential, 'resealRoutine', action.routineId);
    await this.store.resealRoutine(scope, botId, action, this.now());
    await this.options.sync(scope, this.now());
  }
  /**
   * L's owner API `failStuckIntent` (#955): settles as `failed` an open intent whose terminal H refuses with
   * `IntentOutcomeError`, so its FIFO moves on, then syncs, so a Bot Turn ends `failed`.
   */
  async failStuckIntent(credential: C, key: string): Promise<void> {
    const { scope } = await this.owned(credential, 'failStuckIntent', key);
    if (!this.options.failStuckIntent) throw new Error('The command entry has no failStuckIntent');
    await this.options.failStuckIntent(scope, key);
    await this.options.sync(scope, this.now());
  }
  async setRoutineLifecycle(credential: C, botId: string, routineId: string, lifecycle: Routine['lifecycle']): Promise<void> {
    const { scope } = await this.owned(credential, 'setRoutineLifecycle', routineId);
    await this.store.setRoutineLifecycle(scope, botId, routineId, lifecycle, this.now());
    await this.options.sync(scope, this.now());
  }

  private async caller(credential: C): Promise<EntryCaller> {
    let caller: EntryCaller | undefined;
    try { caller = await this.options.authenticate(credential); } catch { caller = undefined; }
    if (!caller || typeof caller.scope !== 'string' || !caller.scope) throw new UnauthenticatedError();
    return caller;
  }
  /** R2: refuse an unverified principal. The audit line commits before the error (K8 host.ts `verifiedOnly`). */
  private async verifiedCaller(credential: C, action: string, target: string): Promise<EntryCaller> {
    const caller = await this.caller(credential);
    if (verified(caller.principal)) return caller;
    await this.store.audit(caller.scope, `Action refused unverified_sender: ${action} ${target}`, this.now);
    throw new EntryRefusedError('unverified_sender', `unverified_sender: ${action} needs a verified principal`);
  }
  /** R2: only the scope's owner principal acts (K8 host.ts `ownerOnly`). */
  private async owned(credential: C, action: string, target: string): Promise<EntryCaller> {
    const caller = await this.verifiedCaller(credential, action, target);
    if (isOwner(caller.principal, await this.options.owner(caller.scope))) return caller;
    await this.store.audit(caller.scope, `Action refused not_owner: ${action} ${target} ${caller.principal.kind}:${caller.principal.id}`, this.now);
    throw new EntryRefusedError('not_owner', `not_owner: ${action} needs the owner principal`);
  }
  private async commit(scope: string, commandId: string, command: Command): Promise<CommitResult> {
    const result = await this.store.commit(scope, { scope, commandId, command }, this.now, { requireBinding: true });
    await this.options.sync(scope, this.now());
    return result;
  }
  /** A keyless owner command (#739 6a): a new command id at each call. */
  private keyless(scope: string, command: KeylessCommand): Promise<CommitResult> {
    return this.commit(scope, randomUUID(), command);
  }
}

function valueOf<T>(result: CommitResult): T {
  if (result.disposition.outcome !== 'accepted') throw new Error('Unexpected refused command');
  return result.disposition.value as T;
}
/** The Turn or round id of an input command. These commands never refuse; they throw. */
function turnOf(result: CommitResult): string {
  if (result.disposition.outcome !== 'accepted' || typeof result.disposition.value !== 'string') throw new Error('Input command has no Turn id');
  return result.disposition.value;
}
