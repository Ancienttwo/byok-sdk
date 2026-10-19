import { hash } from '@byok-sdk/example-host-execution-core';
import type { Mentions } from './rooms';

/** A sender that the channel adapter took from authenticated platform data (docs/host-im-adapter.md R2). */
export interface Principal { id: string; kind: 'human' | 'bot' }
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
  conversation: { kind: 'direct' | 'group'; id: string };
  /** Absent when the adapter cannot verify the sender. */
  sender?: Principal;
  text: string;
  /** Bot ids from the platform's mention entities (R6). The Host never scans `text`. */
  mentions: Mentions;
}
/**
 * Rows of the guide's §3 table, without the echo row. An echo only reconciles a delivery.
 * This example has no delivery outbox yet (M3), so it sends nothing that can echo.
 */
export type InboundClass = 'unverified_sender' | 'bot_audit' | 'bot_background' | 'owner_input' | 'not_owner' | 'room_input';

/** A principal needs a non-empty id and a known kind. */
export function verified(sender: Principal | undefined): sender is Principal {
  return typeof sender?.id === 'string' && sender.id.length > 0 && (sender.kind === 'human' || sender.kind === 'bot');
}
/** Only the human principal with the owner id. A bot account never has owner authority. */
export function isOwner(principal: Principal, owner: string): boolean {
  return principal.kind === 'human' && principal.id === owner;
}
/** The guide's §3 order. The first match wins. */
export function classifyInbound(message: InboundMessage, owner: string): InboundClass {
  const sender = message.sender;
  if (!verified(sender)) return 'unverified_sender';
  const direct = message.conversation.kind === 'direct';
  if (sender.kind === 'bot') return direct ? 'bot_audit' : 'bot_background';
  if (!direct) return 'room_input';
  return isOwner(sender, owner) ? 'owner_input' : 'not_owner';
}
/** A redelivered platform event maps to the same input. A platform message id can be unique only within one chat. */
export function inboundKey(message: InboundMessage): string {
  return hash([message.channel, message.conversation.id, message.platformMessageId]);
}
