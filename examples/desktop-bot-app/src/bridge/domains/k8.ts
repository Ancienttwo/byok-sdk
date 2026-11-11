/**
 * The k8 bridge domain: Bots, their conversations and the clear divider. Owned by A2b #1806; methods by A3 #1807.
 * Methods are named `k8.<verb>`; the Host handlers live in `src/host/k8/domain.ts`.
 */
import type { TurnCancelResult } from '@byok-sdk/bot-collaboration/host-kit';
import type { ConversationSnapshot } from '../../host/conversation/service.ts';
import type { BotProfile } from '../../host/store/types.ts';
import type { BridgeDomain } from '../domain.ts';

export interface K8Methods {
  /** The rail, the brand's roles and models, and the selected Bot's conversation. */
  'k8.view': { params: { botId: string | null }; result: ConversationSnapshot };
  /** Creates (under a renderer-made id, reused on retry) or edits a Bot. */
  'k8.saveBot': { params: BotProfile; result: null };
  /** Archives a Bot for good. */
  'k8.archiveBot': { params: { id: string }; result: null };
  /** One send keyed by the renderer's action id, reused on retry. */
  'k8.send': { params: { actionId: string; botId: string; text: string }; result: { turnId: string } };
  'k8.clear': { params: { actionId: string; botId: string }; result: null };
  'k8.cancel': { params: { turnId: string }; result: TurnCancelResult };
  'k8.answer': { params: { questionId: string; answer: string }; result: null };
}

export const K8_DOMAIN = {
  renderer: ['k8.view', 'k8.saveBot', 'k8.archiveBot', 'k8.send', 'k8.clear', 'k8.cancel', 'k8.answer'],
  main: [],
} as const satisfies BridgeDomain<K8Methods>;
