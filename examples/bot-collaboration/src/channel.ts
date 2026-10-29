import { hash } from '@byok-sdk/server/execution-core';
import type { Mentions } from './rooms';

/** A sender that the channel adapter took from authenticated platform data (docs/host-im-adapter.md R2). */
export interface Principal { id: string; kind: 'human' | 'bot' }
export interface Conversation { kind: 'direct' | 'group'; id: string }
export interface ReplyRoute {
  kind: 'reply'; channel: string; inboundId: string; token: string; expiresAt: number;
}
export interface PushRoute {
  kind: 'push'; id: string; conversation: Conversation; channel: string; target: string;
  optedInBy: string; optedInAt: number; revokedAt?: number;
}
export type DeliveryState = 'pending' | 'sending' | 'accepted' | 'rejected' | 'unknown';
/** `turnId` is the Turn that queued the delivery. Retention keeps the delivery with that Turn's root. */
export interface Delivery {
  id: string; taskId: string; turnId: string; messageId: string; body: string;
  conversation: Conversation; channel: string;
  route: { kind: 'reply'; inboundId: string } | { kind: 'push'; pushRouteId: string };
  state: DeliveryState; attempts: number; nextAttemptAt?: number;
  platformMessageId?: string; code?: string; resendOf?: string;
}
/** A rejection is authoritative. An exception leaves delivery acceptance unknown. */
export interface ChannelPort {
  send(input: { deliveryId: string; route: ReplyRoute | PushRoute; body: string }, signal: AbortSignal): Promise<
    | { result: 'accepted'; platformMessageId: string }
    | { result: 'rejected'; code: string; retryable: boolean; retryAfterMs?: number }>;
  readback?(deliveryId: string): Promise<'accepted' | 'absent' | 'unsupported'>;
}
export interface ChannelOptions {
  port: ChannelPort;
  /** Verified platform bot principal ids. These ids are scoped to their channel. */
  self?: Record<string, readonly string[]>;
  /** Business send deadline. The default is 15 seconds. */
  sendTimeoutMs?: number;
}
/**
 * Optional last argument of the owner APIs and `roomInput`. Its length tells an omitted principal
 * from a given `undefined`, because JavaScript applies a default parameter to both.
 */
export type PrincipalArg = [principal?: Principal];
/**
 * One inbound IM message after the adapter's translation. The adapter maps the platform chat
 * to a Host conversation: a Bot id for `direct`, a room id for `group`.
 */
export interface InboundMessage {
  channel: string; platformMessageId: string;
  conversation: Conversation;
  /** Absent when the adapter cannot verify the sender. */
  sender?: Principal;
  text: string;
  /** Bot ids from the platform's mention entities (R6). The Host never scans `text`. */
  mentions: Mentions;
  replyRoute?: ReplyRoute;
  deliveryId?: string;
  receivedAt?: number;
}
/** Echo candidates only reconcile exact delivery identities. They never create input. */
export type InboundClass = 'unverified_sender' | 'echo' | 'bot_audit' | 'bot_background' | 'owner_input' | 'not_owner' | 'room_input';

/** A principal needs a non-empty id and a known kind. */
export function verified(sender: Principal | undefined): sender is Principal {
  return typeof sender?.id === 'string' && sender.id.length > 0 && (sender.kind === 'human' || sender.kind === 'bot');
}
/** Only the human principal with the owner id. A bot account never has owner authority. */
export function isOwner(principal: Principal, owner: string): boolean {
  return principal.kind === 'human' && principal.id === owner;
}
/** The guide's §3 order. The first match wins. */
export function classifyInbound(message: InboundMessage, owner: string, self?: Record<string, readonly string[]>): InboundClass {
  const sender = message.sender;
  if (!verified(sender)) return 'unverified_sender';
  const selfBots = self && Object.hasOwn(self, message.channel) ? self[message.channel] : undefined;
  if (sender.kind === 'bot' && selfBots?.includes(sender.id)) return 'echo';
  const direct = message.conversation.kind === 'direct';
  if (sender.kind === 'bot') return direct ? 'bot_audit' : 'bot_background';
  if (!direct) return 'room_input';
  return isOwner(sender, owner) ? 'owner_input' : 'not_owner';
}
/** A redelivered platform event maps to the same input. A platform message id can be unique only within one chat. */
export function inboundKey(message: InboundMessage): string {
  return hash([message.channel, message.conversation.id, message.platformMessageId]);
}
