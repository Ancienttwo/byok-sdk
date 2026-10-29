import { hash, type Conclusion } from '@byok-sdk/server/execution-core';
import type { CollaborationState, Turn } from './model';
import { inboundKey, type Conversation, type Delivery, type InboundMessage, type PushRoute, type ReplyRoute } from './channel';
import { deliveryId } from './delivery';

/** The intent conclusions a delivery rule reads. A K4 `LedgerState` fits; H passes its intent rows. */
export interface IntentConclusions { readonly intents: Readonly<Record<string, { readonly conclusion?: Conclusion }>> }

interface StoredInbound {
  id: string; root: string; conversation: Conversation; channel: string; sequence: number;
  reply?: Omit<ReplyRoute, 'token'> & { token?: string };
}
export interface ChannelState {
  inbounds: Record<string, StoredInbound>;
  pushRoutes: Record<string, PushRoute>;
  deliveries: Record<string, Delivery>;
}
export function channelState(state: CollaborationState): ChannelState {
  return state.channel ??= { inbounds: {}, pushRoutes: {}, deliveries: {} };
}
const sameConversation = (a: Conversation, b: Conversation): boolean => a.kind === b.kind && a.id === b.id;
export function turnConversation(state: CollaborationState, turn: Turn): Conversation {
  const seat = state.team.seats[turn.id];
  return seat ? { kind: 'group', id: state.team.rounds[seat.roundId]!.roomId } : { kind: 'direct', id: turn.botId };
}
function turnRoot(state: CollaborationState, turn: Turn): string {
  const seat = state.team.seats[turn.id];
  return seat ? state.team.rounds[seat.roundId]!.root : turn.root;
}
function rootOpen(ledger: IntentConclusions, state: CollaborationState, root: string, conversation: Conversation): boolean {
  return Object.values(state.turns).some(turn => turnRoot(state, turn) === root && sameConversation(turnConversation(state, turn), conversation)
    && !turn.conclusion && !ledger.intents[hash(turn.id)]?.conclusion && !['blocked', 'failed', 'delivered'].includes(turn.status))
    || Object.values(state.inputBatches ?? {}).some(batch => batch.id === root && batch.state === 'open')
    || Object.values(state.team.seats).some(seat => state.team.rounds[seat.roundId]?.root === root && !seat.released);
}
/** Save with input admission, before any process pass can accept its reply. Redelivery never refreshes a token. */
export function rememberInbound(state: CollaborationState, message: InboundMessage, root: string): void {
  if (typeof message.channel !== 'string' || !message.channel.trim() || typeof message.platformMessageId !== 'string' || !message.platformMessageId) throw new Error('Invalid inbound identity');
  const route = message.replyRoute;
  if (route && (route.kind !== 'reply' || route.channel !== message.channel || route.inboundId !== message.platformMessageId
    || typeof route.token !== 'string' || !route.token || !Number.isSafeInteger(route.expiresAt) || route.expiresAt < 0)) {
    throw new Error('Invalid reply route binding');
  }
  const channels = channelState(state), id = inboundKey(message);
  channels.inbounds[id] ??= { id, root, conversation: { ...message.conversation }, channel: message.channel,
    sequence: ++state.sequence, ...(route ? { reply: { ...route } } : {}) };
}
export function enablePush(state: CollaborationState, conversation: Conversation, channel: string, target: string, owner: string, now: number): PushRoute {
  if (!conversation.id || !channel.trim() || !target.trim()) throw new Error('Invalid push route');
  const channels = channelState(state);
  for (const route of Object.values(channels.pushRoutes)) {
    if (sameConversation(route.conversation, conversation) && route.revokedAt === undefined) revokePush(state, route.id, now);
  }
  const id = hash(['push-route', conversation, channel, target, ++state.sequence]);
  const route: PushRoute = { kind: 'push', id, conversation: { ...conversation }, channel, target, optedInBy: owner, optedInAt: now };
  channels.pushRoutes[id] = route;
  return route;
}
export function revokePush(state: CollaborationState, id: string, now: number): void {
  const routes = state.channel?.pushRoutes;
  const route = routes && Object.hasOwn(routes, id) ? routes[id] : undefined;
  if (!route) throw new Error('Push route not found');
  route.revokedAt ??= now;
  for (const delivery of Object.values(state.channel!.deliveries)) {
    if (delivery.state === 'pending' && delivery.route.kind === 'push' && delivery.route.pushRouteId === id) refuseRoute(state, delivery);
  }
}
function activePush(state: CollaborationState, conversation: Conversation): PushRoute | undefined {
  return Object.values(state.channel?.pushRoutes ?? {}).find(route => route.revokedAt === undefined && sameConversation(route.conversation, conversation));
}
function insert(state: CollaborationState, input: Pick<Delivery, 'taskId' | 'turnId' | 'messageId' | 'body' | 'conversation' | 'channel' | 'route'>): Delivery {
  const id = deliveryId(input.taskId, input.messageId, input.route);
  return channelState(state).deliveries[id] ??= { id, ...input, state: 'pending', attempts: 0 };
}
/** Called in the content acceptance transaction. No external call or projection contains the token. */
export function queueDelivery(ledger: IntentConclusions, state: CollaborationState, turn: Turn, taskId: string, messageId: string, body: string, now: number): Delivery | undefined {
  const conversation = turnConversation(state, turn), root = turnRoot(state, turn);
  const inbound = Object.values(state.channel?.inbounds ?? {}).filter(row => row.root === root && sameConversation(row.conversation, conversation))
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (inbound?.reply?.token && inbound.reply.expiresAt > now && rootOpen(ledger, state, root, conversation)) {
    return insert(state, { taskId, turnId: turn.id, messageId, body, conversation, channel: inbound.reply.channel, route: { kind: 'reply', inboundId: inbound.id } });
  }
  const push = activePush(state, conversation);
  if (push) return insert(state, { taskId, turnId: turn.id, messageId, body, conversation, channel: push.channel, route: { kind: 'push', pushRouteId: push.id } });
  state.audit.push(`Delivery ${inbound?.reply ? 'reply_route_expired' : 'no_push_route'}: ${taskId} ${messageId}`);
  return undefined;
}
/** A pending delivery already owns its reply slot, including across terminal settlement. */
export function deliveryRoute(state: CollaborationState, row: Delivery, now: number): ReplyRoute | PushRoute | undefined {
  if (row.route.kind === 'push') {
    const route = state.channel?.pushRoutes[row.route.pushRouteId];
    return route && route.revokedAt === undefined && sameConversation(route.conversation, row.conversation) ? structuredClone(route) : undefined;
  }
  const stored = state.channel?.inbounds[row.route.inboundId], route = stored?.reply;
  return route?.token && route.expiresAt > now && sameConversation(stored!.conversation, row.conversation)
    ? { ...route, token: route.token } : undefined;
}
/** Route expiry is certain non-delivery for a pending row. Any fallback gets its own route-bound id. */
export function refuseRoute(state: CollaborationState, row: Delivery): void {
  if (row.state !== 'pending') return;
  row.state = 'rejected'; delete row.nextAttemptAt;
  row.code = row.route.kind === 'reply' ? 'reply_route_expired' : 'push_route_revoked';
  state.audit.push(`Delivery ${row.code}: ${row.taskId} ${row.messageId}`);
  const push = row.route.kind === 'reply' ? activePush(state, row.conversation) : undefined;
  if (push) insert(state, { taskId: row.taskId, turnId: row.turnId, messageId: row.messageId, body: row.body, conversation: row.conversation,
    channel: push.channel, route: { kind: 'push', pushRouteId: push.id } });
}
export function cleanReplyTokens(ledger: IntentConclusions, state: CollaborationState, now: number): void {
  for (const row of Object.values(state.channel?.inbounds ?? {})) {
    if (!row.reply?.token) continue;
    const reserved = Object.values(state.channel!.deliveries).some(delivery => delivery.route.kind === 'reply'
      && delivery.route.inboundId === row.id && (delivery.state === 'pending' || delivery.state === 'sending'));
    if (now >= row.reply.expiresAt || !reserved && !rootOpen(ledger, state, row.root, row.conversation)) delete row.reply.token;
  }
}
/** A manual resend is an explicit owner action, not an automatic retry of the unknown row. */
export function resendUnknown(state: CollaborationState, id: string, now: number): Delivery {
  const deliveries = state.channel?.deliveries;
  const old = deliveries && Object.hasOwn(deliveries, id) ? deliveries[id] : undefined;
  if (!old || old.state !== 'unknown') throw new Error('Only an unknown delivery can be resent');
  const available = deliveryRoute(state, old, now) ?? activePush(state, old.conversation);
  if (!available) throw new Error('No active delivery route');
  const route: Delivery['route'] = available.kind === 'reply' ? old.route : { kind: 'push', pushRouteId: available.id };
  const nextId = deliveryId(old.taskId, old.messageId, route, String(++state.sequence));
  const row: Delivery = { id: nextId, taskId: old.taskId, turnId: old.turnId, messageId: old.messageId, body: old.body, conversation: { ...old.conversation },
    channel: available.channel, route: { ...route }, state: 'pending', attempts: 0, resendOf: old.id };
  state.channel!.deliveries[nextId] = row;
  return row;
}
export function echoCandidates(state: CollaborationState, message: InboundMessage): Delivery[] {
  return Object.values(state.channel?.deliveries ?? {}).filter(row => row.channel === message.channel
    && sameConversation(row.conversation, message.conversation) && row.state !== 'rejected'
    && (message.deliveryId !== undefined ? row.id === message.deliveryId : row.platformMessageId === message.platformMessageId));
}
